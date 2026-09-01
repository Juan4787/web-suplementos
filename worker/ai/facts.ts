import { UngroundedAnswerFailure } from './errors';
import type { ExactEvidence } from './types';

type PrimitiveFact = string | number | boolean | null;

export type SafeToolResult = {
  schemaVersion: 'ai-facts/v1';
  tool: string;
  period?: Record<string, string>;
  periods?: {
    first: Record<string, string>;
    second: Record<string, string>;
    timezone?: string;
  };
  facts?: Record<string, PrimitiveFact>;
  products?: Array<{
    ref: string;
    label: string;
    status?: string;
    facts: Record<string, PrimitiveFact>;
  }>;
};

export type FactCatalogEntry = ExactEvidence & { rawValue: PrimitiveFact };
export type FactCatalog = Map<string, FactCatalogEntry>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPrimitiveFact = (value: unknown): value is PrimitiveFact =>
  value === null || typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const FACT_ID_PATTERN = /^[a-z][a-z0-9_.]{1,100}$/;
const PRODUCT_REF_PATTERN = /^product:[A-Z0-9][A-Z0-9_-]{1,29}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isIsoDate = (value: string): boolean => {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const normalizeFacts = (value: unknown, maxFacts: number): Record<string, PrimitiveFact> => {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > maxFacts) throw new Error('TOOL_RESULT_TOO_LARGE');

  const normalized: Record<string, PrimitiveFact> = {};
  for (const [key, factValue] of entries) {
    if (!FACT_ID_PATTERN.test(key) || !isPrimitiveFact(factValue)) {
      throw new Error('INVALID_TOOL_RESULT');
    }
    if (typeof factValue === 'string' && factValue.length > 120) {
      throw new Error('INVALID_TOOL_RESULT');
    }
    const normalizedKey = key.endsWith('_basis_points')
      ? `${key.slice(0, -'_basis_points'.length)}_percent`
      : key;
    const normalizedValue = key.endsWith('_basis_points')
      ? typeof factValue === 'number'
        ? factValue / 100
        : undefined
      : factValue;
    if (normalizedValue === undefined || normalizedKey in normalized) {
      throw new Error('INVALID_TOOL_RESULT');
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
};

const normalizePeriod = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  if (!Object.keys(value).every((key) => ['from', 'to', 'timezone'].includes(key))) {
    throw new Error('INVALID_TOOL_RESULT');
  }
  if (
    typeof value.from !== 'string' ||
    !isIsoDate(value.from) ||
    typeof value.to !== 'string' ||
    !isIsoDate(value.to)
  ) {
    throw new Error('INVALID_TOOL_RESULT');
  }
  const normalized: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (
      typeof field !== 'string' ||
      field.length > 80 ||
      (key === 'timezone' && field !== 'America/Argentina/Buenos_Aires')
    ) {
      throw new Error('INVALID_TOOL_RESULT');
    }
    normalized[key] = field;
  }
  return normalized;
};

const normalizePeriods = (value: unknown): SafeToolResult['periods'] | undefined => {
  if (!isRecord(value)) return undefined;
  if (!Object.keys(value).every((key) => ['first', 'second', 'timezone'].includes(key))) {
    throw new Error('INVALID_TOOL_RESULT');
  }
  const first = normalizePeriod(value.first);
  const second = normalizePeriod(value.second);
  if (!first || !second || 'timezone' in first || 'timezone' in second) {
    throw new Error('INVALID_TOOL_RESULT');
  }
  if (
    value.timezone !== undefined &&
    value.timezone !== 'America/Argentina/Buenos_Aires'
  ) {
    throw new Error('INVALID_TOOL_RESULT');
  }
  return {
    first,
    second,
    ...(typeof value.timezone === 'string' ? { timezone: value.timezone } : {})
  };
};

const dateFacts = (
  prefix: string,
  period: Record<string, string>
): Record<string, PrimitiveFact> => ({
  [`${prefix}.from`]: period.from!,
  [`${prefix}.to`]: period.to!,
  [`${prefix}.from_year`]: period.from!.slice(0, 4),
  [`${prefix}.to_year`]: period.to!.slice(0, 4)
});

