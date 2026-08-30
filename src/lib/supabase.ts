import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { appEnv } from '@/app/env';

let client: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient => {
  if (client) return client;
  if (appEnv.mode !== 'supabase') {
    throw new Error('Supabase no está configurado en este entorno.');
  }
  client = createClient(appEnv.supabaseUrl, appEnv.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
  return client;
};

