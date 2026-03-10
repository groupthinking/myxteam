#!/bin/sh
set -e

CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="$CONFIG_DIR/workspace"

# Step 1: Fix any root-owned directories on the persistent volume.
# This handles the case where a previous run created dirs as root.
# We run as root here and will drop to 'node' user before exec.
echo "[fly-entrypoint] Fixing volume permissions ..."
mkdir -p "$CONFIG_DIR"

# Ensure all required subdirectories exist and are owned by node:node.
# This prevents EACCES errors when the gateway tries to write device.json,
# session data, or workspace files inside the persistent volume.
for subdir in identity workspace sessions logs; do
  mkdir -p "$CONFIG_DIR/$subdir"
done

# Recursively fix ownership of the entire data volume so the node user
# can write to all subdirectories (identity/, workspace/, etc.).
chown -R node:node "$CONFIG_DIR" 2>/dev/null || true

# Step 2: Sync the bundled openclaw.json into the persistent volume.
# This ensures config changes from new deploys are picked up.
# Runtime state (SQLite DBs, OAuth tokens) lives in separate files
# inside the volume and is NOT affected by this overwrite.
echo "[fly-entrypoint] Syncing $CONFIG_FILE from bundled openclaw.json ..."
cp /app/openclaw.json "$CONFIG_FILE"
chown node:node "$CONFIG_FILE"

# Step 3: Sync the SOUL.md persona file into the agent workspace.
# SOUL.md defines the @milkxxman "Orchestrator" persona and is loaded
# as a bootstrap context file by the agent system prompt builder.
# We prepend a dynamic "Today's date" line so the agent always knows the
# current date without needing to call session_status.
CURRENT_DATE=$(LC_ALL=C date -u '+%B %d, %Y')  # locale-stable UTC date, e.g. "March 10, 2026"
echo "[fly-entrypoint] Syncing SOUL.md to $WORKSPACE_DIR (date: $CURRENT_DATE) ..."
{
  printf '<!-- auto-generated on deploy: do not edit manually -->\n'
  printf 'Today'"'"'s date: %s (UTC)\n\n' "$CURRENT_DATE"
  cat /app/milkxxman-soul.md
} > "$WORKSPACE_DIR/SOUL.md"
chown node:node "$WORKSPACE_DIR/SOUL.md"

# Note: The xAI API key is injected via models.providers.xai.apiKey in openclaw.json
# using ${XAI_API_KEY} env var substitution — no auth-profiles.json file write needed.

# Step 4: Drop privileges and exec the main process as 'node' user
echo "[fly-entrypoint] Starting gateway as node user ..."
exec gosu node "$@"
