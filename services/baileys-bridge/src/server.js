const express = require('express');
const Redis = require('ioredis');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const RedisSessionLock = require('./lock');
const MediaManager = require('./media');
const OutboundAntiBanQueue = require('./queue');
const DebounceManager = require('./debounce');

// Environment & Configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = pino({ level: LOG_LEVEL });

const PORT = Number(process.env.PORT) || 3000;
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const TENANT_ID = process.env.TENANT_ID || 'default';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/whatsapp-inbound';
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS) || 3500;
const AUTH_DIR = process.env.AUTH_DIR || '/app/auth_info_baileys';
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/media';

// Redis Connection
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => logger.info({ host: REDIS_HOST, port: REDIS_PORT }, 'Redis client connected.'));
redis.on('error', (err) => logger.error({ err: err.message }, 'Redis connection error.'));

// Subsystem Initializations
const sessionLock = new RedisSessionLock(redis, { tenantId: TENANT_ID, logger });
const mediaManager = new MediaManager({ tenantId: TENANT_ID, mediaBaseDir: MEDIA_DIR, logger });

let activeSocket = null;
let currentQR = null;
let isWhatsAppConnected = false;
let reconnectAttempts = 0;

const outboundQueue = new OutboundAntiBanQueue(redis, () => activeSocket, { tenantId: TENANT_ID, logger });
const debounceManager = new DebounceManager(redis, {
  tenantId: TENANT_ID,
  debounceMs: DEBOUNCE_MS,
  n8nWebhookUrl: N8N_WEBHOOK_URL,
  logger,
});

// Express App Setup
const app = express();
app.use(express.json());

// 1. Liveness check: For Docker healthcheck (never blocks on QR)
app.get('/health', async (req, res) => {
  try {
    const pong = await redis.ping();
    if (pong === 'PONG') {
      return res.status(200).json({
        status: 'ok',
        redis: 'connected',
        uptime: process.uptime(),
      });
    }
    return res.status(503).json({ status: 'degraded', redis: 'unresponsive' });
  } catch (err) {
    return res.status(503).json({ status: 'error', error: err.message });
  }
});

// 2. Readiness check: WhatsApp pairing status & telemetry
app.get('/health/whatsapp', async (req, res) => {
  const currentRate = await outboundQueue.getCurrentRate();
  const dlqCount = await debounceManager.getDlqCount();
  const statusCode = isWhatsAppConnected ? 200 : 503;

  res.status(statusCode).json({
    status: isWhatsAppConnected ? 'connected' : (currentQR ? 'waiting_for_qr' : 'disconnected'),
    tenantId: TENANT_ID,
    uptime: process.uptime(),
    session: activeSocket?.user || null,
    lock: {
      held: sessionLock.isHeld(),
      instanceId: sessionLock.getInstanceId(),
      key: sessionLock.getLockKey(),
    },
    queue: {
      pendingOutbound: outboundQueue.getQueueLength(),
      totalDispatched: outboundQueue.totalDispatched,
      currentRatePerMin: currentRate,
      dlqPending: dlqCount,
    },
  });
});

// 3. QR Inspection endpoint
app.get('/qr', (req, res) => {
  if (isWhatsAppConnected) {
    return res.status(200).json({ status: 'connected', message: 'WhatsApp is already linked.' });
  }
  if (!currentQR) {
    return res.status(404).json({ status: 'unavailable', message: 'No QR code currently active.' });
  }
  res.status(200).json({ status: 'qr_ready', qr: currentQR });
});

