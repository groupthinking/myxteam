#!/bin/sh
set -e

CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"

# Step 1: Fix any root-owned directories on the persistent volume.
# This handles the case where a previous run created dirs as root.
# We run as root here and will drop to 'node' user before exec.
echo "[fly-entrypoint] Fixing volume permissions ..."
mkdir -p "$CONFIG_DIR"
chown node:node "$CONFIG_DIR" 2>/dev/null || true
# Recursively fix ownership of any directories that may have been created as root
find "$CONFIG_DIR" -not -user node -exec chown node:node {} + 2>/dev/null || true

# Step 2: Sync the bundled openclaw.json into the persistent volume.
# This ensures config changes from new deploys are picked up.
# Runtime state (SQLite DBs, OAuth tokens) lives in separate files
# inside the volume and is NOT affected by this overwrite.
echo "[fly-entrypoint] Syncing $CONFIG_FILE from bundled openclaw.json ..."
cp /app/openclaw.json "$CONFIG_FILE"
chown node:node "$CONFIG_FILE"

# Note: The xAI API key is injected via models.providers.xai.apiKey in openclaw.json
# using ${XAI_API_KEY} env var substitution — no auth-profiles.json file write needed.

# Step 3: Drop privileges and exec the main process as 'node' user
echo "[fly-entrypoint] Starting gateway as node user ..."
exec gosu node "$@"
