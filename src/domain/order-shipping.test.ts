import { describe, expect, it } from 'vitest';
import { isWholePesoText, MAX_SHIPPING_CENTS, orderableQuantity, parsePercentageBasisPoints, percentageShippingCents, validateShippingCents } from './order-shipping';

describe('envíos y origen de reservas', () => {
  it.each(['', '0', '15000', '15.000', '1.250.000'])('acepta pesos enteros: %s', draft => expect(isWholePesoText(draft)).toBe(true));
  it.each(['-15.000', '+15000', '15.000,50', '15,50', '1e3', 'abc', '15.50', '1..000', '1 000', '∞'])('rechaza sin reinterpretar: %s', draft => expect(isWholePesoText(draft)).toBe(false));
  it.each([-100, 1, 150, NaN, Infinity, MAX_SHIPPING_CENTS + 100])('rechaza importe inválido %s', value => expect(() => validateShippingCents(value)).toThrow());
  it.each([0, 100, 1_250_000, MAX_SHIPPING_CENTS])('acepta importe %s', value => expect(() => validateShippingCents(value)).not.toThrow());
  it.each([['5', 500], ['5,25', 525], ['5.25', 525], ['0', 0], ['100', 10000]])('interpreta porcentaje %s', (draft, expected) => expect(parsePercentageBasisPoints(String(draft))).toBe(expected));
  it.each(['', '-5', '5%', '101', '1e2', 'abc', '5,123', '.5', '5,'])('rechaza porcentaje incompleto o inválido %s', draft => expect(parsePercentageBasisPoints(draft)).toBeNull());
  it('calcula 5% del costo real en pesos enteros', () => expect(percentageShippingCents(1_070_000, 500)).toBe(53_500));
  it('redondea una sola vez y hacia arriba en la mitad de un peso', () => {
    expect(percentageShippingCents(1000, 500)).toBe(100);
    expect(percentageShippingCents(999, 500)).toBe(0);
    expect(percentageShippingCents(1001, 500)).toBe(100);
    expect(percentageShippingCents(1_000_001, 0)).toBe(0);
  });
  it('mantiene precisión cerca del límite permitido', () => expect(percentageShippingCents(99_999_999_999, 500)).toBe(5_000_000_000));
  it('la modalidad en camino no usa físico ni promete unidades ya reservadas', () => {
    const product = {onHand: 20, reserved: 7, incomingAvailable: 3};
    expect(orderableQuantity(product, 'incoming_only')).toBe(3);
    expect(orderableQuantity(product, 'normal')).toBe(16);
    expect(orderableQuantity({...product,incomingAvailable: 0}, 'incoming_only')).toBe(0);
  });
});