// 4. Outbound Dispatcher (POST /send) with anti-ban serialized queue
app.post('/send', async (req, res) => {
  const { to, text, tenantId } = req.body;
  if (!to || !text) {
    return res.status(400).json({ error: "Missing required fields 'to' or 'text'." });
  }
  if (!isWhatsAppConnected || !activeSocket) {
    return res.status(503).json({ error: 'WhatsApp socket is not connected.' });
  }

  try {
    const result = await outboundQueue.enqueue({ to, text, tenantId });
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err: err.message, to }, 'Failed to dispatch outbound message via queue.');
    return res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// WhatsApp Baileys Bridge Core
async function connectToWhatsApp() {
  // 1. Enforce distributed single-instance Redis lock
  const lockAcquired = await sessionLock.acquireLock();
  if (!lockAcquired) {
    logger.warn('Single-instance lock held by another process. Waiting 5000ms before retrying...');
    setTimeout(connectToWhatsApp, 5000);
    return;
  }

  // 2. Prevent socket listener memory leaks: clean up prior socket
  if (activeSocket) {
    try {
      activeSocket.ev.removeAllListeners();
      activeSocket.end(new Error('Re-initializing socket'));
    } catch (err) {
      logger.warn({ err: err.message }, 'Error during previous socket cleanup.');
    }
    activeSocket = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Initializing Baileys socket.');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }), // Suppress internal socket log noise
    browser: ['Ubuntu', 'Chrome', '124.0.0.0'],
    syncFullHistory: false,
  });

  activeSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      logger.info('New WhatsApp QR code generated:');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isWhatsAppConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn({ statusCode, isLoggedOut }, 'WhatsApp connection closed.');

      if (isLoggedOut) {
        logger.error('WhatsApp session logged out (401). Halting auto-reconnect. Fresh QR scan required.');
        await sessionLock.releaseLock();
      } else {
        // Exponential backoff reconnect (1s, 2s, 4s, ... max 30s)
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        logger.info({ reconnectAttempts, delayMs: delay }, 'Scheduling reconnection backoff.');
        setTimeout(connectToWhatsApp, delay);
      }
    } else if (connection === 'open') {
      isWhatsAppConnected = true;
      currentQR = null;
      reconnectAttempts = 0;
      logger.info({ user: sock.user }, 'WhatsApp connection opened successfully.');
    }
  });

  // Inbound messages event listener
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify' || !m.messages) return;

    for (const msg of m.messages) {
      if (!msg.key || msg.key.fromMe) continue; // Skip outbound echoes

      const senderJid = msg.key.remoteJid;
      if (!senderJid || senderJid.endsWith('@g.us') || senderJid === 'status@broadcast') {
        continue; // Filter groups and status broadcasts
      }

      // 2026 Anti-Ban Heuristic: Emulate human read-receipt (blue ticks)
      try {
        await sock.readMessages([msg.key]);
      } catch (err) {
        logger.debug({ err: err.message }, 'Failed to mark message as read.');
      }

      // Process multimodal media if present
      let media = null;
      try {
        media = await mediaManager.processInboundMedia(msg, sock);
      } catch (err) {
        logger.error({ err: err.message }, 'Error in media processing.');
      }

      // Extract text content
      const textContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      // Ignore empty messages that contain no text and no media
      if (!textContent.trim() && !media) continue;

      // Forward to Trailing-Edge Debounce Buffer
      await debounceManager.addMessage({
        senderJid,
        pushName: msg.pushName || 'Unknown',
        text: textContent,
        media,
        rawEvent: msg,
      });
    }
  });

  return sock;
}

// Start HTTP Server
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, tenantId: TENANT_ID }, 'Baileys Bridge HTTP service running.');
  connectToWhatsApp().catch((err) => logger.error({ err: err.message }, 'Failed to initialize Baileys.'));
});

// Graceful Teardown Handler
const shutdown = async (signal) => {
  logger.info({ signal }, 'Initiating graceful shutdown...');

  server.close(async () => {
    logger.info('HTTP server closed.');

    mediaManager.stopPurgeSchedule();
    debounceManager.stopDlqReplay();

    if (activeSocket) {
      try {
        logger.info('Disconnecting WhatsApp socket cleanly...');
        activeSocket.ev.removeAllListeners();
        activeSocket.end(new Error('Container termination'));
      } catch (err) {
        logger.error({ err: err.message }, 'Error closing WhatsApp socket.');
      }
    }

    try {
      await sessionLock.releaseLock();
    } catch (err) {
      logger.error({ err: err.message }, 'Error releasing session lock.');
    }

    try {
      await redis.quit();
      logger.info('Redis connection closed.');
    } catch (err) {
      logger.error({ err: err.message }, 'Error quitting Redis.');
    }

    process.exit(0);
  });

  // Safety hard-exit timeout (25s)
  setTimeout(() => {
    logger.error('Shutdown deadline exceeded (25s). Forcing process exit.');
    process.exit(1);
  }, 25000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
