# Correcciones de uso diario — 09/09/2026

Estado: las correcciones iniciales se publicaron en GitHub y Cloudflare con `1f92547`. Complementa la auditoría del 08/09; no reemplaza sus límites ni certifica disponibilidad de proveedores externos. Las verificaciones posteriores no alteran datos comerciales, cuentas, stock ni políticas de Supabase.

## Corrección posterior: cantidad en camino en Productos

El usuario detectó que, después de cargar la compra #2033, Productos mostraba «0 · En camino». Faltaba cobertura del cruce Compras → Productos: las pruebas anteriores no comprobaban la cantidad pendiente visible en la tarjeta.

La lectura remota confirmó que la compra y el dato `incoming` estaban bien: ACID SUPPORT 30, ANDRO SUPPORT 15, B COMPLEX ACTIVE 12, CREATINA 30, FEMME BALANCE 1, INOSITOL CARE 18 y THYROID SUPPORT 12. Total 118, sin recepciones y con stock físico cero al verificar. No se modificó esta compra.

`ProductsPage.tsx` omitía el número `incoming` y pegaba la etiqueta «En camino» al disponible físico. Ahora muestra «Disponible ahora: 0 unidades» y un bloque separado «En camino: 30 unidades», con la aclaración de que se suman al stock al recibir la mercadería. También muestra reposiciones cuando todavía hay stock disponible. Conserva el cálculo físico menos reservado y no suma compras pendientes al disponible actual.

- Regresión permanente en `ProductsPage.test.tsx`, con API de demo y caché compartida entre pantallas: comprar 30 → 0 disponibles/30 pendientes → recibir 5 → 5/25 → recibir 25 → 30/0; comprar una unidad adicional → 30/1 → cerrar con faltante → 30/0. La caché se configura sin vencimiento para que la prueba dependa de las invalidaciones reales de las operaciones.
- Pruebas dirigidas de Productos, Inventario y API de demo: **20/20**. Después del ajuste tipográfico final, Productos vuelve a aprobar **1/1**. Logs `output/audit/incoming-products-focused.log` y `incoming-products-final-unit.log`.
- TypeScript y build de producción aprobados; log `output/audit/incoming-products-build.log`.
- Navegador en demo: crear una compra de 30 con 4 unidades ya disponibles muestra 4/30; recibir 5 actualiza a 9/25 al navegar, sin recarga. Sin desborde horizontal en 320, 375 y 1280 px. Capturas en `output/playwright/incoming-products-*.png`.
- Pruebas, build y navegador secuenciales; un solo trabajador y heap de Node limitado a 768 MB.
- Corrección publicada en `tienda.desuplementos.workers.dev`, versión de Cloudflare `0a16e676-4edf-42c0-a968-c034059257a5`. El archivo remoto `ProductsPage-pIWxZRe0.js` coincide byte por byte con el build local (SHA-256 `30dcd59651c668be7fadd2343119b7e95b0ac381180c502ab4517fb3447fbb7b`).
- Verificación autenticada en producción, de solo lectura: las siete tarjetas muestran las cantidades pendientes indicadas arriba, y cero disponible físico. Diseño final sin desborde a 320, 375 y 1280 px; evidencia en `output/audit/incoming-products-live-verification.log` y capturas `output/playwright/incoming-products-live-*.png`.

## Cambios

- Producto: el precio unitario se conserva al agotarse; el subtotal por varias unidades se identifica por separado. Catálogo y detalle muestran «Agotado» también en celular y con nombre accesible correcto. Se oculta el selector cuando no se puede comprar. Se conserva la compra de unidades en camino cuando estén disponibles para encargar.
- Carrito: el detalle cuenta las unidades ya agregadas, limita las adicionales y explica cuando el carrito contiene todas las disponibles. Reinicia la selección al cambiar de producto.
- Checkout vacío: permanece en su ruta, explica qué falta y ofrece volver a Productos.
- Imágenes: SVG real en `/product-placeholder.svg` y componente compartido que recupera imágenes ausentes o rotas en catálogo, detalle, carrito y administración. Un fallo del propio recurso de reemplazo no genera un ciclo de cargas.
- Pedidos: texto visible «Ver pedido y acciones». La confirmación de cobro/entrega se muestra fuera de la tarjeta. Los pedidos completados y cancelados indican que están en Completados, con acceso para encontrarlos nuevamente. Los avisos se muestran después de la confirmación del servidor.
- IA y dinero: se conservan centavos en datos y cálculos internos. El modelo recibe valores ya formateados y moneda ARS. Los importes citados mediante referencias se renderizan en el servidor; se rechazan las formas monetarias literales comprobadas que antes permitían presentar centavos como pesos. Se elimina la equivalencia de centavos crudos en la validación numérica y se conserva la precisión de centavos. Las hipótesis monetarias se distinguen en párrafos explícitos.
- Consultas simples de precio: lectura autorizada del catálogo y respuesta determinística, sin llamadas a modelos. Se muestran las presentaciones coincidentes y se pide precisión o corregir el nombre cuando corresponda. Las comparaciones y preguntas contextuales conservan la ruta conversacional. El registro de auditoría identifica que no se usó un modelo.
- Esperas de IA: temporizadores activos hasta terminar el cuerpo de la respuesta, cancelación de lecturas incompletas y reserva de tiempo para el proveedor alternativo. El chat conserva pregunta y contexto para reintentar sin duplicarlos; su estado visible refleja la consulta. Un cupo diario agotado no ofrece reintento inmediato.
- Subida de imágenes: mantiene WebP y el UUID automático exigido por Storage. Distingue sesión vencida, acceso denegado, archivo demasiado grande, formato y fallas temporales. Comprueba que la conversión del navegador realmente produjo WebP.
- Cabecera: el menú de escritorio ya funcionaba correctamente. Se corrigió otra superposición real entre el nombre de la tienda y el carrito a 320 px, permitiendo dos líneas en el nombre.

