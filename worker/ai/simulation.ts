/**
 * Módulo determinístico de cálculos y simulaciones comerciales para Impulso.
 * Toda la matemática económica, variaciones porcentuales y deducciones de stock
 * se realizan exclusivamente en TypeScript/código, jamás por estimación del LLM.
 */

export interface CommercialSimulationInput {
  priceCents: number;
  costCents: number;
  discountPercent: number;
  expectedUnits?: number;
}

export interface CommercialSimulationResult {
  originalPriceCents: number;
  discountPercent: number;
  discountAmountCents: number;
  discountedPriceCents: number;
  costCents: number;
  unitMarginCents: number;
  marginPercent: number;
  expectedUnits?: number;
  totalRevenueCents?: number;
  totalMarginCents?: number;
}

/**
 * Calcula el cambio porcentual exacto entre dos valores base y actual.
 * Previene divisiones por cero, NaN e Infinity.
 * Si el valor base es 0 y el actual es 0, el cambio es 0%.
 * Si el valor base es 0 y el actual es mayor a 0, devuelve null ("Sin dato")
 * ya que no es matemáticamente posible calcular una variación porcentual relativa.
 */
export const calculatePercentageChange = (base: number, current: number): number | null => {
  if (base === 0) {
    if (current === 0) return 0;
    return null;
  }
  const change = ((current - base) / Math.abs(base)) * 100;
  return Number(change.toFixed(2));
};

/**
 * Simula el impacto de un descuento comercial en precio y margen.
 * El descuento se calcula de forma exacta en centavos de moneda.
 */
export const simulateDiscount = (input: CommercialSimulationInput): CommercialSimulationResult => {
  if (input.priceCents < 0 || input.costCents < 0 || input.discountPercent < 0 || input.discountPercent > 100) {
    throw new Error('INVALID_SIMULATION_PARAMETERS');
  }

  const discountAmountCents = Math.round((input.priceCents * input.discountPercent) / 100);
  const discountedPriceCents = Math.max(0, input.priceCents - discountAmountCents);
  const unitMarginCents = discountedPriceCents - input.costCents;

  const marginPercent =
    discountedPriceCents > 0
      ? Number(((unitMarginCents / discountedPriceCents) * 100).toFixed(2))
      : 0;

  const expectedUnits = input.expectedUnits !== undefined ? Math.max(0, input.expectedUnits) : undefined;
  const totalRevenueCents = expectedUnits !== undefined ? discountedPriceCents * expectedUnits : undefined;
  const totalMarginCents = expectedUnits !== undefined ? unitMarginCents * expectedUnits : undefined;

  return {
    originalPriceCents: input.priceCents,
    discountPercent: input.discountPercent,
    discountAmountCents,
    discountedPriceCents,
    costCents: input.costCents,
    unitMarginCents,
    marginPercent,
    expectedUnits,
    totalRevenueCents,
    totalMarginCents
  };
};

/**
 * Calcula el stock comercialmente disponible.
 * Regla de negocio estricta: available = Math.max(0, onHand - reserved).
 * Nunca suma stock en camino (incoming) a la disponibilidad inmediata.
 */
export const calculateAvailableStock = (onHand: number, reserved: number): number => {
  return Math.max(0, onHand - reserved);
};
