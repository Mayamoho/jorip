// Generate the n8n WhatsApp pipeline, in two variants that cannot drift apart:
//
//   jorip-pipeline.json          production — starts where the brain hands off, and
//                                additionally answers Meta's GET verification callback
//   jorip-pipeline-harness.json  test double — starts at an Execute Workflow Trigger,
//                                same nodes, same SQL, same expressions, but the WhatsApp
//                                transport is stubbed so the flow can run with no access
//                                token. This is what `n8n execute` runs.
//
// Why a generator: the Postgres nodes embed db/queries/*.sql as literal strings, and a
// hand-copied SQL block inside a JSON file is a second copy of the query — the one that
// ships is no longer the one scripts/verify-sql.mjs proved. Both variants read the same
// sqlBody(), so what gets tested is what runs. npm run verify re-asserts that equality.
//
// Why the brain, not n8n, receives Meta: Meta signs the RAW request bytes, and n8n keeps
// a raw body as BINARY data that newer versions may move off the item between nodes.
// Depending on a byte-exact round trip through that layer for an HMAC is a bet on storage
// internals. core/inbound.mjs reads the socket buffer directly, so the trust decision
// happens where the bytes are guaranteed intact, and n8n orchestrates everything after it.
//
//   node scripts/build-workflow.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlBody } from './sql-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'n8n', 'workflows');

// Seeded by scripts/seed-n8n.mjs. A fixed id, so the generated JSON is reproducible and a
// reviewer can diff it without a random uuid changing every line.
const PG = { postgres: { id: 'jorip-postgres', name: 'Jorip Postgres' } };
const HISTORY_CAP = 20; // core/agent.mjs caps the transcript too; this is the SQL-side half

// The newest Postgres node the pinned image (docker.n8n.io/n8nio/n8n:1) actually ships:
// dist/nodes/Postgres/Postgres.node.js maps versions 1 … 2.6 and nothing above. Asking for a
// version that does not exist does not fall back to the latest — NodeTypes returns undefined
// and every run dies with "Cannot read properties of undefined (reading 'execute')", in the
// UI as much as from the CLI. Measured, not assumed.
const PG_VERSION = 2.6;

// Both write nodes downstream of the send take their values from the shaped turn, not from
// their own input: the node's input is Meta's response, which carries no session id, no
// score and no reply. `.item` resolves through n8n's item pairing, so a webhook carrying two
// leads writes each lead's own row. If pairing is ever broken the expression throws instead
// of quietly writing a NULL session.
const SHAPED = "$('Shape what gets recorded').item.json";

// Deterministic ids: node ids only have to be unique inside a workflow (connections
// reference names), so they are derived from the name and never from a random uuid. That
// keeps the committed JSON diffable across regenerations.
let seq = 0;
const nextId = () => `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const specs = [];
function node(name, type, typeVersion, parameters, extra = {}) {
  // The Code node's default is "run once for all items", but a default that is inferred is a
  // default that changes with the node's typeVersion. Per-item mode is also what keeps the
  // item pairing that the two write nodes resolve their parameters through, so it is written
  // into the JSON rather than trusted to the importer.
  const params = type === 'n8n-nodes-base.code'
    ? { mode: 'runOnceForAllItems', ...parameters }
    : parameters;
  specs.push({ name, type, typeVersion, parameters: params, ...extra });
  return name;
}

// ---------------------------------------------------------------- nodes

const N_VERIFY = node('Meta verifies (GET)', 'n8n-nodes-base.webhook', 2, {
  httpMethod: 'GET', path: 'whatsapp-verify', responseMode: 'responseNode', options: {},
}, { webhookId: 'jorip-whatsapp-verify', position: [-900, -260], only: 'production' });

// Expression-only on purpose: `$env` is not guaranteed inside a Code node sandbox on a
// locked-down instance, but expressions always resolve it. Fail-closed by construction —
// a wrong token echoes an empty body, so Meta's verification visibly fails rather than
// leaking the challenge to an unauthenticated caller.
const N_CHALLENGE = node('Answer the verification', 'n8n-nodes-base.respondToWebhook', 1.1, {
  respondWith: 'text',
  responseBody: "={{ $json.query['hub.mode'] === 'subscribe' && $json.query['hub.verify_token'] === $env.WHATSAPP_VERIFY_TOKEN ? $json.query['hub.challenge'] : '' }}",
  options: {},
}, { position: [-680, -260], only: 'production' });

const N_ENTRY = node('Pipeline call (POST)', 'n8n-nodes-base.webhook', 2, {
  httpMethod: 'POST', path: 'jorip-pipeline', responseMode: 'responseNode', options: {},
}, { webhookId: 'jorip-pipeline', position: [-900, 120], only: 'production' });

const N_ACK = node('Ack 200', 'n8n-nodes-base.respondToWebhook', 1.1, {
  respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: true }) }}', options: {},
}, { position: [-680, 20], only: 'production' });

const N_HARNESS = node('Harness start', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, {
  workflowInputs: { values: [] }, inputSource: 'passthrough', options: {},
}, { position: [-900, 120], only: 'harness' });

// Stands in for the brain's handoff in the harness: the identical JSON shape, so the nodes
// under test receive exactly what production sends.
const N_FABRICATE = node('Fabricate a Meta delivery', 'n8n-nodes-base.code', 2, {
  jsCode: `// Exactly the envelope n8n's Webhook node hands downstream in production: the parsed POST
