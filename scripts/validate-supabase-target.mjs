import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROJECT_ROOT,
  SUPABASE_DATABASE_HOST,
  SUPABASE_PROJECT_NAME,
  SUPABASE_PROJECT_REF,
  SUPABASE_PROJECT_REGION
} from './project-targets.mjs';

export {
  SUPABASE_DATABASE_HOST,
  SUPABASE_PROJECT_NAME,
  SUPABASE_PROJECT_REF,
  SUPABASE_PROJECT_REGION
};

const fail = (message) => {
  throw new Error(`[supabase-target] Operacion cancelada: ${message}`);
};

export const assertSupabaseTarget = () => {
  if (resolve(process.cwd()) !== PROJECT_ROOT) {
    fail(`el comando debe ejecutarse desde ${PROJECT_ROOT}.`);
  }

  const linkedRef = readFileSync(resolve(PROJECT_ROOT, 'supabase/.temp/project-ref'), 'utf8').trim();
  if (linkedRef !== SUPABASE_PROJECT_REF) fail('el enlace local no apunta al proyecto de suplementos.');

  let projects;
  try {
    const output = execFileSync('pnpm', ['exec', 'supabase', 'projects', 'list', '--output', 'json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    });
    projects = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'fallo desconocido';
    fail(`no se pudo verificar la sesion (${detail}).`);
  }

  if (!Array.isArray(projects)) fail('la lista de proyectos no tiene la forma esperada.');
  const linked = projects.filter((project) => project?.linked === true);
  if (linked.length !== 1) fail('debe existir exactamente un proyecto vinculado.');

  const [project] = linked;
  if (
    project.ref !== SUPABASE_PROJECT_REF ||
    project.name !== SUPABASE_PROJECT_NAME ||
    project.status !== 'ACTIVE_HEALTHY' ||
    project.region !== SUPABASE_PROJECT_REGION ||
    project.database?.host !== SUPABASE_DATABASE_HOST
  ) {
    fail('el proyecto vinculado no coincide exactamente con la base de suplementos activa.');
  }

  console.log(
    `[supabase-target] Destino verificado: ${SUPABASE_PROJECT_NAME} / ${SUPABASE_PROJECT_REF} / ${SUPABASE_PROJECT_REGION}.`,
  );
};
