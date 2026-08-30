import { describe, expect, it } from 'vitest';
import { formatMoney } from './money';
import { buildWhatsAppProtocol, parseWhatsAppProtocol } from './whatsapp';
import type { CartLine, CheckoutData, StoreSettings } from './types';

const settings: StoreSettings = {
  storeName: 'Impulso',
  tagline: 'Tu rutina, bien equipada',
  whatsappPhone: '5491112345678',
  transferAlias: 'IMPULSO.SUPLE',
  transferAccount: 'CVU 0000000000000000000000',
  standardShippingCents: 250_000,
  expressShippingCents: 450_000,
  taxRateBasisPoints: 350,
  currency: 'ARS'
};

const lines: CartLine[] = [
  {
    productId: 'product-1',
    sku: 'CREA300',
    slug: 'creatina',
    name: 'Creatina Monohidratada',
    presentation: '300 g',
    imageUrl: '/demo/creatina.svg',
    unitPriceCents: 2_500_000,
    quantity: 2
  }
];

const checkout: CheckoutData = {
  customerName: 'Juan Pérez',
  paymentMethod: 'transfer',
  deliveryMethod: 'shipping',
  shippingType: 'express',
  address: 'Av. Siempre Viva',
  addressNumber: '742',
  phone: '11 5555 5555'
};

describe('WhatsApp order protocol', () => {
  it('round-trips a generated order without guessing fields', () => {
    const protocol = buildWhatsAppProtocol(checkout, lines, settings);
    const parsed = parseWhatsAppProtocol(protocol.message);

    expect(parsed).toMatchObject({
      customerName: 'Juan Pérez',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'express',
      quotedSubtotalCents: 5_000_000,
      shippingFeeCents: 450_000,
      quotedTotalCents: 5_450_000
    });
    expect(parsed.protocolOrderId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.lines).toEqual([
      expect.objectContaining({ sku: 'CREA300', quantity: 2, unitPriceCents: 2_500_000 })
    ]);
  });

  it('rejects a modified quantity instead of importing uncertain data', () => {
    const protocol = buildWhatsAppProtocol(checkout, lines, settings);
    const modified = protocol.message.replace('2 x $', '3 x $');
    expect(() => parseWhatsAppProtocol(modified)).toThrow('modificado');
  });

  it('gives each generated checkout an idempotency code', () => {
    const first = buildWhatsAppProtocol(checkout, lines, settings);
    const second = buildWhatsAppProtocol(checkout, lines, settings);

    expect(first.orderId).not.toBe(second.orderId);
    expect(parseWhatsAppProtocol(first.message).protocolOrderId).toBe(first.orderId);
  });

  it('keeps pickup independent from payment and shipping', () => {
    const protocol = buildWhatsAppProtocol(
      {
        ...checkout,
        paymentMethod: 'cash',
        deliveryMethod: 'pickup',
        shippingType: null,
        address: null,
        addressNumber: null,
        phone: null
      },
      lines,
      settings
    );
    const parsed = parseWhatsAppProtocol(protocol.message);
    expect(parsed).toMatchObject({
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingFeeCents: 0
    });
  });

  it('handles CRLF line endings from Windows WhatsApp clients seamlessly', () => {
    const protocol = buildWhatsAppProtocol(checkout, lines, settings);
    const crlfMessage = protocol.message.replace(/\n/g, '\r\n');
    const parsed = parseWhatsAppProtocol(crlfMessage);

    expect(parsed.customerName).toBe('Juan Pérez');
    expect(parsed.quotedTotalCents).toBe(5_450_000);
    expect(parsed.lines[0]?.quantity).toBe(2);
  });

  it('handles quantities greater than 9 without truncation or parsing errors', () => {
    const largeLines: CartLine[] = [
      {
        productId: 'product-2',
        sku: 'WHEY1000',
        slug: 'whey-protein',
        name: 'Whey Protein Isolate',
        presentation: '1 kg · Chocolate',
        imageUrl: '/demo/whey.svg',
        unitPriceCents: 3_800_000,
        quantity: 15
      }
    ];
    const protocol = buildWhatsAppProtocol(checkout, largeLines, settings);
    const parsed = parseWhatsAppProtocol(protocol.message);

    expect(parsed.lines[0]?.quantity).toBe(15);
    expect(parsed.quotedSubtotalCents).toBe(57_000_000);
    expect(parsed.quotedTotalCents).toBe(57_450_000);
  });

  it('handles special Unicode characters and accents in customer name and items', () => {
    const unicodeCheckout: CheckoutData = {
      ...checkout,
      customerName: 'María José Agüero (Ñandú) 🏋️‍♂️'
    };
    const protocol = buildWhatsAppProtocol(unicodeCheckout, lines, settings);
    const parsed = parseWhatsAppProtocol(protocol.message);

    expect(parsed.customerName).toBe('María José Agüero (Ñandú) 🏋️‍♂️');
    expect(parsed.lines[0]?.sku).toBe('CREA300');
  });

  it('rejects an altered checksum or tampered prices', () => {
    const protocol = buildWhatsAppProtocol(checkout, lines, settings);
    const tamperedChecksum = protocol.message.replace(
      /\*Código de control\*\n([0-9A-F]{8})/,
      '*Código de control*\nDEADBEEF'
    );
    expect(() => parseWhatsAppProtocol(tamperedChecksum)).toThrow('modificado');

    const tamperedBody = protocol.message.replace(
      formatMoney(protocol.totalCents),
      '$ 10.000'
    );
    expect(() => parseWhatsAppProtocol(tamperedBody)).toThrow('modificado');
  });

  it('re-uses existingOrderId when supplied', () => {
    const existingId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
    const protocol = buildWhatsAppProtocol(checkout, lines, settings, existingId);
    expect(protocol.orderId).toBe(existingId);
    const parsed = parseWhatsAppProtocol(protocol.message);
    expect(parsed.protocolOrderId).toBe(existingId);
  });
});
