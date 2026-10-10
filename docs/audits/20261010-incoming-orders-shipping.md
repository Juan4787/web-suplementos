# Pedidos en camino, cargos de envío y balance — 10 de octubre de 2026

## Decisiones y alcance

Implementación de lo aprobado: selector de origen de stock al cargar un pedido manual, gasto opcional de envío al recibir compras, y cargo de envío del cliente editable solamente antes del cobro. Se revisaron reservas, recepción parcial, faltantes, bolsitas, cobro, regalos, impuestos, ventas, gastos, exportación y permisos.

El cargo del cliente y el envío pagado al proveedor son registros diferentes. No se deduce que uno sea igual al otro, ni se distribuye un gasto de proveedor entre productos sin una regla de negocio aprobada. Todos los cálculos comerciales utilizan el costo exacto guardado en el pedido, incluyendo sus lotes, y el impuesto registrado.

## Cómo usarlo y qué evita

### 1. Cargar un pedido manual

El selector aparece antes del formulario. **Compra normal** es la opción inicial: utiliza unidades físicas libres y luego capacidad entrante libre. **Comprar productos en camino** muestra productos con unidades entrantes libres y reserva exclusivamente compras al proveedor. Mantiene intacta la reserva y cantidad física disponible para otros clientes.

El pedido conserva su origen y las reservas apuntan a los ítems concretos de compras al proveedor. No puede entregarse usando unidades físicas ajenas mientras espera su compra. La llegada convierte únicamente las reservas vinculadas a esa compra; el armado de la bolsita sigue siendo un control físico independiente.

Cambiar el selector conserva cliente, productos y cantidades. Si una cantidad deja de ser válida, el formulario la señala y bloquea Confirmar; exige reducirla, quitarla o cambiar la modalidad. La base valida nuevamente la capacidad bajo bloqueos, de modo que un segundo pedido simultáneo no pueda reservar la misma última unidad.

El origen elegido integra la identidad del intento. Reintentar una respuesta perdida recupera el pedido; cambiar origen o modalidad genera un nuevo intento. Una misma clave con datos incompatibles se rechaza.

La modalidad al costo/regalo queda limitada a la dueña tanto en interfaz como en la base. El origen de stock es independiente del precio y de retiro/envío a domicilio.

### 2. Recibir mercadería

**Costo de envío (opcional)** aparece al inicio de la revisión final de recepción completa o parcial, antes de cualquier lista larga de productos. Cada cambio de paso vuelve al inicio del cuerpo del formulario para que el campo quede visible también en móvil. Admite pesos enteros: `15000` se muestra `15.000`. Blanco y cero no crean gasto. Se rechazan letras, negativos, signos, centavos, notación exponencial, agrupaciones incorrectas y montos que superen el límite.

Un importe positivo crea un gasto puntual vinculado a la operación de recepción y a la compra. La recepción, movimientos de stock, conversión de reservas, gasto y auditoría se confirman en la misma transacción. Si falla el gasto, se revierte también el stock. Un reintento con la misma operación devuelve el resultado anterior; no vuelve a ingresar unidades ni descontar dinero. Cambiar cantidades, compra o envío conservando la operación se rechaza.

Si no llegó ninguna unidad pero se pagó un envío, puede registrarse ese gasto sin inventar mercadería. La compra continúa pendiente. Resolver después los faltantes no vuelve a descontar el envío ya registrado.

En recepciones parciales, el campo comienza vacío. Si el envío del paquete ya se registró en esta compra o en otra, debe dejarse vacío, aunque el paquete llegue por partes. La interfaz lo aclara expresamente. La identidad automática es por recepción; no existe un identificador de paquete/factura que permita inferir que dos registros manuales diferentes corresponden al mismo transporte.

El gasto aparece en Gastos varios con procedencia de compra. Conserva las herramientas existentes de corrección/anulación y su auditoría. Un gasto vinculado a recepción permanece puntual, sin fecha de finalización ni centavos. Una corrección cambia el gasto vigente del balance; la recepción conserva el importe original como evidencia de lo ingresado en aquel momento.

### 3. Cargo de envío del cliente

En **Qué sigue** se agregó una fila discreta: **Costo de envío · Agregar/Editar**. Los campos se muestran al abrirla, evitando ocupar la caja con controles permanentes.

- **Monto manual:** pesos enteros; blanco o cero elimina el cargo.
- **Porcentaje:** entre 0 y 100 %, hasta dos decimales. La base es el costo exacto de la mercadería del pedido, no su precio de venta. Se muestran costo, envío nominal y total a cobrar.

El porcentaje se calcula con aritmética entera exacta y se redondea una sola vez al peso más cercano, con las mitades hacia arriba. Ejemplo: costo $10.700, 5 % → envío $535. El límite nuevo de cargo es $999.999.999.

El importe se suma al total también cuando el cliente retira el pedido: puede cubrir gestión/transporte asociado a esa compra. La explicación aparece junto al editor. El impuesto utiliza la tasa ya guardada en el pedido; para ventas al costo continúa el tratamiento preexistente de impuesto cero.

