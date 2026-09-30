# Correcciones conservadoras y auditoría adversarial — 29/09/2026

Base revisada: `8fca3de`. La auditoría inicial se ejecutó sobre cambios locales. La preparación y el resultado de la publicación se registran al final de este documento. Las pruebas de escritura usaron datos descartables; no se modificaron ni borraron pedidos, productos o stock reales.

## Alcance y decisiones

Se implementaron las correcciones autorizadas de conservación de borradores, actualización de datos operativos y permisos de Inventario. La auditoría agregó correcciones de foco, formularios pendientes y recepción parcial al reproducir fallos concretos. La última revisión priorizó recorridos cotidianos en navegador y lectura de código; no repitió la suite completa tras cada ajuste visual.

El archivo del usuario `src/domain/whatsapp-urgent-debug.test.ts` se conserva intacto. SHA-256 confirmado al cierre: `5cad98b5a647866a4c81e8177c907e6822c7e01827fa50b5ec8252ab88f73854`.

## Correcciones y comprobaciones

| Flujo | Problema reproducido o riesgo verificado | Corrección y control |
| :--- | :--- | :--- |
| Armado de bolsitas | Una actualización reemplazaba cantidades escritas sin guardar. Cerrar acciones o cambiar filtros podía perder el borrador. | Borrador por pedido, cantidades como texto y revisión original conservada. Conflictos explícitos; carga de datos actuales con confirmación. Cerrar/reabrir conserva el conteo; la respuesta confirmada al guardar prevalece sobre una revisión anterior. |
| Cantidades | Un vacío temporal o un texto como `01` podía impedir cambiar un número; entradas inválidas podían interpretarse como otro valor. | Vacío permitido durante edición, normalización únicamente de enteros escritos, texto inválido visible y guardado bloqueado con indicación concreta. Navegador: borrar, salir del campo y escribir otro número no restaura el anterior. |
| Pedidos y búsqueda | La búsqueda de un único pedido reabría automáticamente sus acciones después de pulsar “Ocultar acciones”. | Apertura inicial una vez por resultado de búsqueda. Cierre respetado después de refrescar; reabrir conserva el borrador. Regresión automatizada y recorrido de navegador. |
| Actualización y permisos | Recuperar el foco podía conservar datos operativos recientes pero anteriores a un cambio en otra pestaña. Personal podía entrar a Compras y ver una pantalla vacía. | Refresco al foco restringido a consultas operativas; configuración global del caché conservada. Personal recibe Stock y una explicación. Navegador: una actualización con caché de 0 ms sí refrescó Inventario. |
| Avisos de stock | La configuración recibida durante edición podía sustituir cantidades escritas. Un guardado sobre valores anteriores podía sobrescribir un cambio ajeno. | Borrador conservado, conflicto visible y guardado con comparación contra la configuración original en PostgreSQL. Validaciones y protección de cierre. |
| Formularios en envío | Cambiar datos o navegar durante una solicitud podía asociar el resultado a otra entrada o permitir repetir una operación. | Datos de la solicitud congelados, controles bloqueados, protección de navegación y mensajes que explican que una operación enviada puede completar aunque se salga. Importación conserva la revisión ante errores. |
| Diálogos y selectores | Foco o Escape podían alcanzar la superficie equivocada; selectores/calendarios podían seguir accesibles detrás de otro diálogo. | Foco por profundidad, fondo inerte, Tab/ShiftTab dentro de la superficie activa, Escape del diálogo superior y retorno al control de origen. Portales asociados a su diálogo. Pruebas de consumidores y navegador. |
| Compra con varios productos | En móvil, seis filas dejaban Guardar fuera del panel y el contenido carecía de desplazamiento usable. | Límite de altura también en el fieldset, cuerpo desplazable y pie visible en creación y recepción. La primera corrección solo con flex no bastó; las medidas reales del navegador detectaron el fallo y se corrigió. |
| Cierre accidental de una compra | Escape descartaba el proveedor y las filas escritas sin aviso. | Confirmación al cerrar con Escape, cruz, Cancelar o Atrás si hay cambios. Sin confirmación si el formulario está intacto o si acaba de guardarse correctamente. Navegador: rechazar los tres cierres y Atrás conserva los datos; guardar una compra de seis productos cierra normalmente. |
| Segunda entrega de una compra | Se podían marcar como faltantes productos ya resueltos; aparecía el rango imposible “entre 0 y -1”. | La elección y el detalle de ingreso muestran productos con unidades pendientes. El historial y los cálculos de recepción se conservan. Caso focal con recepción completa, faltante declarado y un producto pendiente. Navegador: recibir la última unidad incrementó solo ese producto; las cinco unidades anteriores quedaron iguales. |
| Lectura de faltantes en móvil | “Llega completo” comprimía el nombre y quedaba cortado. | Insignia debajo del nombre en pantallas pequeñas, disposición horizontal en escritorio. Se revisaron las seis filas en 375, 320 y 1280 px; marcar/desmarcar conserva las cantidades de las otras filas. |
| Llegada parcial y reposición | Reasignar antes de registrar la llegada podía cerrar toda la compra original como faltante y bloquear el ingreso de unidades que sí habían llegado. | Primero se registra lo recibido. Reposición y traslado de reservas en una operación atómica, con comparación de pendiente e identificador de reintento. La declaración de varios faltantes también es atómica. Los errores conservan los datos y la recepción ya registrada. |

