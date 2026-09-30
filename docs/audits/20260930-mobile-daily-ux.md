# Inventario móvil y operación diaria: correcciones y reauditoría — 30/09/2026

Base revisada: `dec280763e4aaf59370693f6f7a0f9d92b4bbfbd`. Objetivo: corregir recortes móviles, bloquear el zoom solicitado y buscar fallos de uso diario mediante edición, navegación, interrupciones y datos extensos. La revisión usa Chromium y datos demo para las escrituras. No modifica pedidos, stock, reservas ni migraciones de producción.

## Hallazgos y decisiones

| Hallazgo | Evidencia y corrección conservadora |
| :--- | :--- |
| «Movimientos» quedaba cortado | A 375 px, el botón terminaba en x=440 y el área disponible en x=359. A 320 px, el área terminaba en x=304. Tres columnas con icono sobre el texto en móvil, dos para personal; escritorio conserva la fila. Etiquetas completas y controles de 56 px de alto. |
| Contenido fuera de pantallas bajas | `min-height: 42rem` situaba el final de main en y=672 en pantallas de 568 o 375 px de alto. Se usa altura dinámica del viewport y `min-height: 0` para conservar el desplazamiento interno. |
| Zoom móvil solicitado | Viewport restringido y `touch-action: pan-x pan-y`. Los gestos táctiles comprobados desplazan main 225 px; un pinch de factor 1,6 mantiene `visualViewport.scale=1`. |
| Cantidades de Inventario aceptaban letras y signos | Se reutiliza la restricción ya publicada de bolsitas: dígitos o vacío, rechazo íntegro de inserciones y portapapeles inválidos, sin reinterpretar `-1` como `1`. Aplica a compra, recepción, avisos y corrección física. Los precios decimales conservan su tratamiento. |
| Abrir corrección descartaba avisos sin guardar | «Corregir stock» pasa por el mismo control de descarte que cerrar el detalle. Rechazar conserva los valores y no abre la corrección. |
| Cerrar corrección perdía el conteo | Escape, cierre y Cancelar usan un control común; la navegación y el cierre de pestaña protegen el borrador. Durante el guardado se bloquea el cierre y la edición. Los errores conservan cantidad y motivo. |
| Stock actualizado mientras se contaba | Se conserva el conteo, se avisa del cambio, se bloquea Guardar y se ofrece «Volver a contar». Descartar requiere decisión expresa y deja el campo vacío. La comparación de stock del servidor permanece. Las cifras reservadas y libres se calculan con la misma lectura actual y se distinguen del registro al abrir. |
| Personal veía avisos editables que requieren dueña | Campos de consulta para personal, explicación de quién los configura y ausencia de Guardar. Se alinea la interfaz con el permiso existente del servidor. |
| Menú móvil dejaba enfocar el fondo y Escape no lo cerraba | Portal y manejo de foco compartido con los diálogos existentes: fondo inactivo, ciclo de Tab, Escape y retorno al botón de apertura. Se cierra al pasar a escritorio para evitar un fondo bloqueado detrás de un diálogo oculto. |
| Nombre largo ocultaba el cierre del cliente | Un apellido concatenado dejaba el cierre en x=553–573 sobre un viewport de 320 px. Texto con ajuste de línea, contenedor reducible y cierre de 44 px. Después: cierre en x=252–296 y ancho de contenido igual al del panel. |
| Paginación de cientos de clientes se cortaba | Con 503 clientes, el control tenía 306 px de contenido en 286 px disponibles y «Siguiente» terminaba en x=323. En móvil el número de página ocupa una fila propia y los botones una segunda fila; escritorio conserva la fila. |
| Primer toque en «Ver pedido» ignorado tras confirmar | El resultado manual aparecía antes de terminar las invalidaciones; el enlace parecía activo y el fieldset cancelaba el clic. Un segundo toque posterior sí navegó. La pantalla de éxito manual se muestra al terminar la mutación; en importación se informa «Actualizando pedidos y stock…» hasta habilitar el resultado. Se conservan guardas, idempotencia y operaciones de negocio. |

También se alinearon dos referencias de `e2e/03-order-lifecycle.spec.ts` con la edición directa actual: los botones «Completar vacíos con 0» y «Ya guardé todo lo reservado» ya habían sido eliminados antes de esta revisión.

## Reauditoría con navegador

