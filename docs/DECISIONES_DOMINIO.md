# Decisiones de dominio v1

Estas reglas cierran las ambigüedades detectadas en la especificación inicial. Cambiarlas exige migración, pruebas de transición y actualización de los contratos visibles.

## Inventario

- `stock_fisico`: unidades presentes en el local.
- `stock_reservado`: unidades de pedidos confirmados que todavía no salieron.
- `stock_disponible = stock_fisico - stock_reservado`.
- `stock_en_camino`: unidades de compras en estado `ordered` todavía no recibidas.
- `stock_proyectado = stock_disponible + stock_en_camino`.
- Confirmar un pedido crea la reserva en una sola transacción.
- Para envíos, el stock físico baja al marcar `enviado`; para retiro, al marcar `entregado`.
- Cancelar antes de la salida libera la reserva. Una devolución posterior es un movimiento separado.
- Una venta normal nunca puede llevar el disponible bajo cero.
- Solo la dueña puede realizar un ajuste explícito, siempre con motivo y registro de auditoría. El ajuste es el único camino que puede representar una corrección histórica negativa.

## Pedido y venta

Los estados son ortogonales:

- pedido: `confirmed | cancelled`;
- pago: `pending | paid | refunded`;
- preparación: `pending | preparing | ready`;
- entrega: `pending | shipped | delivered | cancelled`.

`confirmed` reserva. `paid` reconoce facturación para métricas comerciales. `shipped` o `delivered`, según modalidad, descarga stock. Ninguno de estos eventos se infiere silenciosamente de otro.

## Compra

- compra: `draft | ordered | received | cancelled`;
- `ordered` suma stock en camino;
- `received` incrementa stock físico, crea movimientos y actualiza el costo actual en una sola transacción;
- una compra recibida no puede volver a borrador.

## Datos económicos

- Cada ítem de pedido congela nombre, presentación, precio unitario y costo unitario.
- Cada pedido congela envío, tasa de impuesto e importe calculado.
- La métrica es `margen después de costo de mercadería e impuesto`; nunca se etiqueta como ganancia neta.
- Facturación se reconoce al marcar el pago como `paid`.
- El IPC mensual se carga únicamente desde un dato oficial publicado. Sin índice, la métrica ajustada es `null` y la UI dice “IPC pendiente de publicación”.

## Permisos

- Dueña: acceso completo.
- Personal: operación, catálogo público y precio de venta visible; no puede leer costo, impuesto, margen, facturación, exportación global, IA ni gestión de usuarios.
- El costo vive en una tabla separada de los datos públicos del producto.
- El personal puede editar nombre, presentación, descripción, imágenes y publicación. El precio de venta requiere permiso de dueña en v1.
- La separación se aplica con RLS, privilegios y RPC; ocultar una pantalla no se considera autorización.

## Tienda pública

- Se muestra `Disponible`, `Últimas unidades` o `Sin stock`, no el número exacto.
- El carrito valida cada cantidad contra una consulta de disponibilidad antes de abrir WhatsApp.
- Esa validación no reserva: el mensaje sigue siendo una intención hasta que recepción confirma la importación.

## Alcance diferido

- La hoja histórica `PENDIENTES` no se implementa hasta confirmar su significado y reglas.
- La migración del Excel requiere el archivo original, auditoría de calidad y fecha de corte. No se inventa un importador sin esos datos.
- ARCA, pasarela de pago, WhatsApp Business API, SMS, email transaccional, múltiples sucursales y escritura por IA quedan fuera.

