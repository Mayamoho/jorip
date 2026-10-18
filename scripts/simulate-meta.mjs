// Prove the WhatsApp path end to end without waiting on Meta.
//
// What this verifies, in order:
//   1. a correctly signed POST passes the edge and normalises
//   2. one changed byte is rejected — that is what a forged lead looks like
//   3. the same wamid inserted twice yields one row: Meta's retry cannot
//      produce a second reply
//   4. a real turn produces a decision, a reply and measured token usage
//
// What this deliberately cannot verify: that Meta itself will post to your URL.
// That needs a public HTTPS callback. Saying "round trip verified" without this
// line in the README would be a lie, so it is here instead.
//
//   node --env-file=.env scripts/simulate-meta.mjs

import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// JORIP_BRAIN_URL is how n8n reaches the brain (a container name). Run from the
// host, so default to loopback and let the caller override with SIM_BRAIN_URL.
const BRAIN = process.env.SIM_BRAIN_URL ?? 'http://127.0.0.1:8788';
const SECRET = process.env.WHATSAPP_APP_SECRET || '';
const TOKEN = process.env.JORIP_SHARED_SECRET || '';

if (!SECRET) {
  console.error('WHATSAPP_APP_SECRET is empty. Set one for the test, e.g.\n' +
    '  WHATSAPP_APP_SECRET=dev-secret node --env-file=.env scripts/simulate-meta.mjs\n' +
    '(the edge fails closed without it — that is the correct behaviour, not a bug)');
  process.exit(2);
}

const WAMID = `wamid.HBgNODgwMTcxMTExMTExMQUCABIYFD${randomBytes(6).toString('hex').toUpperCase()}=`;
const LEAD_NUMBER = '8801711111111';

function metaPayload(bodyText, wamid = WAMID) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1022980686398820',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551234567', phone_number_id: '100000000000000' },
          contacts: [{ profile: { name: 'Rahim Uddin' }, wa_id: LEAD_NUMBER }],
          messages: [{
            from: LEAD_NUMBER, id: wamid, timestamp: '1760000000', type: 'text',
            text: { body: bodyText },
          }],
        },
      }],
    }],
  };
}

const sign = (buf) => 'sha256=' + createHmac('sha256', SECRET).update(buf).digest('hex');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function post(path, { body, headers = {} }) {
  let res;
  try {
    res = await fetch(`${BRAIN}${path}`, { method: 'POST', headers, body });
  } catch (e) {
    // A diagnostic that dumps an undici stack is not a diagnostic. Say what is
    // missing and let the rest of the run report what it managed to reach.
    return { status: 0, json: null, contentType: null, unreachable: e?.cause?.code ?? e.message };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-json responses are their own finding */ }
  return { status: res.status, json, contentType: res.headers.get('content-type') };
}

function psql(sql) {
  try {
    return execFileSync('docker', ['compose', 'exec', '-T', 'postgres',
      'psql', '-U', 'jorip', '-d', 'jorip', '-tAc', sql], { encoding: 'utf8' }).trim();
  } catch (e) {
    return { psqlError: (e.stderr ?? e.message).toString().trim().split('\n').pop() };
  }
}
const psqlFailed = (r) => typeof r === 'object';

// psql -t still prints the "INSERT 0 1" command tag after a RETURNING column, so
// grabbing the whole output gives you a uuid with a sentence glued to it.
const asUuid = (r) => (typeof r === 'string'
  ? r.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? ''
  : '');

// `INSERT 0 N` is the command tag: N rows landed. A duplicate returns 0, which is
// the pass condition for the retry test — not an empty string.
const rowsInserted = (r) => (typeof r === 'string' ? Number(r.match(/INSERT 0 (\d+)/)?.[1] ?? -1) : -1);

console.log(`\nJorip — WhatsApp round-trip simulation against ${BRAIN}\n`);

// Reachability first, so every later failure reads as a cause rather than a mystery.
let ping = null;
try {
  ping = await (await fetch(`${BRAIN}/healthz`)).json();
} catch { ping = null; }
if (!ping) {
  console.error(`Cannot reach the brain at ${BRAIN}.\n` +
    'Start it first:\n' +
    '  WHATSAPP_APP_SECRET=dev-round-trip-secret JORIP_BRAIN_HOST=127.0.0.1 \\\n' +
    '    node --env-file=.env scripts/brain-server.mjs &\n');
  process.exit(2);
}

// A lead that should score hot: specific need, stated budget, immediate timeline,
// and they are the decision-maker.
const TEXT = 'আমার ক্লিনিকের জন্য হোয়াটসঅ্যাপ অটোমেশন লাগবে, বাজেট ৩০০০০ টাকা, এই মাসেই শুরু করতে চাই. I decide myself.';
const rawOk = Buffer.from(JSON.stringify(metaPayload(TEXT)), 'utf8');

// 1 + 2 — the edge
const good = await post('/whatsapp-in', {
  body: rawOk,
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(rawOk) },
});
record('genuine Meta-shaped POST is accepted',
  good.status === 200 && good.json?.verified === true,
  `http ${good.status}, ${good.json?.messages?.length ?? 0} message(s)`);
record('the Bangla body survives the byte-for-byte trip',
  good.json?.messages?.[0]?.body?.includes('ক্লিনিক'),
  JSON.stringify(good.json?.messages?.[0]?.profile_name ?? null));
record('wamid is carried through as the dedupe key',
  good.json?.messages?.[0]?.wamid === WAMID, good.json?.messages?.[0]?.wamid);

