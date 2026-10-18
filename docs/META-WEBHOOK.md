# Getting a real WhatsApp message answered

The order matters. Each step says how to know it worked, because "it should be fine" is not a
test result.

## 0. What is already true before you start

```bash
docker compose up -d          # postgres + n8n + brain
./scripts/seed-n8n.mjs        # the Postgres credential n8n needs, fixed id jorip-postgres
```

Check the brain knows both ends of its job:

```bash
curl -s localhost:8788/healthz
# {"ok":true,"configured":{"gemini_key":true,"whatsapp_app_secret":false,…,"pipeline_url":true},…}
```

`whatsapp_app_secret: false` at this point is correct — it means the real Meta app secret has
not been pasted in yet. The edge **refuses traffic** rather than accepting unverified ones:
a POST without it returns `503 secret_not_configured`.

## 1. Meta's side of the credentials

Four values go into `.env`. `bootstrap.sh` generated the file; these four are the ones only
you can fill in, from the Meta app dashboard (App settings → WhatsApp → API Setup):

| variable | where it comes from |
| --- | --- |
| `WHATSAPP_APP_SECRET` | App settings → Basic → App Secret (used for the HMAC) |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp → API Setup → Generate token (a **system user** token, see below) |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → Phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | anything you invent; it must match what you type into the webhook dialog |

Two things bite here, both of them seen on this project:

- The token must belong to a **system user**, not to your personal admin identity. A personal
  token works in the dashboard and returns `(error #10) This call requires a recent
  access token` from a server.
- The phone number must be **assigned to that system user** (Business Settings → Users →
  System Users → Assign assets). Without the assignment the send fails with a permissions
  error that reads like a bad token.

Then `docker compose up -d brain n8n`. Containers take their environment at creation, so a
long-running n8n keeps the old empty values until it is recreated — that is how
`Authorization failed - please check your credentials` shows up after you were sure you set it.

## 2. Put the callback URL somewhere Meta can reach

See `TUNNEL.md`. Meta needs `https://<host>/whatsapp-in`, and the same path answers its GET
handshake.

## 3. Import and activate the pipeline

The workflow JSON is generated, not hand-edited:

```bash
node scripts/build-workflow.mjs     # writes n8n/workflows/*.json
npm run verify                      # the deploy gate, including byte-identity with db/queries
```

Import it (either way):

```bash
docker compose cp n8n/workflows/jorip-pipeline.json n8n:/tmp/wf.json
docker compose exec -T n8n n8n import:workflow --input=/tmp/wf.json
```

…or drag the file onto the n8n workflows list at `http://localhost:5678`.

Activation: the toggle in the UI, or headlessly —

```bash
docker compose exec -T postgres psql -U jorip -d jorip -c \
  "update n8n.workflow_entity set active = true, \"activeVersionId\" = \"versionId\" where name = 'JORIP — WhatsApp pipeline';"
docker compose restart n8n
```

which prints `Activated workflow "JORIP — WhatsApp pipeline" (ID: …)`. This is the exact
sequence used on 2026-10-18; the CLI has no `activate:workflow` command in the pinned image,
which is why it goes through the database.

## 4. Prove the two ends, without waiting for Meta

```bash
# the handshake and the receive path, against whatever is running:
WHATSAPP_APP_SECRET=<the secret in .env> node --env-file=.env scripts/simulate-meta.mjs
```

14 checks: signature accepted, Bangla body intact byte for byte, `wamid` carried through, one
tampered byte rejected, unsigned rejected, the wamid stored exactly once, and a live model turn
with its token usage. It is re-runnable against a lead that already has an open session.

What it cannot check is the thing only Meta can do: post to you from the internet. For that,
send a message to the test number from a real phone and watch:

```bash
docker compose logs -f n8n
docker compose exec -T postgres psql -U jorip -d jorip -c \
  "select direction, left(body,60), created_at from message order by created_at desc limit 6;"
```

## 5. What a working conversation looks like in the database

From a live run on 2026-10-18, signed POST → brain → n8n → brain → Postgres:

| | |
| --- | --- |
| `lead` | `8801711111111`, display name `Rahim Uddin`, taken from Meta's `contacts[]` |
| `session` | one open session; a second webhook for the same lead cannot open another |
| `message` | `direction='in'` with the Bangla body; `direction='out'` with the reply |
| `extraction` | need `specific_programme`, budget `30000`, timeline `within_month`, authority `self` |
| `score` | 25 + 25 + 25 + 15 = **83**, hotness `hot`, action `offer_slot` |
| reply | `reply_source = model` — offered `Sun 18/10, 3:30pm`, a slot id the server listed |
| model | `gemini-3.1-flash-lite`, 995 in / 152 out, 2 s median of three samples (1.5 s / 2.3 s / 7.5 s) |

`turn_cost` stays empty on purpose: `record-turn.sql` writes extraction, score and escalations,
and cost is deliberately absent until there is a price table to write against.

## 6. If it does not reply

| symptom | cause |
| --- | --- |
| Meta shows the webhook failing, `502` | n8n is not running, or the workflow is inactive — the brain only acks after the pipeline takes the message |
| `401 signature_mismatch` | `WHATSAPP_APP_SECRET` is not the secret Meta is signing with |
| `403` on the handshake | `WHATSAPP_VERIFY_TOKEN` does not match what you typed into the dialog |
| `503 pipeline_not_configured` | an app secret is set but `JORIP_PIPELINE_URL` is empty |
| nothing in `message` | the send or a later node errored; read the execution in the n8n UI |
| a reply for a message you never sent | something can reach `/webhook/jorip-pipeline` from outside — see `TUNNEL.md` |

Meta retries a failed delivery for up to 24 hours. Because `message.wamid` is the primary key
and the insert is `ON CONFLICT DO NOTHING`, a retry is a no-op rather than a second answer.
