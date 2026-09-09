#!/bin/bash
# Install Docker + Portainer and link /root/pulse-chat to GitHub.
# Run on the VPS as root. Does not wipe data/uploads or LiveKit secrets.
set -euo pipefail

REPO_HTTPS="${REPO_HTTPS:-https://github.com/Wolframi/pulse-chat.git}"
APP_DIR="${APP_DIR:-/root/pulse-chat}"
KEEP_DIR="${KEEP_DIR:-/root/pulse-keep}"
DEPLOY_KEY="${DEPLOY_KEY:-/root/.ssh/pulse-chat-github}"

export DEBIAN_FRONTEND=noninteractive

if ! swapon --show | grep -q .; then
  echo "Creating 2G swap"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi

apt-get update -y
apt-get install -y git curl ca-certificates gnupg

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker ps --format '{{.Names}}' | grep -qx portainer; then
  docker volume create portainer_data >/dev/null
  docker run -d \
    --name portainer \
    --restart=always \
    -p 9443:9443 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v portainer_data:/data \
    portainer/portainer-ce:lts
fi

mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -f "$DEPLOY_KEY" ]; then
  ssh-keygen -t ed25519 -f "$DEPLOY_KEY" -N "" -C "pulse-chat-vps"
fi
touch /root/.ssh/known_hosts
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null || true
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts

mkdir -p "$KEEP_DIR"
if [ -d "$APP_DIR" ]; then
  for f in data uploads ecosystem.config.cjs .livekit-url .livekit-api-key .livekit-api-secret .livekit-server.yaml .turn-user .turn-pass; do
    if [ -e "$APP_DIR/$f" ]; then
      rm -rf "$KEEP_DIR/$(basename "$f")"
      cp -a "$APP_DIR/$f" "$KEEP_DIR/"
    fi
  done
fi

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "${APP_DIR}.old"
  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "${APP_DIR}.old"
  fi
  GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes" \
    git clone "$REPO_HTTPS" "$APP_DIR" || git clone "$REPO_HTTPS" "$APP_DIR"
else
  cd "$APP_DIR"
  git remote set-url origin "$REPO_HTTPS" || git remote add origin "$REPO_HTTPS"
  GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes" \
    git fetch origin || git fetch origin
  git checkout -f master
  git pull --ff-only origin master || true
fi

for f in data uploads ecosystem.config.cjs .livekit-url .livekit-api-key .livekit-api-secret .livekit-server.yaml .turn-user .turn-pass; do
  if [ -e "$KEEP_DIR/$(basename "$f")" ]; then
    rm -rf "$APP_DIR/$f"
    cp -a "$KEEP_DIR/$(basename "$f")" "$APP_DIR/$f"
  fi
done

mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"
chmod +x "$APP_DIR/scripts/server-update.sh" || true

echo "=== deploy public key (add as GitHub deploy key, read-only) ==="
cat "${DEPLOY_KEY}.pub"
echo "=== portainer ==="
echo "https://$(hostname -I | awk '{print $1}'):9443"