export const sanitizeToolResult = (raw: unknown, expectedTool: string): SafeToolResult => {
  if (!isRecord(raw) || raw.schemaVersion !== 'ai-facts/v1' || raw.tool !== expectedTool) {
    throw new Error('INVALID_TOOL_RESULT');
  }

  const safe: SafeToolResult = {
    schemaVersion: 'ai-facts/v1',
    tool: expectedTool
  };

  const period = normalizePeriod(raw.period);
  if (period) safe.period = period;
  const periods = normalizePeriods(raw.periods);
  if (periods) safe.periods = periods;

  const facts = normalizeFacts(raw.facts, 30);
  const derivedFacts = {
    ...(period ? dateFacts('period', period) : {}),
    ...(periods
      ? {
          ...dateFacts('period.first', periods.first),
          ...dateFacts('period.second', periods.second)
        }
      : {})
  };
  for (const key of Object.keys(derivedFacts)) {
    if (key in facts) throw new Error('INVALID_TOOL_RESULT');
  }
  const combinedFacts = { ...facts, ...derivedFacts };
  if (Object.keys(combinedFacts).length > 40) throw new Error('TOOL_RESULT_TOO_LARGE');
  if (Object.keys(combinedFacts).length > 0) safe.facts = combinedFacts;

  if (raw.products !== undefined) {
    if (!Array.isArray(raw.products) || raw.products.length > 50) {
      throw new Error('TOOL_RESULT_TOO_LARGE');
    }
    safe.products = raw.products.map((product) => {
      if (
        !isRecord(product) ||
        typeof product.ref !== 'string' ||
        !PRODUCT_REF_PATTERN.test(product.ref) ||
        typeof product.label !== 'string' ||
        product.label.length < 1 ||
        product.label.length > 120 ||
        (product.status !== undefined && (typeof product.status !== 'string' || product.status.length > 20))
      ) {
        throw new Error('INVALID_TOOL_RESULT');
      }
      const productFacts = normalizeFacts(product.facts, 20);
      return {
        ref: product.ref,
        label: product.label,
        ...(typeof product.status === 'string' ? { status: product.status } : {}),
        facts: Object.fromEntries(
          Object.entries(productFacts).map(([factId, factValue]) => [
            `${product.ref}.${factId}`,
            factValue
          ])
        )
      };
    });
  }

  const encoded = JSON.stringify(safe);
  if (new TextEncoder().encode(encoded).byteLength > 32_000) {
    throw new Error('TOOL_RESULT_TOO_LARGE');
  }
  return safe;
};

const FACT_LABELS: Record<string, string> = {
  'sales.revenue_cents': 'Facturación cobrada',
  'sales.cost_cents': 'Costo registrado',
  'sales.tax_cents': 'Impuesto estimado',
  'sales.estimated_margin_cents': 'Margen estimado',
  'sales.average_ticket_cents': 'Ticket promedio',
  'sales.order_count': 'Pedidos cobrados',
  'sales.units': 'Unidades vendidas',
  'inventory.active_product_count': 'Productos activos',
  'inventory.attention_product_count': 'Productos que requieren atención',
  'inventory.returned_product_count': 'Productos incluidos',
  'catalog.active_product_count': 'Productos activos',
  'catalog.returned_product_count': 'Productos incluidos',
  'catalog.price_cents': 'Precio',
  'catalog.price_rank': 'Posición por precio',
  'stock.on_hand_units': 'Stock físico',
  'stock.reserved_units': 'Stock reservado',
  'stock.available_units': 'Stock disponible',
  'stock.incoming_units': 'Unidades en camino',
  'stock.projected_units': 'Stock proyectado',
  'stock.reorder_point_units': 'Punto de pedido',
  'stock.safety_units': 'Stock de seguridad',
  'stock.lead_time_days': 'Plazo de reposición',
  'stock.average_daily_sales_units': 'Venta diaria promedio',
  'stock.coverage_days': 'Cobertura estimada',
  'stock.suggested_purchase_units': 'Compra sugerida',
  'performance.units': 'Unidades vendidas',
  'performance.revenue_cents': 'Facturación cobrada',
  'performance.estimated_margin_cents': 'Margen estimado',
  'performance.order_count': 'Pedidos cobrados',
  'performance.returned_product_count': 'Productos con ventas',
  'performance.returned_units': 'Unidades vendidas incluidas',
  'revenue_cents': 'Facturación cobrada',
  'estimated_margin_cents': 'Margen estimado',
  'order_count': 'Pedidos cobrados',
  'units': 'Unidades vendidas',
  'revenue_percent': 'Variación de facturación',
  'margin_percent': 'Variación de margen',
  'period.from': 'Inicio del período',
  'period.to': 'Fin del período',
  'period.from_year': 'Año inicial del período',
  'period.to_year': 'Año final del período',
  'period.first.from': 'Inicio del primer período',
  'period.first.to': 'Fin del primer período',
  'period.first.from_year': 'Año inicial del primer período',
  'period.first.to_year': 'Año final del primer período',
  'period.second.from': 'Inicio del segundo período',
  'period.second.to': 'Fin del segundo período',
  'period.second.from_year': 'Año inicial del segundo período',
  'period.second.to_year': 'Año final del segundo período'
};

