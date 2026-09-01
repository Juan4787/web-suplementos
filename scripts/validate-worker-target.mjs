import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ACCOUNT_NAME,
  CLOUDFLARE_PROFILE,
  PROJECT_ROOT,
  WORKER_NAME
} from './project-targets.mjs';

export {
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ACCOUNT_NAME,
  CLOUDFLARE_PROFILE,
  PROJECT_ROOT,
  WORKER_NAME
};

const fail = (message) => {
  throw new Error(`[worker-target] Publicacion cancelada: ${message}`);
};

const runWrangler = (args) => {
  try {
    return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'fallo desconocido';
    fail(`no se pudo verificar Wrangler (${detail}).`);
  }
};

export const assertWorkerTarget = () => {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    fail(`se requiere Node 20 o superior; la sesion usa Node ${process.versions.node}.`);
  }

  if (resolve(process.cwd()) !== PROJECT_ROOT) {
    fail(`el comando debe ejecutarse desde ${PROJECT_ROOT}.`);
  }

  const config = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'wrangler.jsonc'), 'utf8'));
  if (config.name !== WORKER_NAME) fail(`wrangler.jsonc debe apuntar a ${WORKER_NAME}.`);
  if (config.main !== './worker/index.ts') fail('el entrypoint del Worker no coincide.');
  if (config.workers_dev !== true) fail('workers.dev debe quedar habilitado.');
  if (config.preview_urls !== false) fail('las Preview URLs deben permanecer deshabilitadas.');
  if (config.placement?.region !== 'aws:sa-east-1') fail('la region del Worker no coincide.');
  if (config.ai?.binding !== 'AI') fail('falta el binding AI esperado.');
  if (
    config.assets?.directory !== './dist' ||
    config.assets?.binding !== 'ASSETS' ||
    config.assets?.not_found_handling !== 'single-page-application' ||
    JSON.stringify(config.assets?.run_worker_first) !== JSON.stringify(['/api/*'])
  ) {
    fail('la frontera entre Static Assets y /api/* no coincide.');
  }
  const requiredSecrets = [...(config.secrets?.required ?? [])].sort();
  if (
    JSON.stringify(requiredSecrets) !==
    JSON.stringify(['GROQ_API_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'])
  ) {
    fail('la lista de secretos requeridos no coincide.');
  }
  const aiEnabled = config.vars?.AI_ENABLED;
  const zdrConfirmed = config.vars?.GROQ_ZDR_CONFIRMED;
  if (!['true', 'false'].includes(aiEnabled) || !['true', 'false'].includes(zdrConfirmed)) {
    fail('los flags de IA deben ser booleanos textuales explícitos.');
  }
  if (aiEnabled !== zdrConfirmed) {
    fail('IA y confirmacion ZDR deben habilitarse o cerrarse juntas.');
  }

  const profiles = runWrangler(['auth', 'list']).replace(/\u001b\[[0-9;]*m/g, '');
  if (!profiles.includes(CLOUDFLARE_PROFILE) || !profiles.includes(PROJECT_ROOT)) {
    fail(`el perfil ${CLOUDFLARE_PROFILE} no esta vinculado a este repositorio.`);
  }

  const identity = JSON.parse(runWrangler(['whoami', '--json']));
  if (identity.loggedIn !== true || !Array.isArray(identity.accounts)) {
    fail('la sesion de Cloudflare no esta autenticada.');
  }
  if (identity.accounts.length !== 1) {
    fail('la sesion debe exponer exactamente una cuenta para eliminar ambiguedades.');
  }

  const [account] = identity.accounts;
  if (account.id !== CLOUDFLARE_ACCOUNT_ID || account.name !== CLOUDFLARE_ACCOUNT_NAME) {
    fail('la cuenta activa no es la cuenta aislada de Impulso Suplementos.');
  }

  console.log(
    `[worker-target] Destino verificado: ${CLOUDFLARE_ACCOUNT_NAME} / ${WORKER_NAME} / perfil ${CLOUDFLARE_PROFILE}.`,
  );
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assertWorkerTarget();
}
