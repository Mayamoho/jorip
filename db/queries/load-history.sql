-- The transcript the brain reads, oldest first, excluding the message being answered.
--
-- A separate statement from record-inbound.sql on purpose: it runs in its own
-- snapshot, so the row that query just inserted is visible here. That is the fix
-- for the count-in-the-same-CTE problem, not a workaround for one column.
--
-- The current message is excluded because the caller passes it as `body`, and
-- buildTranscript() appends it last. Leaving it in here would put the lead's own
-- words in the transcript twice — which the model reads as emphasis, and which
-- quietly inflates tokens_in on every turn.
--
-- Parameters:
--   $1 session_id uuid  from record-inbound.sql
--   $2 wamid      text  the message being answered
--   $3 cap        int   caller-owned ceiling; core/agent.mjs uses MAX_MESSAGES - 1
--
-- DESC + LIMIT then re-sort ASC: the window is "the most recent N", the output is
-- "in the order they happened". created_at alone can tie inside a fast batch, so
-- wamid breaks the tie both ways, identically, or the reversal is not stable.
--
-- session_id is in the output for the same reason it is echoed by record-inbound.sql:
-- n8n runs this once per pending message, and a webhook can carry two messages from
-- two different leads. The node's output is a flat list of rows, so the only way to
-- tell which transcript belongs to which lead is to carry the key on every row.
WITH recent AS (
  SELECT session_id, wamid, direction, body, created_at
  FROM message
  WHERE session_id = $1
    AND wamid <> $2
  ORDER BY created_at DESC, wamid DESC
  LIMIT $3
)
SELECT session_id, direction, body
FROM recent
ORDER BY created_at ASC, wamid ASC;
