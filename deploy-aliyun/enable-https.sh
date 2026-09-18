#!/usr/bin/env bash
# Optional: issue Let's Encrypt cert for gushiding.cn and enable 443 block.
# Requires: DNS A already pointing here; HTTP /.well-known/acme-challenge served.
set -euo pipefail

APP=/root/panwatch-licai
HL=/root/health-ledger
EMAIL="${CERTBOT_EMAIL:-admin@gushiding.cn}"

mkdir -p /var/www/certbot /root/health-ledger/deploy/certs/gushiding

if ! command -v certbot >/dev/null 2>&1; then
  if command -v apt-get >/dev/null; then
    apt-get update -y
    apt-get install -y certbot
  else
    echo "Install certbot first" >&2
    exit 1
  fi
fi

certbot certonly --webroot -w /var/www/certbot \
  -d gushiding.cn -d www.gushiding.cn \
  --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring

# Copy into health-ledger certs dir (separate from chaolemei)
cp -f /etc/letsencrypt/live/gushiding.cn/fullchain.pem "$HL/deploy/certs/gushiding/fullchain.pem"
cp -f /etc/letsencrypt/live/gushiding.cn/privkey.pem "$HL/deploy/certs/gushiding/privkey.pem"

# Uncomment HTTPS server block in nginx conf
python3 - <<'PY'
from pathlib import Path
p = Path("/root/panwatch-licai/nginx/default.conf")
text = p.read_text()
# naive: uncomment lines between gushiding HTTPS markers
out=[]
in_block=False
for line in text.splitlines(True):
    if "gushiding.cn HTTPS" in line:
        in_block=True
        out.append(line)
        continue
    if in_block:
        if line.startswith("# ----") and "gushiding" not in line:
            in_block=False
            out.append(line)
            continue
        if line.startswith("# "):
            out.append(line[2:])
        elif line.startswith("#"):
            out.append(line[1:] if len(line)>1 else line)
        else:
            out.append(line)
        # end when we hit closing of commented server - look for lone "# }"
        if line.strip() in ("# }", "#}"):
            in_block=False
        continue
    out.append(line)
p.write_text("".join(out))
print("uncommented HTTPS block")
PY

cp -f "$APP/nginx/default.conf" "$HL/deploy/nginx-ssl.conf"
NGINX_CTR=$(docker ps --filter name=health-ledger-nginx --format '{{.Names}}' | head -1)
docker cp "$APP/nginx/default.conf" "$NGINX_CTR:/etc/nginx/conf.d/default.conf"
# Ensure gushiding certs mounted — chaolemei uses /etc/nginx/certs; gushiding uses /etc/nginx/certs/gushiding
# deploy/certs is already mounted at /etc/nginx/certs, so gushiding/ subdir is enough.
docker exec "$NGINX_CTR" nginx -t
docker exec "$NGINX_CTR" nginx -s reload
echo "HTTPS enabled for gushiding.cn"
