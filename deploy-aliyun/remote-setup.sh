#!/usr/bin/env bash
# Run on ECS as root after deploy-aliyun contents are at /root/panwatch-licai/
set -euo pipefail

APP=/root/panwatch-licai
HL=/root/health-ledger
NGINX_CTR=health-ledger-nginx-1
COMPOSE_FILE="$HL/docker-compose.yml"

cd "$APP"

echo "==> ensure external network health-ledger_default exists"
docker network inspect health-ledger_default >/dev/null

echo "==> docker compose build && up -d (panwatch)"
docker compose build
docker compose up -d

echo "==> install nginx conf into health-ledger deploy (compose mount source)"
mkdir -p "$HL/deploy" /var/www/certbot
cp -f "$APP/nginx/default.conf" "$HL/deploy/nginx-ssl.conf"

# Ensure certbot webroot is mounted into nginx (idempotent)
if [[ -f "$COMPOSE_FILE" ]] && ! grep -q '/var/www/certbot:/var/www/certbot' "$COMPOSE_FILE"; then
  echo "==> patch health-ledger compose to mount certbot webroot"
  python3 - <<'PY'
from pathlib import Path
p = Path("/root/health-ledger/docker-compose.yml")
text = p.read_text()
needle = "    volumes:\n"
idx = text.find("  nginx:")
if idx < 0:
    raise SystemExit("nginx service not found in compose")
# find volumes under nginx
rest = text[idx:]
v = rest.find("    volumes:\n")
if v < 0:
    raise SystemExit("nginx volumes not found")
insert_at = idx + v + len("    volumes:\n")
line = '      - /var/www/certbot:/var/www/certbot:ro\n'
if "/var/www/certbot:/var/www/certbot" not in text:
    text = text[:insert_at] + line + text[insert_at:]
    p.write_text(text)
    print("patched compose")
else:
    print("compose already has certbot mount")
PY
  echo "==> recreate nginx with new mount (brief blip)"
  (cd "$HL" && docker compose up -d nginx)
else
  echo "==> certbot mount already present or compose missing; docker cp conf only"
fi

echo "==> docker cp nginx conf into $NGINX_CTR (and ensure name)"
# container name may change after compose recreate
NGINX_CTR=$(docker ps --filter name=health-ledger-nginx --format '{{.Names}}' | head -1)
if [[ -z "$NGINX_CTR" ]]; then
  echo "ERROR: health-ledger nginx container not found" >&2
  docker ps
  exit 1
fi
docker cp "$APP/nginx/default.conf" "$NGINX_CTR:/etc/nginx/conf.d/default.conf"
docker exec "$NGINX_CTR" mkdir -p /var/www/certbot

echo "==> nginx -t && reload"
docker exec "$NGINX_CTR" nginx -t
docker exec "$NGINX_CTR" nginx -s reload

echo "==> wait for panwatch"
for i in $(seq 1 30); do
  if docker exec "$NGINX_CTR" wget -qO- http://panwatch:8000/api/health 2>/dev/null; then
    echo
    break
  fi
  if docker exec "$NGINX_CTR" curl -sf http://panwatch:8000/api/health 2>/dev/null; then
    echo
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "ERROR: panwatch health failed" >&2
    docker ps -a --filter name=panwatch
    docker logs panwatch --tail 80 || true
    exit 1
  fi
done

echo "==> docker ps"
docker ps --filter name=panwatch --filter name=health-ledger-nginx --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'

echo "==> remote-setup done"
