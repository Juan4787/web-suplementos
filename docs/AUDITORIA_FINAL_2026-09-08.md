# Auditoría de entrega — 08/09/2026

Prioridad acordada: uso diario de Natalia (dueña) y Florencia (personal), venta online por WhatsApp, mensajes comprensibles y prevención de errores silenciosos. Las pruebas pesadas se ejecutan secuencialmente, con un solo worker y límite de memoria de Node de 768 MB. No se detuvieron servicios de otros proyectos.

## Estado de entrega

- **Supabase actualizado:** 37 migraciones locales y remotas, sin pendientes.
- **Cuentas:** únicamente `natisfrutos@gmail.com` (dueña) y `florgarciataverna@gmail.com` (personal), activas. Florencia fue creada con la contraseña indicada, que no se incluye en el repositorio ni en este informe.
- **Datos:** 25 productos, 23 publicados. Tras confirmación expresa del usuario se retiraron tres entradas ficticias: dos «Item Test 41» y una «Item Test 45». El resto del catálogo, precios, descripciones, costos, imágenes y configuración se conservaron exactamente; no se cambió su visibilidad.
- **Operaciones ficticias retiradas:** cero pedidos, compras, clientes, movimientos y reservas. Nunca hubo clientes reales, según lo informado por el usuario.
- **Stock:** todas las cantidades físicas y reservadas en cero. Falta recibir y cargar el inventario real. No tratar los productos sin stock como disponibles para vender.
- **Frontend publicado:** commit `c0c1b5aa6b1116578c2298769055b3d87a70cdf0` está en `origin/main` y el Worker `tienda` quedó publicado con la versión `4641aa0f-25da-4166-ac66-62c7646ab0dc`.

## Correcciones del uso cotidiano

