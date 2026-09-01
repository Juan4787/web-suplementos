import { spawnSync } from 'node:child_process';
import { loadEnv } from 'vite';
import { PROJECT_ROOT } from './validate-worker-target.mjs';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';

const mode = process.argv[2];
if (!['list', 'diff', 'lint', 'dry-run', 'push'].includes(mode)) {
  throw new Error('[supabase-linked] Modo no permitido.');
}

assertSupabaseTarget();

const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || fileEnv.SUPABASE_DB_PASSWORD)?.trim();
if (!password || password.length < 12) {
  throw new Error('[supabase-linked] La contraseña local no supera la validacion previa.');
}

const args = mode === 'list'
  ? ['exec', 'supabase', 'migration', 'list', '--linked']
  : mode === 'diff'
    ? ['exec', 'supabase', 'db', 'diff', '--linked', '--schema', 'public,private']
    : mode === 'lint'
      ? ['exec', 'supabase', 'db', 'lint', '--linked', '--level', 'warning']
    : [
        'exec',
        'supabase',
        'db',
        'push',
        '--linked',
        ...(mode === 'dry-run' ? ['--dry-run'] : ['--yes'])
      ];

const result = spawnSync('pnpm', args, {
  cwd: PROJECT_ROOT,
  env: { ...process.env, SUPABASE_DB_PASSWORD: password },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120_000
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`[supabase-linked] La operacion ${mode} fue rechazada.`);
}

console.log(`[supabase-linked] Operacion ${mode} completada sin exponer la contraseña.`);
