import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Seeds the REMOTE D1 database with the local demo dataset:
//   local sqlite  ->  SQL export  ->  delete prelude (idempotent re-runs)  ->  d1 execute --remote
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = `-c "${path.join(root, 'apps', 'worker', 'wrangler.jsonc')}"`;
const dumpFile = path.join(root, '.seed-remote.sql');
const combinedFile = path.join(root, '.seed-remote.combined.sql');

function run(cmd, label) {
  const res = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`${label} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}

run(`npx wrangler ${cfg} d1 export motoro --local --output "${dumpFile}"`, 'd1 export');

const sql = readFileSync(dumpFile, 'utf8');

// Split on ';' outside single-quoted strings (data can contain semicolons).
function splitStatements(text) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    if (ch === "'") {
      if (inStr && text[i + 1] === "'") {
        cur += text[++i];
        continue;
      }
      inStr = !inStr;
    } else if (ch === ";" && !inStr) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const statements = splitStatements(sql);
const createTable = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/i;
const isSchema = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\b/i;

const tableNames = statements
  .map((s) => s.match(createTable)?.[1])
  .filter(Boolean);
// Schema already exists remotely (applied by `db:migrate:remote`), so the
// export's CREATE statements are dropped; d1_migrations is re-inserted by the
// dump but already populated by the migrator - clearing both (and
// sqlite_sequence) in the same batch avoids PRIMARY KEY conflicts.
const deleteTargets = [...new Set([...tableNames.reverse(), 'd1_migrations', 'sqlite_sequence'])];
const dataStatements = statements.filter((s) => !isSchema.test(s));

// Children are created after parents, so deleting in reverse creation order
// satisfies foreign keys without relying on pragma support in D1.
const prelude = [
  'PRAGMA defer_foreign_keys=TRUE;',
  ...deleteTargets.map((t) => `DELETE FROM "${t}";`),
  '',
].join('\n');

writeFileSync(combinedFile, prelude + dataStatements.join('\n'));
unlinkSync(dumpFile);

run(`npx wrangler ${cfg} d1 execute motoro --remote --file "${combinedFile}"`, 'd1 execute --remote');
if (existsSync(combinedFile)) unlinkSync(combinedFile);

run(
  `npx wrangler ${cfg} d1 execute motoro --remote --command "SELECT ` +
    `(SELECT count(*) FROM emergency_requests) AS requests, ` +
    `(SELECT count(*) FROM users) AS users, ` +
    `(SELECT count(*) FROM jobs) AS jobs, ` +
    `(SELECT count(*) FROM notifications) AS notifications;"`,
  'd1 verify',
);

console.log('Remote database seeded.');
