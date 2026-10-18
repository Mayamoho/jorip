// Prove the SQL in db/queries does what its comments claim, against the real database,
// before any of it is pasted into an n8n node.
//
// Why a script and not a manual psql session: the workflow embeds these files as literal
// query strings, so a mistake here surfaces as a red node in a flow whose failures look
// like model problems. And psql's simple protocol cannot bind typed parameters, so every
// file is wrapped in PREPARE — the extended-protocol path n8n's Postgres node uses. That
// is what catches an unused placeholder such as $5, which Postgres aborts at parse time
// with "could not determine data type of parameter $5" before a single row is written.
//
// Each scenario runs in ONE psql session and carries the session id in a psql variable
// (\gset). Two invocations would not do: record-inbound.sql CREATES the session, so an id
// discovered by a first run is not the id a second run inserts against.
//
//   node scripts/verify-sql.mjs            (needs `docker compose up -d postgres`)

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { QUERY_SPECS, prepareStatement, signatureProblem } from './sql-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LEAD = '8801700000099';
const LEAD2 = '8801700000098';
const M1 = 'wamid.VERIFIER_M1';
const M2 = 'wamid.VERIFIER_M2';
const M3 = 'wamid.VERIFIER_M3';
const OUT = 'wamid.VERIFIER_OUT';
const B1 = '30000 taka budget, ekhon-i start korte chai';
const B2 = 'tomar offer ta bolo';
const REPLY = 'Roktu, Sunday 10:00am possible?';

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function psql(script) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'jorip', '-d', 'jorip', '-qtA', '-v', 'ON_ERROR_STOP=1'], {
    cwd: ROOT, input: script, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`psql failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

// A statement that MUST fail. Escaping the constraint name out of the error text is the
// point: "some error" would also be satisfied by a typo in the query, which tells us
// nothing about whether the enum is enforced.
function psqlExpectFail(script, expect) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'jorip', '-d', 'jorip', '-qtA', '-v', 'ON_ERROR_STOP=1'], {
    cwd: ROOT, input: script, encoding: 'utf8',
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 0) return { ok: false, why: 'the statement succeeded — nothing was enforced' };
  if (!text.includes(expect)) return { ok: false, why: `failed, but not on ${expect}: ${text.trim().split('\n').pop()}` };
  return { ok: true, why: text.trim().split('\n').pop() };
}

// Comments stripped, trailing semicolon removed, signature checked — shared with the
// workflow generator so the string proven here is the string that ships.
function prepare(name) {
  const problem = signatureProblem(name);
  check(`${name}: parameter placeholders match its declared signature`,
    problem === null, problem ?? undefined);
  return prepareStatement(name);
}

// Output convention: `##tag value` for a value \echo expands inline, `##tag` followed by
// raw rows for a result set. \gset consumes the row it captures, which is why result sets
// are printed instead. A scalar SELECT after a bare tag lands in rows[0], so scalar() reads
// either shape.
function parse(out) {
  const tags = {};
  let current = null;
  for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('##')) {
      const [name, ...rest] = line.slice(2).split(/\s+/);
      tags[name] = { value: rest.length ? rest.join(' ') : undefined, rows: [] };
      current = name;
    } else if (current) {
      tags[current].rows.push(line);
    }
  }
  return tags;
}
const val = (t, k) => t[k]?.value ?? t[k]?.rows?.[0];
const rows = (t, k) => t[k]?.rows ?? [];

console.log('\n── db/queries against the live database\n');

