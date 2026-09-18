#!/usr/bin/env bash
# Run on ECS as root after deploy-aliyun contents are at /root/panwatch-licai/
set -euo pipefail

APP=/root/panwatch-licai
HL=/root/health-ledger
NGINX_CTR=health-ledger-nginx-1

cd "$APP"

echo "==> docker compose build && up -d"
docker compose build
docker compose up -d

echo "==> install nginx conf (keep chaolemei certs)"
mkdir -p "$HL/deploy"
cp -f "$APP/nginx/default.conf" "$HL/deploy/nginx-ssl.conf"
# Also stage certbot webroot on host for later mount if needed
mkdir -p /var/www/certbot

# Ensure nginx container has acme webroot (docker cp dir into container)
docker exec "$NGINX_CTR" mkdir -p /var/www/certbot || true

echo "==> docker cp nginx conf into $NGINX_CTR"
docker cp "$APP/nginx/default.conf" "$NGINX_CTR:/etc/nginx/conf.d/default.conf"

echo "==> nginx -t && reload"
docker exec "$NGINX_CTR" nginx -t
docker exec "$NGINX_CTR" nginx -s reload

echo "==> health check panwatch from nginx container"
sleep 3
if docker exec "$NGINX_CTR" wget -qO- http://panwatch:8000/api/health 2>/dev/null; then
  echo
elif docker exec "$NGINX_CTR" curl -sS http://panwatch:8000/api/health; then
  echo
else
  echo "WARN: could not curl/wget panwatch health from nginx container" >&2
  docker ps --filter name=panwatch --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'
  exit 1
fi

echo "==> docker ps (panwatch + nginx)"
docker ps --filter name=panwatch --filter name=health-ledger-nginx --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'

echo "==> remote-setup done"
