# Plan de implementación verificable

Fecha base: 28/08/2026.

## Fase 0 — contratos y riesgos

- [x] Relevar especificación completa.
- [x] Cerrar reglas de reserva, venta, estados, stock negativo, permisos y exposición pública.
- [x] Verificar Supabase, Vercel y candidatos de IA contra documentación vigente.
- [x] Registrar la incompatibilidad Vercel Hobby/comercio.
- [ ] Elegir hosting de producción compatible con uso comercial y $0, o autorizar Vercel Pro.

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

## Fase 6 — IA read-only (última fase; proveedor/modelo pendiente)

- [x] Contrato neutral en frontend, ruta restringida, feature flag apagado y núcleo independiente.
- [ ] Edge Function autenticada y restringida a dueña.
- [ ] Elegir proveedor, modelo y política de fallback con evidencia vigente.
- [ ] Implementar el adaptador seleccionado sin filtrar detalles al frontend.
- [ ] Herramientas RPC cerradas y solo lectura.
- [ ] Límites por usuario, iteraciones y tamaño.
- [ ] Errores humanos para cuota/dependencia.
- [ ] Checklist manual de retención, plan gratuito y modelo permitido.

Puerta: ninguna herramienta ni permiso de escritura; pruebas de rol y fallos 429/5xx.

## Fase 7 — Go-Live

- [ ] Proyecto Supabase creado, migrado y verificado.
- [ ] Dueña inicial creada y rol confirmado.
- [ ] Proveedor de IA elegido: plan gratuito, facturación, retención y modelos verificados.
- [ ] Datos reales de tienda y WhatsApp configurados.
- [ ] Imágenes reales optimizadas.
- [ ] Decisión y despliegue de hosting comercial válido.
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
