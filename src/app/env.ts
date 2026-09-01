export type RuntimeMode = 'demo' | 'supabase' | 'unconfigured';

const DEFAULT_SUPABASE_URL = 'https://mvtpidtuntvebyrxivue.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12dHBpZHR1bnR2ZWJ5cnhpdnVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwNjAyNzQsImV4cCI6MjEwMzYzNjI3NH0.12SQoiExVYxPdKgEARErqThXXatIXhFkYd65074bYMg';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL)
  .replace(/\/rest\/v1\/?$/i, '')
  .replace(/\/+$/, '');

const supabaseUrl = rawUrl ? (rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`) : DEFAULT_SUPABASE_URL;

const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  DEFAULT_SUPABASE_ANON_KEY;

const requestedMode = import.meta.env.VITE_APP_MODE?.trim() || 'supabase';
const hasSupabaseConfiguration = Boolean(supabaseUrl && supabasePublishableKey);
const aiEnabled = import.meta.env.VITE_AI_ENABLED === 'true' || import.meta.env.VITE_AI_ENABLED === undefined;

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