Los pedidos de cortesía conservan su distinción de pago y requieren entrega para figurar completados. Se eliminó la resolución automática que podía registrar cancelaciones o devoluciones de dinero sin comprobar la operación real.

## Evidencia ejecutada

| Comprobación | Resultado y límite |
| :--- | :--- |
| Suite completa final | 61 archivos, 451 tests aprobados después de todos los ajustes, incluidos los tres últimos casos de uso diario. Log: `/tmp/supplements-release-20260929-final/tests.log`; duración 183,69 s. Incluye una prueba privada del usuario que permanece local: el conjunto publicable contiene 450 tests en 60 archivos. |
| Últimas regresiones | Dos casos nuevos de cierre de compras y uno de segunda recepción aprobados en corridas focales y en la suite final. También pasó el caso de respuesta perdida y reintento de reposición, para comprobar que conservar la lista pendiente no altera su resolución. |
| PostgreSQL aislado | 339 assertions pgTAP aprobadas en 12 suites: permisos, reglas de negocio, reservas, llegadas repetidas, armado, gastos, rollback y resolución de faltantes. |
| Concurrencia real | 4 escenarios con conexiones solapadas: mismo identificador crea una reposición; dos identificadores producen un ganador; llegada ganadora rechaza reposición obsoleta; reposición ganadora rechaza llegada obsoleta. Se verificó espera de bloqueo y conservación de stock. |
| Compilación final | `REQUIRE_SUPABASE_ENV=1 pnpm build` aprobado: validación de configuración pública de Supabase, `tsc -b` y Vite. Log: `/tmp/supplements-final-production-build.log`. Artefactos: `index-C2LWp6t-.js`, `OrdersPage-Dj85U3Ey.js`, `InventoryPage-Cs1AR8fa.js`. |
| Revisión final | `git diff --check` sin errores. HEAD y checksum del archivo del usuario conservados. |

La nueva prueba de segunda recepción tuvo dos correcciones de su propio selector: coincidencia de texto con detalle de recepción anterior y uso de una opción de Playwright que TypeScript no admite en Testing Library. Se corrigieron; el caso focal y la compilación final completaron con salida 0.

### Navegador

Servidor explícito `VITE_APP_MODE=demo`, 127.0.0.1:5186, sesión propia `rigorous-ux`. Todas las altas, recepciones y fallos simulados usaron datos sintéticos en memoria.

Recorridos completados y resultados finales revisados:

