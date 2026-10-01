// Financial fixtures are restricted to the separately identified local DB.
// Never load remote credentials, invoke Supabase CLI, or persist fixture rows.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from './project-targets.mjs';

const stage = process.argv[2] ?? 'candidate';
if (!['before', 'candidate', 'expenses'].includes(stage)) throw new Error('Unknown local test stage');
const stagingRoot = resolve(PROJECT_ROOT, '../APP DE SUPLEMENTOS STAGING');
const guard = await import(pathToFileURL(resolve(stagingRoot, 'scripts/staging/local-guard.mjs')));
const inspect = name => JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
guard.assertIsolatedNetwork(inspect(guard.NETWORK));
guard.assertOwnContainer(inspect(guard.ownName('db')));
const credentials = guard.assertLocalCredentials(JSON.parse(readFileSync(resolve(stagingRoot, 'staging/.local/credentials.json'), 'utf8')));
const sql = input => execFileSync('docker', ['exec', '-i', guard.ownName('db'), 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-U', 'supabase_admin', '-d', 'postgres', '-At'], { input, encoding: 'utf8', timeout: 180000, maxBuffer: 16000000 });
if (!sql('begin read only; select instance_id from staging_guard.identity; rollback;').split('\n').includes(credentials.instanceId)) {
  throw new Error('Local database identity mismatch');
}
const migration = readFileSync(resolve(PROJECT_ROOT, 'supabase/migrations/20261001120000_sales_analytics_full_period.sql'), 'utf8');
const file = stage === 'expenses' ? 'misc_expenses.test.sql' : 'sales_periods.test.sql';
const tests = readFileSync(resolve(PROJECT_ROOT, 'supabase/tests/database', file), 'utf8');
const input = stage === 'before' ? tests : tests.replace(/^begin;/, () => `begin;\n${migration}`);
console.log(`Local ${stage}: isolated identity verified; fixture and function changes will roll back.`);
let output;
try { output = sql(input); } catch (error) {
  console.error(error.stdout?.toString().slice(-1500) ?? '');
  console.error(error.stderr?.toString().slice(-2000) ?? 'Local SQL execution failed');
  process.exitCode = 1;
}
if (output) {
  mkdirSync(resolve(PROJECT_ROOT, 'output/audit'), { recursive: true });
  writeFileSync(resolve(PROJECT_ROOT, `output/audit/sales-calendar-${stage}.log`), output);
  console.log(output.split('\n').filter(line => /^(not ok|ok|1\.\.|# Looks)/.test(line)).join('\n'));
  if (/^not ok /m.test(output) || !/^1\.\.\d+$/m.test(output)) process.exitCode = 1;
}
