import { loadEnv } from 'vite';

const fileEnv = loadEnv('production', process.cwd(), '');
const env = { ...fileEnv, ...process.env };
const mustBeConfigured = env.CF_PAGES === '1' || env.REQUIRE_SUPABASE_ENV === '1';

if (!mustBeConfigured) {
  process.exit(0);
}

const mode = env.VITE_APP_MODE?.trim();
const rawUrl = env.VITE_SUPABASE_URL?.trim();
const publicKey =
  env.VITE_SUPABASE_ANON_KEY?.trim() ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const problems = [];

if (mode !== 'supabase') {
  problems.push('VITE_APP_MODE debe ser supabase');
}

if (!rawUrl) {
  problems.push('falta VITE_SUPABASE_URL');
} else {
  try {
    const url = new URL(rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''));

    if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
      problems.push('VITE_SUPABASE_URL no es una dirección HTTPS de Supabase');
    }
  } catch {
    problems.push('VITE_SUPABASE_URL no es una dirección válida');
  }
}

if (!publicKey) {
  problems.push('falta VITE_SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_ANON_KEY');
}

if (problems.length > 0) {
  console.error(
    `[build-config] Publicación cancelada: ${problems.join('; ')}. ` +
      'La versión activa no será reemplazada por una aplicación desconectada.',
  );
  process.exit(1);
}

console.log('[build-config] Configuración pública de Supabase verificada.');
