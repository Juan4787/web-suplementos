import type { SafeToolResult } from './facts';

/*
 * This module is deliberately not an intent router. The model chooses the
 * tool from the conversation and writes the normal answer. The templates
 * below are a last-resort, data-shaped rescue for a provider that returns an
 * unusable final answer after a successful read. They never inspect the
 * wording of the user's question, so a new colloquial formulation cannot
 * create a new business-answer branch here.
 */

const normalizeText = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR');

const WRITE_INTENT_PATTERN =
  /\b(?:agrega|ajusta|borra|cambia|crea|descuenta|elimina|marca|modifica|registra|sube|subi|actualiza|quita|anula)\b/u;

// This is only a fail-closed safety gate for a model that forgot to call a
// read tool. It is intentionally based on broad business concepts, not on
// answer templates or individual colloquialisms.
const BUSINESS_DATA_PATTERN =
  /\b(?:stock|inventario|reposici[oó]n|rotaci[oó]n|precio|precios|caro|costos?|m[aá]rgenes?|facturaci[oó]n|pedidos?|ventas?|vendido|vendi[oó]|producto(?:s)?|cat[aá]logo|compras?|cu[aá]nto|sale|cuesta|vale|valor)\b/u;
const BUSINESS_CONTEXT_PATTERN =
  /\b(?:mi|mis|tengo|hay|queda|quedan|disponible|disponibles|deber[ií]a|prioriz|compar|per[ií]odo|mes|semana|a[nñ]o|fecha|rindi[oó]|rendimiento|m[aá]s|cu[aá]l|qu[eé]|cu[aá]nt)\b/u;
const GENERAL_ADVICE_PATTERN =
  /\b(?:t[eé]cnica(?:s)?|estrategia|consejo(?:s)?|idea(?:s)?|mejorar|vender m[aá]s|venta consultiva|promoci[oó]n)\b/u;
const SPECIFIC_DATA_CUE_PATTERN =
  /\b(?:stock|inventario|reposici[oó]n|rotaci[oó]n|precio|precios|caro|costos?|m[aá]rgenes?|facturaci[oó]n|pedidos?|producto(?:s)?|cat[aá]logo|compras?|compar|per[ií]odo|mes|semana|fecha|cu[aá]l|qu[eé]|cu[aá]nt|rindi[oó]|rendimiento|vendido|vendi[oó])\b/u;

const placeholder = (id: string): string => `{{fact:${id}}}`;

const hasFact = (result: SafeToolResult, id: string): boolean =>
  Object.prototype.hasOwnProperty.call(result.facts ?? {}, id);

const productFactPlaceholder = (
  product: NonNullable<SafeToolResult['products']>[number],
  factId: string
): string | null => {
  const id = `${product.ref}.${factId}`;
  return Object.prototype.hasOwnProperty.call(product.facts, id) ? placeholder(id) : null;
};

