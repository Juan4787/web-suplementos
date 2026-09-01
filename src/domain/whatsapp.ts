import { z } from 'zod';
import { formatMoney } from './money';
import type { CartLine, CheckoutData, ImportOrderInput, StoreSettings } from './types';

export const WHATSAPP_PROTOCOL_HEADER = '*PEDIDO IMPULSO*';

const field = (label: string, value: string): string => `*${label}*\n${value}`;

/**
 * Checksum de integridad de texto no criptográfico (FNV-1a 32-bit).
 *
 * Propósito: Detectar mensajes truncados, cortes de pegado o modificaciones accidentales al copiar.
 *
 * IMPORTANTE sobre seguridad económica:
 * FNV-1a NO es una firma criptográfica. La base de datos (PostgreSQL / BusinessApi) es la
 * ÚNICA autoridad económica: al confirmar el pedido, los precios y disponibilidades se validan
 * y recalculan contra el catálogo vigente en la base de datos, ignorando cualquier precio arbitrario.
 */
const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
};

const normalizeProtocolText = (value: string): string => value.replace(/\r\n/g, '\n').trim();

const productLine = (line: CartLine): string =>
  `- [${line.sku}] ${line.name} | ${line.presentation} | ${line.quantity} x ${formatMoney(line.unitPriceCents)} = ${formatMoney(line.unitPriceCents * line.quantity)}`;

const paymentLabel = (method: CheckoutData['paymentMethod']): string =>
  method === 'cash' ? 'Efectivo' : 'Transferencia';

const deliveryLabel = (method: CheckoutData['deliveryMethod']): string =>
  method === 'pickup' ? 'Retiro' : 'Envío a domicilio';

const shippingLabel = (type: CheckoutData['shippingType']): string =>
  type === 'express' ? 'Express' : 'Tradicional';

const buildProtocolBody = (
  checkout: CheckoutData,
  lines: CartLine[],
  shippingFeeCents: number
): string => {
  const subtotalCents = lines.reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0
  );
  const sections = [
    WHATSAPP_PROTOCOL_HEADER,
    field('Nombre', checkout.customerName.trim()),
    `*Productos*\n${lines.map(productLine).join('\n')}`,
    field('Subtotal', formatMoney(subtotalCents)),
    field('Medio de pago', paymentLabel(checkout.paymentMethod)),
    field('Entrega', deliveryLabel(checkout.deliveryMethod))
  ];

  if (checkout.deliveryMethod === 'shipping') {
    sections.push(
      field('Tipo de envío', shippingLabel(checkout.shippingType)),
      field('Envío', formatMoney(shippingFeeCents)),
      field('Dirección', checkout.address?.trim() ?? ''),
      field('Altura', checkout.addressNumber?.trim() || 'Sin altura'),
      field('Teléfono', checkout.phone?.trim() ?? '')
    );
  } else {
    sections.push(field('Envío', formatMoney(0)));
  }

  sections.push(field('Total', formatMoney(subtotalCents + shippingFeeCents)));
  return sections.join('\n\n');
};

export type WhatsAppProtocol = {
  message: string;
  orderId: string;
  checksum: string;
  subtotalCents: number;
  shippingFeeCents: number;
  totalCents: number;
};

export const createOrderFingerprint = (
  checkout: CheckoutData,
  lines: CartLine[],
  shippingFeeCents: number
): string => {
  const lineStr = lines
    .map((l) => `${l.productId}:${l.quantity}:${l.unitPriceCents}`)
    .sort()
    .join('|');
  const deliveryStr =
    checkout.deliveryMethod === 'shipping'
      ? `shipping:${checkout.shippingType ?? ''}:${checkout.address ?? ''}:${checkout.addressNumber ?? ''}:${checkout.phone ?? ''}:${shippingFeeCents}`
      : 'pickup';
  return `${lineStr}__${checkout.customerName.trim()}__${checkout.paymentMethod}__${deliveryStr}`;
};

