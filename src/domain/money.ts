const ARS_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

export const formatMoney = (cents: number): string => ARS_FORMATTER.format(cents / 100);

export const formatPlainMoney = (cents: number): string =>
  new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(cents / 100);

export const pesosToCents = (pesos: number): number => Math.round(pesos * 100);

export const sumCents = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export const calculateBasisPoints = (amountCents: number, basisPoints: number): number =>
  Math.round((amountCents * basisPoints) / 10_000);

