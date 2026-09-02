# Plan de implementación verificable

Fecha base: 28/08/2026.

## Fase 0 — contratos y riesgos

- [x] Relevar especificación completa.
- [x] Cerrar reglas de reserva, venta, estados, stock negativo, permisos y exposición pública.
- [x] Verificar Supabase, Vercel y candidatos de IA contra documentación vigente.
- [x] Registrar la incompatibilidad Vercel Hobby/comercio.
- [x] Elegir Cloudflare Worker + Static Assets como hosting comercial sin costo recurrente obligatorio.

## Fase 1 — base frontend

- [x] Proyecto React/Vite/TypeScript reproducible.
- [x] TanStack Router con ramas pública y privada y páginas privadas lazy.
- [x] TanStack Query y frontera de datos Supabase/demo; producción nunca cae silenciosamente a demo.
- [x] Sistema visual propio, semántica base, estados de carga/error/vacío y responsive representativo.
- [x] Autenticación, usuario inactivo, guardas de rol y permisos de backend.

Puerta: typecheck, pruebas de navegación y build.

## Fase 2 — tienda y WhatsApp

- [x] Catálogo, detalle, carrito persistido y checkout breve.
- [x] Pago y entrega modelados por separado.
- [x] Validación de disponibilidad antes de abrir WhatsApp.
- [x] Protocolo determinístico versionado, UUID e indicador de integridad.
- [x] Parser estricto con pantalla de revisión y rechazo idempotente de duplicados.
- [x] URL directa según dispositivo.

Puerta: round-trip generador/parser, casos inválidos, cantidades y mobile.

## Fase 3 — Supabase y operación

- [x] Migración inicial completa, índices y triggers acotados.
- [x] RLS y privilegios de dueña/personal/anon.
- [x] Confirmación de pedido y reserva transaccional, incluso ante concurrencia real.
- [x] Transiciones independientes de pago, preparación, envío/entrega y cancelación.
- [x] Compras, recepción y movimientos transaccionales.
- [x] Ajuste de stock auditado y restringido a dueña.
- [x] Productos archivables, datos financieros separados y Storage con políticas cerradas.

Puerta: tests SQL de invariantes, permisos y concurrencia.

## Fase 4 — panel y analíticas

- [x] Inicio orientado a la siguiente acción.
- [x] Historiales crecientes paginados en servidor: pedidos, ventas, compras, movimientos y clientes; catálogo/stock permanecen como conjuntos operativos acotados.
- [x] Métricas nominales, unidades, operaciones, costos, impuesto y margen estimado.
- [x] IPC oficial manual con fuente y fecha; nunca estimado.
- [x] Comparaciones parciales con el mismo día de corte.

Puerta: rol personal no obtiene datos financieros por API ni UI.

## Fase 5 — respaldo XLSX

- [x] Contrato `impulso-business-backup/v1` con 13 hojas y columnas versionadas.
- [x] Exportación solo dueña, con revisión de consistencia.
- [x] Web Worker y librería lazy.
- [x] Cero fórmulas/macros; texto controlado siempre tipado como texto.
- [x] IDs, snapshots y relaciones suficientes para recuperar datos comerciales.
- [x] Reapertura y regrabado real en LibreOffice headless.

Puerta: conteos, relaciones, Unicode, fechas, importes y cero fórmulas.

## Fase 6 — IA read-only

- [x] Contrato neutral en frontend, ruta restringida, feature flag fail-closed y núcleo independiente.
- [x] Migrar toolchain a Node 24 y definir Worker + Static Assets con binding Workers AI.
- [x] Fijar guard de despliegue a la cuenta, perfil y Worker exclusivos de Impulso.
- [x] Elegir Groq/GPT-OSS + Workers AI/GLM 4.7 Flash y failover propio sticky, sin AI Gateway crítico.
- [x] Implementar reclamo atómico, auditoría agregada y herramientas RPC cerradas y solo lectura.
- [x] Limitar cuota a 20/minuto y 100/día; tools a períodos y resultados acotados.
- [x] Endpoint Worker autenticado y restringido a dueña mediante JWT reenviado.
- [x] Implementar adapters, registry versionado, deadline global y circuit breaker.
- [x] Limitar historial, bytes, dos rondas de tools y una transición de proveedor.
- [x] Errores humanos para cuota/dependencia.
- [x] Contratos simulados y certificación real independiente de ambos modelos.
- [x] Verificar Global ZDR de Groq antes de habilitar datos reales.
- [x] Habilitar únicamente modo Automático después de certificar ambos modelos.

