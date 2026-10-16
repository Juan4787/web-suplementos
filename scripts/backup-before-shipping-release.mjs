// Full business dump through the verified pooler. Credentials only enter stdin.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv } from 'vite';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';
assertSupabaseTarget();
const env=loadEnv('production',PROJECT_ROOT,'');
const password=(process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();assert.ok(password);
const directory=join(homedir(),'.local/share/impulso-backups',new Date().toISOString().replace(/[:.]/g,'-')+'-shipping');
mkdirSync(directory,{recursive:true,mode:0o700});
// Docker's attached output can end before a binary stream has been drained.
// Keep the archive as a file until pg_dump closes it, then copy and compare hashes.
const container='supabase_db_app-de-suplementos';
const containerArchive=`/tmp/impulso-backup-${randomUUID()}.dump`;
const result=spawnSync('docker',['exec','-i',container,'sh','-c',
  `umask 077; IFS= read -r PGPASSWORD; export PGPASSWORD; export PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGOPTIONS='-c default_transaction_read_only=on'; pg_dump --host=aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com --port=6543 --username=postgres.${SUPABASE_PROJECT_REF} --dbname=postgres --format=custom --file=${containerArchive} --no-owner --schema=public --schema=private --schema=auth --schema=storage --schema=supabase_migrations; dump_status=$?; if [ "$dump_status" -eq 0 ]; then sha256sum ${containerArchive} > ${containerArchive}.sha256; else printf "%s" "$dump_status" > ${containerArchive}.failed; fi`
],{input:password+'\n',timeout:120000,maxBuffer:2000000});
assert.equal(result.status,0,'Production backup failed; no migration may proceed');
// Snap's client may detach before the remote process finishes. The closed-file
// marker, rather than client exit, is the completion boundary.
const deadline=Date.now()+180000;
let closedHash;
do {
  closedHash=spawnSync('docker',['exec',container,'cat',`${containerArchive}.sha256`],{encoding:'utf8',timeout:15000});
  if (closedHash.status===0) break;
  const failed=spawnSync('docker',['exec',container,'test','-f',`${containerArchive}.failed`],{timeout:15000});
  assert.notEqual(failed.status,0,'Production dump failed before completing');
  assert.ok(Date.now()<deadline,'Backup generation has not finished');
  await delay(2000);
} while(true);
const listing=spawnSync('docker',['exec',container,'pg_restore','--list',containerArchive],{timeout:15000,maxBuffer:2000000});
assert.equal(listing.status,0,'Backup archive cannot be read');
const toc=listing.stdout.toString('utf8');
for(const table of ['orders','order_items','stock_reservations','purchase_items','misc_expenses','misc_expense_audit'])assert.ok(toc.includes('TABLE DATA public '+table),'Backup lacks '+table);
// The snap-packaged Docker client has a private /tmp and cannot access hidden
// home directories. Transfer through a private visible directory, then move it.
const transferDirectory=join(homedir(),`impulso-backup-transfer-${randomUUID()}`);
mkdirSync(transferDirectory,{mode:0o700});
const transferArchive=join(transferDirectory,'archive.dump');
const copied=spawnSync('docker',['cp',`${container}:${containerArchive}`,transferArchive],{timeout:30000});
assert.equal(copied.status,0,'Backup copy failed');
chmodSync(transferArchive,0o600);
renameSync(transferArchive,join(directory,'before-shipping.dump'));
rmdirSync(transferDirectory);
const archive=readFileSync(join(directory,'before-shipping.dump'));
const sha256=createHash('sha256').update(archive).digest('hex');
const sourceHash=spawnSync('docker',['exec',container,'sha256sum',containerArchive],{encoding:'utf8',timeout:15000});
assert.equal(sourceHash.status,0,'Backup source hash unavailable');
assert.equal(sourceHash.stdout.split(/\s/)[0],sha256,'Copied backup differs from the closed source archive');
assert.equal(closedHash.stdout.split(/\s/)[0],sha256,'Archive differs from the completion marker');
const manifest={project:SUPABASE_PROJECT_REF,file:'before-shipping.dump',bytes:archive.length,
  sha256,createdAt:new Date().toISOString(),archiveReadable:true,containerArchive,
  includes:['public','private','auth','storage metadata','migration history','ACLs'],excludes:['Storage file binaries','hosting secrets']};
writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({directory,...manifest}));
