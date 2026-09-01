import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(scriptDirectory, '..');

export const WORKER_NAME = 'impulso';
export const CLOUDFLARE_PROFILE = 'impulso';
export const CLOUDFLARE_ACCOUNT_ID = 'ac3c557ebce16c8392f9199ea0991fb1';
export const CLOUDFLARE_ACCOUNT_NAME = 'app de suplementos';

export const SUPABASE_PROJECT_REF = 'mvtpidtuntvebyrxivue';
export const SUPABASE_PROJECT_NAME = 'web-suplementos';
export const SUPABASE_PROJECT_REGION = 'sa-east-1';
export const SUPABASE_DATABASE_HOST = `db.${SUPABASE_PROJECT_REF}.supabase.co`;
export const SUPABASE_API_HOST = `${SUPABASE_PROJECT_REF}.supabase.co`;
