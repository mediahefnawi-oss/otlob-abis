#!/usr/bin/env bash
# Nightly database backup (also safe to run by hand). Keeps the last 14 days.
set -euo pipefail
cd /opt/otlob
DIR=/var/backups/otlob; mkdir -p "$DIR"
F="$DIR/otlob-$(date +%Y%m%d-%H%M).dump"
docker compose --env-file .env -f deploy/docker-compose.vps.yml exec -T db pg_dump -U otlob -Fc otlob > "$F.tmp"
[ -s "$F.tmp" ] || { echo "empty backup!"; rm -f "$F.tmp"; exit 1; }
mv "$F.tmp" "$F"
find "$DIR" -name 'otlob-*.dump' -mtime +14 -delete
echo "$(date -Is) backup ok: $F ($(du -h "$F" | cut -f1))"
