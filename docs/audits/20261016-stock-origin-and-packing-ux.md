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

La pantalla de recepción avisa qué pedidos siguen pendientes, permite abrirlos y distingue cantidades con otra compra de cantidades que necesitan encargar reposición. La explicación del pedido permite revisar la compra y fecha actuales. La falta de cobertura se presenta como “Sin reposición confirmada” y los indicadores compactos como “Sin reposición”, sin atribuir al proveedor un faltante que no está demostrado.

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

Publicado y comprobado en `https://tienda.desuplementos.workers.dev`.

- Código de la corrección: `3a29bdd`; ajuste final de rótulos: `b08dd02`, subidos a `codex/purchase-cancellation-20261015`.
- Versión publicada en el primer cierre: `6012e66b-7e5f-42a6-a633-3aa82d203e7b`, con el 100 % del tráfico; publicación registrada el `2026-10-16T17:44:19.874843Z`.
- Las dos migraciones del 16/10 se aplicaron correctamente. La comparación remota de las 23 tablas públicas confirmó únicamente ocho movimientos nuevos y el incremento esperado de versión. Se conservaron los movimientos originales y los registros de pedidos, reservas, balances, compras, costos y bolsitas.
- Las diferencias entre historial y reservas pasaron de siete productos a cero. También dieron cero las diferencias entre saldo y reservas físicas, los saldos inválidos, los pedidos normales pendientes con stock libre, las reservas activas de pedidos cancelados y las promesas por encima de la capacidad pendiente de las compras.
- Las ocho definiciones de funciones relevantes coincidieron con la base local verificada. El acceso directo desde cuentas de aplicación a los repartos, la reparación y su evidencia privada quedó denegado; la consulta de contexto no permite acceso anónimo.
- Coincidieron las huellas de los 196 archivos publicados comprobados, incluidos 105 recursos anteriores conservados para pestañas abiertas.
- La comprobación real de interfaz pasó a 1280 y 320 píxeles: compra exacta #2054 abierta en otra pestaña, conteo sin guardar conservado, sin recortes internos, sin errores de aplicación y sin escrituras de negocio. Las consultas de compatibilidad existentes también habían pasado: 14 respuestas verificadas, sin modificar datos de negocio.
- El respaldo final de 987.214 bytes se restauró por completo y se ensayaron las migraciones en la copia. Huella del archivo: `af66582f737d61ad27ccf39c609108ff58ee690c8266345daf342cb42ace73fe`.

### Resultado del pedido real y alcance

En la comprobación publicada del `2026-10-16T17:44:57.871Z`, el pedido #2631 seguía esperando una unidad de B COMPLEX ACTIVE, con 8 unidades registradas y 8 apartadas. La unidad pendiente seguía vinculada a la compra #2054, estimada para el 20/10. La aplicación ahora explica estos compromisos dentro del armado, permite consultar sus pedidos y la compra exacta y mantiene el conteo al abrirlos.

La cifra inicial de 10 unidades corresponde al diagnóstico anterior; las comprobaciones de publicación usan el saldo vigente de 8. No se infiere de estas cifras el conteo físico real, que no fue confirmado. Tampoco se aumentó stock ni se quitaron reservas ajenas para habilitar artificialmente el pedido.

Las pruebas de escrituras, fallos y concurrencia pertenecen a la base local o a la demostración. La comprobación real posterior a la publicación fue de consulta. Sus resultados respaldan los casos documentados; no constituyen una garantía universal sobre cualquier situación futura.

Las firmas anteriores siguen siendo compatibles. Una eventual recuperación de interfaz no requiere borrar las correcciones históricas ni restaurar balances sobre operaciones nuevas de clientes.

Evidencia privada de esta intervención: `/tmp/impulso-stock-fix-20261016/`, con los resultados SQL, superposición real de transacciones, restauración, comparación antes/después, archivos servidos, capturas e informe de navegador. Los archivos con datos reales y el respaldo quedan fuera del repositorio.


## Mejora posterior de jerarquía y armado

La revisión del usuario mostró una deuda que la corrección funcional anterior no resolvía: demasiado texto administrativo alrededor de la tarea de armar. Se tomó la propuesta de simplificación y se priorizaron las unidades habilitadas para el pedido sobre el stock general. Cero unidades libres para vender no impide guardar las que ya tiene asignadas ese pedido.