export const buildWhatsAppProtocol = (
  checkout: CheckoutData,
  lines: CartLine[],
  settings: StoreSettings,
  existingOrderId?: string
): WhatsAppProtocol => {
  if (lines.length === 0) throw new Error('El pedido no tiene productos.');
  const orderId =
    existingOrderId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingOrderId)
      ? existingOrderId.toLowerCase()
      : globalThis.crypto.randomUUID();
  const shippingFeeCents =
    checkout.deliveryMethod === 'shipping'
      ? checkout.shippingType === 'express'
        ? settings.expressShippingCents
        : settings.standardShippingCents
      : 0;
  const subtotalCents = lines.reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0
  );
  const baseBody = buildProtocolBody(checkout, lines, shippingFeeCents);
  const body = normalizeProtocolText(
    baseBody.replace(
      `${WHATSAPP_PROTOCOL_HEADER}\n\n`,
      `${WHATSAPP_PROTOCOL_HEADER}\n\n${field('Código de pedido', orderId)}\n\n`
    )
  );
  const checksum = fnv1a(body);
  return {
    message: `${body}\n\n${field('Código de control', checksum)}`,
    orderId,
    checksum,
    subtotalCents,
    shippingFeeCents,
    totalCents: subtotalCents + shippingFeeCents
  };
};

const productPattern =
  /^- \[([^\]]+)] (.+?) \| (.+?) \| (\d+) x \$\s?([\d.]+(?:,\d{1,2})?) = \$\s?([\d.]+(?:,\d{1,2})?)$/;

const parseArs = (value: string): number => {
  const currencyValue = value.trim().replace(/^\$\s*/u, '').replace(/\s/gu, '');
  if (!/^\d+(?:\.\d{3})*(?:,\d{1,2})?$/u.test(currencyValue)) {
    throw new Error('Importe inválido.');
  }
  const normalized = currencyValue.replaceAll('.', '').replace(',', '.');
  const pesos = Number(normalized);
  if (!Number.isFinite(pesos) || pesos < 0) throw new Error('Importe inválido.');
  return Math.round(pesos * 100);
};

const splitSections = (message: string): Map<string, string> => {
  const chunks = normalizeProtocolText(message).split(/\n\n+/);
  if (chunks[0] !== '*PEDIDO IMPULSO*' && chunks[0] !== '*PEDIDO IMPULSO · V1*') {
    throw new Error('Encabezado inválido.');
  }
  const sections = new Map<string, string>();
  sections.set('Encabezado', chunks[0]);
  for (const chunk of chunks.slice(1)) {
    const match = chunk.match(/^\*([^*]+)\*\n([\s\S]*)$/);
    if (!match?.[1] || match[2] === undefined || sections.has(match[1])) {
      throw new Error('Sección inválida.');
    }
    sections.set(match[1], match[2].trim());
  }
  return sections;
};

const parsedRequired = (sections: Map<string, string>, label: string): string => {
  const value = sections.get(label);
  if (!value) throw new Error(`Falta ${label}.`);
  return value;
};

const parsedPayment = (value: string): CheckoutData['paymentMethod'] => {
  if (value === 'Efectivo') return 'cash';
  if (value === 'Transferencia') return 'transfer';
  throw new Error('Medio de pago inválido.');
};

const parsedDelivery = (value: string): CheckoutData['deliveryMethod'] => {
  if (value === 'Retiro') return 'pickup';
  if (value === 'Envío a domicilio') return 'shipping';
  throw new Error('Entrega inválida.');
};

const parsedShipping = (value: string): CheckoutData['shippingType'] => {
  if (value === 'Tradicional') return 'standard';
  if (value === 'Express') return 'express';
  throw new Error('Tipo de envío inválido.');
};

export type ParsedWhatsAppOrder = Omit<ImportOrderInput, 'lines'> & {
  lines: Array<{
    sku: string;
    name: string;
    presentation: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }>;
};

