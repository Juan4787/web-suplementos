import { describe, expect, it } from 'vitest';
import { buildWhatsAppUrl } from './whatsapp-url';

describe('buildWhatsAppUrl', () => {
  it('uses wa.me on mobile', () => {
    expect(buildWhatsAppUrl('+54 9 11 1234-5678', 'Hola', 'Mozilla Android Mobile')).toBe(
      'https://wa.me/5491112345678?text=Hola'
    );
  });

  it('opens WhatsApp Web directly on desktop', () => {
    expect(buildWhatsAppUrl('5491112345678', 'Hola mundo', 'Mozilla Desktop')).toBe(
      'https://web.whatsapp.com/send?phone=5491112345678&text=Hola%20mundo'
    );
  });
});

