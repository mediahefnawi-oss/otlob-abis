#!/usr/bin/env bash
# Copy ALL the data from the Neon database into this server's database. Run once, BEFORE real customers use the new server:
#   /opt/otlob/deploy/migrate-from-neon.sh
# It asks for the Neon connection string (typed/pasted here on the server, never sent anywhere else).
set -euo pipefail
cd /opt/otlob
COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.vps.yml)
DUMP_DIR=/root/migrate; mkdir -p "$DUMP_DIR"; chmod 700 "$DUMP_DIR"
DUMP="$DUMP_DIR/neon-$(date +%Y%m%d-%H%M).dump"

echo "Paste the Neon connection string (it starts with postgresql://) and press Enter. Nothing will be shown while you paste."
read -r -s NEON_URL; echo
case "$NEON_URL" in postgres://*|postgresql://*) ;; *) echo "That does not look like a connection string"; exit 1;; esac

echo "1/5  Making a full copy of the Neon database..."
docker run --rm -e NEON_URL="$NEON_URL" -v "$DUMP_DIR":/out postgres:16 \
  sh -c 'pg_dump "$NEON_URL" -Fc --no-owner --no-acl --no-publications --no-subscriptions -N "reset_backup_*" -f /out/'"$(basename "$DUMP")"
unset NEON_URL
[ -s "$DUMP" ] || { echo "The copy is empty. Stopping, nothing was changed."; exit 1; }
echo "     copy saved: $DUMP ($(du -h "$DUMP" | cut -f1))"

echo
echo "This will REPLACE everything in the new server's database with the Neon copy."
read -r -p "Type  yes  to continue: " A
[ "$A" = "yes" ] || { echo "Cancelled. Nothing was changed."; exit 0; }

echo "2/5  Stopping the API..."
"${COMPOSE[@]}" stop api
echo "3/5  Preparing an empty database..."
"${COMPOSE[@]}" exec -T db psql -U otlob -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS otlob WITH (FORCE)" -c "CREATE DATABASE otlob OWNER otlob"
echo "4/5  Loading the data..."
"${COMPOSE[@]}" exec -T db pg_restore -U otlob -d otlob --no-owner --no-acl < "$DUMP" 2> "$DUMP_DIR/restore-errors.txt" || true
ERRS=$(grep -c . "$DUMP_DIR/restore-errors.txt" || true)
echo "     messages during loading: $ERRS (see $DUMP_DIR/restore-errors.txt)"
echo "5/5  Starting the API and checking the numbers..."
"${COMPOSE[@]}" up -d api
for i in $(seq 1 60); do
  "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:4000/api/health 2>/dev/null | grep -q '"ok":true' && break; sleep 3
done
"${COMPOSE[@]}" exec -T db psql -U otlob -d otlob -c "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM providers) AS providers, (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM orders) AS orders"
echo "Done. The copy file stays in $DUMP_DIR as a safety net."
