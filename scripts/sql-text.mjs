// One reader for db/queries/*.sql, shared by the verifier and the workflow generator.
//
// The point is byte-identity: the SQL that scripts/verify-sql.mjs proves against the live
// database must be the same string that ends up inside the n8n node. Any second copy —
// pasted into JSON by hand, or stripped by a different regex — is a place where the tested
// query and the shipped query quietly stop being the same query.
//
// Comment stripping matters beyond tidiness. record-inbound.sql's header documents the
// exact Postgres error an unused placeholder causes, and that sentence contains "$5".
// Postgres ignores it (a `--` comment ends at the newline, so it never lexes as a
// parameter), but n8n's own parameter handling does not parse SQL, so shipping the comment
// inside a node is a needless gamble on where a regex stops.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Parameter types are declared, not inferred: PREPARE needs them and they must line up with
// each file's documented signature. A drift here fails at parse time instead of binding a
// uuid as text and corrupting a comparison three tables away.
export const QUERY_SPECS = {
  inbound: { file: 'db/queries/record-inbound.sql', types: ['text', 'text', 'text', 'text'] },
  history: { file: 'db/queries/load-history.sql', types: ['uuid', 'text', 'int'] },
  outbound: { file: 'db/queries/record-outbound.sql', types: ['uuid', 'text', 'text'] },
  turn: {
    file: 'db/queries/record-turn.sql',
    types: ['uuid', 'text', 'text', 'int', 'text', 'text', 'numeric', 'text', 'text', 'int',
      'text', 'int', 'int', 'int', 'int', 'int', 'text', 'text', 'jsonb'],
  },
};

export function sqlBody(name) {
  const spec = QUERY_SPECS[name];
  if (!spec) throw new Error(`no query spec for '${name}'`);
  return readFileSync(join(ROOT, spec.file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/;\s*$/, '');
}

// The highest $n a query mentions must equal the number of parameters declared. This is the
// check that would have caught record-inbound.sql shipping `SELECT sess.id, sess.id` where
// $3 (the wamid) belonged: both files had four-parameter headers, and only the column order
// was wrong.
export function signatureProblem(name) {
  const body = sqlBody(name);
  const used = [...body.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const count = QUERY_SPECS[name].types.length;
  const highest = Math.max(0, ...used);
  if (highest !== count) return `highest placeholder is $${highest}, ${count} parameters declared`;
  const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !used.includes(n));
  if (missing.length) return `parameter $${missing.join(', $')} is declared but never referenced`;
  return null;
}

export function prepareStatement(name) {
  const spec = QUERY_SPECS[name];
  return `PREPARE ${name}(${spec.types.join(',')}) AS\n${sqlBody(name)}\n;`;
}
