#!/usr/bin/env bash
# Exposes the BRAIN to the internet. Not n8n.
#
# This script used to tunnel http://localhost:5678 — n8n — and rewrite WEBHOOK_URL to the
# tunnel host. That was correct when n8n was the webhook receiver. It is now a hole:
# /webhook/jorip-pipeline authenticates nothing, so a public n8n is an open door for anyone to
# insert fake leads and book slots against the calendar. The edge that proves a POST came from
# Meta is core/inbound.mjs, and it runs in the brain on 8788. So 8788 is the only port this
# script publishes, n8n and Postgres stay on loopback, and WEBHOOK_URL stays internal.
#
# A quick tunnel gives a RANDOM trycloudflare.com URL that changes on every run and dies when
# the laptop sleeps. Fine for testing the handshake. NOT a live link for an application email —
# docs/TUNNEL.md and DEPLOY-VPS.md are the versions of that conversation you can act on.
set -euo pipefail
cd "$(dirname "$0")/.."

CLOUDFLARED="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
BRAIN_PORT="${JORIP_BRAIN_PORT:-8788}"
[[ -x "$CLOUDFLARED" ]] || { echo "cloudflared not found at $CLOUDFLARED — run scripts/install-cloudflared.sh"; exit 1; }

# Fail before starting anything, rather than handing back a URL that 502s on every delivery.
if ! curl -sf "http://127.0.0.1:${BRAIN_PORT}/healthz" >/dev/null; then
  echo "nothing answering on 127.0.0.1:${BRAIN_PORT} — start it first: docker compose up -d brain"
  exit 1
fi

"$CLOUDFLARED" tunnel --url "http://localhost:${BRAIN_PORT}" --no-autoupdate 2>&1 \
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

# Written down rather than sed-ed into .env: WEBHOOK_URL is n8n telling *itself* what its own
# callbacks are called, and on this path nothing external ever calls n8n. Changing it to the
# tunnel host would publish a surface this design keeps private, and rewrite the URL the brain
# uses to hand messages over.
cat <<EOF

public URL:              $URL        (brain only)
Meta callback URL:       $URL/whatsapp-in
  — the same path answers Meta's GET handshake, then receives the signed POSTs
verify token:            the WHATSAPP_VERIFY_TOKEN in .env
subscribe to:            whatsapp_business_account → messages

n8n editor:              http://localhost:5678 (never published)
WEBHOOK_URL:             unchanged, and it must stay internal
\$WEBHOOK_URL:            unchanged, and it must stay internal

Ctrl-C kills the tunnel and the URL is gone. This is development, not hosting.
EOF
echo
echo "checking the handshake through the tunnel…"
sleep 2
VTOKEN=$(grep -E '^WHATSAPP_VERIFY_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)
if [[ -n "$VTOKEN" ]]; then
  curl -s -o /dev/null -w "  GET /whatsapp-in → http %{http_code}\n" \
    "$URL/whatsapp-in?hub.mode=subscribe&hub.verify_token=$VTOKEN&hub.challenge=tunnel-check"
else
  echo "  WHATSAPP_VERIFY_TOKEN is empty in .env — Meta's handshake would return 503"
fi

wait "$TUNNEL_PID"