Mientras hay una edición abierta, se bloquean cambios de estado, filtros y paginación que podrían ocultarla. Guardar actualiza inmediatamente el pedido en caché y espera la actualización de consultas antes de habilitar el cobro. Cancelar descarta la edición. La navegación conserva el bloqueo de salida por cambios pendientes; el foco vuelve al control de apertura.

Si otra pantalla cambió el envío, se rechaza el borrador viejo. Si cambió el costo mientras se editaba un porcentaje positivo, no se recalcula silenciosamente: exige cerrar y revisar la edición. La base vuelve a verificar revisión, costo y estado de pago.

**Marcar como cobrado** ahora muestra una confirmación con productos, envío, importe total y aviso de bloqueo posterior. El servidor valida el total y la revisión que se revisaron al abrir esa confirmación; otra pantalla no puede cambiar el cargo y conseguir que se cobre un total diferente sin revisión.

**Al costo** cobra inmediatamente el costo exacto de productos más el envío previamente guardado. Su confirmación lo explica. **Regalar** elimina el cargo y el total, con advertencia explícita y evento de auditoría del cambio. Después de cobrado, el envío no se puede editar; la restricción también existe en la base, no solo ocultando el botón.

El personal ve el importe que debe cobrar, pero no el porcentaje ni la base de costos. La dueña mantiene las operaciones financieras.

## Contabilidad y estadísticas

La fórmula general es:

`Ganancia neta = ventas cobradas − costo de mercadería − impuestos registrados − gastos del período`.

- Las ventas cobradas incluyen los cargos de envío del cliente una sola vez.
- El costo de mercadería es el costo guardado de ventas y regalos. No es todo lo comprado al proveedor ni una lectura del precio actual del catálogo.
- Los regalos cuentan separadamente y su costo reduce la ganancia.
- Los reintegros quedan fuera de las ventas del período. La cancelación de un pedido pagado o de un regalo manual sin entregar lo convierte en reintegrado; listado, dashboard e informes usan el mismo estado de pago.
- Los envíos de proveedor son gastos puntuales por fecha de recepción, vinculados a ella. No aumentan silenciosamente el costo unitario ni se descuentan por segunda vez.
- Los demás gastos conservan su fecha y recurrencia existentes. Los registros históricos sin vinculación a una recepción siguen en Otros gastos; no se les inventa una procedencia según el título.
- Una venta al costo con envío puede tener margen comercial. Se eliminó el margen cero forzado y los textos que afirmaban que siempre era neutral.
- En lotes mixtos, los ingresos de cada línea al costo usan su costo total exacto; no cantidad × costo unitario redondeado. Los precios unitarios históricos guardados permanecen intactos.
- Ventas por producto excluye envío y utiliza ingresos de productos como denominador de participación. El balance general muestra el envío separado. Los gastos generales no se reparten arbitrariamente por producto; el prorrateo de impuestos por línea conserva la regla vigente de redondeo, mientras el total usa el impuesto exacto del pedido.

La tabla por producto incluye unidades de regalos para mostrar su costo, y lo explica expresamente; no llama ventas cobradas a esas unidades. La herramienta del asistente `get_product_performance` conserva su alcance declarado de rendimiento cobrado de un producto, mientras su resumen financiero incluye regalos y gastos. Los conceptos nuevos tienen etiquetas en español en la evidencia del asistente.

Un único desplegable **Cómo se calcula la ganancia neta** muestra ventas, envío ya incluido, mercadería incluyendo regalos, impuestos, envío al proveedor, otros gastos y resultado. Los cargos del cliente no se suman nuevamente al desplegar el detalle.

Ejemplo ilustrativo, con impuesto cero: venta de productos $15.000, costo $10.700 y envío al cliente $535 → cobro $15.535 y margen comercial $4.835. Un envío de proveedor de $15.000 en ese período deja neto −$10.165 para ese conjunto de operaciones. El gasto del proveedor puede corresponder a muchas ventas; ese ejemplo no define un reparto por producto.

El personal recibe un indicador de revisión pendiente, sin conocer porcentaje ni costo. Si el costo cambia, se bloquea el cobro y se explica que la dueña debe revisar el envío, incluso cuando el cargo redondeado sea cero.

El borrador permite disminuir una cantidad aunque todavía siga excediendo la nueva disponibilidad. Las cantidades máximas, avisos y botones consultan el stock actualizado; ante un rechazo de negocio se renueva la disponibilidad sin vaciar el borrador. Los regalos manuales reservan mercadería y esperan la entrega física según el flujo vigente.

## Registro y respaldo

Se agregaron campos a pedidos para origen, método de cargo, porcentaje, base y revisión. Las recepciones conservan importe de transporte y gasto vinculado. El gasto tiene una vinculación única a la recepción. El historial de cambios de envío registra operación, pedido, entrada solicitada, antes/después, fecha y responsable.

La exportación pasa a `impulso-business-backup/v3`, con 17 hojas. Conserva las anteriores y añade Recepciones e Historial envíos clientes; agrega procedencia y modalidad a las hojas de pedidos/gastos. Las entradas de auditoría incluyen la intención de la operación, por ejemplo regalar. Los textos siguen exportándose como texto, incluso si empiezan con una fórmula.

Las migraciones son aditivas. Los pedidos anteriores reciben origen normal y método catálogo; se conservan sus importes, cantidades, cobros, costos, fechas e historial. Ninguna migración corrige stock real ni recrea pedidos históricos.

