-- Jorip — app state.
-- The design rule this schema enforces: the model returns keys and numbers,
-- never display text and never a claim the server cannot vouch for.
-- Every row that reaches a customer's phone traces back to a server-owned table.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- n8n keeps its own tables out of the app schema.
CREATE SCHEMA IF NOT EXISTS n8n;

-- ── People ───────────────────────────────────────────────────────────
create table if not exists lead (
  id            uuid primary key default gen_random_uuid(),
  wa_number     text not null unique,          -- E.164 without '+', as Meta sends it
  display_name  text,                          -- from the WhatsApp profile, not from the model
  business      text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- One conversation per lead. `context` is what the agent already knows, so it
-- never asks twice — the thing that separates this from a form.
create table if not exists session (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references lead(id) on delete cascade,
  status         text not null default 'open',
    -- open | qualified | nurture | booked | escalated | closed
  context        jsonb not null default '{}'::jsonb,
  opened_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists session_open_for_lead on session (lead_id, updated_at desc);

-- ── Messages ─────────────────────────────────────────────────────────
-- wamid is Meta's message id and it is UNIQUE. WhatsApp retries webhooks;
-- a duplicate insert loses the race and the flow stops instead of replying
-- the same sentence twice. This is the whole idempotency story.
create table if not exists message (
  wamid        text primary key,
  session_id   uuid not null references session(id) on delete cascade,
  direction    text not null check (direction in ('in','out')),
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists message_by_session on message (session_id, created_at);

-- ── What the model extracted ─────────────────────────────────────────
-- Keys and numbers only. `raw` is kept so a human can audit the exact
-- JSON the model returned against what the pipeline decided to do with it.
--
-- The enums below are owned by core/vocab.mjs and enforced by CHECK constraints in
-- 002_constraints.sql. They used to be only the comments you see here, and they drifted
-- from the scorer; a prose enum cannot fail a write, so nothing failed.
create table if not exists extraction (
  id                 bigint generated always as identity primary key,
  session_id         uuid not null references session(id) on delete cascade,
  message_wamid      text references message(wamid),
  need               text,             -- specific_programme | category | vague | none
  budget_bdt         integer,          -- null = not yet known; never defaulted to 0
  timeline           text,             -- now | within_month | within_quarter | later | unknown
  authority          text,             -- self | boss_or_team | unknown
  confidence         numeric(3,2),
  model              text not null,
  tier               text not null check (tier in ('flash','escalated','cached')),
  repair_attempts    smallint not null default 0,
  raw                jsonb not null,
  created_at         timestamptz not null default now()
);

-- ── Qualification: arithmetic, not vibes ─────────────────────────────
-- Stored per-component so the score is explainable to a client and
-- unit-testable without calling a model.
create table if not exists score (
  extraction_id  bigint primary key references extraction(id) on delete cascade,
  session_id     uuid not null references session(id) on delete cascade,
  need_pts       smallint not null,
  budget_pts     smallint not null,
  timeline_pts   smallint not null,
  authority_pts  smallint not null,
  total          smallint not null,
  -- nullable on purpose: score() returns hotness = null with action 'clarify' when
  -- confidence is below MIN_CONFIDENCE. Absence of a classification is not a
  -- classification, and 002_constraints.sql enforces the enum around the NULL.
  hotness        text check (hotness in ('hot','warm','cold')),
  rule_version   text not null default 'v1',
  created_at     timestamptz not null default now()
);

-- ── Booking: the server owns the option space ────────────────────────
-- The model is shown a list of free slot ids and may only name one of them.
-- It is therefore structurally unable to promise an availability that does
-- not exist — the class of bug that gets an agency fired by a client.
create table if not exists slot (
  id              uuid primary key default gen_random_uuid(),
  starts_at       timestamptz not null unique,
  duration_mins   integer not null default 30,
  status          text not null default 'free'
                    check (status in ('free','held','booked','cancelled')),
  session_id      uuid references session(id) on delete set null,
  booked_at       timestamptz
);
create index if not exists slot_free_window on slot (starts_at) where status = 'free';

-- ── Grounding ────────────────────────────────────────────────────────
-- Every answer must cite a chunk id. No chunk above threshold ⇒ escalate.
-- gemini-embedding-001 returns 3072 dims by DEFAULT; every embed call must
-- pass outputDimensionality = 768 or the insert below fails on width.
create table if not exists knowledge (
  id          serial primary key,
  doc         text not null,
  chunk       text not null,
  source_ref  text not null,            -- "pricing.md#batch-morning"
  embedding   vector(768) not null
);
create index if not exists knowledge_search on knowledge
  using hnsw (embedding vector_cosine_ops);

-- ── Cost: measured, never estimated ──────────────────────────────────
-- This table is what the README's taka-per-conversation number is derived
-- from. If it is not in here, it does not get printed as a measurement.
create table if not exists turn_cost (
  id             bigint generated always as identity primary key,
  session_id     uuid references session(id) on delete cascade,
  step           text not null,          -- extract | repair today; reply | embed | escalate pending
                                          -- deliberately unconstrained: a cost row must never
                                          -- break a conversation that is already answered
  model          text not null,
  tier           text not null,
  tokens_in      integer not null default 0,
  tokens_out     integer not null default 0,
  cached_tokens  integer not null default 0,
  latency_ms     integer,
  cost_bdt       numeric(10,4) not null default 0,
  created_at     timestamptz not null default now()
);

-- ── Handoff ──────────────────────────────────────────────────────────
-- Machine codes, not prose. A reason the model wrote is a reason a model
-- could have written anything.
create table if not exists escalation (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references session(id) on delete cascade,
  reason_code text not null,
    -- slot_choice_missing | repeated_repair_failure | hot_lead_alert | out_of_scope
    -- (live now) | no_source_above_threshold | human_requested (grounding path)
    -- 001 also listed injection_suspected; nothing produces it and nothing should —
    -- the injection defence is structural, not logged. 002_constraints.sql enforces this.
  alerted_at  timestamptz not null default now()
);

-- ── The metrics the README quotes ────────────────────────────────────
create or replace view v_conversation_cost as
select s.id as session_id,
       s.status,
       count(c.id)                                   as turns,
       coalesce(sum(c.tokens_in),0)                  as tokens_in,
       coalesce(sum(c.tokens_out),0)                 as tokens_out,
       coalesce(sum(c.cached_tokens),0)              as cached_tokens,
       round(coalesce(sum(c.cost_bdt),0), 4)         as cost_bdt,
       round(100.0 * sum(nullif(c.cached_tokens,0)) / nullif(sum(c.tokens_in),0), 1) as cache_hit_pct
from session s
left join turn_cost c on c.session_id = s.id
group by s.id, s.status;

create or replace view v_model_distribution as
select tier,
       count(*)                        as calls,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct,
       round(avg(latency_ms))          as avg_latency_ms,
       round(sum(cost_bdt), 4)         as total_cost_bdt
from turn_cost
group by tier;
