# Corrección de origen de stock y experiencia de armado — 16/10/2026

## Problema y comportamiento resultante

La aplicación explicaba insuficientemente por qué un producto presente en el local podía estar bloqueado para un pedido. Además, el reparto automático podía ignorar la elección explícita de reservar exclusivamente mercadería en camino. La revisión encontró también diferencias históricas en reservas de pedidos cancelados y un recorte interno en teléfonos de 320 píxeles que un control del ancho de página no detectaba.

El pedido real #2631 motivó la investigación. Sus registros mostraban 10 unidades físicas de Complejo B, todas apartadas para nueve pedidos anteriores, y una unidad pendiente de la compra #2054. Ese estado no permite usar una reserva ajena ni demuestra el conteo físico real. La corrección explica la asignación dentro del pedido y conserva las cantidades y compromisos existentes.

## Lógica de asignación

La migración `20261016010000_stock_origin_and_order_context.sql` introduce un reparto común con dos reglas:

- Las compras normales y las reservas anteriores al sistema siguen aprovechando el stock físico libre por prioridad y antigüedad. Recibir otra compra del mismo producto sigue pudiendo desbloquear un pedido normal antiguo. Así se mantiene resuelta la falla original de pedidos ligados a una compra futura pese a existir stock libre.
- Las ventas elegidas exclusivamente en camino sólo pueden recibir unidades nuevas de su compra asignada; si una unidad ya quedó sin reposición confirmada, una nueva llegada real también puede completarla. Cada recepción tiene un límite de unidades recién recibidas; no puede absorber silenciosamente todo el stock libre anterior. El reparto descuenta lo ya utilizado de ese límite, evita asignar la misma unidad dos veces y admite varias compras para una misma línea.

El ajuste positivo de stock, la liberación de reservas y la cancelación de otro cliente conservan las unidades libres para las ventas normales y respetan la elección en camino. Una reposición de proveedor mantiene esa elección y los vínculos de lo pendiente. Se conservan los costos históricos —incluido cero—, los cobros, los conteos de bolsita y las reservas físicas ya asignadas. No se desplazan unidades de otros clientes.

La revisión final encontró un cruce adicional: recibir una compra para atender un pedido normal más antiguo podía dejar otra reserva entrante apuntando a una compra ya cerrada. La recepción ahora mueve únicamente el exceso pendiente a capacidad libre real de otras compras, conserva los costos y mantiene juntas todas las escrituras. Si no hay otra reposición, registra la falta de cobertura y la informa; nunca presenta una compra recibida como mercadería aún en camino. La llegada posterior puede completar esas unidades sin consumir el stock libre anterior. Las reservas previas al sistema conservan su origen y su prioridad.

La pantalla de recepción avisa qué pedidos siguen pendientes, permite abrirlos y distingue cantidades con otra compra de cantidades que necesitan encargar reposición. La explicación del pedido permite revisar la compra y fecha actuales. La falta de cobertura se presenta como “Sin reposición confirmada”, sin atribuir al proveedor un faltante que no está demostrado.

## Explicación y acciones dentro del pedido

La nueva consulta `get_order_stock_context` reúne en una sola instantánea el saldo del producto, la asignación de cada línea, los otros compromisos, las reservas previas y las compras concretas que sostienen lo pendiente. Sólo consulta datos; no reasigna stock. Una cuenta activa puede consultar la explicación sin recibir costos ni datos personales de otros clientes. Los detalles completos de compras siguen siendo exclusivos de la dueña.

El armado muestra qué unidades están asignadas y qué falta para completarlo. Distingue ausencia de asignación, cero contado y contenido sin verificar. Explica por qué espera mercadería y permite desplegar las reservas y las compras sin salir de la bolsita. Los enlaces se abren en otra pestaña para conservar el conteo; cada compra se consulta por su identidad, aunque no esté en la primera página. Volver a la lista y revisar una reposición actualizan también el enlace mostrado en el navegador.

Si los datos cambiaron, se pide actualizar el pedido sin adoptar ni guardar silenciosamente el conteo nuevo. Si la consulta falla, se informa que no pudo comprobarse el detalle y no se sustituyen cantidades desconocidas por ceros. Los rechazos definitivos no ofrecen un reintento idéntico. El personal sin permiso para recibir compras ve cómo solicitar que se registre la recepción.

