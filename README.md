# Jorip (জরিপ)

**A WhatsApp agent that answers, qualifies and books — and cannot invent a price, a claim, or a free slot.**

Built for a mid-size coaching institute in Dhaka that receives ~60 WhatsApp messages a day: half are "what's the fee?", a few are ready to pay, most need qualifying, and today someone answers them at 11pm.

The production shape is the same for a clinic, a real-estate seller or an e-commerce brand. Only `knowledge/` and the ICP rubric change.

---

## Status

Under construction. This section states plainly what runs today, because a README that oversells is worth nothing.

| | |
| --- | --- |
| ✅ | `docker compose up` → n8n + Postgres/pgvector + the brain, app schema migrated |
| ✅ | Model tier measured against the live key, not copied from a docs table |
| ✅ | Signed webhook edge: Meta's HMAC verified over raw bytes, fail-closed on every branch |
| ✅ | Pipeline runs inside n8n against real Postgres: session, dedupe, transcript, extract, score, slot, reply |
| ✅ | The round trip, proven locally: signed POST → brain → n8n → Gemini → n8n → 4 tables → reply |
| ✅ | Generated workflow JSON, with a deploy gate that checks it against the SQL it embeds |
| 🚧 | Meta itself posting to the tunnel — the tunnel has no ingress rule yet, no app secret yet |
| ⬜ | pgvector grounding on the WhatsApp path, `turn_cost` pricing, the eval battery, GTM half |

Measured on 2026-10-18, on this machine, against this stack:

```
npm test            83 pass    (scorer, normalisation, signature, handshake, handoff)
npm run verify:sql  47 pass    (every db/queries/*.sql against a live Postgres)
npm run verify      14 pass    (the deploy gate: variants, node versions, byte-identity, bindings)
scripts/simulate-meta.mjs  14/14 checks passed
```

The round-trip run, in one line: a hot lead in Bangla arrived as a signed webhook, the pipeline
stored it, the model extracted `{specific_programme, 30000, within_month, self}`, the scorer
added up to 83 → `hot` → `offer_slot`, and the reply offered a slot id the server had listed.
The last node, the send to Meta, is the one thing that could not succeed here: it reached
`graph.facebook.com` and came back `httpCode 400` — *"Unsupported post request. Object with ID
'messages' does not exist, cannot be loaded due to missing permissions…"* — because
`WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are still empty. The request left the
building and Meta answered it; only the credentials were missing. Everything before that line
is executed, not described.

---

## Measured, not assumed

Model availability is per-key and it moves faster than any table of it. `scripts/probe-models.mjs` sends one tiny fixed prompt to each candidate and prints what actually came back. Run against this key on 2026-10-17:

| model | http | |
| --- | --- | --- |
| `gemini-3.1-flash-lite` | 200 | routing + extraction tier |
| `gemini-3-flash-preview` | 200 | reply tier — fastest thing that answered correctly |
| `gemini-3.8-flash` | 200 | heavy tier |
| `gemini-3.1-pro-preview` | **429** | reachable in name, zero budget on this tier |
| `gemini-2.5-flash`, `-pro`, `-flash-lite` | **404** | retired for new keys |
| `text-embedding-004` | **404** | gone |

Three findings that changed the design rather than just the config:

**There is no Pro rung.** The escalation tier I first configured pointed at a model this key cannot call. The live ladder is `flash-lite → flash`, and the heavy model is reserved for the offline eval comparison. A routing table with an unreachable tier in it is a runtime error waiting for a hot lead.

**`gemini-3.8-flash` is a thinking model.** At `maxOutputTokens: 8` it spent 5 thought tokens and returned an *empty visible reply* — a blank message to a customer, with a 200 and no error. Output budget is 400, and `thoughtsTokenCount` is billed, so it belongs in the cost table.

**`gemini-embedding-001` defaults to 3072 dimensions.** The schema declares `vector(768)`, so every embed call must pass `outputDimensionality: 768` explicitly or the insert fails somewhere far away from the cause.

Latency above is a single call and it lies: the same model measured 13.9 s / 3.2 s / 1.1 s on three consecutive requests. Anything this README quotes about speed will be a median of N, never one sample.

---

## The four rules this is built on

**1. The model returns keys and numbers. The server owns every string a customer sees.**
Signal labels, prices, scam types, slot ids — all come from tables this server controls. Model output never reaches the page as display text. A prompt-injected or hallucinated sentence therefore *cannot* become product copy.

**2. Booking is impossible to hallucinate.**
The agent is shown a list of genuinely-free `slot.id`s and may only name one of them. There is no code path by which it promises a time that does not exist.

**3. Qualification is arithmetic, not vibes.**
The model extracts `{need, budget, timeline, authority, confidence}`. A deterministic function scores it, and every component is stored, so the hot/warm/cold call can be unit-tested without calling a model and explained to a client afterwards.

**4. No source above threshold ⇒ escalate, never guess.**
If retrieval finds nothing, the agent says it will confirm with the admissions office and pings a human. A wrong fee quoted to a lead costs more than a slow reply.

---

## Architecture

One brain, two deployments, and exactly one published port.

```
WhatsApp Cloud API (Meta, sandbox number)
  │  GET handshake  ──► echo hub.challenge iff the verify token matches, else 403/503
  │  POST delivery  ──► HMAC-SHA256 over the raw bytes
  ▼