export const parseWhatsAppProtocol = (message: string): ParsedWhatsAppOrder => {
  const normalized = normalizeProtocolText(message);
  const checksumMarker = '\n\n*Código de control*\n';
  const checksumIndex = normalized.lastIndexOf(checksumMarker);
  if (checksumIndex < 0) throw new Error('Falta el código de control.');
  const body = normalized.slice(0, checksumIndex);
  const suppliedChecksum = normalized.slice(checksumIndex + checksumMarker.length).trim();
  if (!/^[0-9A-F]{8}$/.test(suppliedChecksum) || fnv1a(body) !== suppliedChecksum) {
    throw new Error('El mensaje fue modificado o está incompleto.');
  }

  const sections = splitSections(normalized);
  const protocolOrderId = parsedRequired(sections, 'Código de pedido');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(protocolOrderId)) {
    throw new Error('Código de pedido inválido.');
  }
  const productRows = parsedRequired(sections, 'Productos').split('\n');
  const lines = productRows.map((row) => {
    const match = row.match(productPattern);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6]) {
      throw new Error('Producto inválido.');
    }
    const quantity = Number(match[4]);
    const unitPriceCents = parseArs(match[5]);
    const lineTotalCents = parseArs(match[6]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || unitPriceCents * quantity !== lineTotalCents) {
      throw new Error('Cantidad o total de producto inválido.');
    }
    return {
      sku: match[1],
      name: match[2],
      presentation: match[3],
      quantity,
      unitPriceCents,
      lineTotalCents
    };
  });
  if (lines.length === 0) throw new Error('El pedido no tiene productos.');

  const deliveryMethod = parsedDelivery(parsedRequired(sections, 'Entrega'));
  const subtotalCents = parseArs(parsedRequired(sections, 'Subtotal'));
  const shippingFeeCents = parseArs(parsedRequired(sections, 'Envío'));
  const totalCents = parseArs(parsedRequired(sections, 'Total'));
  const calculatedSubtotal = lines.reduce((total, line) => total + line.lineTotalCents, 0);
  if (subtotalCents !== calculatedSubtotal || totalCents !== subtotalCents + shippingFeeCents) {
    throw new Error('Los totales del pedido no coinciden.');
  }

  const shippingType =
    deliveryMethod === 'shipping'
      ? parsedShipping(parsedRequired(sections, 'Tipo de envío'))
      : null;
  if (deliveryMethod === 'pickup' && shippingFeeCents !== 0) {
    throw new Error('Un retiro no puede tener costo de envío.');
  }

  return {
    customerName: parsedRequired(sections, 'Nombre'),
    paymentMethod: parsedPayment(parsedRequired(sections, 'Medio de pago')),
    deliveryMethod,
    shippingType,
    address: deliveryMethod === 'shipping' ? parsedRequired(sections, 'Dirección') : null,
    addressNumber:
      deliveryMethod === 'shipping'
        ? parsedRequired(sections, 'Altura').replace(/^Sin altura$/, '') || null
        : null,
    phone: deliveryMethod === 'shipping' ? parsedRequired(sections, 'Teléfono') : null,
    lines,
    shippingFeeCents,
    quotedSubtotalCents: subtotalCents,
    quotedTotalCents: totalCents,
    protocolOrderId: protocolOrderId.toLowerCase(),
    protocolChecksum: suppliedChecksum
  };
};

export const whatsappCheckoutSchema = z
  .object({
    customerName: z.string().trim().min(2, 'Ingresá el nombre de quien hace el pedido.').max(100),
    paymentMethod: z.enum(['cash', 'transfer']),
    deliveryMethod: z.enum(['pickup', 'shipping']),
    shippingType: z.enum(['standard', 'express']).nullable(),
    address: z.string().trim().max(160).nullable(),
    addressNumber: z.string().trim().max(20).nullable(),
    phone: z.string().trim().max(40).nullable()
  })
  .superRefine((data, context) => {
    if (data.deliveryMethod !== 'shipping') return;
    if (!data.shippingType) {
      context.addIssue({ code: 'custom', path: ['shippingType'], message: 'Elegí un tipo de envío.' });
    }
    if (!data.address || data.address.length < 3) {
      context.addIssue({ code: 'custom', path: ['address'], message: 'Ingresá la dirección de entrega.' });
    }
    if (!data.phone || data.phone.replace(/\D/g, '').length < 8) {
      context.addIssue({ code: 'custom', path: ['phone'], message: 'Ingresá un teléfono válido.' });
    }
  });
