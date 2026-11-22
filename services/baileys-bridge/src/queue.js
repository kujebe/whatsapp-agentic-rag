const crypto = require('crypto');

/**
 * Box-Muller Gaussian Random Variable Generator.
 * @param {number} mean Mean delay in ms
 * @param {number} stdDev Standard deviation in ms
 * @param {number} min Minimum clamped ms
 * @param {number} max Maximum clamped ms
 * @returns {number}
 */
function getGaussianJitter(mean = 3000, stdDev = 400, min = 1800, max = 4200) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const val = Math.round(mean + z * stdDev);
  return Math.max(min, Math.min(max, val));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialized Outbound FIFO Queue & Anti-Ban Jitter Pipeline.
 */
class OutboundAntiBanQueue {
  constructor(redis, getActiveSocket, options = {}) {
    this.redis = redis;
    this.getActiveSocket = getActiveSocket;
    this.tenantId = options.tenantId || process.env.TENANT_ID || 'default';
    this.logger = options.logger || console;
    this.maxPerMinute = options.maxPerMinute || 12;
    this.rateKey = `whatsapp:${this.tenantId}:rate:outbound:count`;

    this.queue = [];
    this.isProcessing = false;
    this.totalDispatched = 0;
  }

  /**
   * Enqueue a new outbound message.
   * @param {object} param0 { to, text, tenantId }
   * @returns {Promise<{ status: string, messageId: string }>}
   */
  enqueue({ to, text, tenantId }) {
    return new Promise((resolve, reject) => {
      const jobId = `out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const job = {
        jobId,
        to,
        text,
        tenantId: tenantId || this.tenantId,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      this.queue.push(job);
      this.logger.info({ jobId, to, queueLength: this.queue.length }, 'Outbound message enqueued.');

      // Trigger queue drainer
      this.processQueue();
    });
  }

  /**
   * Check and enforce 12 msgs/min sliding-window token bucket.
   * Delays execution if rate limit threshold is met.
   */
  async enforceRateLimit() {
    try {
      const current = await this.redis.incr(this.rateKey);
      if (current === 1) {
        await this.redis.expire(this.rateKey, 60);
      }

      if (current > this.maxPerMinute) {
        const ttl = await this.redis.ttl(this.rateKey);
        const waitMs = Math.max(ttl * 1000, 2000);
        this.logger.warn({ current, max: this.maxPerMinute, waitMs }, 'Outbound rate limit reached. Pausing queue worker.');
        await sleep(waitMs);
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Failed to check outbound rate limit in Redis.');
    }
  }

  /**
   * Worker loop: processes messages strictly sequentially (concurrency = 1).
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      const socket = this.getActiveSocket();

      if (!socket) {
        this.logger.error({ jobId: job.jobId }, 'WhatsApp socket unavailable. Rejecting outbound message.');
        job.reject(new Error('WhatsApp socket is not connected.'));
        continue;
      }

      const jid = job.to.includes('@s.whatsapp.net')
        ? job.to
        : `${job.to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

      try {
        // 1. Sliding window rate limit check
        await this.enforceRateLimit();

        // 2. Typing presence simulation (35ms per character, capped at 3500ms)
        const typingDuration = Math.min(job.text.length * 35, 3500);
        this.logger.debug({ jid, typingDuration }, 'Simulating composing presence.');
        await socket.sendPresenceUpdate('composing', jid).catch(() => {});
        await sleep(typingDuration);
        await socket.sendPresenceUpdate('paused', jid).catch(() => {});

        // 3. Gaussian delay jitter (1.8s - 4.2s, mean 3.0s)
        const jitter = getGaussianJitter(3000, 400, 1800, 4200);
        this.logger.debug({ jid, jitter }, 'Injecting Box-Muller Gaussian jitter.');
        await sleep(jitter);

        // 4. Outbound plain-text dispatch
        const result = await socket.sendMessage(jid, { text: job.text });
        this.totalDispatched++;

        this.logger.info({
          jobId: job.jobId,
          jid,
          messageId: result.key.id,
          totalDispatched: this.totalDispatched,
        }, 'Outbound message dispatched successfully.');

        job.resolve({
          status: 'sent',
          messageId: result.key.id,
          jitterMs: jitter,
          typingMs: typingDuration,
        });
      } catch (err) {
        this.logger.error({ err: err.message, jobId: job.jobId }, 'Error dispatching message through socket.');
        job.reject(err);
      }
    }

    this.isProcessing = false;
  }

  getQueueLength() {
    return this.queue.length;
  }

  async getCurrentRate() {
    try {
      const count = await this.redis.get(this.rateKey);
      return parseInt(count, 10) || 0;
    } catch {
      return 0;
    }
  }
}

module.exports = OutboundAntiBanQueue;
