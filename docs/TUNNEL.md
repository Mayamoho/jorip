# The tunnel, and what may go through it

`scripts/tunnel.sh` starts a Cloudflare tunnel and prints an `https://…trycloudflare.com`
address. It exists so Meta's dashboard has a URL to point at during development. It is not a
deployment: the address is random and it dies when the laptop sleeps or the process is killed.

## Only the brain goes public

The tunnel has exactly one ingress rule, and it points at **the brain on `127.0.0.1:8788`**.

| service | port | published to | reachable from the internet |
| --- | --- | --- | --- |
| brain | `127.0.0.1:8788` | loopback only | yes, through the tunnel |
| n8n | `127.0.0.1:5678` | loopback only | no |
| postgres | `127.0.0.1:5432` | loopback only | no |

That split is the whole security model of the inbound path:

- **The brain is the component that verifies Meta's HMAC-SHA256 signature over the raw
  bytes.** Putting it first means nothing unauthenticated ever reaches an orchestrator.
- **n8n's webhook paths do not authenticate.** `/webhook/jorip-pipeline` accepts a body whose
  only proof of provenance is `"verified": true` — a flag the brain sets after the signature
  checks. It is a guard against a mis-pointed test run, not against a stranger. Anyone who can
  reach it could insert fake leads and book slots. So nobody outside the compose network can
  reach it, and `WEBHOOK_URL` stays `http://localhost:5678/` or
  `http://n8n:5678/` — never the tunnel host.
- The n8n editor is basic-auth protected, but an exposed editor is still a remote code
  execution surface on a machine holding a database and a paid model key.

If the tunnel is ever configured to route to n8n, this document is the thing that was ignored.

## Pointing Meta at it

```bash
./scripts/tunnel.sh                      # prints https://<random>.trycloudflare.com
```

Then, in the WhatsApp Business app dashboard → Webhooks:

- **Callback URL**: `https://<tunnel-host>/whatsapp-in`
- **Verify token**: the value of `WHATSAPP_VERIFY_TOKEN` in `.env`

The same URL answers both halves of the handshake:

| request | response |
| --- | --- |
| `GET /whatsapp-in?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` | `200` with the challenge echoed, `403` on any mismatch, `503` if no token is configured |
| `POST /whatsapp-in` (signed) | `200` once the pipeline has taken the message, `401` on a bad signature, `502` if the pipeline is down |

Subscribe to object `whatsapp_business_account`, field `messages`.

Measured on this stack, 2026-10-18:

```
right token: http 200 body=HELLO-9
wrong token: http 403 body=
```

## A named tunnel, when the random one stops being enough

`cloudflared tunnel create jorip` gives a stable hostname and an ingress file you control:

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-uuid>
credentials-file: /home/<user>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: webhook.example.com
    service: http://127.0.0.1:8788
  - service: http_status:404      # required catch-all; nothing else is reachable
```

`8f0db1e0-1a9b-4d7b-9bcc-bc314a1c880e` is the tunnel created for this project. It has **no
ingress rule yet**, which is why a POST to its hostname currently fails rather than arriving —
a DNS name without a routed service is not a deployment. Add the ingress above, then
`cloudflared tunnel route dns jorip webhook.example.com`, then
`cloudflared tunnel run jorip`.

Set `WEBHOOK_URL` in `.env` only if you deliberately want n8n's own callbacks to use a public
host. For this design they do not need one: the brain calls n8n by service name on the
compose network.