## Archivos y responsabilidades

- `src/domain/order-shipping.ts` y `types.ts`: reglas monetarias, costo de líneas y contratos.
- `src/components/ui/CurrencyInput.tsx`: entrada estricta optativa de pesos enteros, pegado y cursor; conserva el comportamiento de los demás campos monetarios.
- `src/pages/admin/CreateOrderPage.tsx`: origen de reservas, disponibilidad y bloqueo de cantidades incompatibles.
- `src/components/admin/OrderShippingFeeEditor.tsx` y `OrdersPage.tsx`: edición progresiva, bloqueo, revisión del cobro, permisos y mensajes.
- `src/pages/admin/InventoryPage.tsx`: envío de proveedor dentro de la confirmación de recepción y renovación de las consultas afectadas.
- `src/features/expenses/MiscExpensesSection.tsx`: procedencia y restricciones del gasto de recepción.
- `src/pages/admin/SalesPage.tsx`: balance, margen real de ventas al costo y presentación por producto.
- `worker/ai/facts.ts`: nombres legibles de los conceptos de envío y unidades que incluyen regalos.
- `src/services/business-api.ts`, `supabase-business-api.ts` y `demo-business-api.ts`: contratos, RPC, traducción humana de errores y simulación equivalente de reservas por compra.
- `src/features/export/export-workbook.ts`: 17 hojas y relaciones auditables.
- `supabase/migrations/20261010010000_incoming_orders_and_shipping.sql`: esquema, restricciones, RLS, reserva por origen, recepción/gasto atómicos, edición, cobro comprobado y exportación.
- `supabase/migrations/20261010020000_shipping_financial_reports.sql`: ventas, categorías de gastos y hechos del asistente.
- Pruebas de dominio, editor, importes, demo, páginas, exportación, SQL y navegador: cubren comportamiento y regresiones.
- `scripts/test-shipping-local.mjs`, `test-shipping-http-local.mjs` y `test-shipping-concurrency.mjs`: ejecución exclusivamente en bases locales marcadas y descartables.
- `scripts/audit-shipping-release-readonly.mjs`: comparación antes/después en producción y oráculo contable, en transacción repetible de solo lectura.
- `scripts/backup-before-shipping-release.mjs`: archivo de respaldo fuera del repositorio, credenciales por stdin, permisos privados y verificación de lectura del archivo.
- `scripts/verify-shipping-backup-local.mjs`: restaura realmente el respaldo en una base local aislada y compara las 21 tablas públicas con la captura previa.
- `scripts/verify-shipping-production-ui-readonly.mjs`: inspecciona las pantallas publicadas de la dueña, bloqueando cualquier intento de modificación de negocio.
- `scripts/verify-shipping-served-build.mjs`: compara los bytes publicados del HTML y de todos los archivos JavaScript/CSS con la compilación final.
- `scripts/reconcile-shipping-external-activity.mjs`: concilia actividad real previa a las migraciones contra la base restaurada, sin modificar ninguna de las dos.

## Protección y correcciones encontradas en la auditoría

Se trabajó en `codex/incoming-orders-shipping-20261010`. El archivo preexistente sin seguimiento `src/domain/whatsapp-urgent-debug.test.ts` se conserva y se excluye del cambio.

Las pruebas de negocio usan PostgreSQL local descartable y el modo demo de navegador. La base local original solo proporcionó esquema/permisos; no recibió fixtures de este trabajo. La aplicación real se inspecciona en lectura, sin pedidos, gastos, cobros ni clientes de prueba. Las comprobaciones pesadas se ejecutan con un trabajador.

La revisión amplia detectó y corrigió, antes de publicar:

1. Conversión de reservas previas al sistema: la primera adaptación partía de una versión antigua de recepción. Se recuperó el comportamiento vigente de prioridad, conversión, separación/fusión y procedencia de reservas previas, y se repitieron las pruebas de faltantes y apertura.
2. Pegado real de `15.000`: el navegador disparaba una segunda validación que rechazaba los separadores. Se procesa el pegado válido de forma explícita, conservando selección/cursor y rechazando contenido inválido sin reinterpretarlo.
3. Riesgo de cobrar desde una confirmación vieja: se agregó validación del importe revisado en el servidor y se actualiza la caché antes de volver a habilitar acciones.
4. Cambio del costo durante edición de porcentaje: se conserva la base que se vio y se obliga a revisar si cambió.
5. Mensajes incorrectos de margen neutro y costo por lote redondeado: se corrigieron presentación y estadísticas con snapshots exactos.
6. Permisos incompletos de la copia de pruebas: se restituyeron los ACL del esquema original antes de interpretar pruebas de personal/anónimo.
7. Una prueba antigua de concurrencia apuntaba a la base local predeterminada. Ahora utiliza su base descartable actual y rechaza destinos no descartables.
8. Las simulaciones conservan la compra concreta de cada reserva, incluso en reposición; dos recepciones demo simultáneas registran stock/gasto juntos.
9. Un regalo manual cancelado antes de entregar liberaba stock pero conservaba su costo financiero: la cancelación ahora revierte el reconocimiento del regalo. No existían casos históricos de este tipo en producción al revisarlo. El reintento del cobro como regalo reconoce su resultado aunque haya cambiado la revisión al limpiar el envío.
10. Reducir un borrador que supera la disponibilidad por varias unidades podía quedar bloqueado: se permite corregirlo unidad por unidad y se usa disponibilidad actual.
11. La inspección visual de una compra real de 90 unidades mostró el envío debajo de una lista larga, aunque la prueba de interacción podía encontrarlo desplazándose. Se movió antes de la lista; una prueba de 12 productos reprodujo además el desplazamiento heredado al cambiar a recepción parcial en móvil. Se reinicia el desplazamiento por paso, sin borrar cantidades/importes. La corrección se comprobó con intersección real del campo en la vista, además de capturas.

