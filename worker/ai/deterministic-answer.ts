import type { SafeToolResult } from './facts';

const normalizeIntent = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const WRITE_INTENT_PATTERN =
  /\b(?:agrega|ajusta|borra|cambia|crea|descuenta|elimina|marca|modifica|registra|sube|subi|actualiza)\b/u;
const BUSINESS_READ_PATTERN =
  /\b(?:caro|catalogo|compras?|costos?|facturacion|inventario|margen|pedidos?|precios?|productos?|reposicion|stock|ventas?|vendido|vendio)\b/u;
const HIGHEST_PRICE_PATTERN =
  /\b(?:mas caro|mayor precio|precio mas alto|precio mayor)\b/u;
const TOP_SELLER_PATTERN =
  /\b(?:mas vendido|mas se vendio|se vendio mas|vendio mas|mayor venta)\b/u;

const placeholder = (id: string): string => `{{fact:${id}}}`;

const joinLabels = (ids: string[]): string => {
  if (ids.length === 1) return placeholder(ids[0]!);
  if (ids.length === 2) return `${placeholder(ids[0]!)} y ${placeholder(ids[1]!)}`;
  return `${ids.slice(0, -1).map(placeholder).join(', ')} y ${placeholder(ids.at(-1)!)}`;
};

export const requiresBusinessEvidence = (message: string): boolean => {
  const normalized = normalizeIntent(message);
  return !WRITE_INTENT_PATTERN.test(normalized) && BUSINESS_READ_PATTERN.test(normalized);
};

export const buildDeterministicAnswerTemplate = (
  message: string,
  result: SafeToolResult
): string | null => {
  if (
    (result.tool === 'get_product_performance' || result.tool === 'get_top_selling_products') &&
    result.products?.length === 0 &&
    result.facts?.['performance.returned_product_count'] === 0
  ) {
    return 'No hay productos con ventas cobradas en el período consultado. Productos con ventas: {{fact:performance.returned_product_count}}.';
  }

  const normalized = normalizeIntent(message);

  if (result.tool === 'get_product_catalog' && HIGHEST_PRICE_PATTERN.test(normalized)) {
    const highest = (result.products ?? []).filter(
      (product) => product.facts[`${product.ref}.catalog.price_rank`] === 1
    );
    if (highest.length === 0) return null;

    const labels = highest.map((product) => `${product.ref}.label`);
    const priceId = `${highest[0]!.ref}.catalog.price_cents`;
    return highest.length === 1
      ? `El producto con mayor precio es ${joinLabels(labels)}, a ${placeholder(priceId)}.`
      : `Hay un empate en el mayor precio entre ${joinLabels(labels)}. Cada uno cuesta ${placeholder(priceId)}.`;
  }

  if (
    (result.tool === 'get_product_performance' || result.tool === 'get_top_selling_products') &&
    TOP_SELLER_PATTERN.test(normalized)
  ) {
    const productsWithUnits = (result.products ?? []).flatMap((product) => {
      const unitsId = `${product.ref}.performance.units`;
      const units = product.facts[unitsId];
      return typeof units === 'number' ? [{ product, units, unitsId }] : [];
    });
    if (productsWithUnits.length === 0) return null;

    const highestUnits = Math.max(...productsWithUnits.map(({ units }) => units));
    const highest = productsWithUnits.filter(({ units }) => units === highestUnits);
    const labels = highest.map(({ product }) => `${product.ref}.label`);
    return highest.length === 1
      ? `El producto más vendido en el período consultado fue ${joinLabels(labels)}, con ${placeholder(highest[0]!.unitsId)} unidades vendidas.`
      : `Hubo un empate entre los productos más vendidos: ${joinLabels(labels)}. Cada uno registró ${placeholder(highest[0]!.unitsId)} unidades vendidas.`;
  }

  return null;
};
