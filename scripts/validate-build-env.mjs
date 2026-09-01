import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { PROJECT_ROOT, SUPABASE_API_HOST } from './project-targets.mjs';

const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const env = { ...fileEnv, ...process.env };
if (env.CF_PAGES === '1') {
  console.error(
    '[build-config] Publicación cancelada: este repositorio se despliega únicamente como Cloudflare Worker.',
  );
  process.exit(1);
}

const mustBeConfigured = env.CF_WORKERS === '1' || env.REQUIRE_SUPABASE_ENV === '1';

if (!mustBeConfigured) {
  process.exit(0);
}

const mode = env.VITE_APP_MODE?.trim();
const rawUrl = env.VITE_SUPABASE_URL?.trim();
const publicKey = env.VITE_SUPABASE_ANON_KEY?.trim() || env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const frontendAiEnabled = env.VITE_AI_ENABLED?.trim();
const problems = [];

if (mode !== 'supabase') {
  problems.push('VITE_APP_MODE debe ser supabase');
}

if (!rawUrl) {
  problems.push('falta VITE_SUPABASE_URL');
} else {
  try {
    const url = new URL(rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''));

    if (url.protocol !== 'https:' || url.hostname !== SUPABASE_API_HOST) {
      problems.push('VITE_SUPABASE_URL no apunta al proyecto aislado de suplementos');
    }
  } catch {
    problems.push('VITE_SUPABASE_URL no es una dirección válida');
  }
}

if (!publicKey) {
  problems.push('falta VITE_SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_ANON_KEY');
}

if (!['true', 'false'].includes(frontendAiEnabled)) {
  problems.push('VITE_AI_ENABLED debe ser true o false');
}

const workerConfig = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'wrangler.jsonc'), 'utf8'));
const workerAiEnabled = workerConfig.vars?.AI_ENABLED;
const zdrConfirmed = workerConfig.vars?.GROQ_ZDR_CONFIRMED;
if (workerAiEnabled !== frontendAiEnabled) {
  problems.push('VITE_AI_ENABLED y AI_ENABLED deben coincidir');
}
if (workerAiEnabled !== zdrConfirmed) {
  problems.push('AI_ENABLED y GROQ_ZDR_CONFIRMED deben habilitarse o cerrarse juntos');
}

if (problems.length > 0) {
  console.error(
    `[build-config] Publicación cancelada: ${problems.join('; ')}. ` +
      'La versión activa no será reemplazada por una aplicación desconectada.',
  );
  process.exit(1);
}

console.log('[build-config] Configuración pública de Supabase verificada.');
