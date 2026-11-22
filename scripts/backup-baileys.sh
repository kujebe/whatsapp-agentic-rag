#!/usr/bin/env bash
# ==============================================================================
# Non-Blocking Disaster Recovery Snapshot for WhatsApp Baileys Auth Session
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${WORKSPACE_DIR}"

if [ -f .env ]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs)
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-whatsapp}"
AUTH_VOLUME="${PROJECT_NAME}_baileys_auth"
BACKUP_DIR="./backups"

mkdir -p "${BACKUP_DIR}"

if ! docker volume inspect "${AUTH_VOLUME}" >/dev/null 2>&1; then
  echo "Error: Volume '${AUTH_VOLUME}' does not exist."
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/${AUTH_VOLUME}_backup_${TIMESTAMP}.tar.gz"

echo "Creating non-blocking snapshot of ${AUTH_VOLUME} -> ${BACKUP_FILE}..."
# Use host-stream to eliminate macOS bind mount stalls
docker run --rm -v "${AUTH_VOLUME}":/data:ro alpine tar czf - -C /data . > "${BACKUP_FILE}"

if [ -s "${BACKUP_FILE}" ]; then
  FILE_SIZE=$(ls -lh "${BACKUP_FILE}" | awk '{print $5}')
  echo -e "\033[0;32m✓ Baileys Auth Snapshot successfully created:\033[0m ${BACKUP_FILE} (${FILE_SIZE})"
else
  echo -e "\033[0;31m✗ Backup file is empty or failed to generate.\033[0m"
  exit 1
fi
