import { describe, expect, it, vi } from 'vitest';
import { demoProducts, demoSettings } from '@/data/demo-data';
import { parseShippingAddress, prepareCheckoutSubmission, revalidateCartWithCatalog } from './checkout';
import type { CartLine } from './types';

const product = demoProducts[0]!;
const line: CartLine = { productId: product.id, sku: product.sku, slug: product.slug, name: product.name, presentation: product.presentation, imageUrl: product.imageUrl, quantity: 1, unitPriceCents: product.priceCents };
describe('catálogo vigente durante el checkout', () => {
  it('un catálogo vacío marca como no disponibles todos los productos del carrito', () => {
    expect(revalidateCartWithCatalog([line], []).unavailableProducts).toEqual([line.name]);
  });
  it('no genera WhatsApp con un producto retirado aunque la última comprobación de stock fuera válida', async () => {
    const validateAvailability = vi.fn(async () => ({ ok: true, issues: [] }));
    await expect(prepareCheckoutSubmission({ values: { customerName: 'Cliente de prueba', deliveryMethod: 'pickup', paymentMethod: 'cash', shippingType: null, address: null, addressNumber: null, phone: null }, lines: [line], catalogProducts: [], settings: demoSettings, validateAvailability })).rejects.toThrow('ya no está disponible');
    expect(validateAvailability).not.toHaveBeenCalled();
  });
});

describe('parseShippingAddress', () => {
  it('separa limpiamente dirección y email cuando el número quedó pegado tras el correo', () => {
    const parsed = parseShippingAddress('Av rocatomba · Seguimiento: marcosprueba@gmail.com 8564');
    expect(parsed.streetAddress).toBe('Av rocatomba 8564');
    expect(parsed.trackingEmail).toBe('marcosprueba@gmail.com');
  });

  it('separa dirección y email en formato estándar', () => {
    const parsed = parseShippingAddress('Av. Corrientes 1234 · Seguimiento: cliente@correo.com');
    expect(parsed.streetAddress).toBe('Av. Corrientes 1234');
    expect(parsed.trackingEmail).toBe('cliente@correo.com');
  });

  it('devuelve dirección intacta si no hay email de seguimiento', () => {
    const parsed = parseShippingAddress('San Martín 450, Piso 2 B');
    expect(parsed.streetAddress).toBe('San Martín 450, Piso 2 B');
    expect(parsed.trackingEmail).toBeNull();
  });

  it('maneja valores nulos o vacíos', () => {
    expect(parseShippingAddress(null)).toEqual({ rawAddress: null, streetAddress: null, trackingEmail: null });
    expect(parseShippingAddress('')).toEqual({ rawAddress: null, streetAddress: null, trackingEmail: null });
  });
});