Plugin Browser no disponible: se utilizó Playwright. Se inspeccionaron capturas reales del navegador, además de errores de consola, interacción, controles habilitados y desbordes. La emulación de teléfonos no demuestra una prueba en un teléfono físico.

## Hallazgo previo en datos reales

La inspección de solo lectura previa a cualquier migración confirma B COMPLEX ACTIVE: 8 unidades físicas, 9 reservadas físicamente, 4 reservas pendientes y 30 unidades en camino. Las reservas físicas coinciden con el contador de reservas; la diferencia es entre disponibilidad física y asignación física. El stock total alcanza, pero una unidad está clasificada como física sin cobertura física registrada.

La prueba existente de producción que exige `on_hand >= reserved` falla por este dato. No se debilitó esa comprobación ni se modificaron cantidades para hacerla pasar. Resolver ese registro requiere verificar el conteo físico y el origen de la unidad. La evidencia no permite atribuirlo a una nueva compra ni inventar cuándo ocurrió.

La comprobación adicional de todos los productos encontró cero déficits de cobertura agregada (físico + entradas contra reservas) y cero diferencias entre cantidades pendientes de pedidos y reservas activas. Es una comprobación del estado actual, no una reconstrucción histórica de todos los momentos anteriores.

## Respaldo y recuperación

Respaldo previo: `/home/usuario/.local/share/impulso-backups/2026-10-10T09-48-26-650Z-shipping/before-shipping.dump`, 859.912 bytes. SHA-256: `e53ba37d00335046b7c1118db83ab04768a0ed3fe410f42eeaf3d3c8c4c673aa`. Incluye datos, esquema y ACL de public/private/auth/storage e historial de migraciones. No incluye binarios de archivos en Storage ni secretos del alojamiento.

Se restauró realmente el archivo con `pg_restore --exit-on-error` en la base local aislada `backup_restore_shipping_certified_20261010`. Las cantidades y hashes de filas de las 21 tablas públicas coinciden exactamente con la captura previa de producción. Esa base no está conectada a ningún servidor HTTP ni admite los scripts de fixtures de este trabajo. No se restauró producción. Evidencia: `output/audit/shipping-backup-restoration.json` y `/tmp/supplements-shipping-backup-restoration-20261010.log`.

El primer intento por puerto 5432 falló por conectividad; el respaldo y comprobación previa de migraciones funcionaron por el pooler 6543. La simulación confirmó únicamente las dos migraciones nuevas, sin seeds ni roles pendientes.

La recuperación debe preservar los datos nuevos: volver a la versión anterior del frontend mantiene las columnas añadidas. No se deben eliminar columnas/tablas de auditoría ni restaurar toda la base encima de operaciones posteriores. Para una incidencia SQL, recuperar las funciones anteriores desde el respaldo y revisar la compatibilidad de los cargos ya registrados; preferir una corrección hacia adelante cuando corresponda.

## Resultados de la publicación principal, antes de la corrección de diálogos

### Verificación local y simulada

| Frente | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript | Aprobado | `/tmp/supplements-shipping-typecheck-certified-20261010.log` |
| Suite completa Vitest | 68 archivos; 584 pruebas aprobadas, una comprobación de producción omitida explícitamente por el dato preexistente descrito arriba | `/tmp/supplements-shipping-vitest-certified-20261010.log` |
| PostgreSQL | 14 archivos, 467 aserciones: 443 de la regresión final y 24 del calendario financiero | `/tmp/supplements-shipping-sql-regression-final-20261010.log`, `/tmp/supplements-shipping-db-final2-20261010.log` |
| Oráculo independiente de calendario | 5.120 rangos/fechas, sobre 731 días de 2031–2032, ventanas y extremos; comprueba costos, regalos, impuestos y recurrencias | Prueba `sales_periods.test.sql` y log anterior |
| HTTP real sobre PostgreSQL aislado | 12 comprobaciones aprobadas: contratos, permisos, reintentos, redondeo, cobro, recepción, balance y cancelación de regalo | `/tmp/supplements-shipping-http-certified-20261010.log` |
| Concurrencia real | 9 escenarios aprobados con conexiones independientes y espera de bloqueo observada | `/tmp/supplements-shipping-races-certified-20261010.log` |
| Navegador completo | 62 casos aprobados y 2 omitidos por requerir escrituras reales; Chromium escritorio/móvil y regresiones Firefox | `/tmp/supplements-shipping-e2e-certified-20261010.log` |
| Inspección visual asentada | 2 comprobaciones adicionales de controles y capturas, escritorio/móvil | `/tmp/supplements-shipping-visual-settled-20261010.log` |
| Cierre de UX de recepción grande | Después del último ajuste visual: 27 pruebas de InventoryPage y 10 casos del flujo nuevo aprobados; campo visible sin desplazar en recepción completa/parcial, escritorio/móvil | `/tmp/supplements-shipping-receipt-ux-unit-final-20261010.log`, `/tmp/supplements-shipping-receipt-ux-e2e-final-20261010.log` |
| Exportación | 17 hojas, relaciones y texto literal seguro; lectura de OOXML, ExcelJS y apertura/conversión con LibreOffice | Suite de exportación y navegador |
| Análisis estático de funciones | Sin errores de `plpgsql_check`; solo variables heredadas sin uso/lectura | Ejecución aislada y revertida |
| Compilación de producción y despliegue simulado | Aprobados, 202 recursos estáticos y Worker empaquetado | `/tmp/supplements-shipping-build-dry-20261010.log` |
| Restauración del respaldo | 21 tablas públicas con cantidades y hashes idénticos al original | `output/audit/shipping-backup-restoration.json` |