- Edición vacía, cambio de número, conservación al cerrar/reabrir, actualización externa y rechazo de un guardado en conflicto.
- Guardado demorado y protección de navegación: salir no se describe como cancelación del envío.
- Recepción de 5 sobre 10: stock físico 5 y entrada pendiente 5; cerrar conserva el ingreso y permite continuar después.
- Reposición cuya respuesta se pierde después de confirmar: reintento con el mismo identificador, una sola compra de reposición y error visible dentro del diálogo.
- Navegación con Tab, superficies anidadas, calendario, selectores y restauración del bloqueo de fondo.
- Compra con seis filas: pie accesible y cuerpo desplazable en 375×812, 320×568 y 375×480. Borrar la tercera cantidad, salir del campo y escribir 8 conserva el valor.
- Escape, cruz, Cancelar y Atrás rechazados conservan el borrador. Guardado exitoso de seis productos no pide descartar cambios.
- Segunda recepción: un único producto pendiente visible; guardar 1 incrementa únicamente su stock y finaliza los seis productos sin duplicar los cinco ya recibidos.
- Vista de faltantes: nombres y etiquetas contenidos en sus filas en móvil y escritorio; marcar dos productos cambia el total a 4 y desmarcar uno lo vuelve a 5.

Capturas revisadas visualmente:

- `/tmp/supplements-final-orders-desktop.png`
- `/tmp/supplements-final-orders-mobile.png`
- `/tmp/supplements-daily-purchase-mobile.png`
- `/tmp/supplements-daily-receipt-mobile-final.png`

Una ejecución iniciada no se contó como prueba completada. Se corrigieron errores del guion de navegador y se revisaron sus respuestas finales. Las recargas del servidor de desarrollo activaron la protección de salida con borrador; se aceptaron únicamente para reiniciar los datos sintéticos del ensayo.

## Archivos principales

- Armado y navegación: `OrderPackingEditor.tsx`, `packing-draft.ts`, `OrdersPage.tsx`.
- Formularios operativos: `InventoryPage.tsx`, `ImportOrderPage.tsx`, `CreateOrderPage.tsx`, `inventory.ts`.
- Superficies y portales: `Modal.tsx`, `use-dialog-focus.ts`, `Select.tsx`, `DatePicker.tsx`, `styles.css`.
- Contratos y adaptadores: `business-api.ts`, `supabase-business-api.ts`, `demo-business-api.ts`.
- Migraciones nuevas: `20260929210000_checked_stock_thresholds.sql`, `20260929220000_safe_purchase_resolution.sql`.
- Regresiones junto a cada módulo, `safe_purchase_resolution.test.sql` y `scripts/test-safe-purchase-concurrency.mjs`.

## Compatibilidad de publicación y límites

Al terminar la auditoría local, las dos migraciones nuevas estaban aplicadas únicamente en la base aislada. El frontend nuevo necesita sus funciones para guardar avisos con comparación y resolver reposiciones/faltantes. El resultado remoto se registra por separado al completar la publicación.

La publicación debe coordinar base de datos, frontend y actualización de las pestañas de los operadores. La nueva validación de la función antigua de reasignación rechaza su uso antes de registrar la llegada: un bundle anterior que crea primero la reposición podría dejar esa nueva compra creada antes del rechazo. Para evitar ese cruce, se debe detener brevemente ese recorrido, aplicar las migraciones y publicar el frontend, actualizar las pestañas y verificar los contratos antes de retomarlo. Una reversión de frontend también debe considerar esta compatibilidad.

El modo demo agrupa algunas reservas entrantes por producto y no acredita por sí solo el enlace exacto a cada ítem de compra. Las pruebas de esa relación, rollback e idempotencia se hicieron en PostgreSQL aislado.

Los recorridos de navegador cubren Chromium y vistas móvil/escritorio. Una altura reducida comprueba el espacio disponible; no equivale a probar el teclado virtual real de iOS/Safari. Tampoco se afirma cobertura de todos los dispositivos, cargas o fallos de red posibles. Si una solicitud ya salió, cerrar una pestaña no cancela la operación del servidor; el aviso indica revisar el resultado antes de repetirla.

## Limpieza

