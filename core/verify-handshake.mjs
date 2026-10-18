// Meta's webhook handshake, the side that happens before any message exists.
//
// When someone pastes a callback URL into the WhatsApp Business app dashboard, Meta first
// sends GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… and requires an exact
// 200 echo of `challenge`. Nothing is stored, no model is called, no database is touched —
// this is the one route that answers before the HMAC, because there is no body to sign yet.
//
// Fail-closed in all three directions:
//   * no WHATSAPP_VERIFY_TOKEN configured  → 503. An unconfigured endpoint that accepts any
//     token is a subscription an outsider can complete against your number.
//   * token mismatch                       → 403, and the challenge is never echoed.
//   * anything that is not a subscribe     → 403.
// The comparison is constant-time so a network observer cannot bisect the token length.

import { timingSafeEqual } from 'node:crypto';

function tokensMatch(present, expected) {
  const a = Buffer.from(String(present ?? ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// `query` is the parsed query object n8n would hand over; here it comes from the URL.
// Returns a status plus the body to send, or null when the caller should continue — the
// route decides how to write, so this file stays testable without a socket.
export function answerVerify(query, { verifyToken } = {}) {
  if (query?.['hub.mode'] !== 'subscribe') return { status: 403, body: '', reason: 'not_a_subscribe' };

  const expected = verifyToken ?? '';
  if (!expected.length) return { status: 503, body: '', reason: 'verify_token_not_configured' };

  if (!tokensMatch(query?.['hub.verify_token'], expected)) {
    return { status: 403, body: '', reason: 'verify_token_mismatch' };
  }

  // Dotted keys, not a nested `hub` object — the same shape n8n's Webhook node exposes and the
  // one Meta's query string actually contains.
  const challenge = typeof query?.['hub.challenge'] === 'string' ? query['hub.challenge'] : '';
  if (!challenge.length) return { status: 403, body: '', reason: 'no_challenge' };
  return { status: 200, body: challenge, reason: null };
}
