#!/bin/sh
set -e

# Always sync the bundled openclaw.json into the persistent volume.
# This ensures config changes from new deploys are picked up.
# Runtime state (SQLite DBs, OAuth tokens) lives in separate files
# inside the volume and is NOT affected by this overwrite.
CONFIG_DIR="${OPENCLAW_STATE_DIR:-/data}"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
AGENT_DIR="$CONFIG_DIR/agents/main/agent"
AUTH_PROFILES="$AGENT_DIR/auth-profiles.json"

mkdir -p "$CONFIG_DIR"
mkdir -p "$AGENT_DIR"

echo "[fly-entrypoint] Syncing $CONFIG_FILE from bundled openclaw.json ..."
cp /app/openclaw.json "$CONFIG_FILE"

# Seed auth-profiles.json with xAI key on first boot (only if missing or empty key).
# The XAI_API_KEY env var is injected by Fly.io secrets at runtime.
if [ -n "$XAI_API_KEY" ]; then
  NEEDS_WRITE=false
  if [ ! -f "$AUTH_PROFILES" ]; then
    NEEDS_WRITE=true
  else
    # Check if the key is empty in the existing file
    CURRENT_KEY=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$AUTH_PROFILES','utf8'));console.log(d.profiles?.['xai:default']?.key??'')}catch(e){console.log('')}" 2>/dev/null || echo "")
    if [ -z "$CURRENT_KEY" ]; then
      NEEDS_WRITE=true
    fi
  fi

  if [ "$NEEDS_WRITE" = "true" ]; then
    echo "[fly-entrypoint] Writing xAI API key to $AUTH_PROFILES ..."
    node -e "
const fs = require('fs');
const profiles = {
  version: 1,
  profiles: {
    'xai:default': {
      type: 'api_key',
      provider: 'xai',
      key: process.env.XAI_API_KEY
    }
  }
};
fs.writeFileSync('$AUTH_PROFILES', JSON.stringify(profiles, null, 2));
console.log('[fly-entrypoint] auth-profiles.json written successfully.');
"
  else
    echo "[fly-entrypoint] auth-profiles.json already has xAI key, skipping."
  fi
else
  echo "[fly-entrypoint] WARNING: XAI_API_KEY not set, skipping auth-profiles.json seed."
fi

# Hand off to the main process
exec "$@"
