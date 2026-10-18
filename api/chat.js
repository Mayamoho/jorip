// The public front door: one turn of Jorip as a Vercel serverless function.
//
// This is deliberately NOT the n8n flow. n8n needs a long-lived process, a
// database and a cron scheduler, none of which Vercel provides. What lives here is
// the agent's judgement — read a messy message, extract, score, answer — and the
// WhatsApp path calls this same endpoint over HTTP. One brain, two channels, so
// the web visitor and the WhatsApp lead are told the same thing.
//
// Known limits, stated rather than hidden:
//   - The buckets below are per-instance memory. A serverless instance can be
//     replaced at any time and the counter starts over. That makes them a brake on
//     an accidental runaway, not a defence against a determined caller. Real
//     enforcement wants Upstash or Vercel KV (both free tier); it is not here yet.
//   - There is no database on this path. The client holds the transcript and sends
//     it back each turn. That is fine for a demo and wrong for a customer.

import { runTurn, MAX_MESSAGES } from '../core/agent.mjs';
import { readBody } from '../core/raw-body.mjs';

const MAX_BODY_BYTES = 32 * 1024;

const ALLOWED_ORIGINS = (process.env.JORIP_ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const TRUSTED_SECRET = process.env.JORIP_SHARED_SECRET ?? '';
const DAILY_CALL_CAP = Number(process.env.JORIP_DAILY_CALL_CAP ?? 400);

const buckets = new Map();          // ip -> { count, resetAt }
let dayWindow = { date: '', calls: 0 };

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

function rateLimited(ip, limit) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

function globalCapReached() {
  const today = new Date().toISOString().slice(0, 10);
  if (dayWindow.date !== today) dayWindow = { date: today, calls: 0 };
  dayWindow.calls += 1;
  return dayWindow.calls > DAILY_CALL_CAP;
}

function readBodyStr(req, maxBytes) {
  return readBody(req, maxBytes).then((buf) => buf.toString('utf8'));
}

function send(res, status, payload, req) {
  const origin = req.headers.origin;
  const allowed = origin && (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*'));
  if (allowed) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-jorip-token');
    res.setHeader('access-control-max-age', '600');
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    // A 405 here is the whole difference between an agent and a landing page that
    // looks like one. GrowPilot answered this request with index.html.
    res.setHeader('allow', 'POST, OPTIONS');
    return send(res, 405, { error: 'method_not_allowed' }, req);
  }

  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) return send(res, 503, { error: 'not_configured' }, req);

  const ip = clientIp(req);
  const isTrusted = TRUSTED_SECRET.length > 0 && req.headers['x-jorip-token'] === TRUSTED_SECRET;
  if (rateLimited(ip, isTrusted ? 120 : 12)) {
    return send(res, 429, { error: 'rate_limited', retry_after_s: 60 }, req);
  }
  if (!isTrusted && globalCapReached()) {
    return send(res, 503, { error: 'daily_cap_reached' }, req);
  }

  let body;
  try {
    const raw = await readBodyStr(req, MAX_BODY_BYTES);
    body = raw ? JSON.parse(raw) : null;
  } catch (e) {
    const tooLarge = e?.code === 'too_large';
    return send(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body_too_large' : 'invalid_json' }, req);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) return send(res, 400, { error: 'messages_required', max: MAX_MESSAGES }, req);

  try {
    const turn = await runTurn({
      messages,
      apiKey,
      now: new Date(),
      models: {
        route: process.env.GEMINI_MODEL_ROUTE ?? 'gemini-3.1-flash-lite',
        reply: process.env.GEMINI_MODEL_REPLY ?? 'gemini-3-flash-preview',
        heavy: process.env.GEMINI_MODEL_HEAVY ?? 'gemini-3.8-flash',
      },
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 400),
      thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 0),
    });

    if (!turn.ok) return send(res, 400, { error: turn.stage, details: turn.errors }, req);

    const failed = turn.calls.filter((c) => c.error);
    if (failed.length === turn.calls.length) {
      // Every model call errored. Say so, but never forward the upstream body —
      // it can carry the project name and, in some SDKs, part of the key.
      console.error('jorip: all model calls failed', failed.map((f) => `${f.step} ${f.http}`));
      return send(res, 502, { error: 'model_unavailable' }, req);
    }

    return send(res, 200, {
      reply: turn.reply,
      reply_source: turn.reply_source,
      extraction: turn.extraction,
      score: turn.score,
      action: turn.score.action,
      hotness: turn.score.hotness,
      escalations: turn.escalations,
      slots_offered: turn.slots_offered,
      repair_attempts: turn.repair_attempts,
      rule_version: turn.rule_version,
      usage: turn.calls.map(({ step, model, tier, latency_ms, tokens_in, tokens_out, cached_tokens }) =>
        ({ step, model, tier, latency_ms, tokens_in, tokens_out, cached_tokens })),
    }, req);
  } catch (e) {
    console.error('jorip: turn threw', e?.message);
    return send(res, 500, { error: 'internal' }, req);
  }
}