| Problema observado | Corrección y efecto |
| --- | --- |
| Buscar pedidos solo revisaba la página actual de 50 filas. Un pedido antiguo podía parecer inexistente. | Búsqueda y filtros del historial completo en PostgreSQL, con contadores y paginación coherentes. Búsqueda por cliente, número o teléfono. |
| Clientes buscaba pedidos entre los últimos 100 de toda la tienda y también vinculaba personas por nombre. Una ficha podía quedar incompleta o mostrar pedidos ajenos. | Historial paginado por cliente en PostgreSQL, consultado al abrir su ficha. No une personas por nombre; muestra carga, error y reintento. La lista vacía explica cómo se agregan los clientes. |
| Las ventas cobradas no seguían el período de los indicadores. | Consulta paginada por fecha de cobro, con límites del día en Argentina. Cambio de período vuelve a la primera página; explicación cuando no hay ventas. |
| Reintentar un pedido manual tras perder la respuesta generaba una clave nueva. | El mismo borrador reutiliza la clave de operación; cambios de contenido generan otra. Evita duplicar ese reintento. |
| El checkout usaba precios/configuración guardados y omitía revisar un catálogo vacío. | Reconsulta catálogo y configuración al enviar. Identifica el producto retirado, agotado o con cantidad insuficiente. Si cambia el precio o envío, actualiza el total y pide revisarlo antes de abrir WhatsApp. |
| Un error al cargar productos o configuración podía dejar el proceso sin salida. | Estados de carga, explicación, reintento y conservación del formulario en compras, checkout y carga/importación de pedidos. |
| Una compra incompleta dejaba “Guardar pedido” deshabilitado sin explicar la causa. | Mensaje que identifica la fila sin producto, cantidad incorrecta o campo demasiado largo. |
| El costo de compra perdía el separador decimal mientras se escribía. | Se conserva el texto durante la edición; una entrada de 125,50 llega como 12.550 centavos a la operación. |
| Los importes con centavos se redondeaban al mostrarlos y al construir WhatsApp. | Se conservan los dos decimales cuando existen centavos. Prueba de envío/importación con precio de 125,50 y tres unidades: total de productos 376,50 sin pérdida. |
| Recepción con cero unidades, o corrección sin motivo, bloqueaban acciones sin una instrucción concreta. | Mensajes para ingresar unidades, declarar faltante o completar el motivo; protección al cerrar mientras se guarda. |
| Un conteo de stock abierto antes de otra venta podía sobrescribir la cantidad real con un cálculo desactualizado. | La corrección comprueba el stock visto al abrir el formulario bajo bloqueo transaccional. Si cambió, conserva el stock actual y explica que hay que revisar el conteo. Caso probado: 10 al abrir, 9 tras otra operación; el conteo viejo no lo reduce erróneamente a 8. |
| En celular, márgenes duplicados estrechaban el formulario y el selector quedaba recortado por el cuadro. | Márgenes corregidos y desplegables fuera del área que recorta el contenido; calendario adaptado al espacio de pantalla. Escape cierra primero el selector/calendario y conserva la compra. |
| Varias etiquetas y errores no estaban asociados a sus campos. | Asociación compartida de etiquetas, descripciones e indicación de error en entradas, importes, selectores y fechas. |
| Algunos límites de formularios mostraban mensajes predeterminados en inglés. | Mensajes en español para nombres, presentaciones, descripciones, dirección, teléfono y cantidades. |
| Productos ocultos aparecían como seleccionables al cargar un pedido aunque el servidor los rechazaba. | Se ofrecen productos activos y publicados y se explica dónde revisar su visibilidad. |
| Errores de cantidades recibidas, reservas o reintentos no indicaban qué corregir. | Traducciones comerciales específicas con próximo paso, sin SQL, identificadores internos ni códigos técnicos. |
| Archivar un producto podía iniciar otra escritura diferente si fallaba la primera. | Eliminado el fallback indiscriminado; el error se informa sin ejecutar una segunda modificación del catálogo. |
| Confirmar/cobrar/entregar no refrescaba todas las vistas relacionadas. | Se invalidan también existencias públicas, catálogo, ventas, clientes y movimientos; al volver a la ventana se revalidan consultas. |
| La confirmación reservaba stock físico sin dejar su movimiento de reserva. | Restaurado el movimiento correspondiente dentro de la misma transacción. Verificación con reservas simultáneas y reintentos. |
| Guardar configuración no explicaba los campos inválidos y el formulario retenía valores distintos de los guardados. | Validación de nombre, teléfono, cuenta bancaria, importes y porcentaje; muestra los valores normalizados devueltos por el servidor. |
| Inventario solicitaba compras en segundo plano con la cuenta de personal y generaba errores aunque esa sección no se mostrara. | Solo solicita compras cuando la cuenta puede utilizarlas; evita solicitudes fallidas y reintentos innecesarios. |
| La pantalla de usuarios describía un registro público que no existe. | Instrucciones ajustadas al alta de cuentas habilitadas. |
| Cambiar/cerrar sesión podía conservar consultas o aceptar una respuesta antigua; renovar sesión podía bloquear llamadas. | Perfil comprobado, limpieza al cambiar identidad, descarte de respuestas tardías y revalidación fuera del bloqueo de autenticación. |
| Una falla de pantalla podía mostrar el error técnico del enrutador. | Pantalla de recuperación con mensaje amigable y reintento. |

