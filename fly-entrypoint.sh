#!/bin/sh
set -e

# Seed openclaw.json into the persistent volume on first boot.
# Subsequent deploys will NOT overwrite an existing config so that
# runtime-persisted state (e.g. refreshed OAuth tokens) is preserved.
CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[fly-entrypoint] Seeding $CONFIG_FILE from bundled openclaw.json ..."
  cp /app/openclaw.json "$CONFIG_FILE"
else
  echo "[fly-entrypoint] $CONFIG_FILE already exists — skipping seed."
fi

# Hand off to the main process
exec "$@"
