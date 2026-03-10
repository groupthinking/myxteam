#!/bin/sh
set -e

# Always sync the bundled openclaw.json into the persistent volume.
# This ensures config changes from new deploys are picked up.
# Runtime state (SQLite DBs, OAuth tokens) lives in separate files
# inside the volume and is NOT affected by this overwrite.
CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

mkdir -p "$CONFIG_DIR"

echo "[fly-entrypoint] Syncing $CONFIG_FILE from bundled openclaw.json ..."
cp /app/openclaw.json "$CONFIG_FILE"

# Hand off to the main process
exec "$@"
