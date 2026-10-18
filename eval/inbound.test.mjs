// The WhatsApp edge: reshaping Meta's payload and unwrapping what n8n forwards.
//
// These tests exist because the normaliser used to live inside a Code node, where
// it could only be exercised by firing a real webhook at a running stack. As a
// module it is checked against captured payload shapes offline, including the ones
// that are not a plain text message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { normaliseInbound, buildTranscript } from '../core/normalise.mjs';
import { unwrapEncapsulation } from '../core/inbound.mjs';
import { answerVerify } from '../core/verify-handshake.mjs';

const NOW = new Date('2026-10-17T16:00:00+06:00');

function metaBody(messages, extra = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1022980686398820',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551234567', phone_number_id: '100000000000000' },
          contacts: [{ profile: { name: 'Rahim Uddin' }, wa_id: '8801711111111' },
                     { profile: { name: 'Karim N.' }, wa_id: '8801822222222' }],
          ...extra,
          ...(messages ? { messages } : {}),
        },
      }],
    }],
  };
}

test('a text message normalises into the shape the flow uses', () => {
  const r = normaliseInbound(metaBody([
    { from: '8801711111111', id: 'wamid.A', timestamp: '1760000000', type: 'text', text: { body: 'hello' } },
  ]), { now: NOW });
  assert.equal(r.messages.length, 1);
  const m = r.messages[0];
  assert.equal(m.wamid, 'wamid.A');
  assert.equal(m.wa_number, '8801711111111');
  assert.equal(m.profile_name, 'Rahim Uddin', 'the display name comes from Meta, not the model');
  assert.equal(m.body, 'hello');
  assert.equal(m.status, 'received');
  assert.equal(m.sent_at, new Date(1760000000 * 1000).toISOString(), "Meta's timestamp is kept, not ours");
  assert.equal(m.received_at, NOW.toISOString());
});

test('several messages in one POST become several items, deduped by wamid downstream', () => {
  const r = normaliseInbound(metaBody([
    { from: '8801711111111', id: 'wamid.A', type: 'text', text: { body: 'one' } },
    { from: '8801822222222', id: 'wamid.B', type: 'text', text: { body: 'two' } },
    { from: '8801822222222', id: 'wamid.C', type: 'text', text: { body: 'three' } },
  ]), { now: NOW });
  assert.deepEqual(r.messages.map((m) => m.wamid), ['wamid.A', 'wamid.B', 'wamid.C']);
  assert.equal(r.messages[1].profile_name, 'Karim N.', 'contacts are matched by wa_id, not by order');
});

// WhatsApp sends audio, stickers, documents, locations, reactions, button replies…
// A flow that assumes msg.text.body exists throws on the first voice note and the
// lead never gets an answer.
test('a voice note arrives with a null body rather than crashing', () => {
  const r = normaliseInbound(metaBody([
    { from: '8801711111111', id: 'wamid.V', type: 'audio', audio: { mime_type: 'audio/mpeg', id: 'x' } },
  ]), { now: NOW });
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].body, null);
  assert.equal(r.messages[0].message_type, 'audio');
});

test('delivery receipts are surfaced, failures included', () => {
  const r = normaliseInbound(metaBody(null, {
    statuses: [
      { id: 'wamid.A', status: 'delivered', recipient_id: '8801711111111' },
      { id: 'wamid.Z', status: 'failed', recipient_id: '8801822222222',
        errors: [{ code: 131047, title: 'Re-engagement message', message: 'Failed to send re-engagement' }] },
    ],
  }), { now: NOW });
  assert.equal(r.messages.length, 0);
  assert.equal(r.statuses.length, 2);
  assert.equal(r.statuses[1].error_code, 131047, 'a failed send must not look like a delivered one');
  assert.equal(r.ignored, false, 'a receipt is work, not noise');
});

test('a read receipt alone is an ordinary nothing-to-do', () => {
  const r = normaliseInbound(metaBody(null, {}), { now: NOW });
  assert.equal(r.ignored, true);
  assert.equal(r.reason, 'no_messages_in_payload');
});

