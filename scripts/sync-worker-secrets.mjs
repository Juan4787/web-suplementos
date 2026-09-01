import { spawnSync } from 'node:child_process';
import { loadEnv } from 'vite';
import {
  assertWorkerTarget,
  CLOUDFLARE_PROFILE,
  PROJECT_ROOT,
  WORKER_NAME
} from './validate-worker-target.mjs';
import { SUPABASE_API_HOST } from './project-targets.mjs';

assertWorkerTarget();

const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const env = { ...fileEnv, ...process.env };
const groqApiKey = env.GROQ_API_KEY?.trim();
const supabaseUrl = env.VITE_SUPABASE_URL?.trim()?.replace(/\/+$/, '');
const supabaseAnonKey =
  env.VITE_SUPABASE_ANON_KEY?.trim() || env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

if (!groqApiKey || groqApiKey.length < 20) {
  throw new Error('[worker-secrets] GROQ_API_KEY no supera la validacion local.');
}

if (!supabaseAnonKey || supabaseAnonKey.length < 20) {
  throw new Error('[worker-secrets] La clave publica de Supabase no supera la validacion local.');
}

let parsedSupabaseUrl;
try {
  parsedSupabaseUrl = new URL(supabaseUrl);
} catch {
  throw new Error('[worker-secrets] La direccion de Supabase no es valida.');
}

if (parsedSupabaseUrl.protocol !== 'https:' || parsedSupabaseUrl.hostname !== SUPABASE_API_HOST) {
  throw new Error('[worker-secrets] La direccion de Supabase no corresponde al proyecto aislado de suplementos.');
}

const secrets = {
  GROQ_API_KEY: groqApiKey,
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: supabaseAnonKey
};

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    '--profile',
    CLOUDFLARE_PROFILE,
    'secret',
    'bulk',
    '--name',
    WORKER_NAME
  ],
  {
    cwd: PROJECT_ROOT,
    env: process.env,
    input: JSON.stringify(secrets),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit']
  },
);

if (result.status !== 0) {
  throw new Error('[worker-secrets] Cloudflare rechazo la sincronizacion de secretos.');
}

console.log(
  '[worker-secrets] Configurados GROQ_API_KEY, SUPABASE_URL y SUPABASE_ANON_KEY; ningun valor fue mostrado.',
);
