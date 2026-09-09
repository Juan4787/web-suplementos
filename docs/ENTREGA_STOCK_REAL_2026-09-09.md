# Preparación de entrega con stock real — 09/09/2026

El estado real informado por la dueña está cargado: **49 unidades físicas, 145 en camino en dos compras y 8 reservas previas dentro del primer envío**. Se retiraron las operaciones de prueba por instrucción explícita del usuario, incluida la compra #2033. Desde esta carga deben preservarse todas las operaciones nuevas.

## Stock físico confirmado

| Producto | Unidades en casa |
| --- | ---: |
| B COMPLEX ACTIVE | 2 |
| MAGNESIO DUAL ACTION | 3 |
| ANDRO SUPPORT | 2 |
| FEMME BALANCE | 3 |
| PROBIOVANCE I5 | 2 |
| OMEGA 3 | 5 |
| OMEGA PURE NUTRITION ULTRA | 4 |
| MSM | 4 |
| VITAMINA C | 1 |
| CREATINA | 3 |
| GLUTAMINA | 2 |
| INOSITOL CARE | 3 |
| METABOGLYC | 2 |
| HEPATO SUPPORT | 3 |
| GASTRO SUPPORT | 6 |
| ACID SUPPORT | 4 |
| **Total** | **49** |

Los productos que no aparecen en el stock físico informado quedaron con cero unidades. Se asociaron los nombres abreviados del mensaje con sus productos existentes; «Creativa» corresponde a CREATINA, «Probiovamce» a PROBIOVANCE I5 y «Omega Omapure» al producto OMEGA 3, distinto de OMEGA PURE NUTRITION ULTRA. El producto archivado WHEYPROT se conserva sin stock y fuera de la tienda.

## Limpieza y protección

- Retirados 7 pedidos, 6 clientes, 1 compra, 17 líneas de pedido, 17 reservas de prueba, 7 líneas de compra, 1 registro de recepción y 30 movimientos de prueba.
- Generados 16 movimientos explícitos de stock inicial real. Cero ventas, cobros, pedidos y clientes después de la limpieza.
- Catálogo, costos, imágenes, configuración y las dos cuentas se compararon por huella antes y después de la transacción: idénticos.
- Script `scripts/load-real-opening-stock.mjs`: vista previa obligatoria, bloqueo de escrituras durante la transacción, comprobación de que el estado no cambió y validación de respaldo reciente. Una repetición después de la carga se rechaza.
- Respaldo privado fuera del repositorio: `/home/usuario/.local/share/impulso-backups/2026-09-09T15-13-50-676Z/`. Se verificaron hash y contenido del índice del respaldo con `pg_restore --list`. No contiene los archivos binarios de Storage, que esta operación no modifica.
- Evidencia privada: `output/audit/real-opening-stock-plan.json`, `real-opening-stock-backup.json` y `real-opening-stock-result.json`.

## Compras y reservas confirmadas

La aclaración posterior confirma que los dos bloques son compras distintas. **Compra #2034: 62 unidades**, ya despachadas y en el correo de Santa Fe: B 20, Thyroid 10, Magnesio 10, Vitality 8, Sleep 8, Vitamina C 4 y Colágeno 2. Dentro de esa compra están reservadas Thyroid 3, Sleep 4 y Vitality 1: ocho unidades.

**Compra #2035: 83 unidades**, pagadas al proveedor, con despacho previsto para el viernes: B 10, Thyroid 15, Magnesio 10, Inositol 6, Hepato 6, Andro 8, D más K2 4, Vitality 4, Sleep 4, Femme 2, Vitamina C 2, Glutamina 8, Creatina 2 y Colágeno 2. D más K2 corresponde a D +40 SUPPORT, cuya descripción incluye D3 y K2.

El proveedor figura como «Proveedor no informado» y ambas compras incluyen notas para distinguirlas. No se asignó una fecha de llegada sin confirmar. Los costos se tomaron del catálogo existente, con la indicación de verificarlos contra los comprobantes. La segunda compra menciona en su nota el pago previo informado por la dueña; no se inventó un importe de pago.

