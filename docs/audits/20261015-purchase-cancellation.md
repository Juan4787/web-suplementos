# Auditoría de reconciliación y cancelación de compras al proveedor

La revisión del cambio anterior encontró una corrección válida del incidente original, pero también regresiones reproducibles. Se corrigen con migraciones adicionales, sin reescribir las migraciones publicadas ni modificar datos históricos durante el despliegue.

## Hallazgos comprobados

1. `transition_order` había perdido `mark_refunded`: una devolución real de dinero terminaba en `INVALID_ACTION`. Se restaura la acción y se aclara en Pedidos la diferencia entre deshacer un cobro registrado por error y registrar dinero reintegrado.
2. La fusión de reservas físicas sumaba cantidades con costos distintos y descartaba uno de los costos. La reproducción perdió 10.000 centavos en una línea de dos unidades. Se fusionan solamente reservas con el mismo costo histórico; el armado ya admite varias filas físicas y suma sus cantidades.
3. `mark_at_cost` reemplazaba el costo real de una orden mixta con la suma de costos unitarios simplificados. Se conserva el total histórico de costos para la venta al costo.
4. La recepción quitaba `purchase_item_id` también a reservas anteriores al sistema. Esto viola `reservation_origin_check` y revierte toda la recepción. Estas reservas conservan su origen; las normales continúan sin vínculo a compras al volverse físicas.
5. La recepción directa favorecía las reservas vinculadas a esa compra antes de aplicar la reconciliación de sobrantes. Por tanto, no garantizaba el FIFO global anunciado. Ahora la recepción incrementa el stock y un único motor lo distribuye: reservas previas primero, luego antigüedad del pedido, número e identificador de reserva. No se desplazan reservas físicas ya asignadas ni unidades guardadas.

También se preservan costos históricos de cero, se reconcilia el stock liberado de reservas previas y se alinea la edición de compras con el orden de bloqueos de recepción y cancelación. La auditoría de bolsitas descartó una sospecha inicial: su protección independiente seguía activa. La validación del envío también era previa al cambio investigado.

Las definiciones de las funciones de producción que se reemplazan coincidían con las versiones originales auditadas. El destino verificado es `web-suplementos`, proyecto `mvtpidtuntvebyrxivue`; la referencia de proyecto del informe anterior era incorrecta.

## Decisión y comportamiento

Se compararon cancelar y dejar pedidos sin cobertura, bloquear siempre cuando existen reservas, trasladar a una compra existente y crear una compra de reposición. La solución admite cancelar sin reposición solamente cuando no se abandonan reservas, o crear una reposición nueva y trasladarlas en la misma transacción. La compra nueva mantiene una procedencia inequívoca y no mezcla cupo, precios ni fechas de compras que ya sostienen otros compromisos.

La revisión muestra proveedor anterior, productos y cantidades pendientes, valor del saldo, clientes afectados con sus productos y cantidades, reservas previas y cantidades exactas de reposición. Si existen compromisos, se selecciona inicialmente pedir a otro proveedor. Se solicita nombre del proveedor, fecha opcional, motivo y aceptación explícita.

La reposición incluye lo no recibido y, cuando corresponda, las unidades comprometidas de faltantes ya declarados. Si esto exige más unidades que el saldo pendiente, se explica antes de confirmar. Se copian los costos unitarios de la compra original; la dueña puede revisar los de la compra nueva antes de recibirla. Los precios y costos históricos de los pedidos de clientes se conservan.

Cancelar con reposición crea una compra, traslada sólo reservas entrantes o sin cobertura y cancela el saldo original. La mercadería física, las reservas físicas, las bolsitas, los cobros, los gastos, las recepciones y los pedidos de clientes se conservan. La recepción posterior de la reposición habilita el mismo pedido de cliente. La fecha estimada se deriva de las compras que lo sostienen.

La aplicación registra las compras; no envía un pedido al proveedor ni un aviso al cliente. La interfaz indica coordinar con el proveedor, avisar al cliente si cambia la fecha y resolver por separado cualquier adelanto pagado. Cancelar no registra un reembolso ni anula gastos.

