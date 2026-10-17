#!/usr/bin/env bash
# Exposes local n8n to the internet and rewires WEBHOOK_URL to match.
#
# A quick tunnel gives a RANDOM trycloudflare.com URL that changes on every
# run, and it dies when the laptop sleeps. That is fine for recording a demo.
# It is NOT something to put in an application email as a live link.
set -euo pipefail
cd "$(dirname "$0")/.."

CLOUDFLARED="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
[[ -x "$CLOUDFLARED" ]] || { echo "cloudflared not found at $CLOUDFLARED — run scripts/install-cloudflared.sh"; exit 1; }

"$CLOUDFLARED" tunnel --url http://localhost:5678 --no-autoupdate 2>&1 \
| tee /tmp/jorip-tunnel.log &
TUNNEL_PID=$!

echo "waiting for the tunnel URL…"
URL=""
for _ in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/jorip-tunnel.log | head -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
[[ -n "$URL" ]] || { echo "tunnel did not come up — see /tmp/jorip-tunnel.log"; exit 1; }

echo
echo "public URL: $URL"
# Meta must be able to reach <URL>/webhook/whatsapp-in, and n8n must build
# that same absolute URL when it registers the webhook.
sed -i "s#^WEBHOOK_URL=.*#WEBHOOK_URL=$URL/#" .env
echo "wrote WEBHOOK_URL=$URL/ into .env — now: docker compose up -d n8n"
echo
wait "$TUNNEL_PID"
