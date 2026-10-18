# Moving off the laptop

**Status: written, not executed.** Nothing in this file has been run against a VPS. It is the
plan, with the parts that are already proven marked as such and the parts that are not marked
as they are. The tunnel in `docs/TUNNEL.md` is what is actually running today.

## Why a VPS at all

A webhook has to be reachable when the developer is asleep. That is the entire requirement,
and a random `trycloudflare.com` host that dies with the laptop does not meet it.

## What changes

| | on the laptop | on a VPS |
| --- | --- | --- |
| public host | random tunnel address | `webhook.<your-domain>` on a named tunnel, or Caddy/Traefik with Let's Encrypt |
| brain | `127.0.0.1:8788`, tunnel ingress | unchanged — still loopback, still the only thing published |
| n8n | `127.0.0.1:5678` | unchanged — never published |
| postgres | `127.0.0.1:5432` | bind to `unix`/internal network only; drop the host port entirely |
| secrets | `.env`, chmod 600 | `.env`, chmod 600, and `N8N_ENCRYPTION_KEY` backed up somewhere it can be restored |
| data | `pgdata` volume | `pgdata` volume, plus a dump cron — see below |
| uptime | dies with the lid | `docker compose up -d` + `restart: unless-stopped`, or systemd units |

## The parts that must not be skipped

1. **The HMAC boundary stays where it is.** Whatever the TLS story is, Meta's callback must
   land on the brain. A reverse proxy that routes `/webhook/*` to n8n because "that is where
   webhooks live" quietly turns an authenticated edge into an open one.
2. **Back up `N8N_ENCRYPTION_KEY` before you destroy anything.** n8n's stored credentials are
   AES-256-CBC under it. Lose the key and the credential row is unreadable even though the
   Postgres password is written in `.env` — the fix is `node scripts/seed-n8n.mjs` again, which
   is cheap, but only because the workflow references the credential by a fixed id.
3. **Dump the database before you touch the volume.** `pg_dump` of the `jorip` database is a
   few hundred kilobytes; a lost lead table is not recoverable from the container.

        docker compose exec -T postgres pg_dump -U jorip -d jorip | gzip > jorip-$(date +%F).sql.gz

4. **Re-run the checks after the move, not before.** `scripts/simulate-meta.mjs` proves the
   stack you are standing on. On the new host, `GET /whatsapp-in` handshake + a signed POST +
   the 14 checks are the difference between "it deployed" and "it works".
5. **`WEBHOOK_URL` stays internal.** n8n calls the brain by service name; the brain calls n8n
   by service name. Neither needs a public URL on this path.

## Cost, at the numbers measured here

One qualifying conversation on the current ladder cost 995 input / 152 output tokens on
`gemini-3.1-flash-lite` for the extract call. A $5/month VPS and a Gemini key that is already
paid for (the Jio bundle) put the marginal cost of keeping this online at the VPS price. The
per-conversation figure in the README is not yet derived from `turn_cost` rows, because
`record-turn.sql` deliberately does not write cost yet — that is task #4, not a claim.

## What is still not true

- No Meta business verification, so no production number — the sandbox expires and rate-limits.
- No 24/7 monitoring; a dead brain fails closed with a `502`, which means Meta retries and the
  lead waits, not that the lead is lost.
- No pgvector grounding on the WhatsApp path: answers come from the prompt's knowledge block,
  and an unanswered question escalates instead of inventing a fee.
