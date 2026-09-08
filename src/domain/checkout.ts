import { AppError } from './errors';
import { formatMoney } from './money';
import { createOrderFingerprint, buildWhatsAppProtocol, type WhatsAppProtocol } from './whatsapp';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';
import type {
  AvailabilityCheck,
  CartLine,
  CheckoutData,
  StoreSettings,
  StorefrontProduct
} from './types';

export type ProtocolDraft = {
  orderId: string;
  fingerprint: string;
};

export type CartRevalidationResult = {
  updatedLines: CartLine[];
  priceChanges: Array<{ name: string; oldPriceCents: number; newPriceCents: number }>;
  outOfStockProducts: string[];
  unavailableProducts: string[];
  partialStockProducts: Array<{ name: string; available: number; requested: number }>;
};

/**
 * Sanitiza los valores del formulario de Checkout.
 * Si el método de entrega es retiro en persona, limpia rigurosamente
 * los campos de envío a domicilio (tipo de envío, dirección, altura y teléfono).
 */
export const sanitizeCheckoutValues = (values: CheckoutData): CheckoutData => ({
  ...values,
  customerName: values.customerName.trim(),
  shippingType: values.deliveryMethod === 'shipping' ? values.shippingType : null,
  address: values.deliveryMethod === 'shipping' ? (values.address?.trim() ?? null) : null,
  addressNumber: values.deliveryMethod === 'shipping' ? (values.addressNumber?.trim() || null) : null,
  phone: values.deliveryMethod === 'shipping' ? (values.phone?.trim() ?? null) : null
});

/**
 * Calcula la tarifa de envío vigente según el método y tipo seleccionado.
 */
export const calculateShippingFee = (
  deliveryMethod: CheckoutData['deliveryMethod'],
  shippingType: CheckoutData['shippingType'],
  settings: Pick<StoreSettings, 'standardShippingCents' | 'expressShippingCents'>
): number => {
  if (deliveryMethod !== 'shipping') return 0;
  return shippingType === 'express'
    ? settings.expressShippingCents
    : settings.standardShippingCents;
};

/**
 * Revalida una lista de líneas del carrito contra el catálogo vivo de storefront.
 * Retorna las líneas actualizadas con el precio vigente y la lista de discrepancias encontradas.
 */
export const revalidateCartWithCatalog = (
  currentLines: CartLine[],
  catalogProducts: StorefrontProduct[]
): CartRevalidationResult => {
  const result: CartRevalidationResult = {
    updatedLines: currentLines,
    priceChanges: [],
    outOfStockProducts: [],
    unavailableProducts: [],
    partialStockProducts: []
  };

  if (currentLines.length === 0) return result;

  let hasLinePriceChange = false;
  const updated = currentLines.map((line) => {
    const current = catalogProducts.find((p) => p.id === line.productId);
    if (!current) {
      result.unavailableProducts.push(line.name);
      return line;
    }

    if (current.availability === 'out_of_stock' || current.maxOrderQuantity <= 0) {
      result.outOfStockProducts.push(line.name);
    } else if (line.quantity > current.maxOrderQuantity) {
      result.partialStockProducts.push({
        name: line.name,
        available: current.maxOrderQuantity,
        requested: line.quantity
      });
    }

    if (current.priceCents !== line.unitPriceCents) {
      result.priceChanges.push({
        name: line.name,
        oldPriceCents: line.unitPriceCents,
        newPriceCents: current.priceCents
      });
      hasLinePriceChange = true;
      return {
        ...line,
        unitPriceCents: current.priceCents
      };
    }

    return line;
  });

  return {
    ...result,
    updatedLines: hasLinePriceChange ? updated : currentLines
  };
};

export interface PrepareCheckoutSubmissionInput {
  values: CheckoutData;
  lines: CartLine[];
  catalogProducts?: StorefrontProduct[] | undefined;
  settings: StoreSettings;
  protocolDraft?: ProtocolDraft | null | undefined;
  validateAvailability: (lines: Pick<CartLine, 'productId' | 'quantity'>[]) => Promise<AvailabilityCheck>;
  syncWithLiveCatalog?: ((products: StorefrontProduct[]) => CartRevalidationResult) | undefined;
}

export interface PrepareCheckoutSubmissionOutput {
  effectiveLines: CartLine[];
  sanitizedValues: CheckoutData;
  shippingFeeCents: number;
  subtotalCents: number;
  totalCents: number;
  priceNotice: string | null;
  priceChanges: CartRevalidationResult['priceChanges'];
  fingerprint: string;
  protocol: WhatsAppProtocol;
  whatsappUrl: string;
}