Se cerraron la sesión propia de navegador y el servidor demo del puerto 5186. Se eliminó exclusivamente la base descartable `rigorous_ux_20260929_2105`; el contenedor compartido de Supabase sigue funcionando. Logs y capturas locales quedan como evidencia temporal. No se alteraron credenciales, configuración del Worker ni datos reales.

## Preparación de la publicación autorizada

El usuario confirmó que no hay operaciones en curso y que los operadores cerrarán las pestañas anteriores para abrir la versión nueva. Destinos verificados: Worker `tienda`, perfil `impulso`, y proyecto Supabase `mvtpidtuntvebyrxivue`. Git estaba alineado con `origin/main` antes de preparar el commit.

- Base remota: 53 migraciones aplicadas y exactamente dos pendientes (`20260929210000` y `20260929220000`); simulación sin semillas ni roles adicionales.
- Respaldo previo: archivo nativo PostgreSQL 17, 727.344 bytes, SHA-256 `7cd72d01b85084ee566fe08b2c84fff0013ca6c06b4687c00afbb4424130698f`. Se verificaron las 58 entradas de datos y la lectura completa con `pg_restore --file=/dev/null`, sin restaurar ni modificar producción. Ubicación privada: `~/.local/share/impulso-backups/20260930-release-verified/`. Un primer archivo vacío fue rechazado y no se considera respaldo.
- Se conservaron las definiciones y permisos de 79 funciones, y las huellas y una copia privada de las 22 tablas de negocio, mediante una transacción de solo lectura. Stock sin saldos inválidos ni diferencias entre reservas físicas y sus totales.
- Versión previa del Worker para referencia de reversión: `b6dc4171-0418-476d-9cd3-406061b33ef4`. Volver al frontend anterior requiere considerar la compatibilidad de recepción descrita arriba; no se propone borrar datos ni comprobantes.
- `worker:deploy:dry` aprobado, con validación de destino, TypeScript, build y empaquetado. Conserva los artefactos ya comprobados: `index-C2LWp6t-.js`, `OrdersPage-Dj85U3Ey.js` e `InventoryPage-Cs1AR8fa.js`.
- El archivo privado `whatsapp-urgent-debug.test.ts` contiene datos personales reales y queda fuera de Git y de la publicación, intacto.

## Publicación verificada

Publicación autorizada completada el 29/09/2026. Commit de código: `01e2f5e`, enviado a `origin/main`. La evidencia posterior se incorpora en un commit de documentación; no cambia el paquete desplegado.

| Capa | Evidencia remota revisada |
| :--- | :--- |
| Base de datos | Las dos migraciones se aplicaron correctamente. Historial remoto de 55 migraciones, coincidente con el repositorio y sin pendientes. No se ejecutaron semillas ni pruebas de escritura sobre datos reales. |
| Funciones y permisos | Los cuerpos de las seis funciones afectadas coinciden con el SQL revisado. Solo cambiaron las tres funciones existentes previstas, además de las tres nuevas. Conservan el control de dueña y el contexto de ejecución definido; el acceso anónimo está revocado y la tabla privada de reintentos no permite acceso directo a los clientes. |
| Conservación de datos | Después de las migraciones, contratos y navegador, las 22 tablas existentes conservan las mismas cantidades de filas y huellas completas que antes. La tabla nueva de reintentos contiene 0 filas. Stock: 0 saldos inválidos y 0 diferencias entre reservas físicas y totales. |
| Hosting | Publicación manual del Worker `tienda`: versión `28f30576-4150-419f-bc03-4d6b87563b5f`, desplegada al 100 % y etiquetada `01e2f5e`. Después de los pushes se observaron publicaciones posteriores; sus recursos y archivos servidos se cotejaron como se indica abajo. Origen: `https://tienda.desuplementos.workers.dev`. |
| Artefactos servidos | El HTML inicia `index-C2LWp6t-.js`. SHA-256 idéntico al paquete local para el archivo principal, Pedidos, Inventario y `index-BT8x7WNk.css`. Las cinco rutas revisadas respondieron 200 y `/api/health` respondió `{"status":"ok"}`. |
| Contratos en producción | 14/14 contratos de lectura aprobados con autenticación. Las tres funciones nuevas se comprobaron con identificadores inexistentes: accesibles para la dueña, rechazadas para acceso anónimo y abortadas antes de escribir. `get_purchase_impact` devuelve una lista vacía para la compra inexistente. Esto comprueba exposición y permisos; el comportamiento de escritura se acredita con las pruebas aisladas. |