El calendario completo necesitó actualizar estadísticas del fixture (`ANALYZE`) para evitar planes inadecuados de una copia vacía. La cobertura no se redujo. Una captura tomada durante la transición de color parecía mostrar botones deshabilitados: se comprobó su estado real y color final; no se cambió el diseño por una imagen transitoria.

La suite completa antecede al último ajuste de ubicación/desplazamiento del campo de recepción; después de ese ajuste se repitieron las pruebas afectadas indicadas arriba. Las dos pruebas de ciclo entrante sobre datos reales siguen omitidas por requerir escrituras reales: no se presentan como aprobadas. Las 11 pruebas de evidencia de la asistente también se repitieron después del último cambio de etiquetas.

Comandos reproducibles principales:

```sh
pnpm check
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --testNamePattern='^(?!.*Base de Datos de Producción)'
E2E_ALLOW_REMOTE_WRITES=0 PLAYWRIGHT_BASE_URL=http://localhost:5173 pnpm exec playwright test --workers=1
pnpm worker:deploy:dry
```

Los scripts SQL/HTTP/concurrencia exigen nombres locales `rigorous_ux_shipping_*`, contenedor fijo y marca de trabajo antes de escribir. Ningún fixture se ejecutó en producción. Los archivos de evidencia con datos reales están ignorados por Git y no se incluyen en el cambio. El archivo del respaldo está fuera del repositorio, con acceso privado.

### Publicación y lectura real

Las dos migraciones se aplicaron, sin seeds ni roles nuevos. El código de aplicación quedó registrado en el commit `90a03d6` antes de publicarlo.

La captura previa era de las 06:34 de Argentina. Mientras se trabajaba, a las 08:27:59 se importó el pedido real #2610, antes de iniciar las migraciones. Por eso la primera comparación estricta rechazó diferencias en siete tablas. Se investigó cada fila contra el respaldo restaurado: hay un cliente, un pedido, una línea, una reserva física de 2 unidades y un movimiento de reserva nuevos. El balance correspondiente pasó de 6 físicas / 2 reservadas a 6 físicas / 4 reservadas. Solo cambiaron ese contador/fecha y la revisión/fecha global; los pedidos, clientes y líneas anteriores permanecen idénticos. No hubo unidades físicas cambiadas ni cobros de prueba.

La conciliación no permite diferencias generales: valida las relaciones del pedido, el origen, pago pendiente, fecha anterior al comando de migración, cantidades y movimiento, y guarda fingerprints de las tablas. La auditoría posterior solo acepta esa actividad si esos fingerprints coinciden exactamente; toda diferencia adicional sigue fallando. Evidencia: `output/audit/shipping-external-activity.json`, `/tmp/supplements-shipping-external-activity-certified-20261010.log`. La hipótesis inicial de que nadie usaría la aplicación durante el trabajo no se trató como garantía.

La publicación principal, anterior a la corrección posterior de diálogos, se completó a las 10:35:51 de Argentina en `https://tienda.desuplementos.workers.dev`, perfil `impulso`, Worker `tienda`. La versión `a646989b-c7da-4d15-87c0-a59b4c1f44d1` quedó activa al 100 %. Esa compilación corresponde al código de aplicación de `1eab010`, que añade la corrección visual al cambio principal `90a03d6`. El certificado posterior `a8dc7ec` modifica documentación, sin cambiar aquella aplicación compilada. Sus tres artefactos principales originales se conservan en `output/audit/shipping-principal-certified/`; los artefactos del nivel superior se actualizan con la certificación posterior.