/**
 * Canalización autoritativa para el procesamiento del submit de Checkout.
 * Garantiza que ante un cambio de precio o stock en vivo, tanto la validación
 * como el fingerprint, el total y el mensaje de WhatsApp se armen de inmediato
 * con las líneas autoritativas actualizadas.
 */
export const prepareCheckoutSubmission = async (
  input: PrepareCheckoutSubmissionInput
): Promise<PrepareCheckoutSubmissionOutput> => {
  let effectiveLines = input.lines;
  let priceChanges: CartRevalidationResult['priceChanges'] = [];
  let priceNotice: string | null = null;

  // 1. Revalidación en vivo de catálogo y precios
  if (input.catalogProducts !== undefined) {
    const reval = input.syncWithLiveCatalog
      ? input.syncWithLiveCatalog(input.catalogProducts)
      : revalidateCartWithCatalog(input.lines, input.catalogProducts);

    effectiveLines = reval.updatedLines;
    priceChanges = reval.priceChanges;

    if (reval.unavailableProducts.length > 0) {
      throw new AppError(
        'business',
        `El producto “${reval.unavailableProducts[0]}” ya no está disponible en la tienda.`,
        { nextAction: 'Volvé al carrito y quitalo para poder continuar.' }
      );
    }

    if (reval.outOfStockProducts.length > 0) {
      throw new AppError(
        'business',
        `El producto “${reval.outOfStockProducts[0]}” se quedó sin stock.`,
        { nextAction: 'Volvé al carrito y quitalo para poder continuar.' }
      );
    }

    if (reval.partialStockProducts.length > 0) {
      const partial = reval.partialStockProducts[0];
      if (partial) {
        throw new AppError(
          'business',
          `Ahora quedan ${partial.available} unidades de “${partial.name}” (pediste ${partial.requested}).`,
          { nextAction: 'Volvé al carrito y ajustá la cantidad antes de continuar.' }
        );
      }
    }

    if (reval.priceChanges.length > 0) {
      const changeSummary = reval.priceChanges
        .map((c) => `${c.name}: ${formatMoney(c.oldPriceCents)} → ${formatMoney(c.newPriceCents)}`)
        .join(', ');
      priceNotice = `Actualizamos el total por cambio de precio: ${changeSummary}.`;
    }
  }

  // 2. Validación en tiempo real de disponibilidad y stock en base de datos
  const availability = await input.validateAvailability(
    effectiveLines.map((line) => ({ productId: line.productId, quantity: line.quantity }))
  );

  if (!availability.ok) {
    const issue = availability.issues[0];
    if (issue) {
      if (issue.available <= 0) {
        throw new AppError('business', `El producto “${issue.productName}” se quedó sin stock o no está disponible.`, {
          nextAction: 'Volvé al carrito y quitalo para poder continuar.'
        });
      }
      throw new AppError(
        'business',
        `Ahora quedan ${issue.available} unidades de “${issue.productName}” (pediste ${issue.requested}).`,
        { nextAction: 'Volvé al carrito y ajustá la cantidad antes de continuar.' }
      );
    }
    throw new AppError('business', 'Cambió la disponibilidad de uno o más productos.', {
      nextAction: 'Volvé al carrito y revisá las cantidades antes de continuar.'
    });
  }

  // 3. Sanitización de estado al construir el protocolo
  const sanitizedValues = sanitizeCheckoutValues(input.values);

  // 4. Cálculo de tarifa de envío
  const shippingFeeCents = calculateShippingFee(
    sanitizedValues.deliveryMethod,
    sanitizedValues.shippingType,
    input.settings
  );

  // 5. Huella digital estricta del pedido
  const fingerprint = createOrderFingerprint(
    sanitizedValues,
    effectiveLines,
    shippingFeeCents
  );

  // 6. Estabilidad del ID de pedido vs nuevo ID ante cambios
  const existingOrderId =
    input.protocolDraft?.fingerprint === fingerprint
      ? input.protocolDraft.orderId
      : undefined;

  // 7. Construcción del protocolo con las líneas autoritativas
  const protocol = buildWhatsAppProtocol(
    sanitizedValues,
    effectiveLines,
    input.settings,
    existingOrderId
  );

  // 8. Enlace de WhatsApp
  const whatsappUrl = buildWhatsAppUrl(input.settings.whatsappPhone, protocol.message);

  const subtotalCents = effectiveLines.reduce(
    (acc, line) => acc + line.unitPriceCents * line.quantity,
    0
  );

  return {
    effectiveLines,
    sanitizedValues,
    shippingFeeCents,
    subtotalCents,
    totalCents: subtotalCents + shippingFeeCents,
    priceNotice,
    priceChanges,
    fingerprint,
    protocol,
    whatsappUrl
  };
};
