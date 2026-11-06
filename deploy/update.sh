#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the API (data is kept). Run:  /opt/otlob/deploy/update.sh
set -euo pipefail
cd /opt/otlob
/opt/otlob/deploy/backup.sh || true
git pull --ff-only
docker compose --env-file .env -f deploy/docker-compose.vps.yml up -d --build api caddy
for i in $(seq 1 40); do
  docker compose --env-file .env -f deploy/docker-compose.vps.yml exec -T api wget -qO- http://127.0.0.1:4000/api/health 2>/dev/null | grep -q '"ok":true' && { echo "updated and healthy"; exit 0; }
  sleep 3
done
echo "API is not healthy after the update"; exit 1
