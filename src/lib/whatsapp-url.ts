const MOBILE_PATTERN = /Android|iPhone|iPad|iPod|Mobile/i;

export const buildWhatsAppUrl = (
  phone: string,
  message: string,
  userAgent = navigator.userAgent
): string => {
  const normalizedPhone = phone.replace(/\D/g, '');
  const base = MOBILE_PATTERN.test(userAgent)
    ? 'https://wa.me/'
    : 'https://web.whatsapp.com/send';
  if (base.endsWith('/')) {
    return `${base}${normalizedPhone}?text=${encodeURIComponent(message)}`;
  }
  return `${base}?phone=${normalizedPhone}&text=${encodeURIComponent(message)}`;
};