## Archivos estáticos

Se conservó un original de cada imagen en `assets/originals/`, fuera de la carpeta publicada. Los ocho duplicados de productos se sustituyeron por un único recurso compartido para la demo, y se retiraron del despliegue las dos copias del hero sin referencias en la aplicación.

| Recurso | Antes | Después |
| --- | ---: | ---: |
| Logo descargado por la tienda | 852.634 bytes | 180.710 bytes |
| Imagen genérica compartida | 2.172.673 bytes por copia | 68.840 bytes |
| Carpeta pública completa | 25.095.646 bytes | 2.646.155 bytes |

Reducción de la carpeta publicada: **22.449.491 bytes**. Es reducción de archivos del despliegue; no significa que cada visitante descargara antes todos los duplicados. Las imágenes actuales de los productos reales se conservaron.

## Verificación

- `NODE_OPTIONS=--max-old-space-size=768 pnpm test`: **295/295 en 48 archivos**. Tras extender el aviso a cancelaciones, regresión dirigida de Pedidos: **2/2**. Logs en `output/audit/ux-2026-09-09-unit.log` y `ux-2026-09-09-orders-final.log`.
- Primera ejecución completa: una expectativa aún indicaba la versión anterior del prompt. Se actualizó esa expectativa a la nueva versión; la repetición completa aprobó.
- El último control de TypeScript detectó una opción de búsqueda exclusiva de Playwright en una prueba de Testing Library. Se retiró esa opción; el empaquetado final volvió a aprobar.
- `NODE_OPTIONS=--max-old-space-size=768 pnpm worker:deploy:dry`: TypeScript, compilación de producción y empaquetado del Worker aprobados; **no despliega**. Log `output/audit/ux-2026-09-09-build.log`.
- Playwright, un trabajador, Chromium escritorio y móvil: **22/22** en las suites 01, 03, 08 y 09. Cubre catálogo, checkout, cobro/entrega, cancelación, conservación del carrito, cambios de stock y acceso al asistente. WhatsApp interceptado y operaciones en demo local. Log `output/audit/ux-2026-09-09-e2e.log`.
- Navegador sobre la compilación de producción local y lectura del catálogo remoto: ANDRO SUPPORT a $33.000 estando agotado; botón «Agotado» legible y deshabilitado; checkout vacío permanece en `/checkout`; SVG con tipo `image/svg+xml` y decodificación correcta.
- Se simuló una foto que devuelve HTML con estado 200: se reemplaza por el SVG, con una sola solicitud fallida de la foto original. Log `output/audit/ux-2026-09-09-placeholder.log`.
- Cabecera comprobada geométrica y visualmente a 320, 375 y 1280 px: sin superposición con el carrito ni desborde horizontal. Capturas en `output/playwright/ux-2026-09-09-*.png`.
- Las pruebas de IA reproducen el factor cien y los cuerpos de respuesta incompletos usando proveedores controlados. No consumen cuotas ni constituyen una certificación nueva de modelos en producción.
- Pruebas, compilaciones y navegador ejecutados secuencialmente. Servidores y navegadores propios cerrados al terminar.
- Manifest de archivos del build final: `output/audit/ux-2026-09-09-artifact.json`; SHA-256 de `index.html`: `fa36548638234bae4a0524d655dccfc2163f1377c1a7836cbc02a73f8ce4ba50`.

## Pendientes externos

Durante esta ronda no se hicieron escrituras de negocio ni limpieza de operaciones remotas. La carga posterior del stock físico real y la nueva autorización para retirar las pruebas, incluida #2033, se documentan en [la entrega con stock real](ENTREGA_STOCK_REAL_2026-09-09.md). La dueña aclaró posteriormente que son dos compras distintas: ya se cargaron 145 unidades en camino, con 8 reservadas, y se conservaron las 49 físicas. Las reservas previas tienen un recorrido propio de recepción y entrega, sin inventar clientes ni ventas.