// body under \`body\`, because that is the shape the nodes under test must be written against.
// Emitting it bare here would prove the harness and leave production reading \`undefined\`.
const stamp = Date.now();
return [{ json: {
  headers: { 'content-type': 'application/json' },
  params: {}, query: {},
  body: {
    verified: true,
    phone_number_id: '222222222222222',
    messages: [{
      wamid: 'wamid.HARNESS_' + stamp,
      wa_number: '8801700000077',
      profile_name: 'পরীক্ষা গ্রাহক',
      body: 'আমার বাজেট ৩০,০০০ টাকা। আমি নিজে সিদ্ধান্ত নিতে পারি, এক মাসের মধ্যে শুরু করতে চাই।',
      message_type: 'text',
      sent_at: new Date().toISOString(),
    }],
    statuses: [], ignored: 0, reason: null,
  },
} }];`,
}, { position: [-680, 260], only: 'harness' });

// One item per message, oldest first, and only the newest message of each lead is marked
// answerable. Both halves matter: every message must be STORED (dropping the second text a
// lead sent in a hurry would erase it from the transcript forever), and only one of them
// should be REPLIED to (answering both sends the lead two messages about the same thing).
const N_SPLIT = node('Split and filter messages', 'n8n-nodes-base.code', 2, {
  jsCode: `// n8n's Webhook node delivers the parsed POST body under \`body\`. The harness fabricates
// the same envelope, so both paths resolve to the identical object here.
const wire = $input.first().json;
const payload = wire?.body ?? wire;

// The flag core/inbound.mjs sets after a successful HMAC. Not an authentication mechanism —
// the network boundary is that — but it keeps the pipeline from acting on anything that did
// not come through the verifier, including a manual test run against the wrong URL.
if (payload.verified !== true) {
  throw new Error('pipeline invoked with verified !== true: the brain did not authenticate this body');
}

const rows = [];
for (const m of payload.messages ?? []) {
  // Only text is answerable. A voice note, sticker or document has no body the agent can
  // read, and record-inbound.sql deliberately stores nothing for it — replying to text
  // that never arrived is worse than staying quiet.
  if (m.message_type !== 'text' || typeof m.body !== 'string' || !m.body.length) continue;
  rows.push({
    wamid: m.wamid,
    wa_number: m.wa_number,
    profile_name: m.profile_name ?? null,
    body: m.body,
    sent_at: m.sent_at ?? null,
    phone_number_id: payload.phone_number_id ?? null,
  });
}

