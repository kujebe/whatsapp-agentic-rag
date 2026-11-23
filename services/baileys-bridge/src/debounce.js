/**
 * Trailing-Edge Debounce Buffer & Multi-Message Aggregation Engine.
 * Features Redis Dead-Letter Queue (DLQ) with automated background replay.
 */
class DebounceManager {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.tenantId = options.tenantId || process.env.TENANT_ID || 'default';
    this.debounceMs = Number(options.debounceMs || process.env.DEBOUNCE_MS || 3500);
    this.n8nWebhookUrl = options.n8nWebhookUrl || process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/whatsapp-inbound';
    this.n8nHealthUrl = options.n8nHealthUrl || this.n8nWebhookUrl.replace(/\/webhook\/.*$/, '/healthz');
    this.dlqKey = `whatsapp:${this.tenantId}:dlq:messages`;
    this.dlqIntervalMs = options.dlqIntervalMs || 30000; // 30s
    this.logger = options.logger || console;

    this.startDlqReplay();
  }

  getBufferKey(senderJid) {
    return `whatsapp:${this.tenantId}:debounce:${senderJid}:messages`;
  }

  getTimerKey(senderJid) {
    return `whatsapp:${this.tenantId}:debounce:${senderJid}:timer`;
  }

  /**
   * Buffer an inbound message item and manage the trailing-edge timer.
   */
  async addMessage({ senderJid, pushName, text, media, quotedText, quotedParticipant, rawEvent }) {
    const bufferKey = this.getBufferKey(senderJid);
    const timerKey = this.getTimerKey(senderJid);

    const payload = {
      messageId: rawEvent?.key?.id,
      timestamp: rawEvent?.messageTimestamp,
      text: (text || '').trim(),
      hasMedia: Boolean(media && media.hasMedia),
      media: media || null,
      pushName: pushName || 'Unknown',
      quotedText: quotedText || null,
      quotedParticipant: quotedParticipant || null,
    };

    try {
      // 1. Buffer message item with 300s TTL (prevents memory leaks)
      await this.redis.rpush(bufferKey, JSON.stringify(payload));
      await this.redis.expire(bufferKey, 300);

      // 2. Trailing edge timer management
      const existingTimer = await this.redis.get(timerKey);
      if (!existingTimer) {
        await this.redis.set(timerKey, 'active', 'PX', this.debounceMs);
        this.scheduleFlush(senderJid, this.debounceMs);
      } else {
        // Extend timer key expiration
        await this.redis.psetex(timerKey, this.debounceMs, 'active');
      }
    } catch (err) {
      this.logger.error({ err: err.message, senderJid }, 'Failed to buffer message in Redis.');
    }
  }

  scheduleFlush(senderJid, delayMs) {
    setTimeout(() => this.checkAndFlush(senderJid), delayMs);
  }

  /**
   * Trailing-edge audit and flush execution.
   */
  async checkAndFlush(senderJid) {
    const bufferKey = this.getBufferKey(senderJid);
    const timerKey = this.getTimerKey(senderJid);

    try {
      // Check remaining TTL on the timer
      const remainingPttl = await this.redis.pttl(timerKey);

      // If user sent another message and reset the timer, reschedule
      if (remainingPttl > 50) {
        this.logger.debug({ senderJid, remainingPttl }, 'Debounce timer extended. Rescheduling flush.');
        this.scheduleFlush(senderJid, remainingPttl);
        return;
      }

      // Execute atomic transaction: retrieve all buffered items, delete buffer & timer
      const results = await this.redis
        .multi()
        .lrange(bufferKey, 0, -1)
        .del(bufferKey)
        .del(timerKey)
        .exec();

      const rawItems = results?.[0]?.[1] || [];
      if (!rawItems || rawItems.length === 0) return;

      const parsedItems = rawItems
        .map((str) => {
          try {
            return JSON.parse(str);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (parsedItems.length === 0) return;

      // Collate texts and extract media
      const textParts = [];
      const mediaItems = [];

      for (const item of parsedItems) {
        if (item.text) {
          textParts.push(item.text);
        } else if (item.hasMedia && item.media) {
          const fallbackTag = item.media.caption || `[Sent ${item.media.mediaType}]`;
          textParts.push(fallbackTag);
        }

        if (item.hasMedia && item.media) {
          mediaItems.push(item.media);
        }
      }

      const stitchedText = textParts.join('\n');
      const senderPhone = senderJid.replace(/[^0-9]/g, '');

      // Extract quoted context from the batch if any message replied to a quote
      const quotedItem = parsedItems.find((it) => it.quotedText);
      const quotedContext = quotedItem
        ? { quotedText: quotedItem.quotedText, quotedParticipant: quotedItem.quotedParticipant }
        : null;

      const aggregatedPayload = {
        event: 'messages.aggregated',
        tenantId: this.tenantId,
        sender: senderJid,
        phone: senderPhone,
        pushName: parsedItems[0]?.pushName || 'Unknown',
        messageCount: parsedItems.length,
        stitchedText: stitchedText,
        quotedContext: quotedContext,
        quotedText: quotedContext ? quotedContext.quotedText : null,
        hasMedia: mediaItems.length > 0,
        mediaItems: mediaItems,
        rawEvents: parsedItems,
        dispatchedAt: Date.now(),
      };

      this.logger.info({
        sender: senderJid,
        messageCount: parsedItems.length,
        hasMedia: aggregatedPayload.hasMedia,
      }, 'Dispatching aggregated debounced payload to n8n webhook.');

      await this.dispatchToWebhook(aggregatedPayload);
    } catch (err) {
      this.logger.error({ err: err.message, senderJid }, 'Error during trailing-edge debounce buffer flush.');
    }
  }

  /**
   * Dispatch payload to n8n webhook with status validation and DLQ fallback.
   */
  async dispatchToWebhook(payload, attempt = 1) {
    try {
      const res = await fetch(this.n8nWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        this.logger.warn({ status: res.status, statusText: res.statusText }, 'n8n webhook responded with non-2xx status code.');
        await this.moveToDlq(payload, `HTTP_${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error({ err: err.message, attempt }, 'Failed to POST to n8n webhook.');
      if (attempt < 2) {
        setTimeout(() => this.dispatchToWebhook(payload, attempt + 1), 2000);
      } else {
        await this.moveToDlq(payload, err.message);
      }
      return false;
    }
  }

  /**
   * Save undelivered message payload to Redis Dead-Letter Queue.
   */
  async moveToDlq(payload, reason) {
    try {
      const dlqEntry = {
        ...payload,
        failedAt: Date.now(),
        failureReason: reason,
      };
      await this.redis.rpush(this.dlqKey, JSON.stringify(dlqEntry));
      await this.redis.expire(this.dlqKey, 72 * 3600); // Retain for 72 hours
      this.logger.warn({ sender: payload.sender, reason }, 'Undelivered webhook payload safely stored in Redis DLQ.');
    } catch (err) {
      this.logger.error({ err: err.message }, 'Failed to write payload to Redis DLQ.');
    }
  }

  /**
   * Background DLQ Replay Worker.
   * Periodically re-attempts delivery of buffered DLQ items when n8n is healthy.
   */
  startDlqReplay() {
    this.dlqTimer = setInterval(() => this.replayDlq(), this.dlqIntervalMs);
  }

  stopDlqReplay() {
    if (this.dlqTimer) {
      clearInterval(this.dlqTimer);
      this.dlqTimer = null;
    }
  }

  async replayDlq() {
    try {
      const dlqLen = await this.redis.llen(this.dlqKey);
      if (dlqLen === 0) return;

      // Probe n8n healthz endpoint before replaying
      let n8nHealthy = false;
      try {
        const check = await fetch(this.n8nHealthUrl, { method: 'GET' });
        n8nHealthy = check.ok;
      } catch {
        n8nHealthy = false;
      }

      if (!n8nHealthy) return;

      const rawItem = await this.redis.lpop(this.dlqKey);
      if (!rawItem) return;

      const payload = JSON.parse(rawItem);
      delete payload.failedAt;
      delete payload.failureReason;

      const delivered = await this.dispatchToWebhook(payload, 1);
      if (!delivered) {
        // Push back to head of DLQ if still failing
        await this.redis.lpush(this.dlqKey, rawItem);
      } else {
        this.logger.info({ sender: payload.sender }, 'DLQ message successfully re-delivered to n8n.');
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Error in DLQ replay worker.');
    }
  }

  async getDlqCount() {
    try {
      return await this.redis.llen(this.dlqKey);
    } catch {
      return 0;
    }
  }
}

module.exports = DebounceManager;
