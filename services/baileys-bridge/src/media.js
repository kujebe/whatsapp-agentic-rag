const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

/**
 * Multimodal Media Manager & Ephemeral Disk Lifecycle Engine.
 */
class MediaManager {
  constructor(options = {}) {
    this.mediaBaseDir = options.mediaBaseDir || process.env.MEDIA_DIR || '/app/media';
    this.tenantId = options.tenantId || process.env.TENANT_ID || 'default';
    this.tenantMediaDir = path.join(this.mediaBaseDir, this.tenantId);
    this.logger = options.logger || console;
    this.retentionMs = options.retentionMs || 24 * 60 * 60 * 1000; // 24 hours
    this.purgeIntervalMs = options.purgeIntervalMs || 60 * 60 * 1000; // 1 hour

    this.ensureMediaDirectory();
    this.startPurgeSchedule();
  }

  ensureMediaDirectory() {
    try {
      if (!fs.existsSync(this.tenantMediaDir)) {
        fs.mkdirSync(this.tenantMediaDir, { recursive: true });
      }
    } catch (err) {
      this.logger.error({ err: err.message, dir: this.tenantMediaDir }, 'Failed to initialize media directory.');
    }
  }

  /**
   * Determine media type and extract extension.
   */
  resolveMediaType(message) {
    if (!message) return null;

    if (message.imageMessage) {
      return {
        type: 'image',
        mimeType: message.imageMessage.mimetype || 'image/jpeg',
        ext: this.mimeToExt(message.imageMessage.mimetype, 'jpg'),
        caption: message.imageMessage.caption || '',
        rawMessage: message.imageMessage,
      };
    }
    if (message.audioMessage) {
      return {
        type: 'audio',
        mimeType: message.audioMessage.mimetype || 'audio/ogg; codecs=opus',
        ext: this.mimeToExt(message.audioMessage.mimetype, 'ogg'),
        caption: '',
        rawMessage: message.audioMessage,
      };
    }
    if (message.videoMessage) {
      return {
        type: 'video',
        mimeType: message.videoMessage.mimetype || 'video/mp4',
        ext: this.mimeToExt(message.videoMessage.mimetype, 'mp4'),
        caption: message.videoMessage.caption || '',
        rawMessage: message.videoMessage,
      };
    }
    if (message.documentMessage) {
      const fileName = message.documentMessage.fileName || 'document';
      const fileExt = path.extname(fileName).replace('.', '') || this.mimeToExt(message.documentMessage.mimetype, 'bin');
      return {
        type: 'document',
        mimeType: message.documentMessage.mimetype || 'application/octet-stream',
        ext: fileExt,
        caption: message.documentMessage.caption || fileName,
        rawMessage: message.documentMessage,
      };
    }

    return null;
  }

  mimeToExt(mime, fallback) {
    if (!mime) return fallback;
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('pdf')) return 'pdf';
    return fallback;
  }

  /**
   * Download inbound media attachment and persist to disk.
   * @param {object} msg Baileys WAMessage
   * @param {object} sock Baileys socket instance
   * @returns {Promise<object|null>}
   */
  async processInboundMedia(msg, sock) {
    const mediaInfo = this.resolveMediaType(msg.message);
    if (!mediaInfo) return null;

    const messageId = msg.key.id;
    const fileName = `${messageId}.${mediaInfo.ext}`;
    const filePath = path.join(this.tenantMediaDir, fileName);

    try {
      this.ensureMediaDirectory();
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.logger,
          reuploadRequest: sock?.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : undefined,
        }
      );

      if (!buffer || buffer.length === 0) {
        this.logger.warn({ messageId }, 'Media download returned an empty buffer.');
        return null;
      }

      await fs.promises.writeFile(filePath, buffer);
      this.logger.info({ messageId, fileName, sizeBytes: buffer.length }, 'Inbound media persisted successfully.');

      return {
        hasMedia: true,
        mediaType: mediaInfo.type,
        mimeType: mediaInfo.mimeType,
        localPath: filePath,
        fileName: fileName,
        fileSize: buffer.length,
        caption: mediaInfo.caption || null,
      };
    } catch (err) {
      this.logger.error({ err: err.message, messageId }, 'Failed to process and download inbound media.');
      return {
        hasMedia: true,
        mediaType: mediaInfo.type,
        mimeType: mediaInfo.mimeType,
        localPath: null,
        fileName: fileName,
        fileSize: 0,
        caption: mediaInfo.caption || null,
        error: err.message,
      };
    }
  }

  /**
   * Scheduled cleanup of media older than retention period (default 24h).
   */
  startPurgeSchedule() {
    this.purgeTimer = setInterval(() => this.purgeExpiredMedia(), this.purgeIntervalMs);
    // Run initial sweep on boot
    setTimeout(() => this.purgeExpiredMedia(), 5000);
  }

  async purgeExpiredMedia() {
    try {
      if (!fs.existsSync(this.tenantMediaDir)) return;
      const files = await fs.promises.readdir(this.tenantMediaDir);
      const now = Date.now();
      let purgedCount = 0;

      for (const file of files) {
        const fullPath = path.join(this.tenantMediaDir, file);
        try {
          const stats = await fs.promises.stat(fullPath);
          if (stats.isFile() && (now - stats.mtimeMs > this.retentionMs)) {
            await fs.promises.unlink(fullPath);
            purgedCount++;
          }
        } catch {
          // File may have been deleted concurrently
        }
      }

      if (purgedCount > 0) {
        this.logger.info({ tenantId: this.tenantId, purgedCount }, 'Ephemeral media sweep completed.');
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Error during scheduled media purge sweep.');
    }
  }

  stopPurgeSchedule() {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }
}

module.exports = MediaManager;
