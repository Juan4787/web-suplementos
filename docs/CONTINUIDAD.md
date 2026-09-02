# Fuente de verdad para continuar el proyecto

Este archivo existe para que una compactación de contexto no convierta decisiones firmes en suposiciones.

## Norte del producto

- Cliente: ver productos, armar el pedido y continuarlo por WhatsApp.
- Recepción: pegar el mensaje generado, revisar y confirmar el pedido.
- Operación: preparar, cobrar, enviar o entregar con una siguiente acción evidente.
- Dueña: entender stock, compras, ventas y margen; exportar sus datos; consultar una IA read-only.
- La lógica exacta vive en PostgreSQL. React nunca debe coordinar una media transacción.
- El núcleo sigue funcionando cuando la IA o su proveedor no responden.
- No se introduce deliberadamente ningún costo recurrente.

## Decisiones firmes

- React 19 + Vite + TypeScript + TanStack Router + TanStack Query + Tailwind.
- Supabase para PostgreSQL, Auth, RLS y Storage. La IA no usa Edge Functions ni una service role.
- Producción se empaqueta como un único Cloudflare Worker con Static Assets: React/Vite se sirve como asset y solo `/api/*` ejecuta código.
- La única entrada de IA es `POST /api/ai`, detrás de un orquestador propio. Groq/GPT-OSS y Workers AI/GLM quedan aislados en adapters y el failover no depende de AI Gateway.
- Los aliases de modelo son inmutables y versionados. Ningún modelo se habilita por declararse compatible: primero debe superar el contrato real.
- La selección inicial visible es solamente `Automático`; no se persisten conversaciones.
- Cada tool reenvía el JWT de la dueña a una RPC de Supabase que vuelve a ejecutar `require_owner()`.
- IA exclusivamente para lectura e interpretación; las cifras se calculan en PostgreSQL.
- XLSX se construye en un Web Worker y la librería se carga solo al exportar.
- WhatsApp usa `wa.me` en móvil y `web.whatsapp.com/send` en escritorio.
- Un pedido público no reserva stock. La reserva ocurre al confirmar su importación.
- No se borra un producto con historia: se archiva.
- No se estima IPC faltante.
- Los errores visibles explican el problema y el siguiente paso sin mostrar códigos internos.

## Alertas externas vigentes al 01/09/2026

- El hosting elegido y publicado es Cloudflare Worker + Static Assets. El dominio operativo es `https://impulso.suplementos.workers.dev`; las Preview URLs están desactivadas.
- Supabase Free puede pausar proyectos con muy poca actividad durante siete días. La interfaz debe explicar cómo reanudarlo; no se crearán pings artificiales para evadir esa política.
- Supabase Free no incluye transformación de imágenes. El navegador dimensiona y convierte cada archivo a WebP antes de subir; Storage guarda el archivo ya optimizado.
- La ruta certificada es Groq `openai/gpt-oss-120b` como primario y Workers AI `@cf/zai-org/glm-4.7-flash` como respaldo. Nemotron 3 fue rechazado por tool calls inestables; GPT-OSS mediante el binding AI fue rechazado por incompatibilidad en el round-trip de tools.
- Global Zero Data Retention quedó confirmado en Groq Console, organización `Personal` y proyecto `Default Project`: el control global figura `Enabled` y sobreescribe los ajustes específicos. Producción exige y conserva juntos `AI_ENABLED=true`, `GROQ_ZDR_CONFIRMED=true` y `VITE_AI_ENABLED=true`.
- El orquestador tiene deadline global, máximo dos rondas de tools, una sola transición de proveedor, failover sticky y resultados acotados. El núcleo comercial nunca depende de su disponibilidad.

## Actualización verificable del 01/09/2026

