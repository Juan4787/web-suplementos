# Arquitectura

## Despliegue

```text
Cloudflare Worker: impulso
  ├─ Static Assets: React/Vite
  └─ /api/*: código Worker
          │
          ├─ /api/health
          └─ /api/ai
                 │
                 ▼
          Orquestador propio
            ├─ registry versionado
            ├─ deadline + circuit breaker
            ├─ failover sticky
            ├─ validación de hechos
            └─ máximo dos rondas de tools
                 │
          ┌──────┴────────────────┐
          ▼                       ▼
GroqProvider              WorkersAIProvider
GPT-OSS 120B              GLM 4.7 Flash
          │                       │
          └──────────┬────────────┘
                     ▼
          RPC read-only de Supabase
          con JWT y require_owner()
```

La URL pública es `https://impulso.suplementos.workers.dev`. `wrangler.jsonc` es la fuente de verdad del despliegue. Las Preview URLs están desactivadas y los assets estáticos no ejecutan el Worker salvo las rutas `/api/*`.

## Fronteras

- El navegador puede pedir operaciones de negocio, pero no encadena escrituras críticas.
- Los RPC validan rol, estado previo, stock y snapshots dentro de una transacción.
- El navegador solo envía `message` y `modelPreference: "auto"`; no puede enviar system messages, tools, resultados, proveedor ni model ID.
- `/api/ai` reenvía el JWT de Supabase. Cada RPC vuelve a exigir que la sesión corresponda a la dueña.
- Las tools de IA son una lista cerrada, exclusivamente read-only. No aceptan SQL, nombres de tabla ni operaciones de escritura.
- Las cifras se calculan en PostgreSQL. El orquestador rechaza respuestas con números o fechas que no estén respaldados por hechos normalizados.
- Los errores internos se clasifican para retry/failover, se registran con contexto mínimo y se traducen a mensajes seguros para la interfaz.
- No se persisten conversaciones ni respuestas del modelo.

## Ruta de modelos

| Alias inmutable | Proveedor | Modelo real | Estado |
| --- | --- | --- | --- |
| `gpt_oss_120b_groq_v1` | Groq | `openai/gpt-oss-120b` | certificado 6/6 |
| `glm_4_7_flash_cf_v1` | Workers AI | `@cf/zai-org/glm-4.7-flash` | certificado 6/6 |

El modo visible es solamente `Automático`: primero Groq y, ante un fallo retryable, una única transición a Workers AI. Después de un tool call, el proveedor elegido queda fijo para el resto de ese intento; si cae, el transcript canónico completo pasa al respaldo.

Nemotron 3 no integra la ruta activa porque produjo argumentos de tools inestables. GPT-OSS por Workers AI tampoco integra la ruta activa porque el binding no conservó correctamente el round-trip de tools. Esas decisiones se basan en certificación real, no en capacidades declaradas.

## Cierre de seguridad

La IA solo puede activarse cuando se cumplen ambos flags de runtime:

```text
AI_ENABLED=true
GROQ_ZDR_CONFIRMED=true
```

Mientras cualquiera permanezca en `false`, `/api/ai` falla cerrado antes de invocar proveedores. Global Zero Data Retention fue comprobado en Groq Console y producción conserva ambos flags de runtime en `true`; el build se publicó con `VITE_AI_ENABLED=true`.

Los secretos remotos requeridos son `GROQ_API_KEY`, `SUPABASE_URL` y `SUPABASE_ANON_KEY`. Nunca se usa `service_role` y ningún secreto puede aparecer bajo un nombre `VITE_*`.

## Rendimiento y mantenimiento

- Cada ruta privada del frontend se importa de forma diferida.
- Listados crecientes usan paginación en servidor.
- Dashboard y analíticas consultan agregados de PostgreSQL.
- No se activa Realtime global.
- Imágenes: dimensionado y compresión WebP en cliente antes de Storage; `loading=lazy` fuera del primer viewport.
- XLSX: dataset autorizado, revisión inicial/final, Web Worker y dependencia lazy.
- IA: entrada e historial acotados, seis herramientas read-only agregadas, resultados compactos, deadline global de 30 segundos y máximo dos rondas.

## Adaptadores de datos

El frontend habla con un contrato `BusinessApi`. Hay dos implementaciones:

- Supabase para entornos conectados.
- Demo local, solo en desarrollo o con `VITE_APP_MODE=demo`, siempre identificada visualmente.

Producción nunca cae silenciosamente a demo por falta de variables.
