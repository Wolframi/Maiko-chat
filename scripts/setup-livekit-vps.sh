#!/usr/bin/env bash
# Self-hosted LiveKit on this VM (not LiveKit Cloud).
set -euo pipefail

APP_DIR="${APP_DIR:-/root/pulse-chat}"
LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.8.4}"
CHAT_HOST="${CHAT_HOST:-193.233.247.171.sslip.io}"
# Browser connects through the same nginx vhost: wss://$CHAT_HOST/livekit
LIVEKIT_PUBLIC_URL="${LIVEKIT_PUBLIC_URL:-wss://${CHAT_HOST}/livekit}"
TURN_HOST="${TURN_HOST:-${CHAT_HOST}}"

mkdir -p "$APP_DIR"
if [[ ! -s "$APP_DIR/.turn-user" || ! -s "$APP_DIR/.turn-pass" ]]; then
  echo "Missing $APP_DIR/.turn-user or $APP_DIR/.turn-pass" >&2
  exit 1
fi
if [[ ! -s "$APP_DIR/.livekit-api-key" ]]; then
  printf 'lk_%s\n' "$(openssl rand -hex 12)" > "$APP_DIR/.livekit-api-key"
fi
if [[ ! -s "$APP_DIR/.livekit-api-secret" ]]; then
  openssl rand -hex 32 > "$APP_DIR/.livekit-api-secret"
fi
printf '%s\n' "$LIVEKIT_PUBLIC_URL" > "$APP_DIR/.livekit-url"
chmod 600 "$APP_DIR"/.livekit-*

API_KEY="$(tr -d '\r\n' < "$APP_DIR/.livekit-api-key")"
API_SECRET="$(tr -d '\r\n' < "$APP_DIR/.livekit-api-secret")"
TURN_USER="$(tr -d '\r\n' < "$APP_DIR/.turn-user")"
TURN_PASS="$(tr -d '\r\n' < "$APP_DIR/.turn-pass")"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL \
  "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" \
  -o "$tmp_dir/livekit.tgz"
tar -xzf "$tmp_dir/livekit.tgz" -C "$tmp_dir"
install -m 0755 "$tmp_dir/livekit-server" /usr/local/bin/livekit-server

cat > "$APP_DIR/.livekit-server.yaml" <<EOF
port: 7880
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
  turn_servers:
    - host: ${TURN_HOST}
      port: 3478
      protocol: udp
      username: "${TURN_USER}"
      credential: "${TURN_PASS}"
    - host: ${TURN_HOST}
      port: 5349
      protocol: tls
      username: "${TURN_USER}"
      credential: "${TURN_PASS}"
keys:
  "${API_KEY}": "${API_SECRET}"
room:
  empty_timeout: 300
  departure_timeout: 20
  max_participants: 12
logging:
  level: info
EOF
chmod 600 "$APP_DIR/.livekit-server.yaml"

cat > /etc/systemd/system/livekit.service <<EOF
[Unit]
Description=LiveKit SFU (self-hosted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/livekit-server --config ${APP_DIR}/.livekit-server.yaml
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /etc/nginx/snippets
cat > /etc/nginx/snippets/pulse-livekit.conf <<'EOF'
# Include inside the Pulse HTTPS server { } that already terminates TLS.
location /livekit/ {
    proxy_pass http://127.0.0.1:7880/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
EOF

if [[ -f /etc/nginx/sites-available/pulse-chat ]]; then
  if ! grep -q 'snippets/pulse-livekit.conf' /etc/nginx/sites-available/pulse-chat; then
    echo "Add inside the Pulse HTTPS server block:" >&2
    echo "    include snippets/pulse-livekit.conf;" >&2
  fi
fi

systemctl daemon-reload
systemctl enable --now livekit
sleep 2
systemctl --no-pager --full status livekit || true
curl -fsS "http://127.0.0.1:7880" >/dev/null
echo "LiveKit is local on this VM. Public WS: ${LIVEKIT_PUBLIC_URL}"
echo "Include /etc/nginx/snippets/pulse-livekit.conf in the Pulse HTTPS site, then nginx -t && systemctl reload nginx"