Quedan **137 unidades entrantes libres**, y **186 disponibles proyectadas** al incluir las 49 físicas. La tienda solo permite pedidos sobre la capacidad libre; continúa aplicando el límite por producto y avisa cuando la entrega depende de la reposición.

La carga usa `scripts/load-real-incoming-stock.mjs`: vista previa, respaldo nuevo verificado, bloqueo y comparación de huellas dentro de una transacción. Crea dos compras, 21 líneas y tres reservas previas; conserva íntegros los saldos físicos, movimientos iniciales, productos, costos, imágenes, configuración y cuentas. Rechaza una repetición o la aparición de nuevas operaciones. Evidencia: `output/audit/real-incoming-plan.json`, `real-incoming-backup.json`, `real-incoming-backup-verified.json` y `real-incoming-result.json`.

## Cómo atender las ocho reservas anteriores

1. La dueña registra en **Inventario → Compras** únicamente la mercadería que efectivamente recibió; admite recepciones parciales.
2. Las unidades comprometidas quedan apartadas automáticamente. En **Inventario → Stock → Reservas previas** aparecen las cantidades recibidas y las que siguen en camino.
3. Natalia o Florencia usan **Registrar entrega** al entregar esas unidades. Admiten entregas parciales y los reintentos no descuentan dos veces. No se generan clientes, ventas ni cobros ficticios.
4. Si una reserva se cancela, **Liberar reserva** pide cantidad y confirmación. Si el proveedor no entregará lo faltante, la pantalla explica qué reserva quedó sin cobertura.

No hay nombres de clientes ni un detalle de pagos anteriores. Estas ocho unidades se registran como reservas de apertura; los pedidos y cobros nuevos se gestionan por el recorrido habitual. La exportación XLSX identifica el origen de las reservas y la compra relacionada, aunque no exista un pedido de cliente.

## Corrección de cantidades pendientes

La revisión encontró otra inconsistencia del servidor: Productos usaba el número libre de reservas como total en camino, mientras Inventario sumaba la cantidad pedida completa aunque hubiese recepciones parciales. La migración `20260909160000_incoming_stock_totals_and_reservations.sql` separa total pendiente, reservado en camino y capacidad libre. El disponible proyectado y la sugerencia de compra descuentan también las reservas en camino. La tienda conserva exclusivamente la capacidad libre para nuevos pedidos.

Productos e Inventario explican cuántas unidades en camino ya están reservadas. La migración `20260909170000_opening_reservations.sql` incorpora las reservas de apertura al mismo cálculo de capacidad libre y recepción. Preserva la coherencia de las reservas de pedidos normales y la protección contra reintentos de recepción con datos distintos.

## Verificación

