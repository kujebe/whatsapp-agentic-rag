#!/usr/bin/env bash
set -euo pipefail

echo "=== Layer 1: Environment Schema Validator ==="

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env file missing. Run 'cp .env.example .env' and populate variables."
    exit 1
fi

REQUIRED_VARS=(
    "COMPOSE_PROJECT_NAME"
    "N8N_HOST_PORT"
    "BAILEYS_HOST_PORT"
    "N8N_EXISTING_VOLUME"
    "REDIS_PASSWORD"
    "DEBOUNCE_MS"
    "LOG_LEVEL"
    "N8N_PUBLIC_WEBHOOK_URL"
    "GENERIC_TIMEZONE"
)

MISSING=0
for VAR in "${REQUIRED_VARS[@]}"; do
    # Extract value ignoring comments
    VAL=$(grep -E "^${VAR}=" "$ENV_FILE" | cut -d'=' -f2- | tr -d ' "' || true)
    if [ -z "$VAL" ]; then
        echo "FAIL: Required variable '$VAR' is missing or empty in .env"
        MISSING=$((MISSING + 1))
    else
        echo "OK: $VAR = $VAL"
    fi
done

# Validate REDIS_PASSWORD strength
REDIS_PW=$(grep -E "^REDIS_PASSWORD=" "$ENV_FILE" | cut -d'=' -f2- | tr -d ' "')
if [ "$REDIS_PW" = "change_me_super_secure_random_hex_32" ] || [ ${#REDIS_PW} -lt 16 ]; then
    echo "FAIL: REDIS_PASSWORD must not be the default placeholder and must be >= 16 chars."
    MISSING=$((MISSING + 1))
fi

# Validate numeric ports
N8N_PORT=$(grep -E "^N8N_HOST_PORT=" "$ENV_FILE" | cut -d'=' -f2- | tr -d ' "')
if ! [[ "$N8N_PORT" =~ ^[0-9]+$ ]] || [ "$N8N_PORT" -lt 1024 ] || [ "$N8N_PORT" -gt 65535 ]; then
    echo "FAIL: N8N_HOST_PORT must be a valid port number between 1024 and 65535."
    MISSING=$((MISSING + 1))
fi

if [ $MISSING -gt 0 ]; then
    echo "Validation failed with $MISSING error(s)."
    exit 1
fi

echo "=== .env Schema Validation: ALL CHECKS PASSED ==="
