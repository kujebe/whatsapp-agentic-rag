#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-whatsapp}"
SERVICES=("${PROJECT_NAME}-redis" "${PROJECT_NAME}-baileys" "${PROJECT_NAME}-n8n")

echo "=== Layer 1: Multi-Tenant Health Verification [$PROJECT_NAME] ==="

for SVC in "${SERVICES[@]}"; do
    echo -n "Checking $SVC status... "
    STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$SVC" 2>/dev/null || echo "unhealthy")
    if [ "$STATUS" != "healthy" ]; then
        echo "FAILED: $SVC is $STATUS"
        exit 1
    fi
    echo "OK ($STATUS)"
done

echo -n "Testing Baileys -> Redis connectivity... "
docker exec "${PROJECT_NAME}-baileys" wget -qO- http://127.0.0.1:3000/health | grep -q "ok"
echo "OK"

echo -n "Testing n8n healthz endpoint... "
docker exec "${PROJECT_NAME}-n8n" wget -qO- http://127.0.0.1:5678/healthz | grep -q "ok"
echo "OK"

echo "=== Layer 1 Acceptance Tests: ALL PASSED ==="
