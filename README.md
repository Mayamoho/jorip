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
| 🚧 | WhatsApp sandbox round-trip |
| ⬜ | Session state, grounding, extraction, scoring, booking, eval battery |

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