La corrección de renovación de sesión sigue la advertencia oficial de [Supabase sobre llamadas dentro de onAuthStateChange](https://supabase.com/docs/guides/troubleshooting/why-is-my-supabase-api-call-not-returning-PGzXw0). La auditoría de permisos se limitó a los arreglos necesarios; el trabajo principal estuvo en operación y UX.

## Pruebas y evidencia

- Base inicial: Git limpio, `b9b0774`; TypeScript aprobado y 241 pruebas en 35 archivos.
- Lógica e interfaz: suite completa **263/263 en 41 archivos** (`output/audit/unit-final.log`). Después, 25 pruebas focalizadas verificaron conteos de stock y errores; las últimas correcciones de inventario, clientes, demo y Excel se verificaron en 26 pruebas de cuatro archivos (24 en `customer-and-dependency-tests.log` y dos en `customer-ui-tests.log`, tras corregir un error de edición detectado por el primer intento).
- PostgreSQL local: **133/133 en 6 archivos**, incluidas reservas concurrentes con dos conexiones, idempotencia, recepción parcial/faltante, búsqueda más allá de 50 pedidos, conteos desactualizados e historial de clientes con más de 100 pedidos ajenos posteriores. Comando: `pnpm exec supabase test db --local`; log `output/audit/sql-all-final.log`.
- Navegador: suite completa de escritorio Chromium, móvil Chrome y smoke Firefox: **48 aprobadas y dos omitidas deliberadamente**, las que escriben fixtures en Supabase remoto. Log `output/audit/e2e-final.log`. Después de los últimos cambios, stock y Excel pasaron nuevamente en escritorio y celular: **4/4**, partiendo con caché de Vite vacía; log `output/audit/final-stock-export-e2e.log`.
- Las pruebas existentes de ciclo de pedidos contenían pasos opcionales que podían no ejecutarse. Se reemplazaron por recorridos obligatorios: crear pedido, cobrar/entregar o confirmar cancelación, y comprobar cantidades físicas y reservas en la interfaz. Ambos aprobados en escritorio y móvil.
- Excel descargado y abierto con ExcelJS: **13 hojas**, hojas comerciales presentes y ninguna celda de tipo fórmula. Aprobado en escritorio y móvil. Se reprodujo la interrupción del primer intento con caché de desarrollo vacía: Vite descubría tarde `write-excel-file/browser` y recargaba la página durante la creación. Se agregó esa dependencia a `optimizeDeps.include` en `vite.config.ts`. La captura anterior muestra dos conexiones de la página y el log del servidor registra la optimización tardía; evidencia en `output/audit/export-first-use-before-fix.zip` y `export-first-use-trace.log`. Esta conducta de desarrollo está documentada por [Vite](https://vite.dev/guide/dep-pre-bundling#automatic-dependency-discovery).
- La inspección visual cubre 320 y 375 px en compras y controles emergentes. Capturas locales en `output/playwright/`.
- Build final: `REQUIRE_SUPABASE_ENV=1 NODE_OPTIONS=--max-old-space-size=768 pnpm build`, aprobado; incluye TypeScript. Log `output/audit/build-final.log`.
- Dependencias: `pnpm audit --audit-level=low`, **sin vulnerabilidades conocidas**. Se actualizó `fflate` de 0.8.2 a 0.8.3, incluida la resolución que utiliza la exportación Excel; [el proyecto documenta la corrección de lectura Zip64](https://github.com/101arrowz/fflate/releases/tag/v0.8.3). Se verificó nuevamente el libro exportado.
- Acceso real con Florencia usando el build local conectado a Supabase: ingreso, navegación por pedidos/clientes/inventario, recarga de ruta interna y cierre de sesión aprobados. Una ruta privada después de salir vuelve al ingreso. En 375 px, Pedidos no presenta desborde horizontal. No se crearon operaciones remotas para esta comprobación.
- Smoke público posterior al deploy: `/`, `/app`, `/app/pedidos` y `/api/health` respondieron correctamente; las páginas HTML contienen el asset de esta compilación y la API devolvió `{"status":"ok"}`. El deploy fue realizado sin modificar operaciones comerciales.
- El empaquetado `NODE_OPTIONS=--max-old-space-size=768 pnpm worker:deploy:dry` aprobó para `tienda`, perfil `impulso`, sin publicar. Recompiló y conservó las huellas de todos los archivos del manifest; Worker 643,36 KiB (104,44 KiB gzip). Log `output/audit/worker-package-final.log`.
- La repetición con Florencia sobre el build final confirmó cero solicitudes fallidas, cero consultas innecesarias a compras, ausencia de los productos «Item Test», mensaje inicial de Clientes, recarga y cierre de sesión. Log `output/audit/staff-final-browser.log`.
- El paquete generado no contiene coincidencias con las credenciales privadas del entorno. Manifest local: `output/audit/artifact-manifest.json`, 179 archivos, 33.459.214 bytes; SHA-256 de `index.html`: `e965e272cc4c9e124ebce20a644fc94e25e10811e8702e5e5a8e41057fcccf4e`. Huella del listado ordenado de archivos: `3c0a935a83ae91d143718606f3c28f3902a2137a9e6d56c72bf019311ab5ddaa`.

Los logs detallados están en `output/audit/`, excluidos de Git. Una prueba en demo verifica interfaz y lógica demo; las reglas transaccionales se verificaron por separado en PostgreSQL local. No equivale a una venta real en producción.

## Limpieza autorizada y respaldo

Antes de borrar datos ficticios se creó un respaldo lógico de PostgreSQL fuera del repositorio, con permisos privados:

`~/.local/share/impulso-backups/2026-09-08T09-20-13-088Z/before-handoff.dump`

- Tamaño: 526.870 bytes.
- SHA-256: `ab7584bcf6cda97d957f96219c167bd4fa74853df719ff7809fe8c34d5e8652d`.
- Incluye esquemas public/private, Auth, metadatos de Storage e historial de migraciones. No contiene los binarios de imágenes ni secretos del hosting.
- El índice del archivo se abrió con pg_restore de PostgreSQL 17 (540 entradas). No se afirma un ensayo completo de restauración.
- La limpieza usó transacción, bloqueo y comparación de datos protegidos. Se conservaron también los índices de inflación.
- `scripts/prepare-client-handoff.mjs` es una herramienta de esa limpieza puntual, con precondiciones sobre los conteos originales. No debe reutilizarse en una tienda con operaciones reales ni cambiar sus precondiciones para forzar una ejecución.

Comparaciones idénticas antes y después de retirar las operaciones ficticias, y tras las primeras migraciones (antes de autorizar la retirada de tres productos de prueba):

| Conjunto | Huella MD5 de comparación |
| --- | --- |
| Catálogo completo | `766fcab5a07199befb846effcec17c54` |
| Costos comerciales | `bb309543787ecdb44a5a633a80b2a17f` |
| Imágenes del catálogo | `f3896f57ae5f9173a66d7f71dc54bd6f` |
| Configuración comercial | `4f9dbc582d92128e3cf9a54bac109833` |

Después de confirmar que las tres entradas «Item Test» eran ficticias, se creó otro respaldo privado en `~/.local/share/impulso-backups/2026-09-08T19-44-21-201Z/before-handoff.dump` (433.084 bytes; SHA-256 `f7da846ba2fe6e8e933baeda017a2a7fbbb97da3224fe77a6579560916cd874c`). Se eliminaron por identificadores exactos, sin pedidos ni compras vinculados, comprobando en la transacción que el catálogo restante y su configuración fueran idénticos antes/después. Un primer intento abortó por una consulta de correo en una tabla incorrecta; la transacción se revirtió antes de borrar productos y la consulta corregida completó la operación.

Huellas finales de `scripts/audit-readiness.mjs`: catálogo `9ec04018595d212c64cc457898696104`, costos `11c8644e8d5ac7448b933e0dd9dc350c`; imágenes y configuración conservan sus huellas de la tabla. El script de retirada también comparó costos/configuración incluyendo sus campos de auditoría, por eso esas dos huellas de su log usan una proyección diferente.

Estas huellas se usan para detectar cambios, no como garantía criptográfica de seguridad.

## Incidentes encontrados durante la verificación

1. Un E2E existente mezclaba creación de fixtures remotos con una interfaz en demo y tenía credenciales fallback incrustadas. Su ejecución inicial creó un producto y una compra de prueba. Se retiraron y se verificó la limpieza; después se agregó un bloqueo que exige URL, cuentas y habilitación explícita de escrituras remotas. No volver a ejecutar esa prueba rutinariamente contra producción.
2. La eliminación por Auth API de una cuenta de prueba malformada devolvió error. Primero quedó deshabilitada; después se eliminó en transacción con coincidencia exacta de identificador, correo de prueba y estado inactivo. La verificación final muestra exactamente dos usuarios de Auth y dos accesos activos. El error final del log de limpieza corresponde a ese paso, ya resuelto por separado.
3. Algunas pruebas SQL antiguas esperaban rechazar reintentos que ahora deben ser idempotentes y usaban pasos intermedios de preparación eliminados. Se actualizaron a las reglas vigentes. Una prueba sintética de concurrencia tomaba los locks en orden inverso; se corrigió el orden manteniendo las comprobaciones de una sola reserva, operación y movimiento.

## Límite de esta entrega

Falta recibir el stock real y cargarlo antes de habilitar ventas con existencias. No se certificó un cobro bancario ni el envío efectivo de un mensaje a un cliente: WhatsApp se interceptó en las pruebas y los datos comerciales de pago solo se verificaron por formato. La IA sigue siendo auxiliar; no se renovó aquí su certificación de respuestas factuales en producción. Una indisponibilidad de IA no debe impedir pedidos, inventario ni ventas.

No se promete ausencia absoluta de errores. La evidencia cubre los recorridos normales revisados y sus regresiones concretas; grandes volúmenes, una restauración completa y fallos de red prolongados no quedaron certificados por esta ronda.
