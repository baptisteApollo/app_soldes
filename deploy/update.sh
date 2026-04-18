#!/usr/bin/env bash
# =============================================================================
# Pulls latest from the configured branch and reloads services.
# Called by:
#   - manually:         sudo -u deploy bash deploy/update.sh
#   - the webhook:      deploy/webhook.js spawns this on every validated push
#
# Designed to be safe under concurrent triggers (flock).
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"

# shellcheck disable=SC1091
[[ -f deploy/.env ]] && set -a && . deploy/.env && set +a
BRANCH="${WEBHOOK_BRANCH:-claude/deploy-vercel-5TXlD}"

LOCK="/tmp/app_soldes-update.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "[update] another update is running, skipping"; exit 0; }

log() { printf "\033[1;34m[update]\033[0m %s\n" "$*"; }

log "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"

BEFORE="$(git rev-parse HEAD)"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  log "Already up to date ($AFTER) — nothing to do"
  exit 0
fi

log "Updated $BEFORE -> $AFTER"

# Only reinstall if the relevant lockfile changed
changed() { git diff --name-only "$BEFORE" "$AFTER" -- "$1" | grep -q .; }

if changed package-lock.json || changed package.json; then
  log "Root deps changed — npm ci"
  npm ci || npm install
fi
if changed server/package-lock.json || changed server/package.json; then
  log "Server deps changed — npm ci (server)"
  (cd server && (npm ci || npm install))
fi

# Rebuild the web bundle if anything in app/ or src/ changed
if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^(app|src|assets|app\.json|package(-lock)?\.json)'; then
  log "Frontend changed — rebuilding web bundle"
  npx expo export -p web
fi

log "Reloading pm2 processes"
pm2 reload deploy/ecosystem.config.js --update-env

log "Done."
