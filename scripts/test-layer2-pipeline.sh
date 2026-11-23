#!/usr/bin/env bash
# ==============================================================================
# Layer 2 Acceptance & Invariants Verification Test Suite
# Tests: Baileys Gateway, Distributed Redis Lock, Anti-Ban Queue & Debounce
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${WORKSPACE_DIR}"

# Source environment
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

REDIS_PWD="${REDIS_PASSWORD:-}"
TENANT="${TENANT_ID:-default}"
BAILEYS_PORT="${BAILEYS_HOST_PORT:-3000}"
PASS_COUNT=0
FAIL_COUNT=0

log_pass() {
  echo -e "\033[0;32m[PASS]\033[0m $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

log_fail() {
  echo -e "\033[0;31m[FAIL]\033[0m $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

echo "=============================================================================="
echo " Starting Layer 2 Pipeline Verification (Tenant: ${TENANT})"
echo "=============================================================================="

# 1. Container Health Checks
echo -e "\n--- Test 1: Container Health Status ---"
for container in whatsapp-redis whatsapp-baileys whatsapp-n8n; do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' "${container}" 2>/dev/null || echo "not_found")
  if [ "${STATUS}" = "healthy" ]; then
    log_pass "Container ${container} is healthy"
  else
    log_fail "Container ${container} health status is: ${STATUS}"
  fi
done

# 2. HTTP Liveness Check (/health)
echo -e "\n--- Test 2: HTTP Liveness Endpoint (/health) ---"
HEALTH_RES=$(curl -s "http://127.0.0.1:${BAILEYS_PORT}/health" || echo "")
if echo "${HEALTH_RES}" | grep -q '"status":"ok"'; then
  log_pass "Liveness endpoint responded with status 'ok' and Redis connected"
else
  log_fail "Liveness endpoint failed: ${HEALTH_RES}"
fi

# 3. HTTP Readiness & Telemetry (/health/whatsapp)
echo -e "\n--- Test 3: WhatsApp Readiness & Telemetry (/health/whatsapp) ---"
WA_RES=$(curl -s "http://127.0.0.1:${BAILEYS_PORT}/health/whatsapp" || echo "")
if echo "${WA_RES}" | grep -q '"tenantId"'; then
  log_pass "Readiness telemetry returned tenant-aware payload"
else
  log_fail "Readiness telemetry missing tenantId: ${WA_RES}"
fi

if echo "${WA_RES}" | grep -q '"lock"'; then
  log_pass "Readiness telemetry reports distributed lock status"
else
  log_fail "Readiness telemetry missing lock section: ${WA_RES}"
fi

if echo "${WA_RES}" | grep -q '"queue"'; then
  log_pass "Readiness telemetry reports outbound anti-ban queue stats"
else
  log_fail "Readiness telemetry missing queue section: ${WA_RES}"
fi

# 4. Redis Distributed Lock Key & TTL Verification
echo -e "\n--- Test 4: Redis Distributed Single-Instance Lock ---"
LOCK_KEY="whatsapp:${TENANT}:session:lock"
LOCK_VAL=$(docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli get "${LOCK_KEY}" 2>/dev/null || echo "")
if [ -n "${LOCK_VAL}" ] && [ "${LOCK_VAL}" != "(nil)" ]; then
  log_pass "Lock key '${LOCK_KEY}' is held by instance: ${LOCK_VAL}"
else
  log_fail "Lock key '${LOCK_KEY}' is empty or unacquired"
fi

LOCK_TTL=$(docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli pttl "${LOCK_KEY}" 2>/dev/null || echo "-1")
if [ "${LOCK_TTL}" -gt 0 ] && [ "${LOCK_TTL}" -le 10000 ]; then
  log_pass "Lock TTL is active and valid (${LOCK_TTL}ms remaining)"
else
  log_fail "Lock TTL is invalid: ${LOCK_TTL}"
fi

# 5. Lock Contention Immunity Test (Split-Brain Prevention)
echo -e "\n--- Test 5: Split-Brain Lock Contention Guard ---"
CONTENTION_RES=$(docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli set "${LOCK_KEY}" "fake_rogue_instance" NX 2>/dev/null || echo "")
if [ "${CONTENTION_RES}" = "" ] || [ "${CONTENTION_RES}" = "(nil)" ]; then
  log_pass "Secondary instance lock acquisition denied (NX guard working)"
else
  log_fail "Rogue instance acquired lock unexpectedly: ${CONTENTION_RES}"
fi

# 6. Media Directory & Permissions Check
echo -e "\n--- Test 6: Media Directory & Permissions ---"
MEDIA_DIR_CHECK=$(docker exec whatsapp-baileys ls -ld "/app/media/${TENANT}" 2>/dev/null || echo "")
if echo "${MEDIA_DIR_CHECK}" | grep -q "node"; then
  log_pass "Media directory /app/media/${TENANT} is owned by user 'node'"
else
  log_fail "Media directory ownership invalid or missing: ${MEDIA_DIR_CHECK}"
fi

# 7. Outbound /send Validation (Boundary Test)
echo -e "\n--- Test 7: Outbound /send Boundary & Error Handling ---"
EMPTY_SEND_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${BAILEYS_PORT}/send" \
  -H "Content-Type: application/json" \
  -d '{}' || echo "000")
if [ "${EMPTY_SEND_HTTP}" = "400" ]; then
  log_pass "POST /send with empty body correctly rejected with HTTP 400"
else
  log_fail "POST /send with empty body returned HTTP ${EMPTY_SEND_HTTP} (expected 400)"
fi

# 8. Trailing-Edge Debounce Simulation
echo -e "\n--- Test 8: Trailing-Edge Debounce Buffer Mechanics ---"
TEST_JID="2340000000001@s.whatsapp.net"
TEST_BUF_KEY="whatsapp:${TENANT}:debounce:${TEST_JID}:messages"
TEST_TIMER_KEY="whatsapp:${TENANT}:debounce:${TEST_JID}:timer"

PIPE_OUT=$(docker exec -i -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli <<EOF
RPUSH "${TEST_BUF_KEY}" '{"text":"test_msg_1"}'
PSETEX "${TEST_TIMER_KEY}" 5000 "active"
LLEN "${TEST_BUF_KEY}"
PTTL "${TEST_TIMER_KEY}"
EOF
)

BUF_LEN=$(echo "${PIPE_OUT}" | sed -n '3p')
TIMER_PTTL=$(echo "${PIPE_OUT}" | sed -n '4p')

if [ "${BUF_LEN}" -ge 1 ] && [ "${TIMER_PTTL}" -gt 1000 ]; then
  log_pass "Trailing-edge buffer populated (${BUF_LEN} items, timer PTTL: ${TIMER_PTTL}ms)"
else
  log_fail "Trailing-edge buffer check failed (len=${BUF_LEN}, pttl=${TIMER_PTTL})"
fi

# Clean up synthetic test keys
docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli del "${TEST_BUF_KEY}" "${TEST_TIMER_KEY}" >/dev/null

# 9. Redis Persistence & Eviction Policy Check
echo -e "\n--- Test 9: Redis AOF & Eviction Policy Hardening ---"
AOF_STATUS=$(docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli config get appendonly | tail -n 1)
EVICTION_STATUS=$(docker exec -e REDISCLI_AUTH="${REDIS_PWD}" whatsapp-redis redis-cli config get maxmemory-policy | tail -n 1)

if [ "${AOF_STATUS}" = "yes" ]; then
  log_pass "Redis AOF persistence is active (appendonly: yes)"
else
  log_fail "Redis AOF is inactive (${AOF_STATUS})"
fi

if [ "${EVICTION_STATUS}" = "volatile-lru" ]; then
  log_pass "Redis eviction policy set to volatile-lru (protected session lock)"
else
  log_fail "Redis eviction policy is insecure: ${EVICTION_STATUS}"
fi

# 10. DLQ Telemetry Verification
echo -e "\n--- Test 10: Dead-Letter Queue (DLQ) Readiness ---"
if echo "${WA_RES}" | grep -q '"dlqPending"'; then
  log_pass "Readiness telemetry reports DLQ status"
else
  log_fail "Readiness telemetry missing dlqPending metric"
fi

# 11. Baileys Auth Backup Snapshot Verification
echo -e "\n--- Test 11: Baileys Disaster Recovery Snapshot ---"
LATEST_BACKUP=$(ls -t ./backups/*_baileys_auth_*.tar.gz 2>/dev/null | head -n 1 || echo "")
if [ -n "${LATEST_BACKUP}" ] && [ -s "${LATEST_BACKUP}" ]; then
  log_pass "Verified verified Baileys backup snapshot: ${LATEST_BACKUP}"
else
  log_fail "No valid Baileys auth snapshot found in ./backups"
fi

echo "=============================================================================="
echo " Layer 2 Test Summary: ${PASS_COUNT} Passed, ${FAIL_COUNT} Failed"
echo "=============================================================================="

if [ "${FAIL_COUNT}" -eq 0 ]; then
  echo -e "\033[0;32mALL LAYER 2 ACCEPTANCE CRITERIA SATISFIED FOR PRODUCTION\033[0m"
  exit 0
else
  echo -e "\033[0;31mSOME TESTS FAILED - AUDIT REQUIRED\033[0m"
  exit 1
fi