Las reservas y liberaciones del historial se presentan separadas de las entradas y salidas físicas. En móvil se identifica explícitamente la cantidad libre para vender. Las columnas del pedido y los controles de cantidad se ajustan al ancho disponible; se verifican también los límites internos de textos y controles, además del ancho de página.

## Reparación histórica

La migración `20261016020000_cancelled_reservation_history.sql` agrega los movimientos de liberación que faltan en ocho combinaciones de pedido y producto, correspondientes a siete productos y pedidos antiguos cancelados. Conserva los movimientos originales y una evidencia privada de cada corrección.

La reparación sólo admite diferencias explicadas completamente por pedidos cancelados sin reservas activas. Comprueba que el saldo físico coincide con los movimientos y que las reservas actuales coinciden con el saldo reservado. Una diferencia no explicada aborta toda la operación. Repetir la reparación no genera movimientos duplicados.

Las correcciones se registran con la fecha actual y se identifican como correcciones de historial; no inventan la fecha original de cancelación. No modifican balances, pedidos, cobros, reservas ni bolsitas y no se presentan como unidades recién liberadas para vender.

## Evidencia y validación

- Se restauró un respaldo completo de producción en una base SQL aislada. Entre las 23 tablas públicas sólo cambiaron `stock_movements`, con ocho filas nuevas, y `business_state`, con el incremento de versión esperado. Los movimientos originales conservaron sus huellas; las demás tablas conservaron sus datos. La repetición local de la reparación agregó cero filas.
- Pasaron 711 comprobaciones SQL: reglas de negocio, reservas normales y previas, recepción parcial y repetida, ventas, costos, cobros, armado, cancelación, reposición, informes, permisos y reparaciones históricas. Los datos de prueba de la batería se revirtieron.
- Pasaron cuatro escenarios con transacciones realmente superpuestas: recepción frente a ajuste, dos recepciones distintas, el mismo intento repetido y dos recepciones de compras cruzadas con reasignación pendiente. Se comprobaron esperas reales por bloqueo y cantidades exactas, sin duplicaciones ni consumo indebido del stock libre anterior.
- Un fallo provocado durante la reasignación revirtió por completo la recepción: no quedaron entradas físicas, reservas, cantidades recibidas ni resultados de reintento parciales.
- Se verificaron los 75 archivos de pruebas de la aplicación, reutilizando las comprobaciones válidas y ejecutando específicamente las afectadas por correcciones. Una prueba anterior consideraba correcto ignorar la elección en camino; ahora prueba el reparto entre compras normales, mientras las nuevas comprueban por separado la elección explícita.
- La compilación de tipos y del paquete de producción pasó. La inspección de estilos no encontró controles pendientes. Los 16 recorridos de navegador afectados comprobaron escritorio y móvil, conteo parcial, consultas y enlaces precisos, cancelación y reposición, permisos, foco, ausencia de controles nativos y errores de aplicación.
- Las capturas revelaron un recorte interno que el ancho de documento ocultaba. La corrección se comprobó midiendo la tarjeta, el texto y los controles a 320 píxeles. La pequeña extensión de un icono durante su giro se distingue del recorte real de texto; no se relajó el límite de la tarjeta.

Las escrituras de prueba se hicieron en bases locales descartables y en la demostración local. Las operaciones reales de negocio de los clientes no se utilizan como pruebas de escritura.

## Respaldo y publicación

La restauración descubrió archivos incompletos producidos al transferir un respaldo binario por la salida adjunta de Docker. Esos candidatos se marcaron inválidos. La generación ahora escribe un archivo, verifica una huella emitida al terminar y compara la copia; contempla además las restricciones del Docker instalado mediante snap. Sólo se acepta un respaldo comprobado mediante restauración completa antes de migrar.

Se conservan los recursos de la versión anterior para las pestañas abiertas. Las firmas de funciones, los permisos, las cantidades reales y los archivos servidos se comprueban por separado de la compilación local.

Estado de publicación: pendiente de comprobación remota y publicación en este punto del informe. Se completará con el resultado efectivo, sin presentar pruebas locales como operaciones reales ejecutadas en producción.