- Vitest final: **302/302 en 50 archivos**, un trabajador, sin paralelismo entre archivos y con heap de Node limitado a 768 MB. Log `output/audit/handoff-final-tests.log`.
- Última revisión visual: se corrigió una etiqueta que decía «En camino» en productos con pocas unidades físicas y una reposición pendiente. Tarjeta y detalle ahora conservan «Últimas unidades» en ese caso. Tras este ajuste y el cambio de lenguaje solicitado, **42/42 pruebas específicas en ocho archivos** aprobadas, incluidas dos nuevas regresiones. Log `output/audit/handoff-final-copy-and-availability-tests.log`.
- PostgreSQL local: **20/20** controles específicos. Compra de 10, reserva de 3, recepción de 2 y luego de 8: cantidades coherentes en Productos, Inventario y tienda. El cierre definitivo con faltante también deja de contar unidades pendientes. Prueba `supabase/tests/database/incoming_stock_display.test.sql`, dentro de una transacción que se revierte.
- PostgreSQL local, reservas previas: **34/34** controles de recepción parcial, prioridad de reservas previas, entrega por personal, liberación, faltante, entrega normal de un pedido nuevo y reintentos idempotentes. No se escribieron operaciones de prueba en producción. Log `output/audit/opening-reservations-sql-test.log`.
- Ambas migraciones se aplicaron en Supabase después de revisar el destino y cada vista previa, sin semillas ni cambios de cuentas. Logs `output/audit/real-stock-migration-apply.log` y `output/audit/opening-reservations-migration-apply.log`.
- Otras regresiones PostgreSQL: **99/99** entre reglas de negocio, auditoría final, asignaciones entrantes, recepciones repetidas y reservas concurrentes. Con los dos archivos nuevos son **153 controles aprobados**. Logs `output/audit/handoff-sql-*.log`.
- TypeScript y compilación de producción aprobados. Log `output/audit/handoff-final-build.log`.
- **20/20 recorridos E2E** en Chromium de escritorio y móvil: catálogo, checkout, importación, precios actualizados, importación repetida, búsqueda del pedido, cobro, entrega y cancelación. Las escrituras se hicieron exclusivamente en la demo local. Log `output/audit/handoff-daily-e2e.log`.
- Comprobación remota: **39 migraciones aplicadas, ninguna pendiente**, dos compras reales, cero pedidos/clientes, tres reservas previas y 16 movimientos de apertura. Dos cuentas activas, sin saldos inválidos ni diferencias entre reservas físicas y saldos. Configuración comercial presente. Log `output/audit/handoff-readiness-loaded.log`.
- Validación por producto contra el catálogo público: cantidades entrantes libres y máximo de pedido correctos; exportación con las tres reservas previas, sin ventas ficticias. Evidencia `output/audit/handoff-inventory-verification.json`.

## Publicación y comprobación visual

- Worker `tienda`, versión final **`70779266-9a74-4ab0-a30d-ea7091a836a3`**, publicado en `https://tienda.desuplementos.workers.dev`. Incluye los últimos ajustes de lenguaje y disponibilidad. Log `output/audit/handoff-worker-final-deploy.log`.
- La publicación se comprueba por SHA-256 contra el HTML y los módulos JavaScript de la compilación revisada, junto con la huella de sus fuentes. Evidencias `output/audit/handoff-build-manifest.json` y `handoff-published-artifacts.json`.
- Navegador autenticado en producción, sin escrituras de negocio: tres reservas previas visibles con entrega deshabilitada hasta la recepción y explicación del siguiente paso; dos compras visibles con 62 y 83 unidades y sus notas; Productos muestra Thyroid 25/3/22, Sleep 12/4/8 y Vitality 12/1/11 (en camino/reservadas/libres). Sin desborde horizontal a **320, 375 y 1280 px** en Inventario, Compras y Productos. Logs `output/audit/handoff-browser-*.log` y capturas `output/playwright/handoff-*.png`.
- Respaldo anterior a la nueva migración y las dos compras: `/home/usuario/.local/share/impulso-backups/2026-09-09T17-48-37-777Z/`, SHA-256 `faf6f27c24c71ee2c007d18d07570d69ca79a8740d5f1480f959c5135113c744`. Hash e índice verificados antes de aplicar. Este respaldo precede los datos reales entrantes; restaurarlo requiere reconciliar cualquier operación real posterior, nunca hacerlo automáticamente.

## Lenguaje solicitado antes de entregar

Los textos se dirigen directamente a quien usa la tienda. La nota de la compra #2035 dice «Pagada al proveedor» y las indicaciones de recepción, acceso y exportación evitan hablar de «la dueña» como una tercera persona. También se actualizaron los motivos de los 16 movimientos iniciales a «Stock inicial real para empezar a usar la tienda». Solo se cambió texto: cantidades, reservas y líneas de compra conservaron su huella. Evidencia privada de antes y después en `output/audit/handoff-wording-before.json` y `handoff-wording-result.json`. El asistente tiene la misma pauta de lenguaje en su mensaje de sistema, versión `impulso_business_advisor_v4`.