rows.sort((a, b) => String(a.sent_at ?? '').localeCompare(String(b.sent_at ?? '')));
// A batch can carry three texts from one lead. They are all stored, and only the last is
// answered — otherwise the lead gets three replies about a conversation they already moved
// past, and the model answers each one without the context of the others.
const lastOf = new Map(rows.map((r) => [r.wa_number, r.wamid]));
const answer = new Set(rows.filter((r) => lastOf.get(r.wa_number) === r.wamid).map((r) => r.wamid));

// Returning [] ends the run. Read receipts, echoes of our own messages and voice notes all
// land here; they are normal traffic, not errors, and the ack has already been sent.
return rows.map((r, i) => ({ json: { ...r, answer: answer.has(r.wamid), seq: i } }));`,
}, { position: [-460, 120] });

const N_STORE_IN = node('Store inbound', 'n8n-nodes-base.postgres', PG_VERSION, {
  operation: 'executeQuery',
  query: sqlBody('inbound'),
  options: {
    // An expression that resolves to an ARRAY, never the comma-separated string form:
    // n8n splits that on ',' and drops empty entries, so a comma in a Bangla sentence
    // shreds the parameters and a NULL body silently shifts every $n after it.
    queryReplacement: '={{ [$json.wa_number, $json.profile_name, $json.wamid, $json.body] }}',
  },
}, { credentials: PG, position: [-240, 120] });

const N_DEDUPE = node('Drop redeliveries', 'n8n-nodes-base.code', 2, {
  jsCode: `const pending = new Map($('Split and filter messages').all()
  .map((i) => [i.json.wamid, i.json]));

// 'Store inbound' runs once per item and returns the wamid it stored, so the join is on the
// key rather than on output position. It cannot be positional: record-inbound.sql returns
// ZERO rows when two webhooks race to open a lead's session, and from there on every index
// after that item points at the wrong message — the failure would be two bots for one lead.
//
// The inserted flag comes from an ON CONFLICT DO NOTHING row count: false means Meta retried a
// delivery we already answered. The reply to a duplicate is silence, which is the whole
// idempotency design — no separate dedupe table to drift out of sync.
const out = [];
for (const item of $input.all()) {
  const lead = pending.get(item.json.wamid);
  if (!lead) continue;
  if (item.json.inserted !== true || typeof item.json.session_id !== 'string') continue;
  if (lead.answer !== true) continue;
  out.push({ json: { ...lead, session_id: item.json.session_id } });
}
return out;`,
}, { position: [-20, 120] });

const N_HISTORY = node('Load history', 'n8n-nodes-base.postgres', PG_VERSION, {
  operation: 'executeQuery',
  query: sqlBody('history'),
  options: {
    queryReplacement: `={{ [$json.session_id, $json.wamid, ${HISTORY_CAP}] }}`,
  },
}, { credentials: PG, position: [200, 120] });

const N_ASSEMBLE = node('Assemble the transcript', 'n8n-nodes-base.code', 2, {
  jsCode: `// 'Load history' ran once per lead, and its rows arrive as one flat list. session_id is on
// every row precisely so this grouping needs no assumption about item counts: two leads in
// one webhook get two transcripts, and a lead whose session has no history yet gets [].
const bySession = new Map();
for (const item of $input.all()) {
  const { session_id, direction, body } = item.json;
  if (!bySession.has(session_id)) bySession.set(session_id, []);
  bySession.get(session_id).push({ direction, body });
}

// One item per lead. The current message is excluded by the query and appended by
// core/normalise.mjs as the current body; putting it in here would repeat the lead's own words.
return $('Drop redeliveries').all().map((i) => ({ json: {
  ...i.json,
  history: bySession.get(i.json.session_id) ?? [],
  taken_slots: [],
} }));`,
}, { position: [420, 120] });

const N_BRAIN = node('Ask the brain', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: "={{ ($env.JORIP_BRAIN_URL ?? 'http://brain:8788') + '/reply' }}",
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'content-type', value: 'application/json' },
      { name: 'x-jorip-token', value: '={{ $env.JORIP_SHARED_SECRET }}' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify({ body: $json.body, history: $json.history, taken_slots: $json.taken_slots }) }}',
  options: { timeout: 25000 },
}, { position: [640, 120] });

const N_SHAPE = node('Shape what gets recorded', 'n8n-nodes-base.code', 2, {
  jsCode: `const turn = $input.first().json;
