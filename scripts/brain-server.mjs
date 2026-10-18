// The brain as a long-lived process, for the WhatsApp path.
//
// Same modules as the Vercel function — this file adds routes, not logic. n8n is
// the orchestrator and owns the database; anything that needs a crypto primitive
// or a hard enum check lives here, because n8n's Code node runs in a sandbox where
// importing these modules is not reliable. Splitting on that line means there is
// one implementation of the rules, which is the whole claim.
//
//   GET  /healthz      config booleans, never values
//   POST /chat         the Vercel handler, byte for byte, for local testing
//   POST /whatsapp-in  verify Meta's signature, normalise, hand off to the n8n pipeline
//   POST /reply        one turn: transcript in, answer + decision out

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chatHandler from '../api/chat.js';
import { RULE_VERSION } from '../scripts/score.mjs';
import { handleInbound } from '../core/inbound.mjs';
import { answerVerify } from '../core/verify-handshake.mjs';
import { runTurn } from '../core/agent.mjs';
import { buildTranscript } from '../core/normalise.mjs';
import { readBody } from '../core/raw-body.mjs';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const PORT = Number(process.env.JORIP_BRAIN_PORT ?? 8788);
const HOST = process.env.JORIP_BRAIN_HOST ?? '0.0.0.0';
const MAX_BYTES = 256 * 1024;

// n8n's webhook for the pipeline. Set JORIP_PIPELINE_URL to
// http://n8n:5678/webhook/jorip-pipeline (compose network) or the equivalent host URL.
const PIPELINE_URL = process.env.JORIP_PIPELINE_URL ?? '';
const HANDOFF_TIMEOUT_MS = Number(process.env.JORIP_HANDOFF_TIMEOUT_MS ?? 8000);

// The handoff is the only I/O the edge does: the workflow owns the database, the model call
// and the send. Returning a result object instead of throwing is what lets handleInbound turn
// a dead n8n into a 502, which is the signal Meta retries on.
async function handoff(payload) {
  try {
    const res = await fetch(PIPELINE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `http_${res.status}` };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, reason: timeout ? 'handoff_timeout' : (e?.cause?.code ?? e?.message ?? 'handoff_failed') };
  }
}

const models = () => ({
  route: process.env.GEMINI_MODEL_ROUTE ?? 'gemini-3.1-flash-lite',
  reply: process.env.GEMINI_MODEL_REPLY ?? 'gemini-3-flash-preview',
  heavy: process.env.GEMINI_MODEL_HEAVY ?? 'gemini-3.8-flash',
});

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-jorip-brain', '1');
  res.end(JSON.stringify(payload));
}

// /reply is internal in this topology, but an unauthenticated turn endpoint on a
// machine that also holds a database is still an open proxy to a paid API.
function internalOnly(req) {
  const secret = process.env.JORIP_SHARED_SECRET ?? '';
  if (!secret.length) {
    return { ok: false, why: 'JORIP_SHARED_SECRET is not set — /reply refuses to run without it' };
  }
  return req.headers['x-jorip-token'] === secret
    ? { ok: true }
    : { ok: false, why: 'token_mismatch' };
}

async function replyRoute(req, res, raw) {
  const auth = internalOnly(req);
  if (!auth.ok) return json(res, auth.why.includes('not set') ? 503 : 401, { error: auth.why });

  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return json(res, 400, { error: 'invalid_json' }); }

  const messages = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : buildTranscript(body.history, body.body);

  if (!messages.length) return json(res, 400, { error: 'no_usable_messages' });

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) return json(res, 503, { error: 'not_configured' });

  const turn = await runTurn({
    messages,
    now: body.now ? new Date(body.now) : new Date(),
    apiKey,
    models: models(),
    slotOpts: { taken: body.taken_slots ?? [] },
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 400),
    thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 0),
  });

  if (!turn.ok) return json(res, 400, { error: turn.stage, details: turn.errors });

  const allFailed = turn.calls.length > 0 && turn.calls.every((c) => c.error);
  if (allFailed) return json(res, 502, { error: 'model_unavailable', escalations: turn.escalations });

  return json(res, 200, {
    reply: turn.reply,
    reply_source: turn.reply_source,
    extraction: turn.extraction,
    score: turn.score,
    hotness: turn.score.hotness,
    action: turn.score.action,
    reason_code: turn.score.reason_code,
    escalations: turn.escalations,
    slot_offered: turn.slots_offered[0] ?? null,
    slots_offered: turn.slots_offered,
    repair_attempts: turn.repair_attempts,
    rule_version: turn.rule_version,
    // n8n writes these straight into turn_cost. The README's taka figure is only
    // defensible because every call reports what it actually used.
    usage: turn.calls.map(({ step, model, tier, latency_ms, tokens_in, tokens_out, cached_tokens, error }) =>
      ({ step, model, tier, latency_ms, tokens_in, tokens_out, cached_tokens, error: error ?? null })),
  });
}

