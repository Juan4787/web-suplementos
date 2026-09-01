# Despliegue en Cloudflare Worker

Impulso Suplementos se publica como un único Cloudflare Worker:

- React/Vite se sirve mediante Static Assets;
- únicamente `/api/*` ejecuta el Worker;
- Workers AI se consume mediante el binding `AI`;
- el dominio operativo es `https://impulso.suplementos.workers.dev`.

## Fuente de verdad

| Archivo | Propósito |
| --- | --- |
| `wrangler.jsonc` | Worker, assets, binding AI, región, flags y cierre de Preview URLs |
| `.nvmrc` | Node `24.20.0` |
| `public/_headers` | Cabeceras de seguridad y caché de assets |
| `scripts/project-targets.mjs` | Única fuente de IDs, nombres, región y hosts permitidos |
| `scripts/validate-build-env.mjs` | Detiene builds sin configuración pública de Supabase |
| `scripts/validate-worker-target.mjs` | Impide publicar fuera de la cuenta y Worker de Impulso |
| `scripts/sync-worker-secrets.mjs` | Sincroniza secretos sin imprimir valores |

`public/_redirects` no debe existir. El SPA ya está configurado con `assets.not_found_handling = "single-page-application"`; sumar la antigua reescritura de Pages crea un bucle y Cloudflare rechaza el despliegue.

## Destino inmutable

```text
perfil Wrangler: impulso
cuenta Cloudflare: app de suplementos
Worker: impulso
URL: https://impulso.suplementos.workers.dev
```

El guard también exige ejecutar desde la raíz exacta de este repositorio, que la sesión muestre una sola cuenta, que Static Assets ejecute código solo en `/api/*`, que las Preview URLs estén cerradas y que los flags de IA coincidan. El build y la sincronización de secretos rechazan cualquier host de Supabase distinto de `web-suplementos`. Si cualquier dato difiere, el proceso termina antes de compilar o escribir en Cloudflare.

## Variables de build

El build Vite necesita configuración pública de Supabase:

```text
VITE_APP_MODE=supabase
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_AI_ENABLED=true
```

También se admite `VITE_SUPABASE_ANON_KEY` como compatibilidad. Ninguna variable `VITE_*` puede contener secretos, una clave `service_role` ni la contraseña de base de datos.

## Secretos del Worker

Los únicos secretos requeridos son:

```text
GROQ_API_KEY
SUPABASE_URL
SUPABASE_ANON_KEY
```

Se sincronizan desde el entorno local:

```bash
nvm use
pnpm worker:secrets:sync
```

El script comprueba nombres y destino, usa carga cifrada de Wrangler y luego verifica solo la lista de nombres remotos. Nunca muestra los valores.

## Publicación segura

Ejecutar secuencialmente:

```bash
nvm use
pnpm check
pnpm test
pnpm worker:deploy:dry
pnpm worker:deploy
```

El dry-run debe mostrar:

```text
env.AI
env.ASSETS
env.AI_ENABLED
env.GROQ_ZDR_CONFIRMED
```

Después del despliegue, comprobar:

1. `wrangler --profile impulso deployments list --name impulso`: una sola versión al 100 %;
2. `/`: 200 y el mismo SHA-256 que `dist/index.html`;
3. una ruta SPA: 200 y el mismo HTML;
4. el asset JavaScript principal: 200, tipo JavaScript y mismo SHA-256;
5. `/api/health`: `{"status":"ok"}`;
6. `/api/ai` cerrado: respuesta controlada sin invocar proveedores;
7. origen cruzado y métodos no permitidos: rechazados según contrato.

## Activación de IA

La ruta certificada es:

```text
Groq / openai/gpt-oss-120b
  → failover
Workers AI / @cf/zai-org/glm-4.7-flash
```

Global Zero Data Retention fue comprobado en Groq y ambos modelos aprobaron la certificación real. Producción está activa con:

```text
AI_ENABLED=true
GROQ_ZDR_CONFIRMED=true
```

Los flags de runtime y `VITE_AI_ENABLED=true` deben cambiar siempre juntos. Si cambia la clave u organización de Groq, cerrar los tres hasta confirmar nuevamente Global ZDR, recertificar y repetir el smoke test. No habilitar parcialmente.

## Rollback

Listar despliegues y elegir una versión exacta conocida:

```bash
pnpm exec wrangler --profile impulso deployments list --name impulso
pnpm exec wrangler --profile impulso rollback VERSION_ID --name impulso
```

Verificar nuevamente URL, hash del build y cierre de `/api/ai`. Un rollback de Worker no revierte migraciones de Supabase; las migraciones deben mantenerse compatibles hacia atrás.