- **44 mediciones de pantalla:** 11 rutas en 320×568, 375×812, 812×375 y 1280×800. Inicio, Stock, Compras, Movimientos, Pedidos, pedido manual, importación, Clientes, Productos, Ventas y Configuración. Sin desbordamiento del documento ni main fuera del viewport. Etiquetas de Inventario completas; cero errores JavaScript en el recorrido final de geometría.
- **Gestos reales de entrada del navegador:** desplazamiento táctil positivo y pinch bloqueado. Un primer intento con el gesto sintético de scroll no produjo desplazamiento; se sustituyó por eventos táctiles nativos y se comprobó el resultado. No se cambió la app por ese fallo del instrumento.
- **Edición cotidiana:** borrar `11` con teclado, salir del campo y mantener vacío; escribir `7`; rechazo de letras y signos; Ctrl+V rechaza `-1` conservando `7`. En bolsita, `01` se normaliza a `1`; vacío y cantidades superiores a la reserva no se guardan.
- **Descarte y fallo de conexión:** rechazar salida conserva avisos y conteo; error y reintento conservan cantidad y motivo; mientras la petición está pendiente no se puede editar ni cerrar. Guardado demo de 7 a 6 usa exactamente delta −1 y comparación contra 7.
- **Concurrencia:** actualización demo de stock durante el conteo no lo reemplaza; Guardar bloqueado, rechazo de volver a contar conserva el dato y aprobación deja vacío. Se comprobó que las unidades libres se calculan con la lectura actual.
- **Pedido manual completo:** confirmar, entrar con el primer clic, guardar bolsita, cobrar, marcar listo y entregar. Stock demo 7→6 y reservas 3→3: una salida física y liberación de la reserva del pedido. Inventario refleja el resultado.
- **Importación y cancelación:** mensaje generado con el protocolo real, consultas de actualización retenidas expresamente, resultado sin enlaces prematuros y navegación al primer clic sin preguntar si aún se está guardando. Una confirmación, cancelación conservada en historial, stock físico y reservas vuelven a 7 y 3.
- **Navegación móvil:** 19 avances de Tab permanecen en el menú; Escape cierra y devuelve el foco; pasar a escritorio libera el fondo; navegación en horizontal funciona. Los diálogos dejan el fondo activo al cerrarse.
- **503 clientes y 61 pedidos de historial sintéticos:** páginas 1→2, búsqueda del cliente 503, limpiar y volver a página 1; historial de cuatro páginas y último pedido presente. Error del historial y reintento conservan el cliente. Paginación y nombre largo corregidos se vuelven a medir en móvil y escritorio.
- **Personal:** avisos de solo lectura y explicación de Compras cuando no tiene permiso. La respuesta final guardada de esta comprobación corresponde al código corregido.

## Pruebas y compilación

Pruebas focales, secuenciales y sin el archivo privado del usuario:

```text
pnpm exec vitest run
  src/pages/admin/InventoryPage.test.tsx
  src/pages/admin/InventoryPage.adversarial.test.tsx
  src/components/admin/OrderPackingEditor.test.tsx
  src/pages/admin/OrdersPage.test.tsx
  src/components/ui/Modal.test.tsx
  src/pages/admin/CustomersPage.test.tsx
  src/pages/admin/CreateOrderPage.test.tsx
  src/pages/admin/ImportOrderPage.test.tsx
  --maxWorkers=1 --no-file-parallelism
```

Resultado vigente: **82 casos aprobados en ocho archivos**. La ejecución conjunta aprobó 75 casos en siete archivos y encontró un selector equivocado en la prueba nueva de pedido manual (`Confirmando` frente al nombre real `Confirmar pedido manual`). Tras corregir exclusivamente ese selector, el archivo manual aprobó sus siete casos. No se repitieron los otros siete archivos sin cambios.

Las nuevas regresiones verifican descarte, concurrencia y bloqueo de acciones de éxito mientras las consultas se actualizan. El recorrido E2E se ejecutó mediante Playwright CLI; la suite completa del runner Playwright no se ejecutó en esta revisión.

`pnpm worker:deploy:dry` aprobado: destino `tienda`, perfil `impulso`, configuración Supabase prevista, TypeScript, Vite y empaquetado del Worker. Build Vite: 2,21 s. `git diff --check` sin errores.

Evidencia privada: `/tmp/supplements-mobile-ux-20260930/local-receipt.json` conserva hashes de respuestas finales y ocho archivos del build. Capturas demo en `output/playwright/mobile-ux-20260930/`. Los intentos interrumpidos y los selectores erróneos de automatización no se cuentan como recorridos aprobados. Servidor y navegador demo cerrados antes de compilar.

## Protección de datos y límites

El archivo privado `src/domain/whatsapp-urgent-debug.test.ts` permanece intacto, fuera de Git, con SHA-256 `5cad98b5a647866a4c81e8177c907e6822c7e01827fa50b5ec8252ab88f73854`. No se alteraron SQL, migraciones, servicios de negocio, configuraciones de servicios ni secretos. Las escrituras de las pruebas usan únicamente demo descartable.

Los 503 clientes comprueban paginación y comportamiento de interfaz con respuestas sintéticas; no demuestran rendimiento remoto con esa población. Los gestos y teclados se comprobaron en Chromium, incluyendo emulación móvil; no son una certificación de todos los dispositivos físicos iOS/Android. La revisión acredita los recorridos descritos y no garantiza ausencia de cualquier fallo futuro.

## Publicación

La evidencia de despliegue y comprobación remota se incorporará después de publicar el build auditado. La verificación en producción bloqueará escrituras de negocio y restaurará cualquier edición local sin guardar.