## Protección y trazabilidad

- Sólo la dueña puede revisar y ejecutar la operación. Los recibos de operaciones permanecen privados.
- El servidor compara una huella de la compra, sus líneas y sus reservas bajo bloqueo. Una recepción, edición o reserva nueva invalida una revisión anterior.
- La identidad de operación permite recuperar una respuesta perdida sin repetir efectos. No se acepta reutilizarla con otros datos o por otra persona.
- Se bloquean las operaciones sobre compras cerradas y la cancelación sin reposición cuando quedan compromisos. Las pestañas antiguas no pueden recibir una compra cancelada.
- Se conserva motivo, fecha, responsable, saldo cancelado y vínculo a la reposición. El respaldo Excel incluye estos datos y separa cantidades canceladas de faltantes.
- La interfaz usa diálogos, radios, aceptación y calendario propios; mantiene foco, teclado, estados de espera y mensajes de recuperación. La nueva protección de navegación no genera confirmaciones nativas del navegador.

## Evidencia y límites

Las reproducciones y pruebas con escrituras se ejecutan únicamente en bases locales descartables y en el modo demo del navegador. La copia de producción se restaura localmente para verificar las migraciones y comparar huellas de las 23 tablas públicas: sus filas permanecen iguales. Las pruebas de inyección de fallas comprueban que una reposición creada antes de un error tampoco persiste.

El respaldo completo verificado está fuera del repositorio, con acceso privado. Se comprobó restaurándolo íntegramente; las primeras capturas incompletas se descartaron. La inspección remota anterior a la publicación encontró cero diferencias entre reservas físicas y balance, cero disponibilidad negativa y cero reservas entrantes activas sobre compras cerradas. La comparación de costos por línea en la copia restaurada también dio cero diferencias.

Comandos principales: `pnpm test`, `pnpm check`, `pnpm build`, `pnpm test:contract`, los SQL de `supabase/tests/database` mediante PostgreSQL local y `SAFE_AUDIT_DATABASE=... node scripts/test-purchase-cancellation-concurrency.mjs`. La prueba de navegador `16-purchase-cancellation.spec.ts` cubre cancelación y reposición seguidas de recepción; se comprueban también los controles existentes y las reversiones de pedidos. Se usan Playwright y navegadores instalados porque esta sesión no expone control de navegador administrado por el host.

Resultados previos a publicación:

- 635 pruebas unitarias cubiertas en 72 archivos. En la corrida completa pasan 634; se actualiza la única expectativa pendiente del texto de reintegro y se revalidan las 16 pruebas de ese archivo. Las seis pruebas del diálogo también vuelven a pasar después de simplificar su lenguaje.
- 551 comprobaciones SQL existentes y 55 nuevas: 606 sin fallos. Las nuevas se repiten sobre la secuencia final de migraciones.
- Siete carreras con conexiones PostgreSQL realmente superpuestas: todas pasan, sin bloqueos mutuos ni efectos duplicados.
- 18 recorridos de navegador en escritorio y móvil pasan con los controles, reversiones y nuevas compras. Los cuatro recorridos de la nueva función se repiten después de la revisión de lenguaje, también sin fallos.
- 14 contratos remotos de consulta pasan; compilación de tipos y paquete de producción sin errores.
- El control de estilos no detecta elementos pendientes. La comprobación automática de interfaz rechaza controles nativos, desbordes, errores de consola y confirmaciones del navegador.

Los ejemplos visibles utilizan nombres cotidianos. Las comprobaciones remotas confirman que esta tarea no creó productos, compras ni clientes de prueba en producción. Las primeras pasadas de navegador se invalidaron cuando la recarga de desarrollo coincidió con una edición; la pasada completa final se ejecutó sin editar la aplicación y pasó.

El registro de publicación se añade al finalizar. No se realizan cancelaciones ni pedidos ficticios en producción para certificar el despliegue.
