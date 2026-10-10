// Full business dump through the verified pooler. Credentials only enter stdin.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadEnv } from 'vite';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';
assertSupabaseTarget();
const env=loadEnv('production',PROJECT_ROOT,'');
const password=(process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();assert.ok(password);
const directory=join(homedir(),'.local/share/impulso-backups',new Date().toISOString().replace(/[:.]/g,'-')+'-shipping');
mkdirSync(directory,{recursive:true,mode:0o700});
const result=spawnSync('docker',['exec','-i','supabase_db_app-de-suplementos','sh','-c',
  `IFS= read -r PGPASSWORD; export PGPASSWORD; export PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGOPTIONS='-c default_transaction_read_only=on'; exec pg_dump --host=aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com --port=6543 --username=postgres.${SUPABASE_PROJECT_REF} --dbname=postgres --format=custom --no-owner --schema=public --schema=private --schema=auth --schema=storage --schema=supabase_migrations`
],{input:password+'\n',timeout:120000,maxBuffer:64*1024*1024});
assert.equal(result.status,0,'Production backup failed; no migration may proceed');
const listing=spawnSync('docker',['exec','-i','supabase_db_app-de-suplementos','pg_restore','--list'],{input:result.stdout,timeout:15000,maxBuffer:2000000});
assert.equal(listing.status,0,'Backup archive cannot be read');
const toc=listing.stdout.toString('utf8');
for(const table of ['orders','order_items','stock_reservations','purchase_items','misc_expenses','misc_expense_audit'])assert.ok(toc.includes('TABLE DATA public '+table),'Backup lacks '+table);
writeFileSync(join(directory,'before-shipping.dump'),result.stdout,{mode:0o600});
const manifest={project:SUPABASE_PROJECT_REF,file:'before-shipping.dump',bytes:result.stdout.length,
  sha256:createHash('sha256').update(result.stdout).digest('hex'),createdAt:new Date().toISOString(),archiveReadable:true,
  includes:['public','private','auth','storage metadata','migration history','ACLs'],excludes:['Storage file binaries','hosting secrets']};
writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({directory,...manifest}));
