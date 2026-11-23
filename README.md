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
  "event": "messages.aggregated",
  "tenantId": "default",
  "sender": "2347012345678@s.whatsapp.net",
  "phone": "2347012345678",
  "pushName": "John",
  "messageCount": 2,
  "stitchedText": "Hello\nActually can I get a price list",
  "quotedText": "Can I see your catalog?",
  "quotedContext": {
    "quotedText": "Can I see your catalog?",
    "quotedParticipant": "2347012345678@s.whatsapp.net"
  },
  "hasMedia": false,
  "mediaItems": [],
  "dispatchedAt": 1732271234567
}
```

If n8n returns non-2xx (or is unreachable), the payload goes into a Redis dead-letter queue (`whatsapp:{tenantId}:dlq:messages`). A background worker retries the DLQ every 30 seconds.

---

## Multi-tenant setup & client provisioning

Each client runs an **isolated stack**: dedicated Redis instance, Baileys session, and n8n runner. Containers, networks, volumes, and ports never collide.

### 1. Provision a new client in one command

```bash
./scripts/create-tenant.sh <tenant_id> <baileys_port> <n8n_port> [brand_name] [sales_rep_jid]

# Example:
./scripts/create-tenant.sh gadgethub 3001 5679 "Gadget Hub" "2348012345678@s.whatsapp.net"
```

This creates `clients/<tenant_id>/` with:
- `clients/<tenant_id>/data/config.json`: Client identity, phone, hours, and sales rep JID.
- `clients/<tenant_id>/data/catalog.json`: Starter product inventory.
- `clients/<tenant_id>/.env`: Project-namespaced environment file with dedicated ports, isolated volumes, and a unique Redis password.

### 2. Client configuration schema (`config.json`)

All workflows dynamically read branding from `clients/<tenant_id>/data/config.json` via `$json.tenantId`:

```json
{
  "tenantId": "gadgethub",
  "brandName": "Gadget Hub",
  "supportPhone": "+2348012345678",
  "businessHours": "Monday to Saturday, 9am to 6pm",
  "salesRepJid": "2348012345678@s.whatsapp.net",
  "websiteUrl": "https://gadgethub.example.com",
  "currencySymbol": "₦",
  "currencyCode": "NGN"
}
```

### 3. Start the client's isolated stack

```bash
docker compose --env-file clients/gadgethub/.env -p whatsapp_gadgethub up -d
```

### 4. Link WhatsApp for the client

```bash
docker logs -f whatsapp_gadgethub-baileys
```

Scan the terminal QR code using WhatsApp on the phone assigned to that client. Session credentials persist in `whatsapp_gadgethub_baileys_auth`.

### 5. Inspecting client database in DB Browser for SQLite

Each client's workflows, credentials, and execution logs are stored in an isolated SQLite database inside their n8n container (`/home/node/.n8n/database.sqlite`).

To view and query a client's data with **DB Browser for SQLite**:

1. **Copy the database to your computer:**
   ```bash
   # For default / OgaBassey stack:
   docker cp whatsapp-n8n:/home/node/.n8n/database.sqlite ./ogabassey.sqlite

   # For a provisioned client (e.g. gadgethub):
   docker cp whatsapp_gadgethub-n8n:/home/node/.n8n/database.sqlite ./gadgethub.sqlite
   ```

2. **Open in DB Browser for SQLite:**
   * Launch **DB Browser for SQLite**.
   * Click **Open Database** and choose the downloaded file (`ogabassey.sqlite` or `gadgethub.sqlite`).
   * Primary tables to inspect:
     * `workflow_entity`: Workflow structure, active nodes, and settings.
     * `execution_entity`: Webhook payloads, runtime executions, and error states.
     * `credentials_entity`: Saved credentials (API keys, Redis settings).

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
| `TENANT_ID` | `default` | Namespaces all Redis keys, media paths, and client config |
| `TENANT_CONFIG_PATH` | `/data/clients/${TENANT_ID}/data/config.json` | Path to client branding, phone, and hours config |
| `SALES_REP_JID` | — | Sales rep WhatsApp JID for escalations and EOD reports |
| `REDIS_PASSWORD` | — | Required. No default. |
| `DEBOUNCE_MS` | `3500` | Trailing-edge buffer window in milliseconds |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |
| `BAILEYS_HOST_PORT` | `3000` | Host port for the Baileys HTTP API |
| `N8N_HOST_PORT` | `5678` | Host port for n8n |
| `N8N_EXISTING_VOLUME` | `${COMPOSE_PROJECT_NAME}_n8n_data` | Isolated Docker volume for n8n data persistence |
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
├── clients/
│   ├── ogabassey/             # Production client assets
│   │   ├── data/              # config.json, catalog.json, faq.json
│   │   └── workflows/         # Parameterized hybrid workflows
│   └── template/              # Starter client template
├── services/
│   └── baileys-bridge/
│       ├── Dockerfile
│       ├── package.json
│       └── src/
│           ├── server.js      # Express API + Baileys socket lifecycle + Quote context
│           ├── lock.js        # Redis Lua distributed session lock
│           ├── debounce.js    # Trailing-edge buffer + DLQ + Quote aggregation
│           ├── queue.js       # Outbound FIFO queue + anti-ban timing
│           └── media.js       # Multimodal download + 24h purge
└── scripts/
    ├── create-tenant.sh       # One-command client provisioning CLI
    ├── patch_nodes.py         # Workflow parameterization engine
    ├── test-layer2-pipeline.sh   # 17-test acceptance suite
    ├── test-health.sh
    ├── verify-env.sh
    ├── backup-baileys.sh
    └── restore-baileys.sh
```

---

## Stack versions

- Baileys: `@whiskeysockets/baileys@6.7.9`
- Redis: `7.4-alpine`
- n8n: `2.23.4`
- Node.js: `20-alpine` (Baileys container)