const lead = $('Assemble the transcript').first().json;

// The accepted JSON came from the LAST call the brain made: the extract call if it validated
// first time, the repair call otherwise. Naming the model that actually answered is what
// makes v_model_distribution a measurement instead of a guess.
const usage = Array.isArray(turn.usage) ? turn.usage : [];
const last = usage[usage.length - 1] ?? {};
const s = turn.score ?? {};
const facts = turn.extraction ?? {};

return [{ json: {
  session_id: lead.session_id,
  wamid: lead.wamid,
  wa_number: lead.wa_number,
  reply: turn.reply,
  reply_source: turn.reply_source ?? 'template',
  hotness: s.hotness ?? null,
  need: facts.need ?? null,
  budget_bdt: facts.budget_bdt ?? null,
  timeline: facts.timeline ?? null,
  authority: facts.authority ?? null,
  confidence: facts.confidence ?? null,
  model: last.model ?? 'unknown',
  tier: last.tier ?? 'flash',
  repair_attempts: turn.repair_attempts ?? 0,
  raw: JSON.stringify(facts),
  need_pts: s.need_pts ?? 0,
  budget_pts: s.budget_pts ?? 0,
  timeline_pts: s.timeline_pts ?? 0,
  authority_pts: s.authority_pts ?? 0,
  total: s.total ?? 0,
  rule_version: turn.rule_version ?? 'v1',
  escalations: JSON.stringify(turn.escalations ?? []),
} }];`,
}, { position: [860, 120] });

const N_SEND = node('Send on WhatsApp', 'n8n-nodes-base.httpRequest', 4.2, {
  method: 'POST',
  url: "={{ ($env.WHATSAPP_GRAPH_BASE ?? 'https://graph.facebook.com/v23.0') + '/' + $env.WHATSAPP_PHONE_NUMBER_ID + '/messages' }}",
  sendHeaders: true,
  headerParameters: {
    parameters: [
      { name: 'content-type', value: 'application/json' },
      { name: 'authorization', value: '={{ "Bearer " + ($env.WHATSAPP_ACCESS_TOKEN ?? "") }}' },
    ],
  },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: "={{ JSON.stringify({ messaging_product: 'whatsapp', to: $json.wa_number, text: { preview_url: false, body: $json.reply } }) }}",
  options: { timeout: 15000 },
}, { position: [1080, 120], only: 'production' });

const N_STUB = node('Stub the send (harness)', 'n8n-nodes-base.code', 2, {
  mode: 'runOnceForEachItem',
  jsCode: `// Test double for the Graph API. Meta's response carries the echo id that