| Comprobación real | Resultado | Evidencia |
| --- | --- | --- |
| Migraciones | Únicamente las dos previstas aplicadas; sin seeds ni roles nuevos | `/tmp/supplements-shipping-migrations-published-20261010.log` |
| Datos de negocio | 22 tablas inspeccionadas; las 21 tablas anteriores comparadas contra el respaldo y la actividad real conciliada; cero diferencias sin explicación | `output/audit/shipping-release-after.json`, `/tmp/supplements-shipping-live-final-certified-20261010.log` |
| Funciones y disparadores | Las 13 definiciones nuevas/modificadas coinciden con las migraciones; funciones/disparadores ajenos al cambio permanecen intactos | Artefacto anterior |
| Contabilidad real | 1.370 períodos diarios, mensuales, anuales y entre fechas de actividad, contra sumas independientes de cobros, costos, regalos, impuestos y gastos; cero discrepancias | Artefacto anterior |
| Contratos HTTP de lectura | 14 aprobados, cero fallidos: catálogo, pedidos, compras, inventario, clientes, gastos, dashboard, ventas, exportación y usuarios | `/tmp/supplements-shipping-production-contract-final-20261010.log` |
| Versión activa | 100 % `a646989b-c7da-4d15-87c0-a59b4c1f44d1` | `/tmp/supplements-shipping-deployment-status-final-20261010.log` |
| Archivos servidos | HTML y todos los JavaScript/CSS: 81 recursos con bytes idénticos a `dist`; manifiesto local de 199 archivos | `output/audit/shipping-served-build.json`, `/tmp/supplements-shipping-served-final-certified-20261010.log` |
| Interfaz real de la dueña | Selector, balance, recepción y editor de pedido cargados con datos reales; abrir/cancelar sin guardar; cero errores y cero intentos de escritura de negocio | `output/audit/shipping-production-ui-readonly.json`, `/tmp/supplements-shipping-production-ui-final-certified-20261010.log` |
| Recepción grande real | Compra de 90 unidades: envío visible al abrir la revisión completa y parcial, en escritorio y vista móvil de 390 px | Capturas `output/audit/production-shipping/receipt.png` y `receipt-mobile.png` |

SHA-256 del manifiesto de aquella compilación: `759a260cbabfe004c9c45d842bbd1b641586e7a531707a57b05b75373d259639`. Se calcula sobre rutas ordenadas y SHA-256 de los bytes de cada archivo, no sobre fecha/nombre de despliegue. El HTML devuelve `public, max-age=0, must-revalidate`; exige revalidación antes de reutilizarse. Los archivos con hash se sirven con caché inmutable.

La primera comprobación inmediata tras publicar encontró una respuesta que aún no coincidía durante la propagación. Se comprobó el contenido realmente servido y luego se repitió la comparación estricta completa: los 81 recursos coinciden. No se aceptó un HTTP 200 ni el mensaje de Wrangler como prueba suficiente de la versión servida. El verificador también admite explícitamente la revalidación `max-age=0, must-revalidate`, equivalente para este control a `no-cache`, en lugar de exigir una cadena de cabecera particular.

Se inspeccionaron visualmente las capturas finales reales de carga manual, recepción móvil, editor y balance. Después de los contratos y la navegación de solo lectura, se repitió la comparación completa de producción; volvió a aprobar con la misma actividad externa conciliada. Los saldos históricos y las cantidades físicas permanecieron intactos. La diferencia previa de una reserva física de B COMPLEX ACTIVE permanece identificada; ninguna prueba la ocultó ni la corrigió con un conteo supuesto.

La versión anterior a este trabajo era `9973b334-3d8a-4e0f-85fb-30e9f873bbb3`; queda identificada para recuperación compatible conforme a las condiciones anteriores. No se ejecutó un rollback real. Tampoco se hicieron cobros, entregas, recepción de mercadería ni correcciones de gastos artificiales en producción. Esas operaciones están probadas en PostgreSQL/HTTP local y navegador demo, con separación expresa de la inspección real.

Comprobaciones de publicación, todas sobre el destino fijado del proyecto:

```sh
SUPABASE_DB_TRANSPORT=pooler node scripts/run-supabase-linked.mjs dry-run
SUPABASE_DB_TRANSPORT=pooler node scripts/run-supabase-linked.mjs push
node scripts/audit-shipping-release-readonly.mjs after
pnpm worker:deploy
node scripts/verify-shipping-served-build.mjs
node scripts/verify-shipping-production-ui-readonly.mjs
pnpm test:contract
```

Los comandos de migración/publicación son mutaciones autorizadas de código y esquema. No deben confundirse con los scripts de lectura ni ejecutarse de nuevo para consultar resultados. La conciliación documentada utiliza el respaldo concreto de este trabajo y exige coincidencia exacta; no es una excepción general para ignorar cambios de producción.

## Corrección posterior: decisiones dentro de la interfaz

La captura de la dueña identificó una confirmación nativa al cambiar de pedido con el envío abierto. Se sustituyeron todas las llamadas explícitas a `window.confirm` de la aplicación por un diálogo compartido de la propia interfaz. Los botones de descarte son **Descartar** y **Seguir editando**; no hay un **Aceptar** genérico ni apariencia de error. El título y la descripción explican qué edición se perderá y qué acción seguirá. Se distingue cerrar las acciones del pedido actual de abrir otro pedido.

El foco inicial está en **Seguir editando**. Escape, el fondo del diálogo y cerrar conservan los datos. Enter sobre la decisión inicialmente enfocada también conserva. Solo la elección explícita de **Descartar** autoriza eliminar una edición. Se confina el foco, se bloquea la interacción con el fondo y se restituye el foco al control de origen. Un diálogo sobre una compra o un panel usa la profundidad de las ventanas existentes: Escape cierra solamente la confirmación, conserva la ventana inferior y mantiene el bloqueo del desplazamiento.

