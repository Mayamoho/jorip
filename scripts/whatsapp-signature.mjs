// Meta signs every WhatsApp webhook POST with HMAC-SHA256 over the raw
// request body, keyed by the App secret, in the X-Hub-Signature-256 header.
//
// Verifying it is not optional polish. A tunnel URL is a guessable-free-for-all:
// without this check anyone who learns it can POST a payload claiming to be
// any phone number and write straight into the CRM, or make the agent spam a
// real customer. The demo's whole "server owns the truth" argument collapses
// if the server trusts an unsigned body.
//
// Kept standalone and unit-tested so the crypto is proven independently of
// how the n8n Code node happens to surface the raw body.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const MISSING = 'missing_signature';
export const MISMATCH = 'signature_mismatch';
export const NO_SECRET = 'secret_not_configured';

/**
 * @param rawBody   the exact bytes Meta sent, before any JSON parsing.
 *                  Re-serialising a parsed object changes whitespace or key
 *                  order and the HMAC will not match.
 * @param header    value of X-Hub-Signature-256, e.g. "sha256=1a2b…"
 * @param secret    App secret from Meta → App settings → Basic.
 */
export function verifySignature({ rawBody, header, secret }) {
  if (!secret) return { ok: false, reason: NO_SECRET };
  if (!header || typeof header !== 'string' || !header.startsWith('sha256=')) {
    return { ok: false, reason: MISSING };
  }
  if (rawBody === undefined || rawBody === null) return { ok: false, reason: MISSING };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'), 'utf8');
  const received = Buffer.from(header, 'utf8');

  // Compare lengths before timingSafeEqual — it throws on unequal buffers,
  // and the throw itself would leak the length through an error response.
  if (expected.length !== received.length) return { ok: false, reason: MISMATCH };

  const ok = timingSafeEqual(expected, received);
  return { ok, reason: ok ? null : MISMATCH };
}

/**
 * Pull the raw bytes out of whatever shape n8n hands us. The webhook node
 * exposes them differently depending on version and on whether the payload
 * was parsed, so try each in the order that preserves the original bytes.
 *
 * Always returns { buffer, lossy } or null. `lossy` means the body had already
 * been re-serialised before we saw it, so no signature can be trusted.
 */
export function rawBodyFromItem(item) {
  if (item?.binary?.data) return { buffer: Buffer.from(item.binary.data, 'base64'), lossy: false };
  if (typeof item?.json?.body === 'string') return { buffer: Buffer.from(item.json.body, 'utf8'), lossy: false };
  if (item?.json?.body && typeof item.json.body === 'object') {
    // Already parsed. Best effort, and flagged rather than silently trusted.
    return { buffer: Buffer.from(JSON.stringify(item.json.body), 'utf8'), lossy: true };
  }
  return null;
}

export function headerFromItem(item) {
  const headers = item?.json?.headers ?? {};
  const found = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-hub-signature-256');
  return found ? found[1] : undefined;
}
