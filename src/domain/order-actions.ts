import type { Order, OrderAction } from './types';

export const isOrderPackingComplete = (order: Order): boolean =>
  order.items.length > 0 && order.items.every(item => item.packedQuantity === item.quantity);

export const availableOrderActions = (order: Order): OrderAction[] => {
  if (order.orderState === 'cancelled') return [];

  const actions: OrderAction[] = [];
  if (order.paymentState === 'paid') actions.push('reverse_payment');
  if (order.fulfillmentState === 'delivered') actions.push('reverse_delivery');
  if (order.fulfillmentState === 'shipped') actions.push('reverse_shipment');
  const hasPackedItems = order.items.some(item => (item.packedQuantity ?? 0) > 0);
  if (order.paymentState === 'refunded') {
    if (order.fulfillmentState === 'pending' && !hasPackedItems) actions.push('cancel');
    return actions;
  }

  const canFulfill = !order.stockReadiness || order.stockReadiness === 'ready';
  // Todo pedido sin seguimiento se revisa antes de prepararlo desde esta interfaz.
  // Los ya marcados listos conservan la posibilidad de entrega hasta conciliarlos.
  const canUsePacking = order.packingTracked === undefined ||
    isOrderPackingComplete(order) ||
    (order.packingTracked === false && order.preparationState === 'ready');
  const canExit = canFulfill && canUsePacking;

  // 1. Paso previo: Preparación (Listo para entregar)
  if (order.fulfillmentState === 'pending' && order.preparationState !== 'ready') {
    if (canExit) {
      actions.push('mark_ready');
    }
  }

  // 2. Acciones de Cobro
  if (order.paymentState === 'pending') {
    actions.push('mark_paid');
    actions.push('mark_at_cost');
    if (order.fulfillmentState !== 'pending' || canExit) actions.push('mark_gifted');
  }

  // 3. Acciones de Entrega
  if (canExit) {
    if (order.fulfillmentState === 'pending') {
      actions.push('mark_delivered');
      if (order.deliveryMethod === 'shipping') {
        actions.push('mark_shipped');
      }
    } else if (order.fulfillmentState === 'shipped') {
      actions.push('mark_delivered');
    }
  }

  // 4. Acciones de excepción / reversión al final
  if (order.paymentState === 'paid' && order.fulfillmentState === 'pending') {
    actions.push('mark_refunded');
  }
  if (order.fulfillmentState === 'pending' && order.paymentState !== 'paid' &&
      !hasPackedItems) {
    actions.push('cancel');
  }

  return actions;
};

export const isOrderReversal = (action: OrderAction): boolean =>
  action === 'reverse_payment' || action === 'reverse_delivery' || action === 'reverse_shipment';

export const orderCancellationBlock = (order: Order): string | null => {
  if (order.orderState === 'cancelled') return null;
  if (order.paymentState === 'paid') return 'Primero deshacé el cobro. Si recibiste dinero, devolvelo al cliente antes de cancelar.';
  if (order.fulfillmentState === 'delivered') return 'Primero deshacé la entrega. La mercadería debe volver al local antes de liberar sus reservas.';
  if (order.fulfillmentState === 'shipped') return 'Primero deshacé el envío cuando la mercadería esté de regreso en el local.';
  if (order.items.some(item => (item.packedQuantity ?? 0) > 0)) return 'Devolvé los productos de la bolsita al estante y guardá el armado en cero para cancelar.';
  return null;
};

export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
  reverse_payment: 'Deshacer cobro',
  reverse_delivery: 'Deshacer entrega',
  reverse_shipment: 'Deshacer envío',
  mark_ready: 'Listo para entregar',
  mark_paid: 'Marcar como cobrado',
  mark_at_cost: 'Cobrar al costo',
  mark_gifted: 'Regalar',
  mark_refunded: 'Marcar reintegro realizado',
  start_preparing: 'Empezar a preparar',
  mark_shipped: 'Marcar como enviado',
  mark_delivered: 'Marcar como entregado',
  cancel: 'Cancelar pedido'
};
