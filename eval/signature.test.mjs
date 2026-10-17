import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, rawBodyFromItem, headerFromItem, MISSING, MISMATCH, NO_SECRET } from '../scripts/whatsapp-signature.mjs';

const SECRET = 'test-app-secret-0123456789abcdef';
const sign = (b) => 'sha256=' + createHmac('sha256', SECRET).update(b).digest('hex');

const META_BODY = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: '8801711223344', profile: { name: 'Rafid' } }],
    messages: [{ id: 'wamid.HBgNODg', from: '8801711223344', timestamp: '1760000000', type: 'text', text: { body: 'ফি কত?' } }],
  }}]}],
});

test('a genuine Meta POST passes', () => {
  const r = verifySignature({ rawBody: Buffer.from(META_BODY), header: sign(META_BODY), secret: SECRET });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('one changed byte fails — this is what a forged lead looks like', () => {
  const tampered = META_BODY.replace('8801711223344', '8801700000000');
  const r = verifySignature({ rawBody: Buffer.from(tampered), header: sign(META_BODY), secret: SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.reason, MISMATCH);
});

test('a valid signature for a different body fails', () => {
  const other = META_BODY.replace('ফি কত?', 'আমাকে ব্লক করো');
  const r = verifySignature({ rawBody: Buffer.from(META_BODY), header: sign(other), secret: SECRET });
  assert.equal(r.ok, false);
});

test('no header at all is rejected, not treated as unsigned-but-fine', () => {
  for (const header of [undefined, null, '', 'sha512=abc', 'abc']) {
    const r = verifySignature({ rawBody: Buffer.from(META_BODY), header, secret: SECRET });
    assert.equal(r.ok, false, `header ${JSON.stringify(header)} must not pass`);
    assert.equal(r.reason, MISSING);
  }
});

test('an unconfigured secret fails closed', () => {
  const r = verifySignature({ rawBody: Buffer.from(META_BODY), header: sign(META_BODY), secret: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NO_SECRET);
});

test('a wrong secret fails', () => {
  const r = verifySignature({ rawBody: Buffer.from(META_BODY), header: sign(META_BODY), secret: 'someone-elses-secret' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, MISMATCH);
});

test('a header of a different length is rejected without throwing', () => {
  // timingSafeEqual throws on length mismatch; that path must not be reachable.
  assert.doesNotThrow(() => verifySignature({ rawBody: Buffer.from(META_BODY), header: 'sha256=short', secret: SECRET }));
  assert.equal(verifySignature({ rawBody: Buffer.from(META_BODY), header: 'sha256=short', secret: SECRET }).ok, false);
});

test('a string body and a Buffer body of the same bytes agree', () => {
  const h = sign(META_BODY);
  assert.equal(verifySignature({ rawBody: META_BODY, header: h, secret: SECRET }).ok, true);
  assert.equal(verifySignature({ rawBody: Buffer.from(META_BODY, 'utf8'), header: h, secret: SECRET }).ok, true);
});

test('Bangla and emoji survive the byte comparison', () => {
  const body = JSON.stringify({ text: 'ঠিক আছে 😀 ৳৫০০' });
  assert.equal(verifySignature({ rawBody: Buffer.from(body, 'utf8'), header: sign(body), secret: SECRET }).ok, true);
});

// ── n8n item shape ───────────────────────────────────────────────────

test('raw body is read from binary.data as base64, preserving bytes', () => {
  const item = { binary: { data: Buffer.from(META_BODY, 'utf8').toString('base64') }, json: {} };
  const raw = rawBodyFromItem(item);
  assert.equal(raw.lossy, false);
  assert.equal(raw.buffer.toString('utf8'), META_BODY);
  assert.equal(verifySignature({ rawBody: raw.buffer, header: headerFromItem({ json: { headers: { 'x-hub-signature-256': sign(META_BODY) } } }), secret: SECRET }).ok, true);
});

test('header lookup is case-insensitive', () => {
  for (const key of ['X-Hub-Signature-256', 'x-hub-signature-256']) {
    assert.equal(headerFromItem({ json: { headers: { [key]: 'sha256=deadbeef' } } }), 'sha256=deadbeef');
  }
});

test('a re-serialised body is reported, because it cannot be trusted', () => {
  const item = { json: { body: { object: 'whatsapp_business_account', z: 1, a: 2 } } };
  const raw = rawBodyFromItem(item);
  assert.equal(raw.lossy, true);
  // Key order changed by the parser means the HMAC cannot match, so this must
  // fail closed rather than pass on a lucky re-serialisation.
  assert.equal(verifySignature({ rawBody: raw.buffer, header: 'sha256=x', secret: SECRET }).ok, false);
});

test('an item with no body at all yields null', () => {
  assert.equal(rawBodyFromItem({ json: {} }), null);
  assert.equal(rawBodyFromItem(undefined), null);
});