const humanizeFactId = (id: string): string => {
  const exact = FACT_LABELS[id];
  if (exact) return exact;
  if (id.startsWith('first.')) return `Primer período: ${humanizeFactId(id.slice(6))}`;
  if (id.startsWith('second.')) return `Segundo período: ${humanizeFactId(id.slice(7))}`;
  if (id.startsWith('change.')) return `Cambio: ${humanizeFactId(id.slice(7))}`;
  return id.replaceAll('.', ' ').replaceAll('_', ' ');
};

const formatFact = (id: string, value: PrimitiveFact): string => {
  if (value === null) return 'Sin dato';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'string') {
    if (
      id.startsWith('period.') &&
      (id.endsWith('.from') || id.endsWith('.to') || id === 'period.from' || id === 'period.to')
    ) {
      return new Intl.DateTimeFormat('es-AR', {
        dateStyle: 'medium',
        timeZone: 'UTC'
      }).format(new Date(`${value}T00:00:00.000Z`));
    }
    return value;
  }
  if (id.endsWith('_cents')) {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0
    }).format(value / 100);
  }
  if (id.endsWith('_percent')) {
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(value) + ' %';
  }
  return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(value);
};

export const addToolFacts = (catalog: FactCatalog, result: SafeToolResult): void => {
  for (const [id, value] of Object.entries(result.facts ?? {})) {
    catalog.set(id, {
      id,
      label: humanizeFactId(id),
      rawValue: value,
      value,
      formatted: formatFact(id, value)
    });
  }

  for (const product of result.products ?? []) {
    const prefix = `${product.ref}.`;
    catalog.set(`${product.ref}.label`, {
      id: `${product.ref}.label`,
      label: 'Producto',
      rawValue: product.label,
      value: product.label,
      formatted: product.label
    });
    for (const [id, value] of Object.entries(product.facts)) {
      if (!id.startsWith(prefix)) throw new Error('INVALID_TOOL_RESULT');
      const factId = id.slice(prefix.length);
      catalog.set(id, {
        id,
        label: `${product.label}: ${humanizeFactId(factId)}`,
        rawValue: value,
        value,
        formatted: formatFact(factId, value)
      });
    }
  }
};

export const prepareToolResultForModel = (result: SafeToolResult): SafeToolResult => ({
  ...result,
  ...(result.products
    ? {
        products: result.products.map((product) => ({
          ...product,
          label: `{{fact:${product.ref}.label}}`
        }))
      }
    : {})
});

const PLACEHOLDER_PATTERN = /\{\{fact:([a-zA-Z0-9_.:-]{2,180})\}\}/g;
const BARE_PLACEHOLDER_PATTERN = /\{\{(?!fact:)([a-zA-Z0-9_.:-]{2,180})\}\}/g;
const UNRESOLVED_PLACEHOLDER_PATTERN = /\{\{[^{}\n]{1,200}\}\}/u;
const PLACEHOLDER_WITH_SUFFIX_PATTERN =
  /\{\{fact:([a-zA-Z0-9_.:-]{2,180})\}\}(\s*(?:%|por ciento|puntos b[aá]sicos|bps|pb|centavos|pesos|ARS))?/giu;
