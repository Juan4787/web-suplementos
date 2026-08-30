import type { ExportDataset } from '@/domain/types';

export const BUSINESS_EXPORT_VERSION = 'impulso-business-backup/v1' as const;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type WorkbookCell = { kind: 'text'; value: string } | { kind: 'number'; value: number } | null;
export type WorkbookSheet = { name: string; headers: string[]; widths: number[]; rows: WorkbookCell[][] };
export type BusinessWorkbook = { version: typeof BUSINESS_EXPORT_VERSION; filename: string; mimeType: typeof XLSX_MIME; sheets: WorkbookSheet[] };

export class WorkbookBuildError extends Error {
  constructor(message = 'No pudimos construir un respaldo completo.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkbookBuildError';
  }
}

const invalidOoxmlControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
const text = (value: unknown): WorkbookCell => {
  if (value === null || value === undefined) return null;
  const result = String(value);
  if (invalidOoxmlControl.test(result)) throw new WorkbookBuildError('Uno de los textos contiene caracteres que Excel no admite.');
  return { kind: 'text', value: result };
};
const number = (value: unknown): WorkbookCell => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WorkbookBuildError();
  return { kind: 'number', value };
};
const pesos = (cents: number | null): WorkbookCell => cents === null ? null : number(cents / 100);
const yesNo = (value: boolean): WorkbookCell => text(value ? 'Sí' : 'No');

const sheet = (name: string, headers: string[], widths: number[], rows: WorkbookCell[][]): WorkbookSheet => {
  if (headers.length !== widths.length || rows.some((row) => row.length !== headers.length)) throw new WorkbookBuildError();
  return { name, headers, widths, rows };
};

const filenameFor = (generatedAt: string): string => {
  const date = new Date(generatedAt);
  if (!Number.isFinite(date.getTime())) throw new WorkbookBuildError();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `respaldo-impulso-${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}.xlsx`;
};

