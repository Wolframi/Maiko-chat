#!/usr/bin/env bash
# Coturn for Pulse 1:1 calls. Run on the VPS as a sudoer.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/artem/pulse-chat}"
TURN_HOST="${TURN_HOST:-158.160.159.79.sslip.io}"
PUBLIC_IP="${PUBLIC_IP:-158.160.159.79}"
CERT="/etc/letsencrypt/live/${TURN_HOST}/fullchain.pem"
PKEY="/etc/letsencrypt/live/${TURN_HOST}/privkey.pem"

if [[ ! -s "$APP_DIR/.turn-user" || ! -s "$APP_DIR/.turn-pass" ]]; then
  echo "Missing $APP_DIR/.turn-user or .turn-pass" >&2
  exit 1
fi

TURN_USER="$(tr -d '\r\n' < "$APP_DIR/.turn-user")"
TURN_PASS="$(tr -d '\r\n' < "$APP_DIR/.turn-pass")"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y coturn

sudo tee /etc/turnserver.conf >/dev/null <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=${PUBLIC_IP}
realm=${TURN_HOST}
server-name=${TURN_HOST}
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
min-port=49160
max-port=49200
EOF

if [[ -r "$CERT" && -r "$PKEY" ]]; then
  sudo tee -a /etc/turnserver.conf >/dev/null <<EOF
cert=${CERT}
pkey=${PKEY}
EOF
fi

sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
if ! grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn; then
  echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn >/dev/null
fi

if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 3478/udp || true
  sudo ufw allow 3478/tcp || true
  sudo ufw allow 5349/tcp || true
  sudo ufw allow 49160:49200/udp || true
fi

sudo systemctl enable --now coturn
sudo systemctl restart coturn
sleep 1
sudo systemctl --no-pager --full status coturn | head -20
ss -lptun | grep -E '3478|5349' || true
echo "coturn ready on ${TURN_HOST}:3478"
