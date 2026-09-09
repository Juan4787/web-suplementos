# Correcciones de uso diario — 09/09/2026

Estado: implementadas y verificadas localmente. Esta ronda no publica en GitHub ni Cloudflare y no modifica datos, cuentas, stock ni políticas de Supabase. Complementa la auditoría del 08/09; no reemplaza sus límites ni certifica disponibilidad de proveedores externos.

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

Publicar esta versión cuando corresponda. El stock real sigue pendiente de las cantidades del negocio. No se hicieron nuevas escrituras ni limpieza de operaciones remotas durante esta ronda.