// ── Scenario 1: the idempotency signal, end to end ───────────────────
const one = parse(psql(`
${prepare('inbound')}
${prepare('outbound')}
delete from lead where wa_number = '${LEAD}';

EXECUTE inbound('${LEAD}','Abu Kawser','${M1}','${B1}') \\gset a_
EXECUTE inbound('${LEAD}','Abu Kawser','${M1}','${B1}') \\gset b_
EXECUTE inbound('${LEAD}',null,'${M2}','${B2}') \\gset c_
EXECUTE inbound('${LEAD}',null,'${M3}',null) \\gset i_
EXECUTE outbound(:'c_session_id','${OUT}','${REPLY}') \\gset f_
EXECUTE outbound(:'c_session_id','${OUT}','${REPLY}') \\gset g_

\\echo ##sid :c_session_id
\\echo ##wamid_first :a_wamid
\\echo ##first :a_inserted
\\echo ##retry :b_inserted
\\echo ##sid_retry :b_session_id
\\echo ##second :c_inserted
\\echo ##sid_second :c_session_id
\\echo ##voiceless :i_inserted
\\echo ##sid_voiceless :i_session_id
\\echo ##stored :f_stored
\\echo ##touched :f_session_touched
\\echo ##stored_again :g_stored
\\echo ##name
select coalesce(display_name,'<null>') from lead where wa_number = '${LEAD}';
\\echo ##recency
select updated_at > opened_at from session where id = :'c_session_id';
\\echo ##counts
select (select count(*) from session
          where lead_id = (select id from lead where wa_number = '${LEAD}'))
    || '|' ||
       (select count(*) from message where session_id = :'c_session_id')
    || '|' ||
       (select count(*) from message where session_id = :'c_session_id' and direction = 'out');
delete from lead where wa_number = '${LEAD}';
\\echo ##cleanup
select count(*) from lead where wa_number = '${LEAD}';
`));

const isTrue = (v) => v === 't' || v === 'true';
const isFalse = (v) => v === 'f' || v === 'false';
const session = val(one, 'sid');

check('inbound returns a session id', /^[0-9a-f-]{36}$/.test(session ?? ''), `got ${session}`);
// The workflow joins this row back to its message by key, not by output position,
// because this query legitimately returns zero rows for the session race.
check('inbound echoes the wamid so the join cannot be positional',
  val(one, 'wamid_first') === M1, val(one, 'wamid_first'));
check('first delivery reports inserted = true', isTrue(val(one, 'first')), val(one, 'first'));
check('retry of the same wamid reports inserted = false', isFalse(val(one, 'retry')), val(one, 'retry'));
check('the retry resolves the SAME session, not a new one', val(one, 'sid_retry') === session,
  `${val(one, 'sid_retry')} vs ${session}`);
check('second message reuses the open session', val(one, 'sid_second') === session,
  `${val(one, 'sid_second')} vs ${session}`);
check('a null display_name does not erase the name Meta sent', val(one, 'name') === 'Abu Kawser',
  val(one, 'name'));

// A voice note has no body, so nothing is stored and `inserted` is the only signal the
// workflow gets. It must be false WITHOUT an error: the alternative is a reply built from
// text that was never received.
check('a bodyless message stores nothing and does not throw',
  isFalse(val(one, 'voiceless')), val(one, 'voiceless'));
check('a bodyless message still resolves the open session',
  val(one, 'sid_voiceless') === session, val(one, 'sid_voiceless'));

check('outbound reply is stored', isTrue(val(one, 'stored')), val(one, 'stored'));
check('outbound touches the session row', isTrue(val(one, 'touched')), val(one, 'touched'));
// Meta retries a send whose response timed out. The echo id collides with the row already
// written, so the turn is counted once — stored = false here means "already recorded".
check('a retried send is not stored twice', isFalse(val(one, 'stored_again')), val(one, 'stored_again'));

check('session recency advanced during the run', isTrue(val(one, 'recency')), val(one, 'recency'));
const [sessions, messages, outs] = (val(one, 'counts') ?? '').split('|');
check('exactly one session for the whole conversation', sessions === '1', `sessions=${sessions}`);
check('exactly three messages (2 in, 1 out)', messages === '3' && outs === '1',
  `messages=${messages} out=${outs}`);
check('test rows removed (lead cascaded to messages)', val(one, 'cleanup') === '0', val(one, 'cleanup'));

// ── Scenario 2: the transcript the brain reads ───────────────────────
// Assertions here are on real rows, not counters: "oldest first" and "the message being
// answered is absent" are the two things that change what the model says.
const two = parse(psql(`
${prepare('inbound')}
${prepare('history')}
${prepare('outbound')}
delete from lead where wa_number = '${LEAD}';
delete from lead where wa_number = '${LEAD2}';
EXECUTE inbound('${LEAD}','Abu Kawser','${M1}','${B1}') \\gset r_
EXECUTE inbound('${LEAD}',null,'${M2}','${B2}');
EXECUTE outbound(:'r_session_id','${OUT}','${REPLY}');
\\echo ##prior_to_M2
EXECUTE history(:'r_session_id','${M2}',20);
\\echo ##capped
EXECUTE history(:'r_session_id','${M2}',0);
\\echo ##no_history
delete from lead where wa_number = '${LEAD}';
EXECUTE inbound('${LEAD}','Abu Kawser','${M1}','${B1}') \\gset s_
EXECUTE history(:'s_session_id','${M1}',20);
\\echo ##sid_r :r_session_id
\\echo ##second_lead_start
EXECUTE inbound('${LEAD2}','Nodi','${M3}','${B2}') \\gset q_
\\echo ##sid_q :q_session_id
\\echo ##second_lead
EXECUTE history(:'q_session_id','${M3}',20);
delete from lead where wa_number = '${LEAD}';
delete from lead where wa_number = '${LEAD2}';
`));

