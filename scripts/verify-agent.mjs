// The deploy gate. Runs as the Vercel build command, so a broken front door fails
// the build instead of shipping a page whose Send button answers 405.
//
// This exists because of a specific observed failure: a static SPA with
// `rewrites: /(.) -> /index.html` deployed as an "AI agent". Every /api/* call
// returned index.html with HTTP 200, the page looked alive, and nothing was
// behind it. The checks below are the ones that would have caught that.
//
// It also gates the WhatsApp pipeline, for the same reason in a different medium: the
// generated workflow embeds db/queries/*.sql as string literals, and a workflow whose
// inlined SQL has drifted from the file scripts/verify-sql.mjs proved is a flow that ships
// queries nobody tested. Those checks read only committed files, so they run on a Vercel
// builder with no docker and no database.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { freeSlots } from '../core/slots.mjs';
import { KNOWLEDGE } from '../core/knowledge.mjs';
import { sqlBody, QUERY_SPECS } from './sql-text.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => {
  if (!existsSync(join(root, p))) throw new Error(`missing ${p}`);
  return readFileSync(join(root, p), 'utf8');
};

const failures = [];
const checks = [];
function check(name, fn) {
  checks.push(name);
  try {
    const problem = fn();
    if (problem) failures.push(`${name}: ${problem}`);
    else console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: threw ${e.message}`);
  }
}

console.log('jorip deploy gate\n');

check('the offline battery passes', () => {
  // Discovered, not listed: a new eval/*.test.mjs file that nobody adds to this
  // array is a new test that never runs.
  const suites = readdirSync(join(root, 'eval')).filter((f) => f.endsWith('.test.mjs')).sort();
  if (!suites.length) return 'no test files found in eval/';
  try {
    execFileSync(process.execPath, ['--test', ...suites.map((f) => `eval/${f}`)],
      { cwd: root, stdio: 'pipe' });
    return null;
  } catch (e) {
    return `${suites.length} suite(s) red — fix before shipping\n`
      + (e.stdout?.toString() ?? e.message).split('\n').filter((l) => l.startsWith('not ok')).join('\n');
  }
});

const vercel = JSON.parse(read('vercel.json'));

check('vercel.json declares no catch-all rewrite', () => {
  // The single check that separates a real endpoint from a landing page.
  const r = vercel.rewrites ?? [];
  const catchAll = r.find((x) => typeof x.source === 'string' && /\/\*.*$/.test(x.source) && !x.destination.includes('/api/'));
  return catchAll ? `a rewrite sends ${catchAll.source} to ${catchAll.destination}; /api/chat would return HTML` : null;
});

check('vercel.json builds from web/ and registers the function', () => {
  if (vercel.outputDirectory !== 'web') return `outputDirectory is ${vercel.outputDirectory}`;
  if (!vercel.functions?.['api/chat.js']) return 'api/chat.js is not declared under functions';
  return null;
});

check('the page posts to the function that exists', () => {
  const html = read('web/index.html');
  const js = read('web/app.js');
  if (!js.includes("fetch('/api/chat'")) return 'app.js does not POST to /api/chat';
  if (!/<script src="\/app.js"/.test(html)) return 'index.html does not load /app.js';
  if (/<script>/.test(html)) return 'inline <script> remains, which forces unsafe-inline in the CSP';
  if (/<style>/.test(html)) return 'inline <style> remains';
  if (!vercel.headers?.[0]?.headers?.find((h) => h.key === 'Content-Security-Policy')
        ?.value.includes("script-src 'self'")) return 'CSP does not pin script-src';
  return null;
});

check('the function reads its key from the environment, not a literal', () => {
  const src = read('api/chat.js') + read('core/agent.mjs');
  const leaked = src.match(/AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}/);
  return leaked ? `a key literal is in the source: ${leaked[0].slice(0, 8)}…` : null;
});

check('no placeholder domains in the shipped page or facts', () => {
  const corpus = read('web/index.html') + read('web/app.js') + KNOWLEDGE.map((k) => k.text).join(' ');
  const bad = corpus.match(/[a-z0-9-]+\.(?:example\.(?:com|org|io)|test)\b/i);
  return bad ? `placeholder host ${bad[0]} would be quoted at a real lead` : null;
});

check('every knowledge fact is citable', () => {
  const bad = KNOWLEDGE.filter((k) => !k.ref || !k.id || !k.text?.trim());
  return bad.length ? `${bad.length} fact(s) missing id, ref or text` : null;
});

check('the slot generator still produces an offer', () => {
  // Mon 2026-10-19 04:00Z. A refactor that returns [] here turns every hot lead
  // into "I will confirm with a human", which reads as a working product.
  const s = freeSlots(new Date('2026-10-19T04:00:00Z'));
  return s.length ? null : 'freeSlots returned nothing for a weekday morning';
});

// ── The WhatsApp pipeline workflow ───────────────────────────────────
const WORKFLOWS = {
  production: 'n8n/workflows/jorip-pipeline.json',
  harness: 'n8n/workflows/jorip-pipeline-harness.json',
};
const wf = Object.fromEntries(Object.entries(WORKFLOWS).map(([k, p]) => [k, JSON.parse(read(p))]));
const pgNodes = (v) => wf[v].nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');

check('both workflow variants exist and parse', () => {
  const short = Object.entries(wf).find(([, w]) => !Array.isArray(w.nodes) || w.nodes.length < 8);
  return short ? `${short[0]} has ${short[1]?.nodes?.length ?? 0} nodes` : null;
});

// The Postgres node cannot exceed what the pinned image ships: dist/nodes/Postgres maps
// versions 1 … 2.6, and asking for anything above returns no node implementation at all —
// every run then dies with "Cannot read properties of undefined (reading execute)".
check('postgres nodes stay inside the version the pinned n8n image implements', () => {
  const bad = Object.entries(wf).flatMap(([v, w]) => w.nodes
    .filter((n) => n.type === 'n8n-nodes-base.postgres' && Number(n.typeVersion) > 2.6)
    .map((n) => `${v}/${n.name}@${n.typeVersion}`));
  return bad.length ? `unsupported: ${bad.join(', ')}` : null;
});

// The whole reason the SQL is generated rather than pasted.
check('every inlined query is byte-identical to the file that verify-sql proved', () => {
  const bodies = Object.keys(QUERY_SPECS).map((name) => [name, sqlBody(name)]);
  const bad = [];
  for (const [variant, list] of Object.entries(wf)) {
    for (const n of pgNodes(variant === 'harness' ? 'harness' : 'production')) {
      const q = n.parameters.query;
      const hit = bodies.filter(([, body]) => q.includes(body.trimEnd()));
      if (hit.length !== 1) bad.push(`${variant}/${n.name}: matched ${hit.length} of db/queries`);
    }
  }
  return bad.length ? bad.join('; ') : null;
});

// Counts the top-level items of the array literal in a queryReplacement expression, so a
// parameter dropped or added in one of the two places fails here rather than as a Postgres
// "there is no parameter $4" at 3am inside a flow whose errors look like model errors.
function arrayItems(expr) {
  const m = /^=\{\{\s*\[([\s\S]*)\]\s*\}\}$/.exec(String(expr ?? '').trim());
  if (!m) return null;
  if (!m[1].trim()) return 0;
  let depth = 0, count = 1;
  for (const ch of m[1]) {
    if ('[{('.includes(ch)) depth++;
    else if (']})'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

check('parameter binding uses the array form with the exact declared arity', () => {
  const names = Object.keys(QUERY_SPECS);
  const bad = [];
  for (const [variant, list] of Object.entries(wf)) {
    for (const n of pgNodes(variant)) {
      const body = n.parameters.query;
      const name = names.find((k) => body.includes(sqlBody(k).trimEnd()));
      if (!name) { bad.push(`${variant}/${n.name}: no known query`); continue; }
      const got = arrayItems(n.parameters.options?.queryReplacement);
      const want = QUERY_SPECS[name].types.length;
      // The comma-separated string form is the trap this guards: n8n splits it on ',' and
      // drops empties, so a Bangla sentence with a comma in the budget shreds the params.
      if (got === null) bad.push(`${variant}/${n.name}: queryReplacement is not =[ [..] ]`);
      else if (got !== want) bad.push(`${variant}/${n.name}: ${got} bound for ${name}, ${want} declared`);
    }
  }
  return bad.length ? bad.join('; ') : null;
});

check('the two variants share one implementation of every node they have in common', () => {
  const byName = (v) => new Map(wf[v].nodes.map((n) => [n.name, n]));
  const shared = [...byName('harness').keys()].filter((k) => byName('production').has(k));
  const bad = shared.filter((k) => JSON.stringify(byName('harness').get(k).parameters)
    !== JSON.stringify(byName('production').get(k).parameters));
  return bad.length
    ? `harness and production disagree in: ${bad.join(', ')} — the test double would be testing a different flow`
    : null;
});

check('the workflow JSON carries no secret material', () => {
  const corpus = read(WORKFLOWS.production) + read(WORKFLOWS.harness);
  const bad = corpus.match(/AIza[0-9A-Za-z_-]{20,}|sha256=[0-9a-f]{40,}/);
  return bad ? `literal secret in the workflow: ${bad[0].slice(0, 10)}…` : null;
});

console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length) {
  console.error('\nDEPLOY BLOCKED:\n- ' + failures.join('\n- ') + '\n');
  process.exit(1);
}
console.log('ready to publish.\n');