brain  ·  core/inbound.mjs            ← the only thing the internet can reach
  ├─ verify signature                 ← fail closed: 401 mismatch, 503 unconfigured
  ├─ normalise                        ← wamid, wa_number, body, receipts — byte for byte
  └─ hand off, then ack               ← a 502 is Meta's cue to retry; a 200 means it is stored
        │
        ▼
n8n  ·  loopback only                 ← the orchestrator, unauthenticated by design
  ├─ dedupe on wamid                  ← Meta retries webhooks; a duplicate must not double-reply
  ├─ load / open session              ← Postgres; never asks for something it already knows
  ├─ assemble the transcript          ← last 20 turns, oldest first
  ├─ ask the brain ──► route → extract → zod → 1 repair loop → deterministic score → slot
  ├─ send on WhatsApp                 ← Graph API, the reply the brain composed
  └─ write the turn                   ← message, extraction, score, escalation
```

Why the signature is checked in the brain and not in n8n: n8n's Code node runs in a sandbox
where `node:crypto` over an exact byte buffer is not reliable, and n8n re-serialises bodies.
Meta signs bytes, not objects. So the crypto lives where the bytes are trustworthy, and n8n
keeps everything it is genuinely good at — orchestration, the database, retries, the visible
execution log.

**The same `core/agent.mjs` answers both channels.** The Vercel function (`api/chat.js`) is the
web demo; this container is the WhatsApp path. One implementation of the four rules, so a fix
cannot land on one side and be forgotten on the other.

Two model tiers, measured rather than assumed (see below): Flash-lite routes and extracts,
Flash replies. pgvector grounding over `knowledge/` and the `turn_cost` pricing table are the
two pieces of this diagram that are drawn but not yet built — the agent answers from the
knowledge block in the prompt and escalates rather than inventing a fee.

---

## Running it

```bash
cp .env.example .env && ./scripts/bootstrap.sh   # generates secrets, chmod 600
# put your GEMINI_API_KEY into .env
docker compose up -d
./scripts/seed-n8n.mjs                           # the Postgres credential, fixed id
node scripts/build-workflow.mjs                  # regenerates n8n/workflows/*.json
npm run verify                                   # the deploy gate
./scripts/tunnel.sh                              # prints the public URL + checks the handshake
```

Then import `n8n/workflows/jorip-pipeline.json`, activate it, and put
`https://<tunnel-host>/whatsapp-in` plus `WHATSAPP_VERIFY_TOKEN` into Meta's webhook dialog.
`docs/META-WEBHOOK.md` is that walkthrough with the check command for every step.

n8n editor: http://localhost:5678 — basic-auth protected, and bound to loopback. The editor is
where a workflow is built; it is not a surface to publish.

To see the pipeline move without Meta:

```bash
WHATSAPP_APP_SECRET=<secret> node --env-file=.env scripts/simulate-meta.mjs   # 14 checks, real DB, live model
docker compose exec -T n8n n8n execute --id <harness-workflow-id>             # same chain, send stubbed
```

**A tunnel URL is random and dies when the laptop sleeps.** It exists for development and for recording. It is not a production deployment, and `DEPLOY-VPS.md` is what moves it to one.

---

## What is real, and what is demo data

_Stated plainly, because a prototype that hides this is worth nothing._

**Real, running:**
- the compose stack and the schema that enforces the four rules above
- the signature edge: HMAC over Meta's raw bytes, plus the GET handshake, both fail-closed
- webhook dedupe on `wamid`, in the database rather than in the workflow's memory
- the deterministic scorer, unit-tested without any model call
- the slot table — the agent cannot name a time that is not in it
- per-call token and latency accounting, returned by every model call
- the workflow JSON as a generated artifact, checked against the SQL it embeds before it ships

**Built but not yet wired:** `turn_cost` — every call reports what it used, and the schema has
the table, but `record-turn.sql` deliberately writes no cost until there is a price table to
read. So there is no taka-per-conversation number in this README, and the diagram above says so.

**Built but not reachable yet:** the send to Meta. It fires a real Graph API request and gets a
real 400 back, because no access token is configured. See `docs/META-WEBHOOK.md` §1.

**Demo data, labelled as such:**
- the coaching institute's pricing and course documents in `knowledge/`
- the lead list used by the outbound half
- calendar slots, seeded rather than connected to a real diary

**Proposed, not built:** real client numbers, Meta business verification, 24/7 hosting, voice.

---

## Layout

```
docker-compose.yml         n8n + Postgres/pgvector + the brain
db/init/001_schema.sql     the app state: leads, sessions, messages, extractions,
                           scores, slots, knowledge (pgvector), turn_cost, escalations
db/queries/*.sql           the four statements the workflow runs — proved by verify:sql,
                           then inlined byte-for-byte into the workflow JSON
core/                      one brain: agent, inbound edge, verify handshake, slots, vocab
api/chat.js                the same brain as a Vercel function
n8n/workflows/             generated workflow JSON — the thing to import and run
knowledge/                 the grounded document the agent may answer from
docs/                      TUNNEL.md, META-WEBHOOK.md; DEPLOY-VPS.md at the repo root
scripts/                   bootstrap, tunnel, seed-n8n, build-workflow, probes, the gates
eval/                      scripted conversations, run offline with the model faked
```
