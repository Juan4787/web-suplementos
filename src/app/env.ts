export type RuntimeMode = 'demo' | 'supabase' | 'unconfigured';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL?.trim() ?? '')
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const supabaseUrl = rawUrl ? (rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`) : '';

const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  '';

const requestedMode = import.meta.env.VITE_APP_MODE?.trim();
const hasSupabaseConfiguration = Boolean(supabaseUrl && supabasePublishableKey);
const aiEnabled = import.meta.env.VITE_AI_ENABLED === 'true';

const resolveMode = (): RuntimeMode => {
  if (requestedMode === 'demo') return 'demo';
  if (hasSupabaseConfiguration) return 'supabase';
  if (requestedMode === 'supabase' && hasSupabaseConfiguration) return 'supabase';
  if (import.meta.env.DEV) return 'demo';
  return 'unconfigured';
};

export const appEnv = {
  mode: resolveMode(),
  supabaseUrl,
  supabasePublishableKey,
  aiEnabled,
  isDemo: resolveMode() === 'demo',
  isConfigured: resolveMode() !== 'unconfigured'
} as const;