- Toolchain local migrado a Node `24.20.0`, Wrangler `4.127.1` y Supabase CLI de proyecto `2.116.0`.
- `wrangler.jsonc` apunta exclusivamente al Worker `impulso`, usa Static Assets para `dist`, ejecuta el Worker solo en `/api/*` y declara el binding `AI`.
- Antes de cualquier escritura remota, `scripts/validate-worker-target.mjs` exige el perfil `impulso`, el directorio exacto, una única cuenta llamada `app de suplementos` y su ID esperado.
- Las migraciones `20260901000000_ai_infrastructure.sql`, `20260901190000_ai_quota_policy.sql` y `20260901200000_ai_conversation_quota.sql` completan `ai_usage_counters` y `ai_request_audit`, implementan cuota atómica de 20 solicitudes por minuto y 100 por día, y mantienen las RPC de hechos read-only.
- Las RPC de IA no devuelven clientes, teléfonos, direcciones, notas ni descripciones. Ventas y márgenes se calculan en PostgreSQL; inventario y rendimiento devuelven como máximo 20 y 10 productos respectivamente.
- La migración se aplicó al proyecto Supabase vinculado `web-suplementos` después de comparar el esquema. Los conteos comerciales antes y después permanecieron iguales: 25 productos, 1 compra, 21 movimientos, 0 pedidos y 1 usuario.
- La suite SQL específica aprobó 23/23 y la suite SQL completa 75/75; el conjunto web aprobó 117/117 en 19 archivos. La certificación real aprobó 6/6 casos en GPT-OSS/Groq y 6/6 en GLM 4.7 Flash/Workers AI.
- La primera consulta real con tools, `¿Qué productos tengo?`, expuso dos salidas de modelo rechazadas correctamente: GPT-OSS escribió cantidades con palabras y GLM omitió el prefijo `fact:`. Se reforzó el prompt, se normalizan solo referencias que coinciden exactamente con facts existentes y el caso quedó incorporado a la certificación permanente.
- El Worker `impulso` se publicó en `https://impulso.suplementos.workers.dev`. La versión verificada al cierre es `8fedfbd8-7d36-4174-9920-d73a674181d0`, activa al 100 %.
- Producción sirve el mismo `index.html` y asset JavaScript que el build local según SHA-256. `/`, una ruta SPA, `/api/health`, método inválido, origen cruzado y el cierre seguro de `/api/ai` fueron comprobados contra la URL pública.

## Estado de implementación

La lista autoritativa está en `PLAN_IMPLEMENTACION.md`. No marcar una fase terminada por la mera existencia de archivos: exige sus verificaciones.

Al cierre local del 28/08/2026, el núcleo está implementado y verificado: tienda, checkout/WhatsApp, importación idempotente, roles, transacciones de stock/pedidos/compras, analíticas e IPC, respaldo XLSX y recuperación. La migración se reconstruyó desde cero, el lint SQL quedó limpio y las 43 pruebas de base —incluida concurrencia— aprobaron. TypeScript, 14 pruebas web, build y auditoría de dependencias también aprobaron.

La infraestructura de IA está implementada, migrada, certificada, desplegada y activa en modo `Automático`. Global ZDR fue comprobado antes de habilitar los tres flags. Las conversaciones no se persisten y el núcleo comercial continúa independiente de la IA.

La infraestructura remota de Impulso está separada y verificada: perfil Cloudflare `impulso`, cuenta única `app de suplementos`, Worker `impulso` y proyecto Supabase `web-suplementos`. No usar ninguna otra cuenta, perfil, repositorio, dominio ni proyecto Supabase para esta aplicación.

## Punto de reanudación

Si una sesión se interrumpe:

1. revisar `git status --short` sin descartar cambios;
2. leer la última sección de este archivo y el plan;
3. no modificar la ruta certificada ni volver a aplicar la migración ya publicada;
4. preservar juntos `VITE_AI_ENABLED`, `AI_ENABLED` y `GROQ_ZDR_CONFIRMED` en `true`; si cambia la clave u organización de Groq, cerrar los tres hasta volver a comprobar Global ZDR;
5. ejecutar primero la prueba focalizada del área modificada;
6. ejecutar `pnpm check`, pruebas de a una, build y smoke test remoto;
7. separar siempre evidencia local, Supabase, GitHub y hosting.
