#!/usr/bin/env node
// Which models can this key actually call, right now, at what latency?
//
// The model list endpoint shows what exists. It does not show what your tier
// will let through — that only comes out when you send a request. So we send
// one tiny fixed prompt per candidate and record what happens.
//
//   node scripts/probe-models.mjs
//
// This is the measurement behind the README's routing table. Anything not
// printed by this script is an assumption, not a finding.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);

const KEY = env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY empty in .env'); process.exit(1); }

// The ladder we want to believe in, plus the stale names currently in .env,
// so the script tells us if we have been configuring a ghost.
const CANDIDATES = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  // Plus whatever .env actually configures, so a typo or a retired name in
  // the live config shows up here rather than in a customer conversation.
  ...(env.GEMINI_MODEL_ROUTE ? [env.GEMINI_MODEL_ROUTE] : []),
  ...(env.GEMINI_MODEL_REPLY ? [env.GEMINI_MODEL_REPLY] : []),
  ...(env.GEMINI_MODEL_HEAVY ? [env.GEMINI_MODEL_HEAVY] : []),
];

const EMBED_CANDIDATES = ['gemini-embedding-001', 'text-embedding-004', env.GEMINI_EMBED_MODEL].filter(Boolean);
const EMBED_DIMS = Number(env.GEMINI_EMBED_DIMS || 768);

const PROMPT = 'Reply with exactly the word: ready';

async function call(model, path, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${path}`;
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ms, json };
  } catch (err) {
    return { ok: false, status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, json: { error: { message: err.name } } };
  }
}

function reason(r) {
  if (r.ok) return null;
  const m = r.json?.error?.message ?? `http ${r.status}`;
  return m.replace(/API key: [^\s"]+/, 'API key: [redacted]').slice(0, 110);
}

const rows = [];
console.log(`\nprobing ${new Set(CANDIDATES).size} chat models + ${new Set(EMBED_CANDIDATES).size} embedders…\n`);

for (const model of [...new Set(CANDIDATES)]) {
  const r = await call(model, 'generateContent', {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: {
      // Deliberately the budget the runtime uses. On a thinking model a tiny
      // maxOutputTokens does not make a cheaper probe — it makes an empty
      // reply, and "answered oddly" about a working model teaches the wrong
      // lesson.
      maxOutputTokens: Number(env.GEMINI_MAX_OUTPUT_TOKENS || 400),
      thinkingConfig: { thinkingBudget: Number(env.GEMINI_THINKING_BUDGET ?? 0) },
      temperature: 0,
    },
  });
  const u = r.json?.usageMetadata ?? {};
  const text = r.json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  rows.push({
    model, kind: 'chat',
    ok: r.ok, status: r.status,
    latency_ms: Math.round(r.ms),
    tokens_in: u.promptTokenCount ?? 0,
    tokens_out: u.candidatesTokenCount ?? 0,
    cached: u.cachedContentTokenCount ?? 0,
    note: reason(r) ?? (text.trim().toLowerCase().includes('ready')
      ? `ok${u.thoughtsTokenCount ? `, ${u.thoughtsTokenCount} thought tok` : ''}`
      : `EMPTY REPLY — thought ${u.thoughtsTokenCount ?? 0}, visible ${u.candidatesTokenCount ?? 0}`),
  });
}

for (const model of [...new Set(EMBED_CANDIDATES)]) {
  const r = await call(model, 'embedContent', {
    content: { parts: [{ text: 'fee schedule' }] },
    outputDimensionality: EMBED_DIMS,
  });
  const dims = r.json?.embedding?.values?.length ?? 0;
  rows.push({
    model, kind: 'embed',
    ok: r.ok, status: r.status,
    latency_ms: Math.round(r.ms),
    tokens_in: r.json?.metadata?.embeddingTokenCount ?? 0, tokens_out: 0, cached: 0,
    // The schema declares vector(768). If an embedder returns another width,
    // the insert fails later in a place that is much harder to read.
    note: reason(r) ?? `${dims} dims${dims && dims !== EMBED_DIMS ? `  ← asked for ${EMBED_DIMS}` : ''}`,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('model', 30), pad('kind', 7), pad('http', 6), pad('ms', 6), pad('in/out', 10), 'note');
console.log('-'.repeat(105));
for (const r of rows) {
  console.log(
    pad(r.model, 30), pad(r.kind, 7), pad(r.status, 6), pad(r.latency_ms, 6),
    pad(`${r.tokens_in}/${r.tokens_out}`, 10), r.note
  );
}

const usable = rows.filter((r) => r.ok && r.kind === 'chat');
console.log(`\nreachable chat models: ${usable.length}/${rows.filter((r) => r.kind === 'chat').length}`);
if (usable.length) {
  const bySpeed = [...usable].sort((a, b) => a.latency_ms - b.latency_ms);
  console.log(`fastest: ${bySpeed[0].model} (${bySpeed[0].latency_ms} ms)`);
  console.log(`slowest: ${bySpeed.at(-1).model} (${bySpeed.at(-1).latency_ms} ms)`);
}