// Rows are `session_id|direction|body`, which is what lets one node output carry the
// transcripts of several leads from a single webhook without mixing them up.
const turn = (r) => { const [session_id, direction, ...rest] = r.split('|'); return { session_id, direction, body: rest.join('|') }; };
const prior = rows(two, 'prior_to_M2').map(turn);
const sidR = val(two, 'sid_r');
// M1 arrived, the agent answered, then M2 arrived. So the history for M2 is two turns:
// the lead's first message and the agent's own reply. Anything else here means the bot is
// answering the same question twice, or has forgotten it already asked for a budget.
check('history returns both prior turns and nothing else', prior.length === 2, JSON.stringify(prior));
check('every history row carries the session it belongs to',
  prior.every((r) => r.session_id === sidR), JSON.stringify(prior));
check('history renders session, direction and body',
  prior.every((r) => (r.direction === 'in' || r.direction === 'out') && r.body.length),
  JSON.stringify(prior));
check('history excludes the message being answered',
  !prior.some((r) => r.body.includes('offer ta bolo')), JSON.stringify(prior));
check('the agent can see its own previous reply',
  prior.some((r) => r.direction === 'out'), JSON.stringify(prior));
check('transcript order is oldest first: inbound turn, then the reply',
  prior[0]?.direction === 'in' && prior[1]?.direction === 'out', JSON.stringify(prior));
check('history honours the cap', rows(two, 'capped').length === 0, JSON.stringify(rows(two, 'capped')));
// Asking for the history of the only message in the session must come back empty, and
// must NOT count the reply written after it: the exclusion is by wamid, not by "everything
// before now", which a retried webhook would break.
check('a first message has no history at all', rows(two, 'no_history').length === 0,
  JSON.stringify(rows(two, 'no_history')));
// Two leads answering the same sentence must not share a conversation. This is the case
// the session_id column exists for: one node output, two transcripts, grouped by key.
check('a second lead gets its own session and an empty transcript',
  val(two, 'sid_r') !== session && val(two, 'sid_q') !== val(two, 'sid_r')
    && rows(two, 'second_lead').length === 0,
  `sid_q=${val(two, 'sid_q')} rows=${JSON.stringify(rows(two, 'second_lead'))}`);


// ── Scenario 3: one turn recorded, and the enums that must be impossible ─
const three = parse(psql(`
${prepare('inbound')}
${prepare('turn')}
delete from lead where wa_number = '${LEAD}';
EXECUTE inbound('${LEAD}','Abu Kawser','${M1}','${B1}') \\gset r_

EXECUTE turn(:'r_session_id','${M1}','specific_programme',30000,'now','self',0.9,
  'gemini-3.1-flash-lite','flash',0,'{"need":"specific_programme"}',
  25,20,25,15,85,'hot','v1','["hot_lead_alert","slot_choice_missing"]') \\gset h_
EXECUTE turn(:'r_session_id','${M1}','vague',null,'unknown','unknown',0.2,
  'gemini-3.8-flash','escalated',1,'{}',7,0,0,0,7,null,'v1','[]') \\gset n_

\\echo ##hot_id :h_extraction_id
\\echo ##hot_score :h_score_written
\\echo ##hot_esc :h_escalations_written
\\echo ##null_id :n_extraction_id
\\echo ##null_score :n_score_written
\\echo ##null_esc :n_escalations_written
\\echo ##audit
select (select count(*) from extraction where session_id = :'r_session_id')
  || '|' || (select count(*) from score where session_id = :'r_session_id')
  || '|' || (select count(*) from score where session_id = :'r_session_id' and hotness is null)
  || '|' || (select count(*) from escalation where session_id = :'r_session_id')
  || '|' || (select raw @> '{"need":"specific_programme"}'::jsonb from extraction where id = :'h_extraction_id');
delete from lead where wa_number = '${LEAD}';
\\echo ##gone
select count(*) from extraction where session_id = :'r_session_id';
`));

