# whatsapp-agentic-rag

A self-hosted WhatsApp automation gateway. Three Docker containers, no cloud dependency, no per-message fees. Receives WhatsApp messages, buffers them, and fires structured webhooks into n8n for whatever you want to do next.

Layer 3 (n8n workflow logic) is not included here — that lives in your n8n instance.

---

## What's running

| Container | Image | Purpose |
|---|---|---|
| `whatsapp-redis` | `redis:7.4-alpine` | Session lock, debounce timers, outbound queue, DLQ |
| `whatsapp-baileys` | Local build | WhatsApp bridge via Baileys + Express HTTP API |
| `whatsapp-n8n` | `n8nio/n8n:2.23.4` | Workflow automation — receives inbound webhooks |

---

## Architecture

```
WhatsApp ──► Baileys bridge
               │
               ├── messages.upsert (inbound)
               │     └── Redis trailing-edge debounce (3500ms)
               │           └── POST /webhook/whatsapp-inbound ──► n8n
               │
               └── POST /send (outbound)
                     └── FIFO queue → Gaussian jitter → sendMessage()
```

Redis sits under everything: session lock, debounce timers, rate limiter, dead-letter queue.

---

## Anti-ban pipeline

This is the part most DIY setups skip, and it's the reason accounts get banned.

**Inbound side:**
- `messages.upsert` with `type: notify` only — ignores everything else
- Groups (`@g.us`) and status broadcasts filtered before they hit the buffer
- Read receipts sent immediately after receive (simulates human behaviour)
- 3500ms trailing-edge debounce: messages from the same sender within the window get stitched into one payload before n8n sees them

**Outbound side:**
- Every `POST /send` goes into an in-memory FIFO queue — no parallel sends
- Typing state sent before each message, duration = `35ms × char_count` (capped at 3500ms)
- Gaussian delay between messages: mean 3.0s, std 0.6s, clamped 1.8s–4.2s
- Hard rate cap: 12 messages/minute per tenant
- Plain text only — no interactive buttons (deprecated by Meta, triggers spam flags)

**Session side:**
- Atomic Redis Lua lock (`baileys:session:lock:{tenantId}`) prevents two containers from owning the same WhatsApp session
- 401 disconnect (logged out) = hard stop, no retry, QR re-scan required
- 428/515/other disconnects = exponential backoff (1s, 2s, 4s... max 30s)
- Socket listeners removed before each reconnect to prevent EventEmitter memory leaks
- 25s hard-exit timeout on SIGTERM/SIGINT if graceful close stalls

---

## Multimodal support

The bridge handles images, video, audio, and documents inbound. `media.js` downloads and stores them locally, then passes metadata to the n8n payload so your workflow can decide what to do (call a vision LLM, transcribe audio, forward to a human, etc.).

Media files older than 24 hours are purged automatically on a cron.

```
/app/media/{tenantId}/{messageId}.{ext}
```

The `whatsapp_media` Docker volume is shared between the Baileys container and n8n, so n8n workflows can read files directly without HTTP round-trips.

---

## HTTP API (Baileys bridge)

### `GET /health`
Docker healthcheck endpoint. Returns 200 if the process is alive and Redis responds to PING. Never blocks on WhatsApp connection state.

```json
{ "status": "ok", "redis": "connected", "uptime": 3721.4 }
```

### `GET /health/whatsapp`
Full readiness check. Returns 200 when WhatsApp is connected, 503 otherwise.

```json
{
  "status": "connected",
  "tenantId": "default",
  "uptime": 3721.4,
  "session": { "id": "2347089374804:5@s.whatsapp.net", "name": "Seun BK" },
  "lock": { "held": true, "instanceId": "abc123", "key": "baileys:session:lock:default" },
  "queue": {
    "pendingOutbound": 0,
    "totalDispatched": 142,
    "currentRatePerMin": 3,
    "dlqPending": 0
  }
}
```

**Status values:** `connected` | `waiting_for_qr` | `disconnected`

### `GET /qr`
Returns the current QR string if the session needs pairing. Returns 200+connected if already linked.

### `POST /send`
Enqueue an outbound message. Goes through the anti-ban queue — it will not send immediately.

```json
// Request
{ "to": "2347012345678@s.whatsapp.net", "text": "Your order is confirmed." }

// Response (202 — queued, not yet sent)
{ "queued": true, "position": 1, "estimatedDelaySec": 3.1 }
```

---

## Inbound webhook contract

When the debounce window closes, the bridge fires a `POST` to `N8N_WEBHOOK_URL` with this payload:

```json
{
  "tenantId": "default",
  "senderJid": "2347012345678@s.whatsapp.net",
  "pushName": "John",
  "timestamp": 1732271234567,
  "messages": [
    { "text": "Hello", "media": null },
    { "text": "Actually can I get a price list", "media": null }
  ],
  "media": {
    "type": "image",
    "mimeType": "image/jpeg",
    "localPath": "/app/media/default/ABC123.jpg",
    "caption": "Is this in stock?"
  }
}
```

If n8n returns non-2xx (or is unreachable), the payload goes into a Redis dead-letter queue (`baileys:dlq:{tenantId}`). A background worker retries the DLQ every 30 seconds.