// message.wamid stores, and that id is what makes a retried send a no-op; the stub returns
// the same shape so the two write nodes downstream are exercised for real. Per-item mode,
// because that is what keeps the item pairing the write nodes resolve their inputs through.
return { messaging_product: 'whatsapp', messages: [{ id: 'wamid.HARNESS_ECHO_' + Date.now() }] };`,
}, { position: [1080, 120], only: 'harness' });

const N_STORE_OUT = node('Store outbound', 'n8n-nodes-base.postgres', PG_VERSION, {
  operation: 'executeQuery',
  query: sqlBody('outbound'),
  options: {
    // The node's own input is Meta's response, which carries no session id and no reply text,
    // so both come from the shaped item. One line: a line break inside {{ }} is a needless
    // gamble on how the expression field is edited later by hand.
    queryReplacement: `={{ [${SHAPED}.session_id, $json.messages?.[0]?.id ?? null, ${SHAPED}.reply] }}`,
  },
}, { credentials: PG, position: [1300, 120] });

// 19 parameters, in exactly the order record-turn.sql documents and sql-text.mjs declares.
// A reorder here writes a budget into the confidence column with no error anywhere, so the
// list is checked against the PREPARE signature by scripts/verify-agent.mjs on every build.
// Every value comes from the shaped item: this node's own input is the outbound write's
// result row ({ session_id, stored, session_touched }), which has none of the score fields.
const TURN_FIELDS = ['session_id', 'wamid', 'need', 'budget_bdt', 'timeline', 'authority',
  'confidence', 'model', 'tier', 'repair_attempts', 'raw', 'need_pts', 'budget_pts',
  'timeline_pts', 'authority_pts', 'total', 'hotness', 'rule_version', 'escalations'];

const N_RECORD = node('Record the turn', 'n8n-nodes-base.postgres', PG_VERSION, {
  operation: 'executeQuery',
  query: sqlBody('turn'),
  options: {
    queryReplacement: `={{ [${TURN_FIELDS.map((f) => `${SHAPED}.${f}`).join(', ')}] }}`,
  },
}, { credentials: PG, position: [1520, 120] });

// ---------------------------------------------------------------- wiring

const CHAIN = [N_SPLIT, N_STORE_IN, N_DEDUPE, N_HISTORY, N_ASSEMBLE, N_BRAIN, N_SHAPE, 'SEND', N_STORE_OUT, N_RECORD];

const LINKS = {
  'Meta verifies (GET)': [N_CHALLENGE],
  'Pipeline call (POST)': [N_ACK, N_SPLIT],
  'Harness start': [N_FABRICATE],
  'Fabricate a Meta delivery': [N_SPLIT],
};
// 'SEND' is a placeholder for whichever transport node the variant uses; resolve() swaps it.
for (let i = 0; i < CHAIN.length - 1; i++) LINKS[CHAIN[i]] = [CHAIN[i + 1]];

function build(variant) {
  const isHarness = variant === 'harness';
  const included = specs.filter((n) => !n.only || n.only === variant);
  if (!included.every((n) => n.name !== 'SEND')) throw new Error('SEND is a placeholder, not a node');

  const names = included.map((n) => n.name);
  const list = included.map((n) => {
    const out = {
      parameters: n.parameters, id: nextId(), name: n.name,
      type: n.type, typeVersion: n.typeVersion, position: n.position,
    };
    if (n.webhookId) out.webhookId = n.webhookId;
    if (n.credentials) out.credentials = n.credentials;
    return out;
  });

  // The harness swaps the transport node but keeps its position in the chain, so both ends of
  // that edge are re-pointed through resolve().
  const resolve = (name) => (name === 'SEND' ? (isHarness ? N_STUB : N_SEND) : name);
  const connections = {};
  for (const [from, targets] of Object.entries(LINKS)) {
    const src = resolve(from);
    const kept = targets.map(resolve).filter((t) => names.includes(t));
    if (!kept.length || !names.includes(src)) continue;
    connections[src] = { main: [kept.map((t) => ({ node: t, type: 'main', index: 0 }))] };
  }

  // Every node except the triggers must have exactly one inbound edge: a chain that silently
  // loses a branch is the failure mode a generator is supposed to make impossible.
  const inbound = {};
  for (const c of Object.values(connections)) {
    for (const edge of c.main[0]) inbound[edge.node] = (inbound[edge.node] ?? 0) + 1;
  }
  const triggers = isHarness ? [N_HARNESS] : [N_ENTRY, N_VERIFY];
  for (const n of names) {
    const want = triggers.includes(n) ? 0 : 1;
    if ((inbound[n] ?? 0) !== want) throw new Error(`${n}: ${inbound[n] ?? 0} inbound edges, expected ${want}`);
  }

  return {
    name: isHarness
      ? 'JORIP — pipeline harness (n8n execute, WhatsApp stubbed)'
      : 'JORIP — WhatsApp pipeline',
    nodes: list,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
  };
}

for (const [variant, file] of [['production', 'jorip-pipeline.json'], ['harness', 'jorip-pipeline-harness.json']]) {
  seq = 0;
  const json = JSON.stringify(build(variant), null, 2);
  writeFileSync(join(OUT_DIR, file), json + '\n');
  const wf = JSON.parse(json);
  const edges = Object.values(wf.connections).reduce((a, c) => a + c.main[0].length, 0);
  console.log(`  ${file}: ${wf.nodes.length} nodes, ${edges} edges`);
}