### Recorrido de la versión publicada

Sesión propia Chromium `production-release-20260929`, autenticada como dueña. Un interceptor permitió únicamente lecturas y autenticación: ninguna operación de negocio de escritura fue intentada. Se revisó la respuesta final y el estado tras los diálogos antes de dar el recorrido por terminado. El recorrido se vincula con los archivos servidos comprobados; los metadatos posteriores muestran que, durante ese intervalo, ya había una publicación posterior del mismo paquete.

- Pedidos reales cargados correctamente. Un campo de armado se borró con teclado, quedó vacío después de perder foco, normalizó `01` a `1` y conservó el borrador al cerrar/reabrir. Se restauró su valor original sin guardar.
- Pedidos e Inventario: ancho del documento de 375 px dentro del viewport de 375 px, sin desplazamiento horizontal de la página.
- Entrada directa a Compras: contenido y acción de nuevo pedido visibles para la dueña.
- Formulario de compra en 320×568: Guardar dentro del viewport; 12 ciclos de Tab mantuvieron el foco dentro del diálogo. Rechazar el cierre con Escape conservó el proveedor escrito; aceptar el descarte con la cruz cerró el diálogo y devolvió el foco a “Nuevo pedido”. No se guardó una compra.
- Resultado final: 0 errores de JavaScript, 0 consultas fallidas, 0 escrituras intentadas, diálogo cerrado y comprobantes completos de los recorridos. Se cerró únicamente la sesión propia, se revocó solo su sesión de autenticación y se retiró el archivo temporal con tokens. Las sesiones de los operadores no se cerraron globalmente.

Evidencia privada de publicación: `/tmp/supplements-release-20260929-final/`, con respaldo persistente en la ubicación indicada arriba. El último cotejo de tablas se ejecutó a las `2026-09-30T02:41:21Z` (23:41 del 29/09 en Argentina). Los límites de dispositivos, teclado virtual y cobertura descritos en la auditoría siguen vigentes.

### Publicaciones posteriores y comprobación del paquete

El control de cierre detectó las versiones `c6c42763-4071-4d4a-8f36-c3be7c05ac37` (02:22 UTC) y `06a05759-e9d5-4ae7-b52c-d9a779a8c792` (02:47 UTC), posteriores a los pushes de código y documentación. Ambas registran exactamente los mismos recursos que la publicación manual: mismo script, configuración de ejecución y bindings. SHA-256 del conjunto de recursos: `39ac238b8fca632d1ebe86c41511222562ed7a3304d507ffe86d8a38e3c2b823`.

Se volvió a cotejar el paquete servido después de detectar esas versiones: inicio correcto, salud correcta y los cuatro archivos principales idénticos por SHA-256. Los IDs anteriores describen hitos comprobados; la última versión activa se registra en `publication-complete.json` junto al HEAD remoto y el cotejo de recursos y archivos, para evitar confundir un nuevo identificador con un cambio de código. No se cambió la configuración de publicación.

### Observación posterior sobre el campo de bolsitas

El usuario señaló que el campo permite escribir signos y letras. El control actual usa texto con teclado numérico para permitir el vacío temporal y conservar entradas inválidas sin transformarlas en otro número. La validación marca esas entradas y bloquea el guardado. Se reconoce que permitir que aparezcan resulta confuso para un contador de unidades.

Se propuso aceptar únicamente dígitos o vacío y rechazar completa una entrada inválida, conservando el borrador, sin convertir `-1` en `1` ni `1,5` en `15`. Esa propuesta no se implementó como respuesta a la pregunta; el comportamiento desplegado sigue siendo el descrito y requiere una revisión específica antes de modificarlo.
