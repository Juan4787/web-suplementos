import { describe, expect, it } from 'vitest';
import { availableOrderActions, ORDER_ACTION_LABELS } from './order-actions';
import type { Order } from './types';

const baseOrder: Order = {
  id: '00000000-0000-4000-8000-000000000001',
  number: 101,
  customerId: null,
  customerName: 'Cliente Prueba',
  customerPhone: '1155555555',
  paymentMethod: 'cash',
  deliveryMethod: 'pickup',
  shippingType: null,
  shippingAddress: null,
  orderState: 'confirmed',
  paymentState: 'pending',
  preparationState: 'pending',
  fulfillmentState: 'pending',
  subtotalCents: 5000000,
  shippingFeeCents: 0,
  totalCents: 5000000,
  taxRateBasisPoints: 350,
  taxAmountCents: 175000,
  costTotalCents: 3000000,
  createdAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  paidAt: null,
  fulfilledAt: null,
  items: []
};

describe('order actions state machine', () => {
  it('returns no actions when order is cancelled', () => {
    const order: Order = { ...baseOrder, orderState: 'cancelled' };
    expect(availableOrderActions(order)).toEqual([]);
  });

  it('allows mark_paid, start_preparing, and cancel for a new pending pickup order', () => {
    const order: Order = { ...baseOrder };
    const actions = availableOrderActions(order);
    expect(actions).toContain('mark_paid');
    expect(actions).toContain('start_preparing');
    expect(actions).toContain('cancel');
    expect(actions).not.toContain('mark_delivered');
  });

  it('allows mark_ready when order is preparing', () => {
    const order: Order = { ...baseOrder, preparationState: 'preparing' };
    const actions = availableOrderActions(order);
    expect(actions).toContain('mark_ready');
    expect(actions).not.toContain('start_preparing');
  });

  it('allows mark_delivered when pickup order is ready, paid, and fulfillment pending', () => {
    const order: Order = {
      ...baseOrder,
      deliveryMethod: 'pickup',
      paymentState: 'paid',
      preparationState: 'ready',
      fulfillmentState: 'pending'
    };
    const actions = availableOrderActions(order);
    expect(actions).toContain('mark_delivered');
    expect(actions).toContain('mark_refunded');
    expect(actions).not.toContain('mark_shipped');
    expect(actions).not.toContain('cancel');
  });

  it('allows mark_shipped when shipping order is ready, paid, and fulfillment pending', () => {
    const order: Order = {
      ...baseOrder,
      deliveryMethod: 'shipping',
      shippingType: 'express',
      shippingAddress: 'Av. Corrientes 1234',
      paymentState: 'paid',
      preparationState: 'ready',
      fulfillmentState: 'pending'
    };
    const actions = availableOrderActions(order);
    expect(actions).toContain('mark_shipped');
    expect(actions).toContain('mark_refunded');
    expect(actions).not.toContain('mark_delivered');
  });

  it('allows mark_delivered when shipping order has been shipped', () => {
    const order: Order = {
      ...baseOrder,
      deliveryMethod: 'shipping',
      shippingType: 'express',
      shippingAddress: 'Av. Corrientes 1234',
      paymentState: 'paid',
      preparationState: 'ready',
      fulfillmentState: 'shipped'
    };
    const actions = availableOrderActions(order);
    expect(actions).toContain('mark_delivered');
    expect(actions).not.toContain('mark_shipped');
  });

  it('allows cancel if order payment was refunded while fulfillment was pending', () => {
    const order: Order = {
      ...baseOrder,
      paymentState: 'refunded',
      fulfillmentState: 'pending'
    };
    const actions = availableOrderActions(order);
    expect(actions).toEqual(['cancel']);
  });

  it('has human-friendly Spanish labels for all actions', () => {
    expect(ORDER_ACTION_LABELS.mark_paid).toBe('Marcar como cobrado');
    expect(ORDER_ACTION_LABELS.mark_refunded).toBe('Marcar reintegro realizado');
    expect(ORDER_ACTION_LABELS.start_preparing).toBe('Empezar a preparar');
    expect(ORDER_ACTION_LABELS.mark_ready).toBe('Marcar como listo');
    expect(ORDER_ACTION_LABELS.mark_shipped).toBe('Marcar como enviado');
    expect(ORDER_ACTION_LABELS.mark_delivered).toBe('Marcar como entregado');
    expect(ORDER_ACTION_LABELS.cancel).toBe('Cancelar pedido');
  });
});
