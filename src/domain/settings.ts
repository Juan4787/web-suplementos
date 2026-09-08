import { AppError } from './errors';
import type { StoreSettings } from './types';

export function validateStoreSettings(settings: StoreSettings): void {
  const issues: string[] = [];
  if (settings.storeName.trim().length < 2 || settings.storeName.trim().length > 100) issues.push('Nombre comercial: escribí entre 2 y 100 caracteres.');
  if (!/^\d{10,15}$/.test(settings.whatsappPhone)) issues.push('WhatsApp: ingresá el número completo, con código de país y área (entre 10 y 15 dígitos).');
  if (!settings.transferAlias.trim()) issues.push('Transferencia: completá el alias de la cuenta.');
  if (!/^\d{22}$/.test(settings.transferAccount)) issues.push('CBU / CVU: ingresá los 22 dígitos de la cuenta, sin el nombre del titular.');
  if (!Number.isSafeInteger(settings.standardShippingCents) || settings.standardShippingCents < 0) issues.push('Envío estándar: ingresá un importe positivo o cero si es gratis.');
  if (!Number.isSafeInteger(settings.expressShippingCents) || settings.expressShippingCents < 0) issues.push('Envío express: ingresá un importe positivo o cero si es gratis.');
  if (settings.taxRateBasisPoints === null || !Number.isInteger(settings.taxRateBasisPoints) || settings.taxRateBasisPoints < 0 || settings.taxRateBasisPoints > 10000) issues.push('Tasa impositiva: ingresá un porcentaje entre 0 y 100.');
  if (issues.length) throw new AppError('validation', issues.join(' '), { nextAction: 'Corregí estos campos y volvé a guardar.' });
}
