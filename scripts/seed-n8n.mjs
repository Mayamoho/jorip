// Create the Postgres credential inside n8n's own database, so the WhatsApp flow can be
// EXECUTED headlessly (`n8n execute`) instead of only imported and admired.
//
// Why script it rather than click: every other part of this project is verified by running
// it. A workflow that has never executed is a claim, not a test — and an unreadable
// credential block is exactly where a comma in a Bangla message turns into a red node at
// 2am for someone else.
//
// Secret handling: nothing here ever touches a secret in this shell. The container already
// has DB_POSTGRESDB_PASSWORD and N8N_ENCRYPTION_KEY in its own environment, so encryption
// happens in there and only the CIPHERTEXT crosses the boundary. The ciphertext is not a
// secret (it is AES-256-CBC under a key that stays in the container), it is never printed,
// and this script is useless without the target database.
//
//   node scripts/seed-n8n.mjs
//
// Re-running is safe: both rows are upserted on their primary keys.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A fixed id, not a random one: the generated workflow JSON references this literal, so a
// random id would make the flow non-reproducible across machines.
const CREDENTIAL_ID = 'jorip-postgres';
const CREDENTIAL_NAME = 'Jorip Postgres';

function docker(service, args, input) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', service, ...args], {
    cwd: ROOT, input, encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`docker exec ${service} failed (exit ${r.status}):\n${redact(r.stdout ?? '')}${redact(r.stderr ?? '')}`);
  }
  return r.stdout ?? '';
}

// If anything ever echoes the key or the plaintext password into a log line, keep it out of
// the terminal. Belt and braces on a script whose whole job is moving credential material.
function redact(text) {
  return text
    .replace(/N8N_ENCRYPTION_KEY\s*=\s*\S+/g, 'N8N_ENCRYPTION_KEY=[redacted]')
    .replace(/DB_POSTGRESDB_PASSWORD\s*=\s*\S+/g, 'DB_POSTGRESDB_PASSWORD=[redacted]');
}

console.log('\n── seeding n8n with the site database credential\n');

const encryptor = `
const core = require('/usr/local/lib/node_modules/n8n/node_modules/n8n-core');
const key = process.env.N8N_ENCRYPTION_KEY;
if (!key) { console.error('N8N_ENCRYPTION_KEY is not set in the n8n container'); process.exit(1); }
for (const need of ['DB_POSTGRESDB_DATABASE', 'DB_POSTGRESDB_USER', 'DB_POSTGRESDB_PASSWORD']) {
  if (!process.env[need]) { console.error(need + ' is not set in the n8n container'); process.exit(1); }
}
// The property names must match Postgres.credentials.js exactly: an unknown key is stored,
// never read, and the node then silently connects to the 'postgres' default database.
const data = {
  host: 'postgres',
  database: process.env.DB_POSTGRESDB_DATABASE,
  user: process.env.DB_POSTGRESDB_USER,
  password: process.env.DB_POSTGRESDB_PASSWORD,
  port: 5432,
  ssl: 'disable',
  allowUnauthorizedCerts: false,
  maxConnections: 10,
};
process.stdout.write(new core.Cipher({ encryptionKey: key }).encrypt(data, key));
`;

const cipher = docker('n8n', ['node', '-'], encryptor).trim();
if (!/^[A-Za-z0-9+/=]+$/.test(cipher) || cipher.length < 64) {
  throw new Error('n8n did not return a usable ciphertext');
}
console.log(`  encrypted credential payload: ${cipher.length} base64 chars (not printed)`);

const sql = `
insert into n8n.credentials_entity (id, name, type, data, "isManaged", "isGlobal", "createdAt", "updatedAt")
values ('${CREDENTIAL_ID}', '${CREDENTIAL_NAME}', 'postgres', '${cipher}', false, false, now(), now())
on conflict (id) do update
  set data = excluded.data, name = excluded.name, "updatedAt" = now();

insert into n8n.shared_credentials ("credentialsId", "projectId", role, "createdAt", "updatedAt")
select '${CREDENTIAL_ID}', p.id, 'credential:owner', now(), now()
from n8n.project p where p.type = 'personal' order by p.id limit 1
on conflict ("credentialsId", "projectId") do update set role = excluded.role, "updatedAt" = now();

select 'credential='||count(*) from n8n.credentials_entity where id='${CREDENTIAL_ID}'
union all select 'shared='||count(*) from n8n.shared_credentials where "credentialsId"='${CREDENTIAL_ID}';
`;

const result = docker('postgres', ['psql', '-U', 'jorip', '-d', 'jorip', '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
const lines = result.trim().split('\n');
for (const line of lines) console.log(`  ${line}`);

const ok = lines.includes('credential=1') && lines.includes('shared=1');
console.log(ok
  ? `\n  credential '${CREDENTIAL_ID}' is ready; the generated workflow references it by id.\n`
  : '\n  SEED INCOMPLETE — expected credential=1 and shared=1\n');
process.exit(ok ? 0 : 1);