export const buildBusinessWorkbook = (data: ExportDataset): BusinessWorkbook => {
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.products)) throw new WorkbookBuildError();
  const sheets: WorkbookSheet[] = [
    sheet('Resumen', ['Dato', 'Detalle'], [28, 75], [
      [text('Versión del contrato'), text(BUSINESS_EXPORT_VERSION)],
      [text('Revisión consistente'), number(data.revision)],
      [text('Tienda'), text(data.settings.storeName)],
      [text('Slogan'), text(data.settings.tagline)],
      [text('WhatsApp'), text(data.settings.whatsappPhone)],
      [text('Alias de transferencia'), text(data.settings.transferAlias)],
      [text('Cuenta de transferencia'), text(data.settings.transferAccount)],
      [text('Envío tradicional ARS'), pesos(data.settings.standardShippingCents)],
      [text('Envío express ARS'), pesos(data.settings.expressShippingCents)],
      [text('Tasa de impuesto bp'), number(data.settings.taxRateBasisPoints)],
      [text('Moneda'), text(data.settings.currency)],
      [text('Generado'), text(data.generatedAt)],
      [text('Zona horaria'), text('America/Argentina/Buenos_Aires')],
      [text('Productos'), number(data.products.length)],
      [text('Pedidos'), number(data.orders.length)],
      [text('Compras'), number(data.purchases.length)],
      [text('Movimientos'), number(data.movements.length)],
      [text('Reservas'), number(data.reservations.length)],
      [text('Clientes'), number(data.customers.length)],
      [text('Usuarios'), number(data.users.length)],
      [text('Alcance'), text('Datos comerciales tabulares y permisos. No incluye contraseñas, imágenes binarias, código, esquema SQL, secretos ni configuración del proveedor.')]
    ]),
    sheet('Productos', ['ID', 'SKU', 'Nombre', 'Presentación', 'Descripción', 'Categoría', 'Precio venta ARS', 'Costo actual ARS', 'Activo', 'Publicado', 'Destacado', 'Punto pedido', 'Stock seguridad', 'Lead time días', 'URL imagen', 'Creado', 'Actualizado'], [38, 16, 28, 24, 55, 18, 18, 18, 12, 12, 12, 15, 16, 15, 45, 25, 25], data.products.map((product) => [
      text(product.id), text(product.sku), text(product.name), text(product.presentation), text(product.description), text(product.category), pesos(product.priceCents), pesos(product.currentCostCents), yesNo(product.active), yesNo(product.published), yesNo(product.featured), number(product.reorderPoint), number(product.safetyStock), number(product.leadTimeDays), text(product.imageUrl), text(product.createdAt), text(product.updatedAt)
    ])),
    sheet('Stock', ['Producto ID', 'SKU', 'Producto', 'Físico', 'Reservado', 'Disponible', 'En camino', 'Proyectado', 'Venta media diaria', 'Cobertura días', 'Compra sugerida', 'Estado'], [38, 16, 28, 12, 12, 12, 12, 12, 18, 15, 16, 14], data.inventory.map((item) => [
      text(item.id), text(item.sku), text(item.name), number(item.onHand), number(item.reserved), number(item.available), number(item.incoming), number(item.projected), number(item.averageDailySales), number(item.coverageDays), number(item.suggestedPurchase), text(item.status)
    ])),
    sheet('Pedidos', ['ID', 'Número', 'Origen', 'Código protocolo', 'Checksum protocolo', 'Cliente ID', 'Cliente', 'Teléfono', 'Pedido estado', 'Pago estado', 'Preparación estado', 'Entrega estado', 'Medio pago', 'Modalidad entrega', 'Tipo envío', 'Dirección', 'Subtotal ARS', 'Envío ARS', 'Total ARS', 'Tasa impuesto bp', 'Impuesto ARS', 'Costo ARS', 'Creado', 'Confirmado', 'Pagado', 'Reembolsado', 'Enviado', 'Finalizado', 'Cancelado'], [38, 12, 20, 38, 20, 38, 28, 20, 18, 18, 20, 18, 18, 20, 16, 40, 16, 16, 16, 16, 16, 16, 25, 25, 25, 25, 25, 25, 25], data.orders.map((order) => [
      text(order.id), number(order.number), text(order.source), text(order.protocolOrderId), text(order.protocolChecksum), text(order.customerId), text(order.customerName), text(order.customerPhone), text(order.orderState), text(order.paymentState), text(order.preparationState), text(order.fulfillmentState), text(order.paymentMethod), text(order.deliveryMethod), text(order.shippingType), text(order.shippingAddress), pesos(order.subtotalCents), pesos(order.shippingFeeCents), pesos(order.totalCents), number(order.taxRateBasisPoints), pesos(order.taxAmountCents), pesos(order.costTotalCents), text(order.createdAt), text(order.confirmedAt), text(order.paidAt), text(order.refundedAt), text(order.shippedAt), text(order.fulfilledAt), text(order.cancelledAt)
    ])),
    sheet('Detalle pedidos', ['Ítem ID', 'Pedido ID', 'Pedido número', 'Producto ID', 'SKU', 'Producto snapshot', 'Presentación snapshot', 'Cantidad', 'Precio unitario ARS', 'Costo unitario ARS', 'Subtotal ARS'], [38, 38, 14, 38, 16, 28, 24, 12, 20, 20, 18], data.orders.flatMap((order) => order.items.map((item) => [
      text(item.id), text(order.id), number(order.number), text(item.productId), text(item.sku), text(item.productName), text(item.presentation), number(item.quantity), pesos(item.unitPriceCents), pesos(item.unitCostCents), pesos(item.subtotalCents)
    ]))),
    sheet('Ventas', ['Pedido ID', 'Pedido número', 'Cliente', 'Fecha cobro', 'Unidades', 'Facturación ARS', 'Costo ARS', 'Impuesto ARS', 'Margen estimado ARS'], [38, 14, 28, 25, 12, 18, 18, 18, 22], data.orders.filter((order) => order.paymentState === 'paid').map((order) => [
      text(order.id), number(order.number), text(order.customerName), text(order.paidAt), number(order.items.reduce((sum, item) => sum + item.quantity, 0)), pesos(order.totalCents), pesos(order.costTotalCents), pesos(order.taxAmountCents), pesos(order.totalCents - (order.costTotalCents ?? 0) - (order.taxAmountCents ?? 0))
    ])),
    sheet('Compras', ['ID', 'Número', 'Proveedor', 'Estado', 'Pedido', 'Esperado', 'Recibido', 'Total costo ARS', 'Notas', 'Creado'], [38, 12, 28, 16, 25, 25, 25, 18, 50, 25], data.purchases.map((purchase) => [
      text(purchase.id), number(purchase.number), text(purchase.supplierName), text(purchase.state), text(purchase.orderedAt), text(purchase.expectedAt), text(purchase.receivedAt), pesos(purchase.totalCostCents), text(purchase.notes), text(purchase.createdAt)
    ])),
    sheet('Detalle compras', ['Ítem ID', 'Compra ID', 'Compra número', 'Producto ID', 'Producto', 'Cantidad', 'Costo unitario ARS'], [38, 38, 14, 38, 28, 12, 20], data.purchases.flatMap((purchase) => purchase.items.map((item) => [
      text(item.id), text(purchase.id), number(purchase.number), text(item.productId), text(item.productName), number(item.quantity), pesos(item.unitCostCents)
    ]))),
    sheet('Movimientos', ['ID', 'Producto ID', 'Producto', 'Tipo', 'Variación física', 'Variación reservada', 'Motivo', 'Pedido ID', 'Compra ID', 'Fecha', 'Realizado por'], [38, 38, 28, 22, 16, 18, 45, 38, 38, 25, 22], data.movements.map((movement) => [
      text(movement.id), text(movement.productId), text(movement.productName), text(movement.kind), number(movement.physicalDelta), number(movement.reservedDelta), text(movement.reason), text(movement.orderId), text(movement.purchaseId), text(movement.createdAt), text(movement.createdByName)
    ])),
    sheet('Reservas', ['ID', 'Pedido ID', 'Producto ID', 'Cantidad', 'Estado', 'Creada', 'Resuelta'], [38, 38, 38, 12, 16, 25, 25], data.reservations.map((reservation) => [
      text(reservation.id), text(reservation.orderId), text(reservation.productId), number(reservation.quantity), text(reservation.state), text(reservation.createdAt), text(reservation.resolvedAt)
    ])),
    sheet('Clientes', ['ID', 'Nombre', 'Teléfono', 'Primera compra', 'Última compra', 'Cantidad pedidos', 'Total pagado ARS', 'Creado'], [38, 30, 22, 25, 25, 16, 20, 25], data.customers.map((customer) => [
      text(customer.id), text(customer.name), text(customer.phone), text(customer.firstOrderAt), text(customer.lastOrderAt), number(customer.orderCount), pesos(customer.totalPaidCents), text(customer.createdAt)
    ])),
    sheet('IPC', ['Período', 'Índice oficial', 'Fuente', 'Publicado'], [16, 18, 55, 25], data.inflation.map((index) => [
      text(index.period), number(index.indexValue), text(index.sourceUrl), text(index.publishedAt)
    ])),
    sheet('Usuarios', ['ID', 'Nombre', 'Correo', 'Rol', 'Activo', 'Creado', 'Actualizado'], [38, 28, 36, 16, 12, 25, 25], data.users.map((user) => [
      text(user.id), text(user.displayName), text(user.email), text(user.role), yesNo(user.active), text(user.createdAt), text(user.updatedAt)
    ]))
  ];
  return { version: BUSINESS_EXPORT_VERSION, filename: filenameFor(data.generatedAt), mimeType: XLSX_MIME, sheets };
};