- Un solo contenedor, con separaciones entre productos. Se eliminaron las tarjetas interiores, el aspecto de botón bloqueado y los párrafos repetidos.
- El encabezado resume unidades habilitadas y pendientes. Cada producto conserva su cantidad pedida y el conteo explícito de bolsita.
- La reposición muestra cantidad, compra exacta y llegada **estimada al local**. Una ayuda opcional explica la asignación por reservas y antigüedad y la posibilidad de cambios. Varias compras conservan sus fechas propias; no se inventa una fecha única.
- El detalle opcional reúne En local, Apartadas y Libres. Primero muestra tres pedidos con reservas; permite desplegar el resto sin scroll interno. Las reservas anteriores al sistema se identifican por separado y el pedido actual no abre una copia de sí mismo.
- Los enlaces señalan la apertura en otra pestaña mediante un icono y una descripción accesible. Las instrucciones permanentes se retiraron.
- Guardar armado se mantiene visible con una explicación cuando está deshabilitado. Sólo permite cantidades compatibles con las unidades físicas asignadas. Los pedidos mixtos pueden guardar su parte habilitada; no se guardan ceros implícitos de un pedido sin stock físico.
- Se conservaron el conteo sin verificar, los borradores, el rechazo de datos cambiados, la recuperación de errores, los permisos y las confirmaciones propias de la aplicación.

Pasaron las 39 comprobaciones de los tres archivos afectados, con comprobaciones específicas posteriores para el texto y la jerarquía final. Pasaron los ocho recorridos de navegador afectados entre escritorio y móvil: reservas extensas, apertura por teclado, ayuda opcional, guardado parcial, elección en camino, recepción parcial, cancelación, reposición y conservación de cobros y conteos. Los fallos de selectores durante la adaptación se distinguieron de fallos de aplicación; se corrigieron las consultas ambiguas y las que seguían buscando el nombre anterior de un botón ya desplegado. Se reutilizó la evidencia de los recorridos que no requerían repetirse.

La inspección visual encontró una etiqueta partida en móvil; se corrigió y se midieron también los textos e indicadores internos. La compilación y la inspección de estilos pasaron. Esta segunda mejora cambia presentación e interacción de consulta; no modifica las reglas ni las funciones de base de datos ya verificadas.

La comparación se hizo con el **mismo pedido real #2631**, antes y después de publicar, sin cambiar sus cantidades. Se midió el bloque completo del producto, incluyendo su encabezado y reposición. “Detalle abierto” corresponde a su primera vista, con los tres primeros pedidos; el resto sigue accesible bajo consulta.

| Ancho | Vista inicial: antes → después | Reducción | Detalle abierto: antes → después | Reducción |
| --- | --- | --- | --- | --- |
| 1280 px | 254.75 → 195.75 px | 23 % | 846.25 → 522.12 px | 38 % |
| 320 px | 393.00 → 243.25 px | 38 % | 1238.00 → 569.62 px | 54 % |

La mejora quedó publicada con el código `b5e5a63`, versión `40a3b5c4-ca2d-479d-a163-01890c80dc05`, al 100 % del tráfico desde `2026-10-16T18:13:11.260751Z`. Coincidieron los 220 archivos publicados comprobados, incluidos 129 recursos anteriores conservados para pestañas abiertas.

La comprobación publicada del `2026-10-16T18:14:41.200Z` pasó en escritorio y móvil: detalle y ayuda operables con teclado, reservas completas sin scroll interno, compra exacta #2054 en otra pestaña y conteo sin guardar conservado. No se encontraron recortes internos ni errores de aplicación en esos recorridos. Las solicitudes de negocio que escribieran datos estaban bloqueadas; no hubo ninguna. Las pruebas de guardado y recepción pertenecen al entorno local, no a pedidos reales.

Evidencia privada de esta segunda mejora: `/tmp/impulso-packing-ux-20261016/`, con capturas, comparación de alturas, pruebas afectadas, archivos servidos y comprobación de la versión publicada. El cierre anterior documenta las pruebas de base de datos; no se repitieron para un cambio limitado a estas dos interfaces.

## Verificación del significado y consistencia entre pantallas

La nueva revisión comprobó cada afirmación contra el código de asignación, los estados guardados y casos aislados de varios pedidos y proveedores. No se usó el pedido #2631 como única prueba. Se implementaron las propuestas aprobadas manteniendo las reglas de reserva, recepción, cobro, envío y cancelación.