check('a hot turn writes an extraction and its score row',
  /^\d+$/.test(val(three, 'hot_id') ?? '') && isTrue(val(three, 'hot_score')),
  `id=${val(three, 'hot_id')} score=${val(three, 'hot_score')}`);
check('both escalation codes land as rows', val(three, 'hot_esc') === '2', val(three, 'hot_esc'));
check('a low-confidence turn keeps its row with hotness NULL',
  isTrue(val(three, 'null_score')) && val(three, 'null_esc') === '0',
  `score=${val(three, 'null_score')} esc=${val(three, 'null_esc')}`);
const [ex, sc, nullHot, esc, rawKept] = (val(three, 'audit') ?? '').split('|');
check('two extractions, two scores, one null hotness',
  ex === '2' && sc === '2' && nullHot === '1' && esc === '2', val(three, 'audit'));
// `text || boolean` renders a Postgres bool as the word 'true', not as 't' — the cast is
// what the concatenation does, not anything the database is hiding.
check('the model\'s own JSON is retained for audit', rawKept === 'true', rawKept);
check('deleting the lead cascades the turn rows', val(three, 'gone') === '0', val(three, 'gone'));

// The drift that already happened, proven impossible. Each of these VALUES is something
// the pipeline emitted or could emit; before 002_constraints.sql every one was accepted and
// scored as 0 points, which turned a hot lead cold without an error anywhere in the stack.
const lastLine = (out) => out.split('\n').filter((l) => l.trim() !== '').pop()?.trim() ?? '';
const badLead = lastLine(psql(`delete from lead where wa_number = '${LEAD}';
insert into lead (wa_number, display_name) values ('${LEAD}','verifier') returning id;`));
const badSession = psql(`insert into session (lead_id, status) values ('${badLead}','open') returning id;`).trim();
check('constraint fixture created', /^[0-9a-f-]{36}$/.test(badSession), badSession);
const EXTRACTION = psql(`insert into extraction (session_id, model, tier, raw) values ('${badSession}','m','flash','{}'::jsonb) returning id;`).trim();

const CONSTRAINTS = [
  ['timeline outside core/vocab.mjs', `insert into extraction (session_id, timeline, model, tier, raw) values ('${badSession}','1m','m','flash','{}'::jsonb);`, 'extraction_timeline_check'],
  ['authority outside core/vocab.mjs', `insert into extraction (session_id, authority, model, tier, raw) values ('${badSession}','team','m','flash','{}'::jsonb);`, 'extraction_authority_check'],
  ['a step label used as a tier', `insert into extraction (session_id, model, tier, raw) values ('${badSession}','m','route','{}'::jsonb);`, 'extraction_tier_check'],
  ['a negative budget', `insert into extraction (session_id, budget_bdt, model, tier, raw) values ('${badSession}',-5,'m','flash','{}'::jsonb);`, 'extraction_budget_bdt_check'],
  ['confidence above 1', `insert into extraction (session_id, confidence, model, tier, raw) values ('${badSession}',1.5,'m','flash','{}'::jsonb);`, 'extraction_confidence_check'],
  ['a session status no query knows', `insert into session (lead_id, status) values ('${badLead}','hot');`, 'session_status_check'],
  ['a reason code nothing emits', `insert into escalation (session_id, reason_code) values ('${badSession}','injection_suspected');`, 'escalation_reason_code_check'],
  ['a hotness outside the enum', `insert into score (extraction_id, session_id, need_pts, budget_pts, timeline_pts, authority_pts, total, hotness, rule_version) values (${EXTRACTION},'${badSession}',1,1,1,1,4,'boiling','v1');`, 'score_hotness_check'],
];
console.log('\n  constraints — each of these was silently accepted before 002\n');
for (const [name, stmt, constraint] of CONSTRAINTS) {
  const r = psqlExpectFail(stmt, constraint);
  check(`rejected: ${name}`, r.ok, r.why);
}
psql(`delete from lead where wa_number = '${LEAD}';`);

if (failures.length) {
  console.log(`\nSQL NOT SAFE TO SHIP — ${failures.length} failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\n${pass} checks passed — db/queries/*.sql is safe to inline into the workflow.`);
