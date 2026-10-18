-- Store the reply the agent actually sent, so the next turn's transcript contains it.
--
-- Without this row the lead is talking to a bot that remembers only its own questions:
-- load-history.sql returns the inbound half, buildTranscript() renders it, and the model
-- sees a conversation where it never said anything. That is not a memory bug the model
-- can apologise for — it re-asks what it already answered, on the customer's bill.
--
-- $2 is Meta's own message id from the send response, so the primary key does the
-- idempotency work here too: if n8n retries a timed-out send, the second write conflicts,
-- `stored` comes back false, and the flow does not double-count a turn in turn_cost.
-- The workflow must therefore treat stored = false as "already recorded", not as an error.
--
-- Parameters:
--   $1 session_id uuid  from record-inbound.sql
--   $2 wamid      text  Meta's messages[0].id from the Graph API response
--   $3 body       text  exactly what was sent, not what the model drafted
--
-- The body stored is the body handed to the send API. If the reply was truncated or
-- rewritten in flight, the database records the lie — so the write happens after the
-- send, from the same string that went out.

WITH ins AS (
  INSERT INTO message (wamid, session_id, direction, body)
  VALUES ($2, $1, 'out', $3)
  ON CONFLICT (wamid) DO NOTHING
  RETURNING 1
),
touch AS (
  UPDATE session SET updated_at = now()
  WHERE id = $1
  RETURNING 1
)
SELECT $1::uuid        AS session_id,
       (SELECT count(*) FROM ins) > 0    AS stored,
       (SELECT count(*) FROM touch) > 0  AS session_touched;
