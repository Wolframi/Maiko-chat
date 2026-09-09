#!/bin/bash
# Pull Pulse Chat from GitHub and restart PM2. Safe for data/uploads/secrets.
set -euo pipefail
APP_DIR="${APP_DIR:-/root/pulse-chat}"
cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "Not a git checkout: $APP_DIR" >&2
  exit 1
fi

git fetch origin
git checkout master
git pull --ff-only origin master

mkdir -p data uploads
npm ci
SEED_DEMO=0 NEXT_PUBLIC_DEMO=0 npm run build

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
systemctl enable --now livekit >/dev/null 2>&1 || true

sleep 3
curl -fsS http://127.0.0.1:3000/api/health
echo
curl -fsS http://127.0.0.1:3000/api/health/livekit || true
echo
pm2 status pulse-chat
