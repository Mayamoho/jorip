# Jorip (জরিপ)

**A WhatsApp agent that answers, qualifies and books — and cannot invent a price, a claim, or a free slot.**

Built for a mid-size coaching institute in Dhaka that receives ~60 WhatsApp messages a day: half are "what's the fee?", a few are ready to pay, most need qualifying, and today someone answers them at 11pm.

The production shape is the same for a clinic, a real-estate seller or an e-commerce brand. Only `knowledge/` and the ICP rubric change.

---

## Status

Under construction. This section states plainly what runs today, because a README that oversells is worth nothing.

| | |
| --- | --- |
| ✅ | `docker compose up` → n8n + Postgres/pgvector, app schema migrated |
| ✅ | Public URL via Cloudflare tunnel, `WEBHOOK_URL` rewired automatically |
| ✅ | Model tier measured against the live key, not copied from a docs table |
| 🚧 | WhatsApp sandbox round-trip |
| ⬜ | Session state, grounding, extraction, scoring, booking, eval battery |

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

```
WhatsApp Cloud API (sandbox test number)
  └─ webhook ──► n8n
       ├─ dedupe on wamid          ← Meta retries webhooks; a duplicate must not double-reply
       ├─ load / open session      ← Postgres; never asks for something it already knows
       ├─ route intent             ← Gemini Flash, ~40 tokens
       ├─ answer        ──► pgvector retrieval over knowledge/ → grounded reply or escalate
       ├─ qualify       ──► structured extract → zod validate → 1 repair loop → score
       ├─ book          ──► server lists free slots → model picks → conflict-checked write
       └─ escalate      ──► WhatsApp alert to the founder + audit row
  every turn ──► turn_cost (tokens, cached tokens, latency, model, tier)
                    └──► the taka-per-conversation number in this README
```

Two tiers, measured rather than assumed: Flash handles the ordinary turns, a stronger model is reached only when extraction is shaky or a hot lead is about to be lost. The routing table and the cost per qualified conversation are published from `turn_cost`, not estimated.

---

## Running it

```bash
cp .env.example .env && ./scripts/bootstrap.sh   # generates secrets, chmod 600
# put your GEMINI_API_KEY into .env
docker compose up -d
./scripts/tunnel.sh                              # prints the public URL, rewrites WEBHOOK_URL
```

n8n editor: http://localhost:5678 — basic-auth protected.

**A tunnel URL is random and dies when the laptop sleeps.** It exists for development and for recording. It is not a production deployment, and `DEPLOY-VPS.md` is what moves it to one.

---

## What is real, and what is demo data

_Stated plainly, because a prototype that hides this is worth nothing._

**Real, running:**
- the compose stack and the schema that enforces the four rules above
- webhook dedupe on `wamid`
- the deterministic scorer, unit-tested without any model call
- the slot table — the agent cannot name a time that is not in it
- token and cost accounting per turn

**Demo data, labelled as such:**
- the coaching institute's pricing and course documents in `knowledge/`
- the lead list used by the outbound half
- calendar slots, seeded rather than connected to a real diary

**Proposed, not built:** real client numbers, Meta business verification, 24/7 hosting, voice.

---

## Layout

```
docker-compose.yml         n8n + Postgres/pgvector
db/init/001_schema.sql     the app state: leads, sessions, messages, extractions,
                           scores, slots, knowledge (pgvector), turn_cost, escalations
n8n/workflows/             exported workflow JSON — the thing to import and run
knowledge/                 the grounded document the agent may answer from
docs/                      ICP rubric, model-routing measurements
scripts/                   bootstrap, tunnel, eval battery
eval/                      scripted conversations, run offline with the model faked
```