Puerta: ninguna herramienta ni permiso de escritura; pruebas de rol y fallos 429/5xx.

## Fase 7 — Go-Live

- [x] Proyecto Supabase creado, migrado y verificado.
- [x] Dueña inicial creada y rol confirmado mediante el reclamo autenticado de IA.
- [x] Proveedor de IA elegido: plan gratuito, retención y modelos verificados.
- [ ] Datos reales de tienda y WhatsApp configurados.
- [ ] Imágenes reales optimizadas.
- [x] Decisión y despliegue de hosting comercial válido.
- [ ] Auditoría responsive, seguridad, accesibilidad, recuperación y backup.
- [ ] Migración histórica auditada o decisión explícita de comenzar en cero.

No declarar producción lista mientras quede un ítem de Go-Live sin evidencia.

## Evidencia local de cierre del núcleo

Ejecutada secuencialmente el 28/08/2026:

- `pnpm check`: TypeScript sin errores.
- `pnpm test`: 4 archivos y 14 pruebas aprobadas. Incluye protocolo WhatsApp, URLs por dispositivo, imágenes y estructura/binario XLSX.
- `pnpm build`: build de producción aprobado; 2.995 módulos transformados y rutas privadas separadas en chunks.
- Preview del build sin variables: muestra “Falta conectar la tienda” tanto en `/` como en `/app`; no expone la demo local.
- `pnpm audit --audit-level=high`: ninguna vulnerabilidad conocida.
- `supabase db reset --local`: migración reconstruida desde cero.
- `supabase db lint --local --level warning`: ningún error de esquema.
- `supabase test db`: 2 archivos y 43 pruebas aprobadas. Incluye RLS, roles, snapshots, estados, compras paginadas y dos reservas concurrentes contra el mismo stock.
- Navegador real, escritorio: checkout con transferencia + envío express, URL a WhatsApp Web, round-trip del mensaje, creación/reserva, rechazo del duplicado, estados independientes, permisos personal/dueña y descarga XLSX.
- Navegador real, 360 px: tienda, checkout, panel, navegación, importador, productos, compras y exportación sin overflow del documento.
- XLSX descargado desde el navegador: 13 hojas OOXML; la prueba automatizada además lo abre, regraba y vuelve a inspeccionar con LibreOffice.

Esta evidencia es local. No acredita todavía Supabase remoto, datos reales, dominio ni hosting de producción.

## Evidencia local de infraestructura IA — 01/09/2026

- Node `24.20.0`, Wrangler `4.127.1` y Supabase CLI de proyecto `2.116.0` verificados.
- El guard confirmó cuenta Cloudflare única `app de suplementos`, perfil/directorio `impulso` y Worker `impulso` antes de permitir despliegues.
- `supabase db reset --local --no-seed`: migración inicial + `20260901000000_ai_infrastructure.sql` aplicadas desde cero.
- `supabase db lint --local --level warning`: cero errores y cero advertencias.
- `supabase test db supabase/tests/database/ai_infrastructure.test.sql`: 23/23 pruebas aprobadas.
- La migración se aplicó al proyecto remoto vinculado `web-suplementos`; el esquema quedó limpio y los conteos comerciales no cambiaron.
- Endpoint, adapters, failover sticky, circuit breaker, validación de hechos y UI `Automático` quedaron implementados.
- Suite web completa: 19 archivos y 117/117 pruebas aprobadas.
- Suite SQL completa: 3 archivos y 75/75 pruebas aprobadas.
- Certificación remota: GPT-OSS/Groq 6/6 y GLM 4.7 Flash/Workers AI 6/6. Incluye `¿Qué productos tengo?`, selección de tools, hechos exactos y rechazo de escrituras. Nemotron 3 y GPT-OSS mediante el binding AI quedaron fuera del registry activo por fallos reproducibles de contrato.
- Secrets remotos presentes por nombre: `GROQ_API_KEY`, `SUPABASE_URL` y `SUPABASE_ANON_KEY`; sus valores no se imprimieron.
- Worker publicado en `https://impulso.suplementos.workers.dev`, versión `8fedfbd8-7d36-4174-9920-d73a674181d0` activa al 100 %, Preview URLs desactivadas.
- Smoke test remoto aprobado: raíz, ruta SPA y asset coinciden por SHA-256 con el build local; salud, método inválido, origen cruzado y cierre seguro de IA responden según contrato.
- Global ZDR fue comprobado en Groq antes de activar juntos `VITE_AI_ENABLED=true`, `AI_ENABLED=true` y `GROQ_ZDR_CONFIRMED=true`.
