#!/bin/bash
# Run via Yandex Serial Console as root (or with sudo).
# Forces SSH access for ubuntu with the known local pubkey, then prints status.

set -euo pipefail
PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICz0eofywVCcC3DBGvdQSu18UFdndKpP7N613dyhUij/ artem@DESKTOP-19MEOBT'
USER_HOME=/home/ubuntu

if ! id ubuntu >/dev/null 2>&1; then
  useradd -m -s /bin/bash ubuntu
  usermod -aG sudo ubuntu
  echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/ubuntu
fi

mkdir -p "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/.ssh"
touch "$USER_HOME/.ssh/authorized_keys"
chmod 600 "$USER_HOME/.ssh/authorized_keys"
grep -qxF "$PUB" "$USER_HOME/.ssh/authorized_keys" || echo "$PUB" >>"$USER_HOME/.ssh/authorized_keys"
chown -R ubuntu:ubuntu "$USER_HOME/.ssh"

sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

echo "--- authorized_keys ---"
cat "$USER_HOME/.ssh/authorized_keys"
echo "--- done: try ssh -i id_ed25519 ubuntu@PUBLIC_IP ---"
