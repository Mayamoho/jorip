// The WhatsApp edge: prove the POST came from Meta, then reshape it.
//
// This runs before anything is written to a database. An unverified webhook body
// is a form anyone can post to — with the tunnel URL alone, a stranger could put
// fake leads into the CRM and book slots against a real calendar.
//
// The signature is HMAC-SHA256 over the raw bytes. n8n's Webhook node with
// rawBody=true hands those to us as binary.data; if they ever reach here as a
// re-serialised object, verifySignature fails closed rather than guessing.

import { verifySignature, MISSING, MISMATCH, NO_SECRET } from '../scripts/whatsapp-signature.mjs';
import { normaliseInbound } from '../core/normalise.mjs';

const MAX_BODY_BYTES = 256 * 1024;   // Meta's webhook posts are small; a giant body is a probe

// n8n's HTTP Request node cannot reliably forward an incoming raw body as the
// outgoing request body while also keeping the signature header intact. Base64 can,
// and base64 round-trips the exact bytes — so the HMAC is computed over what Meta
// actually sent, not over a re-serialisation of it.
//
// This does not weaken anything: the caller still has to present a signature valid
// for WHATSAPP_APP_SECRET, and nobody who cannot read that secret can mint one.
// The endpoint is only bound to the compose network and loopback, never published.
export function unwrapEncapsulation(rawBody) {
  const head = rawBody.subarray(0, 1).toString();
  if (head !== '{') return { raw: rawBody, header: null };
  let parsed;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return { raw: rawBody, header: null }; }
  if (typeof parsed?.b64 !== 'string' || !parsed.b64.length) return { raw: rawBody, header: null };
  const buf = Buffer.from(parsed.b64, 'base64');
  // Reject anything that does not decode back to itself: that is not a wrapped body.
  if (buf.toString('base64') !== parsed.b64) return { raw: rawBody, header: null };
  return { raw: buf, header: typeof parsed.signature === 'string' ? parsed.signature : null };
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export async function handleInbound(req, res, { rawBody, dispatch }) {
  const secret = process.env.WHATSAPP_APP_SECRET ?? '';
  const { raw, header: wrappedSignature } = unwrapEncapsulation(rawBody);
  const header = wrappedSignature ?? req.headers['x-hub-signature-256'];

  if (raw.length > MAX_BODY_BYTES) return send(res, 413, { error: 'body_too_large' });

  const verdict = verifySignature({ rawBody: raw, header, secret });
  if (!verdict.ok) {
    // Never echo the expected signature or the body back: this endpoint is public.
    console.warn('jorip: rejected inbound', verdict.reason);
    return send(res, verdict.reason === NO_SECRET ? 503 : 401, { error: verdict.reason });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'body_not_json' });
  }

  const parsed = normaliseInbound(body, { now: new Date() });
  const payload = {
    verified: true,
    messages: parsed.messages,
    statuses: parsed.statuses,
    ignored: parsed.ignored,
    reason: parsed.reason,
    waba_id: body?.entry?.[0]?.id ?? null,
    phone_number_id: body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? null,
  };

  // Handing off BEFORE acknowledging is the point, not a detail. Nothing else in the stack
  // has written this message yet — the lead row and the message row are n8n's job — so a 200
  // that the handoff never happened would lose the message for good: Meta stops retrying a
  // delivery it saw acknowledged. Failing here makes Meta retry, and record-inbound.sql's
  // ON CONFLICT on the wamid makes that retry a no-op for the rows and a fresh reply request
  // for the flow. Idempotency is what makes "ack only after handoff" safe rather than slow.
  //
  // The handoff itself is fast: n8n's webhook answers at its own Ack node while the pipeline
  // (database, model, send) continues behind it.
  if (dispatch && parsed.messages.length) {
    const handoff = await dispatch(payload);
    if (!handoff?.ok) {
      console.warn('jorip: pipeline handoff failed', handoff?.reason ?? 'unknown');
      return send(res, 502, { error: 'pipeline_unavailable', messages: parsed.messages.length });
    }
  }

  return send(res, 200, payload);
}

export { MISSING, MISMATCH, NO_SECRET };