1. **Stock registrado, reservas y bolsitas:** el total registrado incluye las bolsitas sin entregar; las unidades libres corresponden a nuevas ventas. El pedido conserva su cantidad solicitada y el contador «En bolsita», con un límite visible cuando sólo tiene parte asignada. El detalle de stock queda cerrado inicialmente y los números se alinean también a 320 px.
2. **Diferencia general de stock:** si las reservas físicas superan el total registrado, aparece una advertencia incluso en pedidos totalmente asignados. La diferencia se informa para el producto, sin atribuírsela arbitrariamente a un cliente ni modificar compromisos, cobros o conteos. En Inventario tampoco se promete disponibilidad futura mientras exista esa diferencia.
3. **Pendiente de recibir:** reemplaza «En camino» para compras al proveedor, porque una compra abierta no demuestra un despacho. El término es consistente en pedidos, productos, inventario, tienda, exportación y respuestas del asistente. Los envíos al cliente conservan su estado propio.
4. **Origen de la reserva:** se distingue «Stock local primero» de «Solo compras al proveedor». En este último caso se explica, cuando corresponde, por qué el stock libre del local queda para otras ventas. La ayuda ampliada conserva la posible prioridad de pedidos anteriores y reservas previas al recibir.
5. **Conteo y preparación:** guardar cero muestra «Conteo guardado: bolsita vacía» y deja pendiente la preparación. Guardar parte la deja en preparación; completar el conteo no marca automáticamente el pedido listo. La vista previa corresponde a la misma regla de `save_order_packing`. Los errores, datos cambiados y borradores siguen protegidos.
6. **Compra vigente frente a faltante histórico:** el contexto agrega `incomingQuantity` y `uncoveredQuantity` por compra y mantiene el agregado anterior `reservedQuantity`. Una unidad sin reposición nunca toma la fecha de una unidad cubierta por la misma compra. Varias compras mantienen sus fechas separadas, incluidas las que no tienen fecha. Los enlaces abren la compra exacta, aunque esté fuera de la primera página.
7. **Carrito y WhatsApp:** el aviso de que enviar la solicitud no reserva stock ya existía; se corrigió esa conclusión de la revisión inicial. Se simplificó el texto junto a la acción de continuar. Sí se encontró una afirmación incorrecta adicional: se anunciaba entrega o despacho usando la llegada estimada del proveedor. Ahora el carrito y la confirmación comparten un aviso breve de llegada estimada **al local**, sujeto a confirmación de entrega. Si falta la fecha de alguna compra necesaria, no muestran una fecha completa del pedido.

El único cambio de base de datos de esta revisión es una consulta estable de contexto, con dos campos adicionales. Conserva la comprobación de usuario activo, los permisos, la firma y los campos que usan las versiones anteriores. No ejecuta una nueva reparación histórica ni escribe stock, reservas o pedidos. En demostración no se inventa un origen histórico para faltantes que ese entorno no conserva.

### Comprobaciones de esta revisión

- **Aplicación:** 674 casos distintos cubiertos por la batería completa y las comprobaciones específicas posteriores. Los dos fallos iniciales correspondían a una respuesta simulada que devolvía un conteo anterior y a un selector de estado ambiguo; se corrigieron y pasaron los casos afectados. Las siete nuevas comprobaciones del aviso público incluyen fecha parcial, inexistente e inválida.
- **Base aislada:** 189 comprobaciones válidas: contexto 44, prioridades 24, recepciones 15, armado 51 y cancelación 55. El caso sintético de compatibilidad histórica reúne una unidad cubierta y otra sin reposición en la misma compra abierta. Una comparación anterior/posterior demuestra que consultar no altera balances, reservas, cantidades, cobros ni revisiones. También se comprueban el acceso del personal activo y el rechazo de usuarios deshabilitados y anónimos. Todas las pruebas revierten sus datos.
- **Navegador local:** 54 recorridos distintos válidos entre escritorio y móvil, incluidos 320 px, teclado, borradores, reserva exclusiva al proveedor, cambios de cantidad, cobro y envío, recepción parcial, cancelación, reposición y fechas incompletas. Dos recorridos remotos con escrituras quedaron omitidos deliberadamente; no se presentan como evidencia real. Se conservaron los recorridos ya válidos y sólo se repitieron los afectados por cambios visuales o correcciones de la prueba. La primera ejecución del nuevo recorrido público intentaba crear su escenario antes de cargar la demostración; se corrigió la preparación del escenario y pasaron sus cuatro variantes.
- **Inspección visual:** una ronda conjunta encontró números desalineados y un salto innecesario de la ayuda en móvil. La confirmación pasó después de corregir ambos; también se acortó el enlace a Inventario. Los recorridos controlan recortes, errores de aplicación y ausencia de controles nativos en las superficies revisadas. No hubo un navegador administrado disponible; se usó Playwright local.
- **Detector de estilos:** revisó 17 archivos de interfaz. Señaló un degradado de texto preexistente en el encabezado público, fuera de las líneas modificadas; no encontró ese patrón en los controles o avisos nuevos. Se conservó el diseño existente del encabezado.
- **Compilación y compatibilidad:** pasó la compilación final de producción, incluida la comprobación de tipos. Las 14 consultas de contratos reales pasaron en modo de consulta. El ensayo remoto previo identificó únicamente la nueva migración de contexto; el destino de aplicación y base quedó verificado.

La evidencia privada de esta revisión queda en `/tmp/impulso-clarity-ui-20261016/`. Los resultados con datos reales y la definición anterior de la consulta permanecen fuera del repositorio.
