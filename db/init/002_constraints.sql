-- Jorip — constraint patch.
--
-- Read this before editing: db/init/*.sql only executes when the Postgres volume is
-- EMPTY. On a machine that has already run, this file is not applied by a restart —
-- apply it explicitly:
--
--   docker compose exec -T postgres psql -U jorip -d jorip \
--     -v ON_ERROR_STOP=1 -f - < db/init/002_constraints.sql
--
-- What it fixes is a drift that already happened, not a hypothetical one. 001_schema.sql
-- documented timeline as `now | 1m | 3m | later | null` and authority as
-- `self | team | boss | unknown` while the scorer's tables said `within_month`,
-- `within_quarter`, `boss_or_team`. The schema was a comment, so nothing failed: the
-- scorer scored '1m' as 0 points and a hot lead quietly became a cold one. A prose enum
-- is not a constraint.
--
-- The single source of truth is core/vocab.mjs; scripts/score.mjs throws at import if its
-- tables drift from it, and scripts/verify-agent.mjs greps this file for the same lists.
-- Values here and there must match, and CHECK constraints make a wrong value a failed
-- write instead of a silently wrong score.

begin;

-- ── session ──────────────────────────────────────────────────────────
-- status was a comment too. The workflow writes it, so a typo would create a state
-- no view or query knows about.
alter table session drop constraint if exists session_status_check;
alter table session add constraint session_status_check
  check (status in ('open','qualified','nurture','booked','escalated','closed'));

-- One open conversation per lead, enforced rather than intended.
--
-- Meta posts each message as its own webhook and retries them, so two inbound
-- messages for a brand-new lead can arrive in parallel. Without this, both
-- branches find no open session, both create one, and the lead ends up in two
-- simultaneous conversations with a bot that does not know the other one exists.
-- That is the exact class of bug this project claims to prevent.
--
-- Partial, because a lead legitimately has many closed sessions and exactly one open.
create unique index if not exists session_one_open_per_lead
  on session (lead_id) where status = 'open';

-- ── extraction ───────────────────────────────────────────────────────
-- All three enums are nullable: "not yet known" is a real state in a qualification
-- flow and it must not be defaulted. The CHECK allows NULL and rejects a value
-- outside the vocabulary — the difference between 0 points and no answer.
alter table extraction drop constraint if exists extraction_need_check;
alter table extraction add constraint extraction_need_check
  check (need is null or need in ('specific_programme','category','vague','none'));

alter table extraction drop constraint if exists extraction_timeline_check;
alter table extraction add constraint extraction_timeline_check
  check (timeline is null or timeline in ('now','within_month','within_quarter','later','unknown'));

alter table extraction drop constraint if exists extraction_authority_check;
alter table extraction add constraint extraction_authority_check
  check (authority is null or authority in ('self','boss_or_team','unknown'));

-- A negative budget is not "unknown", and confidence is a probability.
alter table extraction drop constraint if exists extraction_budget_bdt_check;
alter table extraction add constraint extraction_budget_bdt_check
  check (budget_bdt is null or budget_bdt >= 0);

alter table extraction drop constraint if exists extraction_confidence_check;
alter table extraction add constraint extraction_confidence_check
  check (confidence is null or (confidence >= 0 and confidence <= 1));

-- tier's CHECK already exists in 001 and matches what the brain emits today:
-- 'flash' for the route/extract call, 'escalated' for the repair call. 'cached'
-- is reserved for the grounding path, where a reused prefix is billed as a cache
-- read. Nothing here writes 'route' or 'heavy' — those are model names, not tiers.

-- ── score ────────────────────────────────────────────────────────────
-- hotness is arithmetic over these same enums; a hot row with cold components is a
-- bug in the scorer, and the CHECK below is what makes it visible in a write error
-- instead of in a client's pipeline.
--
-- NULL is allowed and means "not classifiable yet", which is a state the scorer
-- genuinely returns: below MIN_CONFIDENCE it emits { hotness: null, action: 'clarify',
-- reason_code: 'low_confidence' }. Forcing a value there would invent a category —
-- exactly the "unknown is not 0" rule this schema already applies to budget_bdt. The
-- row still lands, so the low-confidence lead is auditable instead of invisible.
alter table score drop constraint if exists score_hotness_check;
alter table score add constraint score_hotness_check
  check (hotness is null or hotness in ('hot','warm','cold'));

-- 001 declared the column NOT NULL, so the CHECK above alone would still reject a
-- low-confidence row. Both halves have to change together.
alter table score alter column hotness drop not null;

-- ── escalation ───────────────────────────────────────────────────────
-- The reason codes core/agent.mjs actually emits today, plus the two the grounding
-- path will emit: no_source_above_threshold and human_requested.
--
-- 001 also listed injection_suspected. Nothing produces it and nothing should: the
-- injection defence here is structural — the model may only echo server-owned slot
-- ids, so a successful injection cannot widen the option space — not detected-and-
-- logged. Dropping it keeps this list to codes a human can act on.
alter table escalation drop constraint if exists escalation_reason_code_check;
alter table escalation add constraint escalation_reason_code_check
  check (reason_code in (
    'repeated_repair_failure',
    'slot_choice_missing',
    'hot_lead_alert',
    'out_of_scope',
    'no_source_above_threshold',
    'human_requested'
  ));

-- ── turn_cost.step ───────────────────────────────────────────────────
-- Deliberately NOT constrained. A cost row is telemetry written after the customer has
-- already been answered; a CHECK here would let an accounting label break a live
-- conversation. 001's comment listed 'route | extract | reply | embed | escalate'
-- before any of it ran. What the brain reports today is 'extract' and 'repair';
-- 'reply', 'embed' and 'escalate' stay possible as the grounding path lands.
-- The drift this comment had was in the other direction from the enums above: real,
-- harmless, and a reminder about which fields deserve a constraint and which do not.

commit;