// Dispatch by path, not by "METHOD path": on Vercel, api/chat.js receives a GET
// and answers 405 itself. Matching the full verb locally turned GET /chat into a
// router 405 instead, so the local replica was not testing what production does.
const HANDLERS = {
  '/chat': (req, res) => chatHandler(req, res),
  '/whatsapp-in': async (req, res) => {
    // Meta configures a callback in two moves: a GET handshake on the exact URL, then POSTs
    // to it. Serving only the POST means the subscription can never be completed through
    // this edge, so the handshake answers here — before any body exists to sign.
    if (req.method === 'GET') {
      const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      const verdict = answerVerify(query, { verifyToken: process.env.WHATSAPP_VERIFY_TOKEN });
      res.statusCode = verdict.status;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      // The challenge is a nonce an attacker controls; it never goes into a log line.
      console.log(`jorip: verify handshake ${verdict.reason} (${verdict.status})`);
      return res.end(verdict.body);
    }
    const raw = await readBody(req, MAX_BYTES);
    // A configured webhook with nowhere to send the message would acknowledge deliveries into
    // a void: Meta stops retrying, and nothing downstream ever learns the lead wrote. Refuse
    // the traffic loudly instead, so the 503 is visible in Meta's delivery report.
    if ((process.env.WHATSAPP_APP_SECRET ?? '').length && !PIPELINE_URL.length) {
      return json(res, 503, { error: 'pipeline_not_configured' });
    }
    return handleInbound(req, res, { rawBody: raw, dispatch: PIPELINE_URL.length ? handoff : undefined });
  },
  '/reply': async (req, res) => {
    const raw = await readBody(req, MAX_BYTES);
    return replyRoute(req, res, raw);
  },
  '/healthz': (req, res) => json(res, 200, {
    ok: true,
    configured: {
      gemini_key: !!process.env.GEMINI_API_KEY,
      whatsapp_app_secret: !!process.env.WHATSAPP_APP_SECRET,
      shared_secret: !!process.env.JORIP_SHARED_SECRET,
      verify_token: !!process.env.WHATSAPP_VERIFY_TOKEN,
      // The two booleans that decide whether an inbound message can reach a database at all.
      pipeline_url: PIPELINE_URL.length > 0,
    },
    models: models(),
    rule_version: RULE_VERSION,
    timeout_ms: Number(process.env.JORIP_MODEL_TIMEOUT_MS ?? 12000),
  }),
};

// web/ is served here too, with the same CSP Vercel will send, so a page that only
// works when the header is absent fails locally before it ships.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
  + "img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(res, entry) {
  let buf;
  try { buf = readFileSync(join(WEB_DIR, entry[0])); }
  catch { return json(res, 404, { error: 'missing_static', file: entry[0] }); }
  res.statusCode = 200;
  res.setHeader('content-type', entry[1]);
  res.setHeader('content-security-policy', CSP);
  res.setHeader('cache-control', entry[0] === 'index.html' ? 'no-store' : 'public, max-age=300');
  res.end(buf);
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const handler = HANDLERS[path];
    if (handler) return await handler(req, res);
    const entry = STATIC[path];
    if (entry && req.method === 'GET') return serveStatic(res, entry);
    res.setHeader('allow', 'GET, POST, OPTIONS');
    return json(res, 405, { error: 'no_such_route' });
  } catch (e) {
    console.error('jorip brain:', req.method, path, e?.message ?? e);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`jorip brain on http://${HOST}:${PORT}  (healthz /chat /whatsapp-in /reply)`);
});