const MONEY_SUFFIX_PATTERN = /(?:centavos|pesos|ARS)/iu;
const PERCENT_SUFFIX_PATTERN = /(?:%|por ciento|puntos b[aá]sicos|bps|pb)/iu;
const MONTH_YEAR_PATTERN =
  /\b((?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de)?)\s+((?:19|20)\d{2})\b/giu;
const NUMBER_WORD_PATTERN =
  /\b(?:cero|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|mil|mill[oó]n|millones)\b/iu;
const ONE_BUSINESS_QUANTITY_PATTERN =
  /\b(?:un|una)\s+(?:unidad|pedido|producto|d[ií]a|peso|centavo|porcentaje)(?:es|s)?\b/iu;

const stripRedundantFactSuffixes = (template: string): string =>
  template.replace(PLACEHOLDER_WITH_SUFFIX_PATTERN, (match, id: string, suffix?: string) => {
    if (!suffix) return match;
    if (id.endsWith('_cents') && MONEY_SUFFIX_PATTERN.test(suffix)) return `{{fact:${id}}}`;
    if (id.endsWith('_percent') && PERCENT_SUFFIX_PATTERN.test(suffix)) return `{{fact:${id}}}`;
    return match;
  });

const groundTrustedMonthYears = (template: string, catalog: FactCatalog): string => {
  const yearFacts = new Map<string, string>();
  for (const [id, fact] of catalog) {
    if (id.startsWith('period.') && id.endsWith('_year') && typeof fact.rawValue === 'string') {
      yearFacts.set(fact.rawValue, id);
    }
  }
  return template.replace(MONTH_YEAR_PATTERN, (match, month: string, year: string) => {
    const factId = yearFacts.get(year);
    return factId ? `${month} {{fact:${factId}}}` : match;
  });
};

const normalizeKnownFactPlaceholders = (template: string, catalog: FactCatalog): string =>
  template.replace(BARE_PLACEHOLDER_PATTERN, (match, id: string) =>
    catalog.has(id) ? `{{fact:${id}}}` : match
  );

export const renderGroundedAnswer = (
  template: string | null,
  catalog: FactCatalog
): { answer: string; evidence: ExactEvidence[] } => {
  const trimmed = template?.trim() ?? '';
  if (!trimmed) throw new UngroundedAnswerFailure('empty_answer');
  const normalizedTemplate = stripRedundantFactSuffixes(
    normalizeKnownFactPlaceholders(groundTrustedMonthYears(trimmed, catalog), catalog)
  );

  const usedIds: string[] = [];
  const withoutPlaceholders = normalizedTemplate.replace(PLACEHOLDER_PATTERN, (_match, id: string) => {
    const fact = catalog.get(id);
    if (!fact) throw new UngroundedAnswerFailure('unknown_fact');
    if (!usedIds.includes(id)) {
      if (usedIds.length >= 60) throw new UngroundedAnswerFailure('unknown_fact');
      usedIds.push(id);
    }
    return '';
  });

  if (UNRESOLVED_PLACEHOLDER_PATTERN.test(withoutPlaceholders)) {
    throw new UngroundedAnswerFailure('unknown_fact');
  }

  if (/\p{Number}/u.test(withoutPlaceholders)) {
    throw new UngroundedAnswerFailure('literal_number');
  }
  if (
    catalog.size > 0 &&
    (NUMBER_WORD_PATTERN.test(withoutPlaceholders) ||
      ONE_BUSINESS_QUANTITY_PATTERN.test(withoutPlaceholders))
  ) {
    throw new UngroundedAnswerFailure('literal_number');
  }

  const answer = normalizedTemplate.replace(
    PLACEHOLDER_PATTERN,
    (_match, id: string) => catalog.get(id)!.formatted
  );
  if (answer.length > 4000) throw new UngroundedAnswerFailure('empty_answer');
  return {
    answer,
    evidence: usedIds.map((id) => {
      const { rawValue: _rawValue, ...evidence } = catalog.get(id)!;
      return evidence;
    })
  };
};
