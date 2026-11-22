#!/usr/bin/env bash
set -euo pipefail

# Load environment if present
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-whatsapp}"
TARGET_VOLUME="${N8N_EXISTING_VOLUME:-n8n_data}"

echo "=== Layer 1: Zero-Traps Migration & Provisioning Engine [$PROJECT_NAME] ==="

# 1. Dual-mode volume check: Adopt existing OR auto-provision greenfield
if docker volume inspect "$TARGET_VOLUME" >/dev/null 2>&1; then
    echo "✓ Detected existing volume: '$TARGET_VOLUME'."
    
    # Check if a standalone container named 'n8n' is running on the host
    if docker ps --format '{{.Names}}' | grep -Eq "^n8n$"; then
        echo "Gracefully stopping standalone 'n8n' container (allowing WAL flush)..."
        docker stop -t 15 n8n
        docker update --restart=no n8n 2>/dev/null || true
        echo "✓ Standalone 'n8n' stopped safely."
    fi

    # Snapshot existing data using host stream (eliminates Docker Desktop macOS bind mount stalls)
    mkdir -p ./backups
    BACKUP_FILE="./backups/${TARGET_VOLUME}_backup_$(date +%Y%m%d_%H%M%S).tar.gz"
    echo "Creating automated snapshot -> $BACKUP_FILE..."
    docker run --rm -v "$TARGET_VOLUME":/data:ro alpine tar czf - -C /data . > "$BACKUP_FILE"
    echo "✓ Snapshot verified: $(ls -lh "$BACKUP_FILE" | awk '{print $5, $9}')"
else
    echo "Greenfield installation detected: Volume '$TARGET_VOLUME' does not exist."
    echo "Creating fresh volume '$TARGET_VOLUME' for $PROJECT_NAME..."
    docker volume create "$TARGET_VOLUME"
    echo "✓ Volume '$TARGET_VOLUME' provisioned."
fi

echo "=== Pre-Flight Complete: Ready for 'docker compose up -d' ==="
