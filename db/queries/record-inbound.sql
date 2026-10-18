-- Record an inbound WhatsApp message and return the session it belongs to.
--
-- One statement, three things decided at once:
--   * the lead exists (or is created) and its name is refreshed from Meta
--   * the conversation is the lead's open session, created only if there is none
--   * the message lands once — a retry returns inserted = false and the flow stops
--
-- `inserted` is the idempotency signal the workflow branches on. It is derived from
-- the row count of an ON CONFLICT DO NOTHING insert, so the database, not the
-- model and not the workflow's memory, is what decides whether a lead gets a reply.
--
-- Parameters, in order:
--   $1 wa_number     text  E.164 without '+', as Meta sends it
--   $2 display_name  text  from Meta's contacts[], nullable
--   $3 wamid         text  Meta's message id — the primary key
--   $4 body          text  nullable: a voice note has no body, so nothing is stored
--
-- There are exactly four parameters. A fifth would be an unused, untyped
-- placeholder and Postgres aborts the extended-protocol parse with
-- "could not determine data type of parameter $5" — which is an n8n runtime
-- failure, not a warning, so the signature stays narrow.
--
-- Only text messages reach this query. The workflow filters on
-- type = 'text' before calling it: a body the agent cannot read must not become
-- a row that looks answerable.
--
-- Concurrency: if two webhooks for a brand-new lead race, both read "no open session"
-- in the same snapshot and both try to create one. session_one_open_per_lead
-- (db/init/002_constraints.sql) turns that into a conflict rather than two parallel
-- conversations; the losing branch's `created` returns nothing, `sess` is empty, and
-- this query returns ZERO ROWS. That is deliberate. The workflow errors, Meta marks the
-- delivery failed, retries the webhook, and on the retry the committed session is found.
-- A lead gets a late reply; a lead never gets two bots.

WITH l AS (
  INSERT INTO lead (wa_number, display_name)
  VALUES ($1, $2)
  ON CONFLICT (wa_number) DO UPDATE
    SET display_name = COALESCE(EXCLUDED.display_name, lead.display_name),
        last_seen_at = now()
  RETURNING id
),
existing AS (
  SELECT id FROM session
  WHERE lead_id IN (SELECT id FROM l) AND status = 'open'
  ORDER BY updated_at DESC
  LIMIT 1
),
created AS (
  INSERT INTO session (lead_id, status, context)
  SELECT l.id, 'open', '{}'::jsonb
  FROM l
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT (lead_id) WHERE status = 'open' DO NOTHING
  RETURNING id
),
sess AS (
  SELECT id FROM existing
  UNION ALL
  SELECT id FROM created
),
msg AS (
  INSERT INTO message (wamid, session_id, direction, body)
  SELECT $3, sess.id, 'in', $4
  FROM sess
  WHERE $4 IS NOT NULL
  ON CONFLICT (wamid) DO NOTHING
  RETURNING 1
),
-- Recency lives on the session, not on the lead: `existing` picks the open session by
-- updated_at DESC, and every view that sorts conversations reads it. A session that
-- never advances its own timestamp is indistinguishable from one abandoned weeks ago.
--
-- The outer SELECT never mentions `touch`, and it still runs: Postgres executes a
-- data-modifying CTE exactly once regardless of whether the primary query refers to it.
-- Verified here rather than assumed — proved by updated_at > opened_at in
-- scripts/verify-sql.mjs. record-outbound.sql references its touch column instead, which
-- is the safer shape if this query ever moves off Postgres.
touch AS (
  UPDATE session SET updated_at = now()
  WHERE id IN (SELECT id FROM sess)
  RETURNING 1
)
-- The output deliberately has no message count. A data-modifying CTE and the
-- outer SELECT share one snapshot, so counting `message` here returns the turns
-- BEFORE this insert: measured live as 0 for the first message and 1 for the
-- second. `inserted` is safe because it reads the CTE's own RETURNING set.
-- Anything that needs to see the row it just wrote is a separate statement —
-- that is db/queries/load-history.sql.
--
-- `wamid` is echoed back so the workflow can join this row to the message it came
-- from by identity instead of by output position. n8n's Postgres node emits one row
-- per input item, and this query legitimately emits ZERO rows for the session race
-- above — so a positional join silently attaches lead A's data to lead B's result
-- exactly when something unusual happens. Joining on the key cannot drift.
SELECT sess.id                         AS session_id,
       $3                              AS wamid,
       (SELECT count(*) FROM msg) > 0  AS inserted
FROM sess
LIMIT 1;