test('a message with no wamid is dropped, since it cannot be deduped', () => {
  const r = normaliseInbound(metaBody([{ from: '8801711111111', type: 'text', text: { body: 'no id' } }]), { now: NOW });
  assert.equal(r.messages.length, 0);
});

test('a change on a non-messages field is ignored', () => {
  const body = metaBody([{ from: '8801711111111', id: 'wamid.A', type: 'text', text: { body: 'x' } }]);
  body.entry[0].changes[0].field = 'account_update';
  assert.equal(normaliseInbound(body, { now: NOW }).ignored, true);
});

test('an empty or malformed body does not throw', () => {
  for (const b of [undefined, null, {}, { entry: [] }, { entry: [{ changes: [{}] }] }]) {
    const r = normaliseInbound(b, { now: NOW });
    assert.equal(r.messages.length, 0);
  }
});

// ── Transcript assembly ──────────────────────────────────────────────
test('history and the new message become a transcript in order', () => {
  const t = buildTranscript([
    { direction: 'in', body: 'hi' },
    { direction: 'out', body: 'hello, what do you need?' },
  ], 'a whatsapp bot, 30000 tk');
  assert.deepEqual(t, [
    { role: 'lead', text: 'hi' },
    { role: 'assistant', text: 'hello, what do you need?' },
    { role: 'lead', text: 'a whatsapp bot, 30000 tk' },
  ]);
});

test('a bodyless historical message is skipped, not sent as an empty turn', () => {
  const t = buildTranscript([{ direction: 'in', body: null }, { direction: 'out', body: 'ok?' }], 'now');
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.role), ['assistant', 'lead']);
});

// ── The n8n forwarding shape ─────────────────────────────────────────
test('a base64-wrapped body unwraps to the exact original bytes', () => {
  const original = Buffer.from(JSON.stringify(metaBody([
    { from: '8801711111111', id: 'wamid.A', type: 'text', text: { body: 'আমার ক্লিনিক' } },
  ])), 'utf8');
  const wrapped = Buffer.from(JSON.stringify({
    b64: original.toString('base64'),
    signature: 'sha256=' + createHmac('sha256', 's3cret').update(original).digest('hex'),
  }), 'utf8');

  const out = unwrapEncapsulation(wrapped);
  assert.deepEqual(out.raw, original, 'byte-for-byte, or the HMAC cannot match');
  assert.equal(out.header.slice(0, 7), 'sha256=');
});

test('a genuine Meta POST is passed through unwrapped', () => {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), 'utf8');
  const out = unwrapEncapsulation(raw);
  assert.equal(out.raw, raw, 'same buffer, not a copy');
  assert.equal(out.header, null, 'the signature stays on the real header');
});

test('a JSON body with no b64 field is not mistaken for a wrapped payload', () => {
  const raw = Buffer.from('{"hello":"world"}', 'utf8');
  const out = unwrapEncapsulation(raw);
  assert.equal(out.raw, raw);
  assert.equal(out.header, null);
});

test('a b64 that does not decode back to itself is rejected as a wrapper', () => {
  // Guards against a caller smuggling a different body than the one it signed.
  const out = unwrapEncapsulation(Buffer.from(JSON.stringify({ b64: '###not base64###' }), 'utf8'));
  assert.equal(out.header, null);
});

// ── The handoff to n8n ───────────────────────────────────────────────
// The edge answers Meta only after the pipeline has taken the message. Nothing else in
// the stack has written it yet, so a 200 before the handoff would acknowledge a delivery
// that no database ever saw — and Meta stops retrying anything it saw acknowledged.
process.env.WHATSAPP_APP_SECRET = 'handoff-test-secret';

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s ?? ''; },
    get json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
}

function signedReq(payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = 'sha256=' + createHmac('sha256', 'handoff-test-secret').update(raw).digest('hex');
  return { raw, req: { headers: { 'x-hub-signature-256': header } } };
}