---

## Multi-tenant setup

One instance = one WhatsApp account. To run multiple clients on the same host, copy the stack and change these two variables:

```bash
COMPOSE_PROJECT_NAME=client_b
TENANT_ID=client_b
BAILEYS_HOST_PORT=3001
N8N_HOST_PORT=5679
```

All Redis keys, volumes, and container names are namespaced by `COMPOSE_PROJECT_NAME` and `TENANT_ID`. They will not collide.

---

## Setup

**Prerequisites:** Docker + Docker Compose v2, Git.

```bash
git clone https://github.com/kujebe/whatsapp-agentic-rag.git
cd whatsapp-agentic-rag
cp .env.example .env
```

Edit `.env` — at minimum, set `REDIS_PASSWORD` to something you generated:

```bash
openssl rand -hex 32
```

Then:

```bash
docker compose up -d
docker compose logs -f baileys
```

Watch the logs until a QR code appears in the terminal. Scan it with WhatsApp on the phone that owns the number you want to use. Session credentials persist in the `baileys_auth` Docker volume — you only scan once unless the session is explicitly logged out.

Confirm it's up:

```bash
curl http://localhost:3000/health/whatsapp
```

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `whatsapp` | Namespaces all containers and volumes |
| `TENANT_ID` | `default` | Namespaces all Redis keys and media paths |
| `REDIS_PASSWORD` | — | Required. No default. |
| `DEBOUNCE_MS` | `3500` | Trailing-edge buffer window in milliseconds |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |
| `BAILEYS_HOST_PORT` | `3000` | Host port for the Baileys HTTP API |
| `N8N_HOST_PORT` | `5678` | Host port for n8n |
| `N8N_EXISTING_VOLUME` | `n8n_data` | External Docker volume for n8n data persistence |
| `N8N_PUBLIC_WEBHOOK_URL` | `http://localhost:5678/` | n8n's externally reachable URL |
| `GENERIC_TIMEZONE` | `Africa/Lagos` | Timezone for n8n cron nodes |

---

## Verification tests

Run the full acceptance suite against a live stack:

```bash
./scripts/test-layer2-pipeline.sh
```

17 tests covering: Redis connectivity, session lock acquisition and exclusivity, debounce buffering and stitching, outbound queue ordering, rate limiter, DLQ write and replay, media purge cron, health endpoint state machine, and graceful shutdown.

Manual spot-checks:

```bash
# 1. Health
curl -s http://localhost:3000/health/whatsapp | jq .

# 2. Send a test message (WhatsApp must be connected)
curl -s -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{"to":"YOUR_NUMBER@s.whatsapp.net","text":"ping"}'

# 3. Inspect DLQ
docker exec whatsapp-redis redis-cli -a "$REDIS_PASSWORD" \
  LLEN "baileys:dlq:default"

# 4. Session lock
docker exec whatsapp-redis redis-cli -a "$REDIS_PASSWORD" \
  GET "baileys:session:lock:default"
```

---

## Backup and restore

Non-blocking snapshot of the Baileys auth session (run any time, safe while connected):

```bash
./scripts/backup-baileys.sh
```

Disaster recovery restore (restores from latest `backups/` snapshot):

```bash
./scripts/restore-baileys.sh
```

Backups land in `backups/` as `.tar.gz` files. This directory is in `.gitignore` — never committed.

---

## Redis persistence

AOF enabled (`appendonly yes`, `appendfsync everysec`). Session lock keys use `volatile-lru` policy so Redis never evicts them under memory pressure — only TTL-keyed cache entries get dropped first. Maxmemory is set to 256MB with a hard limit of 384MB container memory.

---

## What's not here

- **Layer 3 (n8n workflows):** Intent routing, price lookups, swap intake, human handoff logic. That belongs in your n8n instance and is not part of this repo.
- **Multi-device linking:** The bridge runs as a single paired session. WhatsApp multi-device is supported by Baileys but this setup uses one phone number per stack.
- **Voice/video calls:** Not handled. The `messages.upsert` listener processes text and downloadable media only.
- **Outbound media:** The `/send` route accepts text only right now. Image/document sends are not wired yet.

---

## File structure

```
.
├── docker-compose.yml
├── .env.example
├── .gitignore
├── services/
│   └── baileys-bridge/
│       ├── Dockerfile
│       ├── package.json
│       └── src/
│           ├── server.js      # Express API + Baileys socket lifecycle
│           ├── lock.js        # Redis Lua distributed session lock
│           ├── debounce.js    # Trailing-edge buffer + DLQ + replay worker
│           ├── queue.js       # Outbound FIFO queue + anti-ban timing
│           └── media.js       # Multimodal download + 24h purge
└── scripts/
    ├── test-layer2-pipeline.sh   # 17-test acceptance suite
    ├── test-health.sh
    ├── verify-env.sh
    ├── backup-baileys.sh
    ├── restore-baileys.sh
    ├── migrate-n8n.sh
    └── rollback-n8n.sh
```

---

## Stack versions

- Baileys: `@whiskeysockets/baileys@6.7.9`
- Redis: `7.4-alpine`
- n8n: `2.23.4`
- Node.js: `20-alpine` (Baileys container)