const join = (parts: string[]): string => {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)!}`;
};

export const requiresBusinessEvidence = (message: string): boolean => {
  const normalized = normalizeText(message);
  if (WRITE_INTENT_PATTERN.test(normalized)) return false;
  if (!BUSINESS_DATA_PATTERN.test(normalized)) return false;
  // Advice about selling is intentionally allowed to remain a conversation.
  // A store-specific cue ("mis productos", a period, a comparison, etc.)
  // still forces the server to require a read before accepting figures.
  if (GENERAL_ADVICE_PATTERN.test(normalized) && !SPECIFIC_DATA_CUE_PATTERN.test(normalized)) {
    return false;
  }
  return BUSINESS_CONTEXT_PATTERN.test(normalized) || /\?/u.test(normalized);
};

const buildComparisonTemplate = (result: SafeToolResult): string | null => {
  const required = [
    'first.revenue_cents',
    'first.estimated_margin_cents',
    'first.order_count',
    'first.units',
    'second.revenue_cents',
    'second.estimated_margin_cents',
    'second.order_count',
    'second.units',
    'change.revenue_cents',
    'change.revenue_percent',
    'change.margin_cents',
    'change.margin_percent',
    'change.order_count',
    'change.units'
  ];
  if (!required.every((id) => hasFact(result, id))) return null;
  if (!result.periods?.first || !result.periods.second) return null;
  return [
    'Período base ({{fact:period.first.from}} a {{fact:period.first.to}}): ',
    'facturación {{fact:first.revenue_cents}}, margen {{fact:first.estimated_margin_cents}}, ',
    'pedidos {{fact:first.order_count}} y unidades {{fact:first.units}}. ',
    'Período comparado ({{fact:period.second.from}} a {{fact:period.second.to}}): ',
    'facturación {{fact:second.revenue_cents}}, margen {{fact:second.estimated_margin_cents}}, ',
    'pedidos {{fact:second.order_count}} y unidades {{fact:second.units}}. ',
    'Cambio del segundo respecto del primero: facturación {{fact:change.revenue_cents}} ',
    '({{fact:change.revenue_percent}}), margen {{fact:change.margin_cents}} ',
    '({{fact:change.margin_percent}}), pedidos {{fact:change.order_count}} y ',
    'unidades {{fact:change.units}}.'
  ].join('');
};

const buildInventoryTemplate = (result: SafeToolResult): string | null => {
  if (result.tool !== 'get_inventory_status') return null;

  const summaryParts = [
    hasFact(result, 'inventory.returned_product_count')
      ? `{{fact:inventory.returned_product_count}} productos incluidos`
      : null,
    hasFact(result, 'inventory.attention_product_count')
      ? `{{fact:inventory.attention_product_count}} requieren atención`
      : null
  ].filter((part): part is string => part !== null);

  const productLines = (result.products ?? []).flatMap((product) => {
    const coverageId = `${product.ref}.stock.coverage_days`;
    const coverage = productFactPlaceholder(product, 'stock.coverage_days');
    const details = [
      ['disponible', productFactPlaceholder(product, 'stock.available_units')],
      ['en camino', productFactPlaceholder(product, 'stock.incoming_units')],
      ['compra sugerida', productFactPlaceholder(product, 'stock.suggested_purchase_units')],
      [
        'cobertura',
        coverage
          ? `${coverage}${product.facts[coverageId] === null ? '' : ' días'}`
          : null
      ]
    ]
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([label, value]) => `${label} ${value}`);
    return details.length > 0
      ? [`${placeholder(`${product.ref}.label`)}: ${details.join(', ')}.`]
      : [];
  });

  if (summaryParts.length === 0 && productLines.length === 0) return null;
  const summary = summaryParts.length > 0 ? `El inventario consultado indica ${join(summaryParts)}.` : '';
  return [summary, ...productLines].filter(Boolean).join(' ');
};

const buildEmptyPerformanceTemplate = (result: SafeToolResult): string | null => {
  if (
    (result.tool !== 'get_product_performance' && result.tool !== 'get_top_selling_products') ||
    (result.products ?? []).length !== 0 ||
    result.facts?.['performance.returned_product_count'] !== 0
  ) {
    return null;
  }
  return hasFact(result, 'performance.returned_product_count')
    ? 'No hay productos con ventas cobradas en el período consultado. Productos con ventas: {{fact:performance.returned_product_count}}.'
    : 'No hay productos con ventas cobradas en el período consultado.';
};

const buildPerformanceTemplate = (result: SafeToolResult): string | null => {
  if (
    result.tool !== 'get_product_performance' &&
    result.tool !== 'get_top_selling_products'
  ) {
    return null;
  }
  const lines = (result.products ?? []).flatMap((product) => {
    const details = [
      ['unidades vendidas', productFactPlaceholder(product, 'performance.units')],
      ['facturación', productFactPlaceholder(product, 'performance.revenue_cents')],
      ['margen estimado', productFactPlaceholder(product, 'performance.estimated_margin_cents')],
      ['pedidos', productFactPlaceholder(product, 'performance.order_count')]
    ]
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(([label, value]) => `${label} ${value}`);
    return details.length > 0
      ? [`${placeholder(`${product.ref}.label`)}: ${details.join(', ')}.`]
      : [];
  });
  return lines.length > 0 ? `Rendimiento de los productos consultados: ${lines.join(' ')}` : null;
};

const buildSalesSummaryTemplate = (result: SafeToolResult): string | null => {
  if (result.tool !== 'get_sales_summary') return null;
  const details = [
    ['facturación cobrada', 'sales.revenue_cents'],
    ['costo registrado', 'sales.cost_cents'],
    ['impuesto estimado', 'sales.tax_cents'],
    ['margen estimado', 'sales.estimated_margin_cents'],
    ['ticket promedio', 'sales.average_ticket_cents'],
    ['pedidos cobrados', 'sales.order_count'],
    ['unidades vendidas', 'sales.units']
  ]
    .filter((entry): entry is [string, string] => hasFact(result, entry[1]))
    .map(([label, id]) => `${label} ${placeholder(id)}`);
  return details.length > 0 ? `El resumen del período indica ${join(details)}.` : null;
};

const buildCatalogTemplate = (result: SafeToolResult): string | null => {
  if (result.tool !== 'get_product_catalog') return null;
  const products = result.products ?? [];
  // This is a last-resort rescue, not the normal answer path. Keep it small:
  // a failed final generation must not turn a question about one product into
  // a wall of every catalog row. The model normally receives the complete
  // sanitized catalog and can answer the requested slice conversationally.
  const sampleProducts = products.slice(0, 5);
  const productLines = sampleProducts.flatMap((product) => {
    const label = placeholder(`${product.ref}.label`);
    const price = productFactPlaceholder(product, 'catalog.price_cents');
    return [price ? `${label}: ${price}` : label];
  });
  const count = hasFact(result, 'catalog.returned_product_count')
    ? `{{fact:catalog.returned_product_count}} productos`
    : hasFact(result, 'catalog.active_product_count')
      ? `{{fact:catalog.active_product_count}} productos activos`
      : null;
  if (!count && productLines.length === 0) return null;
  const intro = count ? `El catálogo consultado incluye ${count}.` : 'Estos son los productos consultados.';
  if (productLines.length === 0) return intro;
  const tail = products.length > sampleProducts.length
    ? ' Si querés revisar otro producto o comparar precios, decime cuál.'
    : '';
  return `${intro} Una muestra: ${productLines.join('; ')}.${tail}`;
};

/**
 * Builds only a provider-failure rescue. The normal path always gives the
 * model a second turn after the tool result so the user gets a conversational
 * answer instead of one of these summaries.
 */
export function buildDeterministicAnswerTemplate(result: SafeToolResult): string | null;
/** @deprecated The message is ignored; kept only for callers compiled against the old helper. */
export function buildDeterministicAnswerTemplate(message: string, result: SafeToolResult): string | null;
export function buildDeterministicAnswerTemplate(
  first: SafeToolResult | string,
  legacyResult?: SafeToolResult
): string | null {
  const result = typeof first === 'string' ? legacyResult : first;
  if (!result) return null;
  return (
    buildComparisonTemplate(result) ??
    buildInventoryTemplate(result) ??
    buildEmptyPerformanceTemplate(result) ??
    buildPerformanceTemplate(result) ??
    buildSalesSummaryTemplate(result) ??
    buildCatalogTemplate(result)
  );
}
