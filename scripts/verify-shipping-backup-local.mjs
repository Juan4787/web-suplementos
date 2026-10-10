// Restore the private production archive into a fresh SQL-only local database.
// This destination deliberately cannot pass the shipping fixture runner guard.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const container='supabase_db_app-de-suplementos';
const database='backup_restore_shipping_certified_20261010';
const archive='/home/usuario/.local/share/impulso-backups/2026-10-10T09-48-26-650Z-shipping/before-shipping.dump';
const expectedHash='e53ba37d00335046b7c1118db83ab04768a0ed3fe410f42eeaf3d3c8c4c673aa';
const data=readFileSync(archive);
assert.equal(createHash('sha256').update(data).digest('hex'),expectedHash);
const execSql=(db,input)=>execFileSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',db,'-At'],{input,encoding:'utf8',timeout:30000});
assert.equal(execSql('postgres',`select exists(select 1 from pg_database where datname='${database}');`).trim(),'f','Backup destination must not exist');
execSql('postgres',`create database ${database} template template0;`);
execSql(database,"drop schema public cascade;create schema extensions;create extension pgcrypto with schema extensions;create extension \"uuid-ossp\" with schema extensions;create extension pg_trgm with schema extensions;create extension vector with schema extensions;");
execFileSync('docker',['exec','-i',container,'pg_restore','-U','supabase_admin','-d',database,'--no-owner','--exit-on-error'],{input:data,stdio:['pipe','ignore','pipe'],timeout:60000});
const before=JSON.parse(readFileSync(resolve('output/audit/shipping-release-before.json'),'utf8'));
const differences=[];
const identifier=name=>'"'+name.replaceAll('"','""')+'"';
for(const [table,expected] of Object.entries(before.tables)) {
  const result=JSON.parse(execSql(database,`begin read only;select jsonb_build_object('count',count(*)::text,'hash',coalesce(md5(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text))),md5(''))) from public.${identifier(table)} t;rollback;`).split('\n').find(line=>line.startsWith('{')));
  if(JSON.stringify(result)!==JSON.stringify(expected)) {
    // JSON key order is not a data difference.
    if(result.count!==expected.count || result.hash!==expected.hash)differences.push(table);
  }
}
assert.deepEqual(differences,[],'Restored public data must match the read-only pre-release snapshot');
writeFileSync('output/audit/shipping-backup-restoration.json',JSON.stringify({environment:'isolated-local-restoration',database,archiveHash:expectedHash,publicTables:Object.keys(before.tables).length,dataMatches:true,sqlOnly:true},null,2));
console.log('PASS private archive restored into SQL-only local database; '+Object.keys(before.tables).length+' public tables match pre-release row fingerprints');
