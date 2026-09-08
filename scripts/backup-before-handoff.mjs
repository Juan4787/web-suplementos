import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const env = loadEnv('production', process.cwd(), '');
if (new URL(env.VITE_SUPABASE_URL).hostname !== `${SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Unexpected target');
const directory = join(homedir(), '.local/share/impulso-backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const destination = join(directory, 'before-handoff.dump');
// Use the existing PostgreSQL 17 client; the host's client is older than production.
// Pass the password through stdin, never through command arguments or logs.
const result = spawnSync('docker', ['exec', '-i', 'supabase_db_app-de-suplementos', 'sh', '-c',
  `IFS= read -r PGPASSWORD; export PGPASSWORD; export PGSSLMODE=require PGCONNECT_TIMEOUT=15; exec pg_dump --host=aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com --port=5432 --username=postgres.${SUPABASE_PROJECT_REF} --dbname=postgres --format=custom --no-owner --no-acl --schema=public --schema=private --schema=auth --schema=storage --schema=supabase_migrations`
], { input: `${env.SUPABASE_DB_PASSWORD}\n`, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
if (result.status !== 0) throw new Error(`Backup failed: ${result.stderr}`);
writeFileSync(destination, result.stdout, { mode: 0o600 });
chmodSync(destination, 0o600);
const contents = readFileSync(destination);
const manifest = { project: SUPABASE_PROJECT_REF, file: 'before-handoff.dump', bytes: statSync(destination).size,
  sha256: createHash('sha256').update(contents).digest('hex'), createdAt: new Date().toISOString(),
  includes: ['public', 'private', 'auth', 'storage metadata', 'migration history'], excludes: ['Storage file binaries', 'hosting secrets'] };
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ directory, ...manifest }));
