# Campo de unidades en bolsita: corrección y auditoría — 30/09/2026

Base: `4f9f4fa`. La restricción de letras y signos había quedado como propuesta en la auditoría anterior; no estaba implementada ni publicada. Esta revisión corrige ese comportamiento ante el aviso del usuario.

## Comportamiento requerido y alcance

- El campo admite dígitos o vacío durante la edición. Borrar `11`, salir del campo y escribir `7` debe ser posible sin restaurar automáticamente el valor anterior.
- Letras, signos, decimales y notación científica se rechazan completos: nunca se transforma `-1` en `1`, `1,5` en `15` ni `1e2` en `12`.
- Una entrada rechazada conserva el conteo anterior. El pegado inválido conserva además la selección; el rechazo al escribir conserva el cursor en el recorrido Chromium comprobado.
- Un número entero que supera la reserva física permanece visible con la validación existente. La edición no lo recorta a otro número y Guardar sigue deshabilitado.
- Vacíos y conteos escritos continúan conservándose frente a cierre y reapertura. Las revisiones externas mantienen el conflicto y bloquean el guardado sobre una revisión anterior.

La modificación de producto se limita a los eventos del input en `OrderPackingEditor.tsx`. Se conserva el campo como texto con teclado numérico, el estado de borrador como cadena, el comportamiento de foco, la normalización de ceros iniciales y todas las validaciones de guardado. El helper compartido, Inventario, contratos, funciones de base de datos y configuración de publicación no cambian.

Se rechaza la inserción inválida en `onBeforeInput`, el texto original del portapapeles en `onPaste` y el valor inválido en `onChange` como protección adicional. Revisar el portapapeles original evita que un salto de línea se convierta en otra cantidad al ser eliminado por el input del navegador.

## Reproducción y reauditoría

| Comprobación | Evidencia |
| :--- | :--- |
| Antes de corregir | Dos regresiones nuevas fallaron: se aceptaba `abc` y el pegado inválido no se cancelaba. |
| Pruebas focales finales | `pnpm exec vitest run src/components/admin/OrderPackingEditor.test.tsx src/pages/admin/OrdersPage.test.tsx src/domain/inventory.test.ts --maxWorkers=1 --no-file-parallelism`: 34/34, tres archivos, 10,76 s. |
| Borradores anteriores | La prueba que antes introducía texto inválido se ajustó para recibir un borrador anterior ya inválido. Sigue permitiendo corregirlo, conserva los datos al remontar y bloquea el guardado si se reduce la reserva física. |
| Navegador demo, edición real | Borrar `11` con teclado, Tab, vacío conservado, rechazo de letras y signos, escritura posterior de `7`, validación de límite conservada. |
| Cursor y selección | Rechazar una letra en medio de `17` conserva el cursor. Insertar `3` produce `137`; Backspace vuelve a `17`; sustituir la selección final produce `18`. |
| Portapapeles real | Ctrl+V rechaza `abc`, `-1`, `1,5`, `1.5`, `1e2` y dos líneas `1`/`2`, conservando valor y selección. Acepta `01` y muestra `1`. |
| Recorrido completo demo | Vacío y número conservados al cerrar/reabrir; ancho de página 375 px; guardar dos cantidades de `1` confirma armado completo y conserva ambos valores. Cero errores JavaScript. |
| Compilación y destino | `pnpm worker:deploy:dry` aprobado: destino aislado, configuración pública Supabase, TypeScript, build y empaquetado del Worker. |
| Revisión de código | Tres eventos restringidos al input; no se añade bloqueo global de teclado ni se eliminan caracteres para reinterpretar una cantidad. El borrado y las validaciones existentes siguen intactos. |

El único guardado de esta revisión de navegador usa datos demo descartables. El archivo privado del usuario `src/domain/whatsapp-urgent-debug.test.ts` se conserva intacto y fuera de Git: SHA-256 `5cad98b5a647866a4c81e8177c907e6822c7e01827fa50b5ec8252ab88f73854`.

Evidencia temporal privada: `/tmp/supplements-numeric-20260930/`. La sesión demo y su servidor se cerraron después de capturar la respuesta final del navegador. La aplicación ya operativa no recibió pruebas de escritura, migraciones ni operaciones de inventario. Esta auditoría comprueba los recorridos detallados en Chromium; no equivale a una prueba de teclados físicos iOS/Android.

## Publicación

Preparación validada. La versión desplegada, los archivos servidos y el recorrido protegido en producción se registrarán al completar la publicación.
