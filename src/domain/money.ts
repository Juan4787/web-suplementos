const ARS_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
const ARS_DECIMAL_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2
});

export const formatMoney = (cents: number): string =>
  (cents % 100 === 0 ? ARS_FORMATTER : ARS_DECIMAL_FORMATTER).format(cents / 100);

export const formatPlainMoney = (cents: number): string =>
  new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(cents / 100);

export const pesosToCents = (pesos: number): number => Math.round(pesos * 100);

export const sumCents = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export const calculateBasisPoints = (amountCents: number, basisPoints: number): number =>
  Math.round((amountCents * basisPoints) / 10_000);
