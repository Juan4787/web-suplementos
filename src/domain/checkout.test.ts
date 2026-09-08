import { describe, expect, it, vi } from 'vitest';
import { demoProducts, demoSettings } from '@/data/demo-data';
import { prepareCheckoutSubmission, revalidateCartWithCatalog } from './checkout';
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
