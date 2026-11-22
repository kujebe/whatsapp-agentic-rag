#!/usr/bin/env bash
set -euo pipefail

if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

TARGET_VOLUME="${N8N_EXISTING_VOLUME:-n8n_data}"
echo "=== Emergency Rollback Engine [$TARGET_VOLUME] ==="

# 1. Stop Compose stack
echo "Stopping Compose services..."
docker compose down

# 2. Find latest backup for this volume
LATEST_BACKUP=$(ls -t ./backups/${TARGET_VOLUME}_backup_*.tar.gz 2>/dev/null | head -n 1 || true)
if [ -n "$LATEST_BACKUP" ]; then
    echo "Restoring $TARGET_VOLUME from $LATEST_BACKUP..."
    docker run --rm -i \
        -v "$TARGET_VOLUME":/data \
        alpine sh -c "rm -rf /data/* && tar xzf - -C /data" < "$LATEST_BACKUP"
    echo "✓ Restored $TARGET_VOLUME to pre-migration state."
else
    echo "No backup archive found in ./backups. Skipping volume restore."
fi

# 3. Restart original container if present
if docker ps -a --format '{{.Names}}' | grep -Eq "^n8n$"; then
    echo "Restarting original standalone n8n container..."
    docker start n8n
    echo "✓ Standalone n8n is back online on port 5678."
fi
