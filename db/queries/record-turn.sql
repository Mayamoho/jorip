-- Record one agent turn: what was extracted, how it scored, and why it escalated.
--
-- Three tables, one statement, because the rows are only meaningful together. An
-- extraction without its score is a claim about a lead with no arithmetic behind it; a
-- score without its extraction_id loses the `raw` JSON the model actually returned, which
-- is the only way to audit the pipeline later. The extraction_id foreign key is what makes
-- that pairing permanent.
--
-- This writes facts, not decisions. It never touches slot status and never promotes a
-- session out of 'open' — booking a call and closing a conversation are separate choices
-- with separate failure modes, and neither belongs in a logging statement.
--
-- Parameters:
--   $1  session_id      uuid   from record-inbound.sql
--   $2  message_wamid   text   the inbound message this turn answered
--   $3  need            text   ┐
--   $4  budget_bdt      int    │ the five validated facts, straight from core/agent.mjs
--   $5  timeline        text   │ and straight into the enums 002_constraints.sql enforces,
--   $6  authority       text   ┘ so a value that drifted from core/vocab.mjs fails HERE.
--   $7  confidence      numeric 0..1, or NULL when the model declined to say
--   $8  model           text   the model that produced the accepted answer
--   $9  tier            text   flash | escalated | cached
--   $10 repair_attempts int    0 or 1; more than one is not a retry, it is a bug
--   $11 raw             jsonb  the model's own JSON, kept verbatim for audit
--   $12 need_pts        smallint ┐
--   $13 budget_pts      smallint │ score.mjs components, stored per-part so a client can
--   $14 timeline_pts    smallint │ be shown WHY their lead was called hot
--   $15 authority_pts   smallint │
--   $16 total           smallint ┘
--   $17 hotness         text   nullable: below MIN_CONFIDENCE the honest answer is null
--   $18 rule_version    text   'v1' — the arithmetic is versioned so a re-score is possible
--   $19 escalations     jsonb  array of reason codes, [] when nothing needs a human
--
-- Cost is deliberately absent. turn_cost stays empty until there is a price table to
-- multiply these token counts by: writing 0 into a column the README quotes as a
-- measurement would make the agent look cheaper than it is, which is the one error
-- direction a cost claim must never have.

WITH ex AS (
  INSERT INTO extraction
    (session_id, message_wamid, need, budget_bdt, timeline, authority, confidence, model, tier, repair_attempts, raw)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
  RETURNING id
),
sc AS (
  INSERT INTO score
    (extraction_id, session_id, need_pts, budget_pts, timeline_pts, authority_pts, total, hotness, rule_version)
  SELECT ex.id, $1, $12, $13, $14, $15, $16, $17, $18
  FROM ex
  RETURNING extraction_id
),
esc AS (
  INSERT INTO escalation (session_id, reason_code)
  SELECT $1, value
  FROM jsonb_array_elements_text($19::jsonb) AS value
  WHERE value <> ''
  RETURNING id
)
SELECT (SELECT id FROM ex)                          AS extraction_id,
       (SELECT count(*) FROM sc) > 0                 AS score_written,
       (SELECT count(*) FROM esc)                    AS escalations_written;
