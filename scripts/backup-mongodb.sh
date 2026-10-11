#!/bin/bash
set -euo pipefail
umask 077
APP_DIR="${APP_DIR:-/root/pulse-chat}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/maiko-mongodb-daily}"
CONTAINER="${MONGODB_CONTAINER:-maiko-mongodb}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/$stamp.mongo.archive.gz"
docker exec "$CONTAINER" sh -c 'exec mongodump --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db maiko --archive --gzip' > "$archive.tmp"
test -s "$archive.tmp"
mv "$archive.tmp" "$archive"
tar -czf "$BACKUP_DIR/$stamp.data.tgz" -C "$APP_DIR" data
echo "MongoDB and application data backed up: $stamp"
