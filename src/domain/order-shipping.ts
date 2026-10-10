import { AppError } from './errors';
import type { Order, StockSource } from './types';

export const MAX_SHIPPING_PESOS = 999_999_999;
export const MAX_SHIPPING_CENTS = MAX_SHIPPING_PESOS * 100;

export const isWholePesoText = (text: string): boolean =>
  text === '' || /^\d+$/.test(text) || /^\d{1,3}(?:\.\d{3})+$/.test(text);

export const validateShippingCents = (amount: number): void => {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_SHIPPING_CENTS || amount % 100 !== 0) {
    throw new AppError('validation', 'Ingresá el envío en pesos enteros, sin signos ni centavos.');
  }
};

export const parsePercentageBasisPoints = (draft: string): number | null => {
  if (!/^\d{1,3}(?:[,.]\d{1,2})?$/.test(draft)) return null;
  const [whole = '', fraction = ''] = draft.replace(',', '.').split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return basisPoints >= 0 && basisPoints <= 10_000 ? basisPoints : null;
};

// Round once, half up to whole pesos, using exact integer arithmetic.
export const percentageShippingCents = (costCents: number, basisPoints: number): number => {
  if (!Number.isSafeInteger(costCents) || costCents < 0 || !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new AppError('validation', 'Revisá el costo del pedido y el porcentaje del envío.');
  }
  const pesos = (BigInt(costCents) * BigInt(basisPoints) + 500_000n) / 1_000_000n;
  const result = Number(pesos * 100n);
  validateShippingCents(result);
  return result;
};

export const shippingFeeNeedsReview = (order: Order): boolean =>
  order.paymentState === 'pending' && (order.shippingFeeNeedsReview === true || (order.shippingFeeMethod === 'percentage' && (order.shippingFeeBasisPoints ?? 0) > 0 &&
  order.costTotalCents !== null && order.shippingFeeCostBaseCents !== order.costTotalCents));

export const orderableQuantity = (product: { onHand: number; reserved: number; incomingAvailable?: number }, source: StockSource): number =>
  Math.max(0, product.incomingAvailable ?? 0) + (source === 'normal' ? Math.max(0, product.onHand - product.reserved) : 0);

export const orderCommercialMargin = (order: Order): number =>
  order.totalCents - (order.costTotalCents ?? 0) - (order.taxAmountCents ?? 0);

export const orderLineRevenue = (order: Order, item: Order['items'][number]): number =>
  order.saleType === 'gift' || order.paymentState === 'gifted' ? 0 : order.saleType === 'cost' || order.isCostSale
    ? item.costTotalCents ?? (item.unitCostCents ?? 0) * item.quantity : item.subtotalCents;
