#!/bin/bash
# Pull origin/master when it moved, then rebuild Pulse Chat.
# Installed to /usr/local/sbin so a git reset cannot remove it.
# Failed builds restore the previous commit; the live process is not reloaded.
set -euo pipefail

APP_DIR="${APP_DIR:-/root/pulse-chat}"
LOCK_FILE="${LOCK_FILE:-/var/lock/pulse-auto-update.lock}"
LOG_FILE="${LOG_FILE:-/var/log/pulse-auto-update.log}"
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

mkdir -p "$(dirname "$LOCK_FILE")" "$(dirname "$LOG_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -u +%FT%TZ) skip: deploy already running" >>"$LOG_FILE"
  exit 0
fi

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG_FILE"; }

build_app() {
  # npm run build, not next build: prebuild generates gitignored DTLN assets.
  SEED_DEMO=0 NEXT_PUBLIC_DEMO=0 npm run build
}

cd "$APP_DIR"
if [ ! -d .git ]; then
  log "error: not a git checkout: $APP_DIR"
  exit 1
fi

git fetch origin master
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/master)"

if [ "$FORCE" != 1 ] && [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

if [ "$FORCE" != 1 ] && ! git merge-base --is-ancestor HEAD origin/master; then
  log "skip: origin/master is not a fast-forward ($LOCAL -> $REMOTE)"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "skip: refusing to overwrite local tracked changes"
  exit 1
fi

if [ -f server.ts ] && git cat-file -e origin/master:site/server.ts 2>/dev/null; then
  log "skip: moving the live application into site/ requires a manual deployment"
  exit 1
fi

if grep -qs '^MONGODB_URI=' .env.local site/.env.local || [ -n "${MONGODB_URI:-}" ]; then
  if ! git cat-file -e origin/master:src/server/messageStore.ts 2>/dev/null && \
     ! git cat-file -e origin/master:site/src/server/messageStore.ts 2>/dev/null; then
    log "skip: incoming version does not support the migrated MongoDB message store"
    exit 0
  fi
fi

log "updating $LOCAL -> $REMOTE"
git checkout -f master
git reset --hard origin/master
git clean -fd \
  --exclude=data \
  --exclude=uploads \
  --exclude=public/audio \
  --exclude=.env \
  --exclude=.s3-storage.json \
  --exclude=.giphy-api-key \
  --exclude=.deepgram-api-key \
  --exclude=.deepgram-keyterms \
  --exclude=.groq-api-key \
  --exclude=.groq-proxy-url \
  --exclude=.groq-bridge-secret \
  --exclude=.groq-egress-proxy \
  --exclude=.livekit-url \
  --exclude=.livekit-api-key \
  --exclude=.livekit-api-secret \
  --exclude=.livekit-server.yaml \
  --exclude=.turn-user \
  --exclude=.turn-pass

mkdir -p data uploads
npm ci
if ! build_app; then
  log "build failed, restoring $LOCAL"
  git reset --hard "$LOCAL"
  npm ci
  exit 1
fi

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
systemctl enable --now livekit >/dev/null 2>&1 || true
sleep 3
curl -fsS http://127.0.0.1:3000/api/health | tee -a "$LOG_FILE"
echo | tee -a "$LOG_FILE"
curl -fsS http://127.0.0.1:3000/api/health/livekit | tee -a "$LOG_FILE" || true
echo | tee -a "$LOG_FILE"
log "done $(git rev-parse --short HEAD)"
