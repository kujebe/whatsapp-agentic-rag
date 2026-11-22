#!/usr/bin/env bash
# ==============================================================================
# Disaster Recovery Restore Engine for WhatsApp Baileys Auth Session
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

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path_to_backup_tar_gz>"
  echo "Available backups:"
  ls -lh ./backups/*_baileys_auth_*.tar.gz 2>/dev/null || echo "No backups found."
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Error: Backup file '${BACKUP_FILE}' not found."
  exit 1
fi

echo "Stopping '${PROJECT_NAME}-baileys' before restoring session..."
docker stop -t 10 "${PROJECT_NAME}-baileys" 2>/dev/null || true

echo "Restoring ${BACKUP_FILE} into ${AUTH_VOLUME}..."
docker run --rm -v "${AUTH_VOLUME}":/data -i alpine sh -c "rm -rf /data/* && tar xzf - -C /data" < "${BACKUP_FILE}"

echo "Starting '${PROJECT_NAME}-baileys'..."
docker start "${PROJECT_NAME}-baileys"

echo -e "\033[0;32m✓ Baileys Auth Session restored successfully from:\033[0m ${BACKUP_FILE}"