const tampered = Buffer.from(JSON.stringify(metaPayload(TEXT.replace('৩০০০০', '৩০০০০০'))), 'utf8');
const forged = await post('/whatsapp-in', {
  body: tampered,
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(rawOk) },
});
record('a valid signature over a different body is rejected',
  forged.status === 401, `http ${forged.status} ${forged.json?.error ?? ''}`);

const garbage = await post('/whatsapp-in', {
  body: rawOk,
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
});
record('an unsigned POST is rejected', garbage.status === 401, `http ${garbage.status}`);

// 3 — idempotency against the real database, not a mock
const probe = psql('select 1');
if (psqlFailed(probe)) {
  record('postgres reachable for the dedupe check', false, probe.psqlError);
} else {
  // Re-runnable by construction: the live pipeline may already have opened this lead's
  // session, and `session_one_open_per_lead` then rejects a second one. Reuse what is open
  // and only delete the session this test actually created — otherwise the second run of
  // this script fails on a constraint that is working correctly, which reads as a bug in
  // the product rather than in the test.
  const sidRes = psql(`
    with l as (
      insert into lead (wa_number, display_name) values ('${LEAD_NUMBER}', 'Simulated Lead')
      on conflict (wa_number) do update set display_name = excluded.display_name returning id
    ), open_sess as (
      select id from session
      where lead_id in (select id from l) and status = 'open'
      order by updated_at desc limit 1
    ), new_sess as (
      insert into session (lead_id, status, context)
      select l.id, 'open', '{}'::jsonb from l where not exists (select 1 from open_sess)
      on conflict (lead_id) where status = 'open' do nothing returning id
    )
    select id, 'reused' from open_sess
    union all select id, 'created' from new_sess
    limit 1`);
  if (psqlFailed(sidRes)) {
    record('simulated lead + session available', false, sidRes.psqlError);
  } else {
    const sid = asUuid(sidRes);
    const madeNew = sidRes.includes('created');
    record('simulated lead + session available', !!sid, `${sid.slice(0, 8)} (${madeNew ? 'created' : 'reused the open one'})`);

    // The signed POST above went through the real pipeline, so the row for this wamid may
    // already exist — stored by the workflow, not by this script. Ask the database which
    // case it is rather than inserting blind and calling a conflict a failure.
    const already = psql(`select count(*) from message where wamid = '${WAMID}'`);
    const storedByPipeline = !psqlFailed(already) && Number(already) > 0;
    const firstTag = storedByPipeline ? 'INSERT 0 1 (already there)' : psql(`
      insert into message (wamid, session_id, direction, body)
      values ('${WAMID}', '${sid}', 'in', 'simulated') on conflict (wamid) do nothing returning wamid`);
    const second = psql(`
      insert into message (wamid, session_id, direction, body)
      values ('${WAMID}', '${sid}', 'in', 'simulated') on conflict (wamid) do nothing returning wamid`);
    record('first delivery of a wamid is inserted',
      storedByPipeline || (rowsInserted(firstTag) === 1 && String(firstTag).includes(WAMID)),
      storedByPipeline ? 'stored by the live pipeline from the signed POST' : `rows inserted: ${rowsInserted(firstTag)}`);
    record('Meta retrying the same wamid inserts nothing, so the flow stops',
      rowsInserted(second) === 0 && !asUuid(second),
      `rows inserted: ${rowsInserted(second)} — a 1 here would reply twice`);
    psql(`delete from message where wamid = '${WAMID}'`);
    if (madeNew) psql(`delete from session where id = '${sid}'`);
    psql(`delete from lead where wa_number = '${LEAD_NUMBER}' and display_name = 'Simulated Lead'`);
  }
}

// 4 — a real turn, on a real model
if (!TOKEN) {
  record('JORIP_SHARED_SECRET set (needed for /reply)', false, 'skipping the live turn');
} else {
  const turn = await post('/reply', {
    body: JSON.stringify({
      messages: [{ role: 'lead', text: good.json?.messages?.[0]?.body ?? TEXT }],
    }),
    headers: { 'content-type': 'application/json', 'x-jorip-token': TOKEN },
  });
  const d = turn.json ?? {};
  record('/reply answers a signed-in caller', turn.status === 200, `http ${turn.status}`);
  record('the lead scores hot on need+budget+timeline+authority',
    d.hotness === 'hot', `total ${d.score?.total}, action ${d.action}`);
  record('the budget extracted is the one stated, not invented',
    d.extraction?.budget_bdt === 30000, `got ${d.extraction?.budget_bdt}`);
  record('the timeline is spelled the way the scorer reads it',
    d.extraction?.timeline === 'now' || d.extraction?.timeline === 'within_month',
    `got ${d.extraction?.timeline}`);
  record('a slot is offered only from the server-owned space',
    !d.action || d.action !== 'offer_slot' || (d.slot_offered && d.slots_offered?.length),
    d.slot_offered ? d.slot_offered.label : 'no slot offered this turn');
  record('the reply came from the model, not the fallback template',
    d.reply_source === 'model', d.reply?.slice(0, 90));

  const u = (d.usage ?? []);
  console.log('\n  measured this turn:');
  for (const c of u) {
    console.log(`    ${String(c.step).padEnd(7)} ${String(c.model).padEnd(24)} ${String(c.tier).padEnd(10)} ` +
      `${c.tokens_in} in / ${c.tokens_out} out / ${c.cached_tokens} cached  ${c.latency_ms} ms${c.error ? '  ' + c.error : ''}`);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  console.log('Unverified or broken:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
console.log('Not covered by this run: Meta posting to you over the public internet.');
console.log('That needs a public HTTPS callback URL — see docs/TUNNEL.md.');
process.exit(failed.length ? 1 : 0);
