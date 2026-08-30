export type RuntimeMode = 'demo' | 'supabase' | 'unconfigured';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
const requestedMode = import.meta.env.VITE_APP_MODE;
const hasSupabaseConfiguration = Boolean(supabaseUrl && supabasePublishableKey);
const aiEnabled = import.meta.env.VITE_AI_ENABLED === 'true';

const resolveMode = (): RuntimeMode => {
  if (requestedMode === 'demo') return 'demo';
  if (requestedMode === 'supabase' && hasSupabaseConfiguration) return 'supabase';
  if (hasSupabaseConfiguration) return 'supabase';
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
