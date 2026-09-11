import type { Order, OrderAction } from './types';

export const availableOrderActions = (order: Order): OrderAction[] => {
  if (order.orderState === 'cancelled') return [];

  const actions: OrderAction[] = [];
  if (order.paymentState === 'refunded') {
    if (order.fulfillmentState === 'pending') actions.push('cancel');
    return actions;
  }

  // 1. Acciones principales operativas: Cobro y Entrega directos
  if (order.paymentState === 'pending') {
    actions.push('mark_paid');
    actions.push('mark_at_cost');
    actions.push('mark_gifted');
  }

  const canFulfill = !order.stockReadiness || order.stockReadiness === 'ready';
  if (canFulfill) {
    if (order.fulfillmentState === 'pending') {
      actions.push('mark_delivered');
      if (order.deliveryMethod === 'shipping') {
        actions.push('mark_shipped');
      }
    } else if (order.fulfillmentState === 'shipped') {
      actions.push('mark_delivered');
    }
  }

  // 2. Acciones de excepción / reversión al final
  if (order.paymentState === 'paid' && order.fulfillmentState === 'pending') {
    actions.push('mark_refunded');
  }
  if (order.fulfillmentState === 'pending' && order.paymentState !== 'paid') {
    actions.push('cancel');
  }

  return actions;
};

export const ORDER_ACTION_LABELS: Record<OrderAction, string> = {
  mark_paid: 'Marcar como cobrado',
  mark_at_cost: 'Cobrar al costo',
  mark_gifted: 'Regalar',
  mark_refunded: 'Marcar reintegro realizado',
  start_preparing: 'Empezar a preparar',
  mark_ready: 'Marcar como listo',
  mark_shipped: 'Marcar como enviado',
  mark_delivered: 'Marcar como entregado',
  cancel: 'Cancelar pedido'
};