Las decisiones simultáneas no se reemplazan unas a otras. Si desaparece el editor de origen, la solicitud pendiente se resuelve como conservar; no puede ejecutarse más tarde un descarte de una pantalla que ya no está. El desmontaje de la aplicación también resuelve la decisión pendiente sin aprobar el descarte. El contexto compartido mantiene su identidad para evitar volver a renderizar todos los editores al abrir una confirmación.

### Edición abierta, cambios y guardado son estados distintos

- Abrir el envío sin modificarlo permite cambiar de pedido o navegar sin una pregunta falsa de descarte. Guardar sin cambios está deshabilitado.
- Volver al monto guardado elimina el estado de cambios. Los valores de un método oculto no hacen aparecer un descarte falso: cambiar a porcentaje y volver al mismo monto manual conserva el estado original. `5` y `5,00` son el mismo porcentaje; un envío vacío y cero representan el mismo cargo cero.
- Un porcentaje que necesita revisión por un costo nuevo permite guardar la revisión explícita aunque no se cambie el número. Las validaciones de base de costo, revisión y cobro siguen vigentes.
- Mientras se guarda el envío no se puede cambiar de tarjeta ni cobrar. Si el guardado falla, se conservan método, monto y edición para reintentar. El estado de guardado se comunica antes de pintar la interfaz.
- Cuando una operación ya se envió, el diálogo de navegación dice **El guardado ya comenzó**, con **Salir** y **Seguir esperando**. Explica que salir no cancela el guardado y que hay que revisar el resultado antes de volver a cargar o cobrar. No promete descartar una operación que el servidor ya puede completar.
- Si hay simultáneamente cambios de envío y conteos de bolsitas, la explicación incluye ambos. Abrir un envío intacto no hace llamar “envío sin guardar” a un conteo de bolsita pendiente.

Se aplicó la misma presentación a compras nuevas/editadas, avisos de inventario, correcciones de stock, conteos de bolsitas, recarga de datos actualizados y navegación durante la creación/importación de pedidos. Se mantienen las restricciones y escrituras de negocio existentes; esta corrección no añade migraciones ni cambia cálculos financieros.

La navegación interna utiliza este diálogo de la app. El cierre de una pestaña, la recarga completa y la salida del sitio conservan la protección `beforeunload` cuando hay datos pendientes: el navegador impone esa advertencia y no permite personalizar sus botones ni esperar un diálogo de React. No se quitó la protección contra pérdida de datos para ocultar esa limitación del navegador.

Archivos principales: `src/components/ui/AppConfirmation.tsx`, `Modal.tsx`, `use-dialog-focus.ts`, `src/main.tsx`, `src/components/admin/OrderShippingFeeEditor.tsx`, `OrderPackingEditor.tsx`, y las páginas `OrdersPage.tsx`, `CreateOrderPage.tsx`, `ImportOrderPage.tsx`, `InventoryPage.tsx`. La comprobación real se amplía en `scripts/verify-shipping-production-ui-readonly.mjs`; intercepta toda escritura de negocio y compara el envío real antes/después de descartar solamente un borrador local.

Los logs de certificación del cambio principal están copiados en `output/audit/shipping-certification-logs/`, con permisos privados. No se versionan datos reales, credenciales ni respaldos.

### Regresión de la interfaz corregida

La primera corrección de diálogos aprobó 69 archivos y **596 pruebas**, con la misma comprobación de producción omitida explícitamente por el déficit físico anterior. Las 102 comprobaciones enfocadas iniciales también aprobaron; después se amplió la cobertura de equivalencias numéricas y se ejecutó la suite completa. Estos resultados preceden a la corrección adicional de navegación entre búsquedas descrita abajo. Evidencia: `/tmp/supplements-app-confirmation-vitest-certified-20261010.log`.

La primera corrección de diálogos aprobó **73 casos** de navegador, con dos casos de escrituras reales omitidos (75 en total). Incluye Chromium de escritorio, Chrome móvil y Firefox. Nueve casos ejercitan específicamente las tres situaciones nuevas en los tres entornos: cambio de pedido, navegación interna/Atrás, y confirmación anidada. Se comprueban Escape, Enter, foco, importe conservado, descarte explícito, ausencia de confirmaciones nativas y ausencia de errores de consola. También se repiten tienda, importación, cobro, entrega, cancelación, inventario, ventas, gastos, Excel y los flujos de envío/reservas. Estos resultados preceden a la ampliación final. Evidencia: `/tmp/supplements-app-confirmation-e2e-certified-20261010.log`.

La primera ejecución de las pruebas nuevas detectó un problema del fixture: se habían creado pedidos por API demo directamente y la lista inicial permanecía en caché. Se invalidan explícitamente esas consultas, como hacen las mutaciones reales de la interfaz. No se relajaron las comprobaciones de interacción ni se cambió la aplicación para ocultar ese fallo del fixture. Las capturas finales se inspeccionaron visualmente, además de verificar los estados y resultados.

### Pestañas abiertas durante la publicación

