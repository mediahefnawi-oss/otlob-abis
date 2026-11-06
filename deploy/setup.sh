#!/usr/bin/env bash
# One-shot installer for a fresh Ubuntu server. Safe to run again (it never overwrites existing secrets).
# Reads /root/otlob-settings.env (written by cloud-init.yaml, or by hand), then builds and starts everything.
set -euo pipefail

APP_DIR=/opt/otlob
SETTINGS=/root/otlob-settings.env
LOG() { echo "[otlob-setup] $*"; }

[ -f "$SETTINGS" ] || { echo "Missing $SETTINGS"; exit 1; }
set -a; . "$SETTINGS"; set +a

: "${OWNER_USERNAME:=owner}"
: "${OWNER_PHONE:?OWNER_PHONE is empty}"
: "${OWNER_PASSWORD:?OWNER_PASSWORD is empty}"
: "${CORS_ORIGINS:=https://otlob-abis-app.vercel.app}"
: "${VAPID_SUBJECT:=mailto:admin@example.com}"
DOMAIN="${DOMAIN:-}"

if [ "${#OWNER_PASSWORD}" -lt 10 ] || [ "$OWNER_PASSWORD" = "CHANGE-ME-TO-A-LONG-PASSWORD" ]; then
  echo "OWNER_PASSWORD must be changed and be at least 10 characters"; exit 1
fi
case "$OWNER_PASSWORD" in *[!A-Za-z0-9_.@!%^*+=-]*) echo "OWNER_PASSWORD may only contain letters, digits and _ . @ ! % ^ * + = -  (no spaces, quotes or \$)"; exit 1;; esac
case "$OWNER_PHONE" in 01[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "OWNER_PHONE must look like 01012345678"; exit 1;; esac

# ---- the server's own address -> a free HTTPS name (sslip.io) until a real domain is set ----
IP="$(curl -4fsS --max-time 10 https://api.ipify.org || curl -4fsS --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')"
if [ -n "$DOMAIN" ]; then API_HOST="$DOMAIN"; else API_HOST="${IP//./-}.sslip.io"; fi
LOG "public IP: $IP   API address: https://$API_HOST"

# ---- firewall: only SSH + web ----
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

# ---- code ----
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 --branch "${BRANCH:-main}" "${REPO_URL:-https://github.com/mediahefnawi-oss/otlob-abis.git}" "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only || true
fi
cd "$APP_DIR"

# ---- secrets (generated once, kept in /opt/otlob/.env, readable by root only) ----
if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
DB_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
OWNER_USERNAME=$OWNER_USERNAME
OWNER_PHONE=$OWNER_PHONE
OWNER_PASSWORD=$OWNER_PASSWORD
CORS_ORIGINS=$CORS_ORIGINS
VAPID_SUBJECT=$VAPID_SUBJECT
API_HOST=$API_HOST
EOF
  umask 022
  NEW_ENV=1
else
  # keep the secrets, only refresh the address / origins
  sed -i "s|^API_HOST=.*|API_HOST=$API_HOST|; s|^CORS_ORIGINS=.*|CORS_ORIGINS=$CORS_ORIGINS|" .env
  grep -q '^API_HOST=' .env || echo "API_HOST=$API_HOST" >> .env
  NEW_ENV=0
fi

# ---- phone (Android) notifications: optional Firebase file the owner puts at /root/firebase.json ----
if [ -f /root/firebase.json ]; then
  sed -i '/^FIREBASE_SERVICE_ACCOUNT=/d' .env
  echo "FIREBASE_SERVICE_ACCOUNT=$(jq -c . /root/firebase.json)" >> .env
fi

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.vps.yml)
LOG "building and starting (first time takes a few minutes)..."
"${COMPOSE[@]}" up -d --build db api

# ---- web-push keys (new server = new keys, generated once) ----
if ! grep -q '^VAPID_PUBLIC_KEY=.' .env; then
  KEYS="$("${COMPOSE[@]}" run --rm --no-deps api node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")"
  PUB="${KEYS%% *}"; PRIV="${KEYS##* }"
  sed -i '/^VAPID_PUBLIC_KEY=/d; /^VAPID_PRIVATE_KEY=/d' .env
  printf 'VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n' "$PUB" "$PRIV" >> .env
  "${COMPOSE[@]}" up -d --force-recreate api
fi

LOG "waiting for the API to be healthy..."
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:4000/api/health 2>/dev/null | grep -q '"ok":true'; then OKAPI=1; break; fi
  sleep 3
done
[ "${OKAPI:-0}" = 1 ] || { echo "API did not become healthy. Run:  docker compose --env-file /opt/otlob/.env -f /opt/otlob/deploy/docker-compose.vps.yml logs api"; exit 1; }

"${COMPOSE[@]}" up -d caddy

# ---- daily database backup (03:17 every night, keeps 14 days) ----
chmod +x deploy/*.sh
cat > /etc/cron.d/otlob-backup <<'EOF'
17 3 * * * root /opt/otlob/deploy/backup.sh >> /var/log/otlob-backup.log 2>&1
EOF

LOG "checking HTTPS (the certificate can take up to 2 minutes)..."
HTTPS_OK=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 8 "https://$API_HOST/api/health" 2>/dev/null | grep -q '"ok":true'; then HTTPS_OK=1; break; fi
  sleep 5
done

cat > /root/READY.txt <<EOF
Otlob Abis server
API address (use this as EXPO_PUBLIC_API_URL):  https://$API_HOST
Health check:                                   https://$API_HOST/api/health
HTTPS working now:                              $([ "$HTTPS_OK" = 1 ] && echo YES || echo "NOT YET - wait 2 minutes and open the health link")
Owner login:                                    phone $OWNER_PHONE (password as you set it)
Secrets file (do not share):                    /opt/otlob/.env
Backups folder:                                 /var/backups/otlob
EOF
cat /root/READY.txt
