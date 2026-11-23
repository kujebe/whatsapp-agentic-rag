#!/usr/bin/env bash
# ==============================================================================
# Multi-Tenant Provisioning Script for whatsapp-n8n
# Creates an isolated client environment with dedicated Redis, Baileys, and n8n
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TENANT_ID="${1:-}"
BAILEYS_PORT="${2:-}"
N8N_PORT="${3:-}"
BRAND_NAME="${4:-${TENANT_ID}}"
SALES_REP_JID="${5:-}"

if [[ -z "${TENANT_ID}" || -z "${BAILEYS_PORT}" || -z "${N8N_PORT}" ]]; then
  echo "Usage: $0 <tenant_id> <baileys_port> <n8n_port> [brand_name] [sales_rep_jid]"
  echo "Example: $0 gadgethub 3001 5679 \"Gadget Hub\" \"2348012345678@s.whatsapp.net\""
  exit 1
fi

# Sanitize tenant ID (lowercase alphanumeric and underscore/hyphen only)
if [[ ! "${TENANT_ID}" =~ ^[a-z0-9_-]+$ ]]; then
  echo "Error: tenant_id must be lowercase alphanumeric with optional dashes/underscores."
  exit 1
fi

CLIENT_DIR="${ROOT_DIR}/clients/${TENANT_ID}"
CLIENT_DATA_DIR="${CLIENT_DIR}/data"

echo "==> Setting up new tenant: ${TENANT_ID} (${BRAND_NAME})"

mkdir -p "${CLIENT_DATA_DIR}"

# 1. Generate client-specific config.json
CONFIG_FILE="${CLIENT_DATA_DIR}/config.json"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  cat <<EOF > "${CONFIG_FILE}"
{
  "tenantId": "${TENANT_ID}",
  "brandName": "${BRAND_NAME}",
  "supportPhone": "+2340000000000",
  "businessHours": "Monday to Saturday, 9am to 6pm",
  "salesRepJid": "${SALES_REP_JID}",
  "websiteUrl": "https://example.com",
  "currencySymbol": "₦",
  "currencyCode": "NGN"
}
EOF
  echo "  [+] Created ${CONFIG_FILE}"
else
  echo "  [*] ${CONFIG_FILE} already exists. Skipping."
fi

# 2. Copy starter catalog and faq if missing
if [[ ! -f "${CLIENT_DATA_DIR}/catalog.json" ]]; then
  cp "${ROOT_DIR}/clients/template/data/catalog.json" "${CLIENT_DATA_DIR}/catalog.json"
  echo "  [+] Created starter catalog.json"
fi

if [[ ! -f "${CLIENT_DATA_DIR}/faq.json" && -f "${ROOT_DIR}/clients/template/data/faq.json" ]]; then
  cp "${ROOT_DIR}/clients/template/data/faq.json" "${CLIENT_DATA_DIR}/faq.json"
  echo "  [+] Created starter faq.json"
fi

# 3. Generate client-specific .env
CLIENT_ENV="${CLIENT_DIR}/.env"
REDIS_PW=$(openssl rand -hex 16)

cat <<EOF > "${CLIENT_ENV}"
# ==============================================================================
# Isolated Stack Configuration for Tenant: ${TENANT_ID}
# ==============================================================================
COMPOSE_PROJECT_NAME=whatsapp_${TENANT_ID}
TENANT_ID=${TENANT_ID}

# Dedicated Ports
BAILEYS_HOST_PORT=${BAILEYS_PORT}
N8N_HOST_PORT=${N8N_PORT}

# Isolated Storage & Redis Security
N8N_EXISTING_VOLUME=whatsapp_${TENANT_ID}_n8n_data
REDIS_PASSWORD=${REDIS_PW}

# Inbound Debounce Window (ms)
DEBOUNCE_MS=3500
LOG_LEVEL=info

# n8n External Webhook URL
N8N_PUBLIC_WEBHOOK_URL=http://localhost:${N8N_PORT}/
GENERIC_TIMEZONE=Africa/Lagos

# Client Assets inside container
TENANT_CONFIG_PATH=/data/clients/${TENANT_ID}/data/config.json
TENANT_CATALOG_PATH=/data/clients/${TENANT_ID}/data/catalog.json
TENANT_FAQ_PATH=/data/clients/${TENANT_ID}/data/faq.json
SALES_REP_JID=${SALES_REP_JID}
EOD_CRON_WAT="0 19 * * 1-6"
EOF

echo "  [+] Created ${CLIENT_ENV}"

echo ""
echo "========================================================================"
echo " Tenant [${TENANT_ID}] Provisioned Successfully!"
echo "========================================================================"
echo "To start this isolated stack (dedicated Redis, Baileys, and n8n):"
echo ""
echo "  docker compose --env-file clients/${TENANT_ID}/.env -p whatsapp_${TENANT_ID} up -d"
echo ""
echo "To view QR pairing code for this tenant:"
echo "  docker logs -f whatsapp_${TENANT_ID}-baileys"
echo ""
echo "Ports allocated:"
echo "  - Baileys API: http://localhost:${BAILEYS_PORT}"
echo "  - n8n Editor:  http://localhost:${N8N_PORT}"
echo "========================================================================"