El alojamiento publica archivos estáticos junto con cada versión del Worker. Como inferencia para este despliegue, una pestaña anterior que carga una sección después del cambio puede pedir un nombre de archivo que la nueva compilación no incluya. La documentación de [versiones](https://developers.cloudflare.com/workers/versions-and-deployments/) y [afinidad de versión y archivos estáticos](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) explica el empaquetado y este riesgo de mezclar nombres de versiones.

Se verificó nuevamente la compilación anterior servida (81 recursos, mismos bytes) antes de capturar sus 80 archivos JavaScript/CSS con nombres hash. `scripts/preserve-shipping-session-assets.mjs` comprueba cada hash contra el certificado concreto anterior y rechaza colisiones. Después de compilar se conservan solo esos archivos junto con los nuevos; jamás se restaura el HTML anterior, el Worker, configuración ni datos. Es una protección específica de esta publicación, no una política de acumular versiones indefinidamente.

`scripts/verify-shipping-open-tab-readonly.mjs` permite mantener una pestaña real de la dueña abierta antes del despliegue, con un importe de recepción escrito solamente en memoria. Tras certificar la versión nueva, comprueba que el importe continúa intacto y que una página de Ventas de la versión anterior se carga por primera vez sin recargar. Intercepta y bloquea todas las escrituras de negocio. La prueba no ingresa mercadería, gastos ni cobros reales.

### Ampliación de la auditoría: búsquedas y acciones sobre resultados anteriores

La revisión posterior encontró un defecto adicional y lo reprodujo en el navegador: Atrás entre dos búsquedas de Pedidos cambiaba los parámetros de la misma ruta sin consultar por el envío pendiente. La comparación anterior contemplaba solamente el nombre de ruta. Se incluyó el cambio efectivo de búsqueda normalizada; conservar mantiene el importe y la vista original. Descartar cierra explícitamente el editor y restablece los conteos sin guardar, incluso si el pedido sigue apareciendo en los siguientes resultados. Un guardado ya enviado no se cancela ni se describe como cancelado.

Se corrigió también la eliminación del parámetro de búsqueda al entrar nuevamente desde la navegación: ahora limpia el campo y vuelve a Pendientes. Durante los 250 ms de espera de la búsqueda y mientras no hay una respuesta para ella, los controles de los resultados anteriores quedan deshabilitados mediante un `fieldset` nativo. No se puede abrir o cobrar una fila transitoria. Un indicador discreto en el propio buscador comunica la espera sin insertar una pantalla de carga grande ni desplazar los pedidos. El campo mantiene su valor y los borradores permanecen en memoria.

Se añadieron pruebas de página del descarte conjunto de envío/conteos y de acciones bloqueadas antes/después de la respuesta. La prueba de navegador hace Atrás, conserva, vuelve a hacer Atrás, descarta, hace Adelante, verifica el borrador vacío y entra por el enlace real de Pedidos. Controla el reloj para ejercer la ventana de espera sin depender de velocidad de ejecución. Usa el historial real; un intento inicial del fixture importaba una segunda instancia del router de desarrollo y no representaba esa navegación. Los intentos fallidos se conservaron como diagnóstico, no como certificación.

Finalmente, el editor de porcentaje distingue un costo no disponible de un costo registrado como cero: nunca representa un valor desconocido como $0. Impide guardar un porcentaje sin base, explica cómo usar un monto manual o volver a abrir la edición, y muestra el importe nominal manual al elegirlo. No se inventa ni modifica ningún costo de mercadería.

La compilación intermedia de la primera corrección de diálogos quedó publicada como `eadd6d78-1585-41ad-a4b9-4b705e8f4a0b`, desde `5ac6702`. Su manifiesto `3846b565c6015b2e233758422e5c6ac29dc6e3df757a5af615376c5d99d63515` incluye 241 archivos y 116 recursos HTML/JavaScript/CSS con bytes servidos comprobados. Su certificado se conserva en `output/audit/shipping-dialog-intermediate-certified/`. Para la última compilación se capturaron también sus 115 JavaScript/CSS, incluyendo los de la publicación principal que ya retenía; se incorporaron 35 archivos nuevos al archivo privado. El HTML y el Worker antiguos no se reutilizan.

La suite completa del código final aprobó **69 archivos y 599 pruebas**, con una omitida por la cobertura física preexistente; no se debilitó su condición. `pnpm check` aprobó. Las cuatro situaciones de confirmación y navegación aprobaron **12 casos** en escritorio, móvil y Firefox antes de repetir el navegador completo. Evidencia: `/tmp/supplements-app-confirmation-final-typecheck-20261010.log`, `/tmp/supplements-app-confirmation-final-vitest-20261010.log`, `/tmp/supplements-app-confirmation-route-e2e-all-20261010.log`.

La regresión completa de navegador del código final aprobó **76 casos**, con los mismos dos casos de escritura real omitidos (78 en total), un trabajador y cero reintentos. Incluye todos los recorridos de escritorio y móvil y los de tienda/importación/confirmación en Firefox. Se comprobó que un clic real sobre Cobrar durante la espera de búsqueda no abre una confirmación ni inicia un cobro. Evidencia: `/tmp/supplements-app-confirmation-final-e2e-20261010.log`.