const { handleInbound } = await import('../core/inbound.mjs');

test('a verified message is handed off before the 200', async () => {
  const { raw, req } = signedReq(metaBody([
    { from: '8801711111111', id: 'wamid.H1', type: 'text', text: { body: 'bajet 30000' } },
  ]));
  const seen = [];
  const res = fakeRes();
  await handleInbound(req, res, { rawBody: raw, dispatch: async (p) => { seen.push(p); return { ok: true }; } });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(seen.length, 1, 'the pipeline got exactly one handoff');
  assert.equal(seen[0].messages[0].wamid, 'wamid.H1');
  assert.equal(seen[0].verified, true, 'the workflow refuses anything the verifier did not sign');
  assert.equal(seen[0].phone_number_id, '100000000000000', 'the send needs to know which line');
});

test('a pipeline that will not take the message gets no ack', async () => {
  const { raw, req } = signedReq(metaBody([
    { from: '8801711111111', id: 'wamid.H2', type: 'text', text: { body: 'hello' } },
  ]));
  const res = fakeRes();
  await handleInbound(req, res, { rawBody: raw, dispatch: async () => ({ ok: false, reason: 'http_500' }) });

  // 502, not 200: this is the whole retry story. Meta re-posts, the wamid collides with
  // nothing (the first attempt never wrote a row), and the lead still gets an answer.
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.json.error, 'pipeline_unavailable');
});

test('a receipt-only POST is acked without a handoff', async () => {
  const { raw, req } = signedReq(metaBody(null, {
    statuses: [{ id: 'wamid.OUT1', status: 'delivered', recipient_id: '8801711111111' }],
  }));
  let called = 0;
  const res = fakeRes();
  await handleInbound(req, res, { rawBody: raw, dispatch: async () => { called += 1; return { ok: true }; } });

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(called, 0, 'nothing answerable means nothing to hand off');
});

test('an unsigned POST never reaches the pipeline', async () => {
  const raw = Buffer.from(JSON.stringify(metaBody([
    { from: '8801799999999', id: 'wamid.FAKE', type: 'text', text: { body: 'fake lead' } },
  ])), 'utf8');
  let called = 0;
  const res = fakeRes();
  await handleInbound({ headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }, res,
    { rawBody: raw, dispatch: async () => { called += 1; return { ok: true }; } });

  assert.equal(res.statusCode, 401, res.body);
  assert.equal(called, 0, 'the pipeline must not be a place to inject leads');
});

// ── the subscription handshake: Meta's GET before any message exists ──

const q = (over = {}) => ({
  'hub.mode': 'subscribe',
  'hub.verify_token': 'round-trip-token',
  'hub.challenge': 'FACECHECK-123',
  ...over,
});

test('the handshake echoes the challenge only for the configured token', () => {
  const ok = answerVerify(q(), { verifyToken: 'round-trip-token' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'FACECHECK-123');

  const bad = answerVerify(q({ 'hub.verify_token': 'guessed' }), { verifyToken: 'round-trip-token' });
  assert.equal(bad.status, 403);
  assert.equal(bad.body, '', 'a wrong token must not receive the challenge');
});

test('an endpoint with no verify token configured refuses to subscribe', () => {
  const res = answerVerify(q(), { verifyToken: '' });
  assert.equal(res.status, 503, 'unconfigured is not the same as accepted');
  assert.equal(res.reason, 'verify_token_not_configured');
});

test('a request that is not a subscribe is not a handshake', () => {
  assert.equal(answerVerify(q({ 'hub.mode': 'unsubscribe' }), { verifyToken: 'round-trip-token' }).status, 403);
  assert.equal(answerVerify({}, { verifyToken: 'round-trip-token' }).status, 403);
});

test('a matching token with no challenge to echo still fails closed', () => {
  const res = answerVerify(q({ 'hub.challenge': '' }), { verifyToken: 'round-trip-token' });
  assert.equal(res.status, 403);
  assert.equal(res.reason, 'no_challenge');
});
