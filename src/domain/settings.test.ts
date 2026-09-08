import { describe, expect, it } from 'vitest';
import { demoSettings } from '@/data/demo-data';
import { validateStoreSettings } from './settings';
describe('validación de configuración comercial', () => {
  it('explica exactamente los campos que impiden guardar', () => {
    expect(() => validateStoreSettings({ ...demoSettings, storeName: '', whatsappPhone: '12', transferAlias: '', transferAccount: 'Titular', taxRateBasisPoints: 10001 })).toThrow(/Nombre comercial:.*WhatsApp:.*Transferencia:.*CBU.*Tasa impositiva:/);
  });
  it('permite envío gratuito e impuesto cero de forma explícita', () => {
    expect(() => validateStoreSettings({ ...demoSettings, whatsappPhone: '5491123456789', transferAlias: 'cuenta.real', transferAccount: '0000003100010000000000', standardShippingCents: 0, expressShippingCents: 0, taxRateBasisPoints: 0 })).not.toThrow();
  });
});
