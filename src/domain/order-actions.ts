import type { Order, OrderAction } from './types';

export const isOrderPackingComplete = (order: Order): boolean =>
  order.items.length > 0 && order.items.every(item => item.packedQuantity === item.quantity);

export const availableOrderActions = (order: Order): OrderAction[] => {
  if (order.orderState === 'cancelled') return [];

  const actions: OrderAction[] = [];
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

export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
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
