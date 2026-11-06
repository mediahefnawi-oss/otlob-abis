#!/usr/bin/env bash
# When the domain is bought and its DNS (an A record, e.g. api.otlobabis.com -> this server's IP) is set:
#   /opt/otlob/deploy/set-domain.sh api.otlobabis.com
set -euo pipefail
D="${1:?usage: set-domain.sh api.yourdomain.com}"
cd /opt/otlob
sed -i "s|^API_HOST=.*|API_HOST=$D|" .env
sed -i "/^DOMAIN=/d" /root/otlob-settings.env; echo "DOMAIN=$D" >> /root/otlob-settings.env
docker compose --env-file .env -f deploy/docker-compose.vps.yml up -d --force-recreate caddy
echo "Wait a minute, then open https://$D/api/health"
