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

export * from './fact-ledger';

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
        : factValue === null
          ? null
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

export const humanizeFactId = (id: string): string => {
  const exact = FACT_LABELS[id];
  if (exact) return exact;
  if (id.startsWith('first.')) return `Primer período: ${humanizeFactId(id.slice(6))}`;
  if (id.startsWith('second.')) return `Segundo período: ${humanizeFactId(id.slice(7))}`;
  if (id.startsWith('change.')) return `Cambio: ${humanizeFactId(id.slice(7))}`;
  return id.replaceAll('.', ' ').replaceAll('_', ' ');
};

export const formatFact = (id: string, value: PrimitiveFact): string => {
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

/**
 * The model receives the sanitized labels as ordinary data so it can speak
 * naturally. The server still treats every label as untrusted text and never
 * executes it as an instruction.
 */
export const prepareToolResultForModel = (result: SafeToolResult): SafeToolResult => ({
  ...result,
  ...(result.products
    ? {
        products: result.products.map((product) => ({
          ...product,
          label: product.label
        }))
      }
    : {})
});

const PLACEHOLDER_PATTERN = /\{\{fact:([a-zA-Z0-9_.:-]{2,180})\}\}/g;
const BARE_PLACEHOLDER_PATTERN = /\{\{(?!fact:)([a-zA-Z0-9_.:-]{2,180})\}\}/g;
const UNRESOLVED_PLACEHOLDER_PATTERN = /\{\{[^{}\n]{1,200}\}\}/u;
const NUMERIC_TOKEN_PATTERN = /[-+]?\d(?:[\d.,\u00a0]*\d)?/gu;
const PLACEHOLDER_WITH_SUFFIX_PATTERN =
  /\{\{fact:([a-zA-Z0-9_.:-]{2,180})\}\}(\s*(?:%|por ciento|puntos b[aá]sicos|bps|pb|centavos|pesos|ARS))?/giu;
const MONEY_SUFFIX_PATTERN = /(?:centavos|pesos|ARS)/iu;
const PERCENT_SUFFIX_PATTERN = /(?:%|por ciento|puntos b[aá]sicos|bps|pb)/iu;
const MONTH_YEAR_PATTERN =
  /\b((?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de)?)\s+((?:19|20)\d{2})\b/giu;
const SPANISH_NUMBER_VALUES: Readonly<Record<string, number>> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  'dieciséis': 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintiun: 21,
  veintiuna: 21,
  veintidos: 22,
  'veintidós': 22,
  veintitres: 23,
  'veintitrés': 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  'veintiséis': 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  doscientas: 200,
  trescientos: 300,
  trescientas: 300,
  cuatrocientos: 400,
  cuatrocientas: 400,
  quinientos: 500,
  quinientas: 500,
  seiscientos: 600,
  seiscientas: 600,
  setecientos: 700,
  setecientas: 700,
  ochocientos: 800,
  ochocientas: 800,
  novecientos: 900,
  novecientas: 900,
  'millón': 1_000_000
};
const SPANISH_NUMBER_TOKENS = [
  ...Object.keys(SPANISH_NUMBER_VALUES),
  'mil',
  'millon',
  'millones',
  'y'
].join('|');
const SPANISH_NUMBER_SEQUENCE_PATTERN = new RegExp(
  `\\b(?:${SPANISH_NUMBER_TOKENS})(?:\\s+(?:${SPANISH_NUMBER_TOKENS}))*\\b`,
  'giu'
);
const NUMBER_WORD_PATTERN =
  /\b(?:cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti(?:uno|un|una|d[oó]s|tr[eé]s|cuatro|cinco|s[eé]is|siete|ocho|nueve)|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscient(?:os|as)|trescient(?:os|as)|cuatrocient(?:os|as)|quinient(?:os|as)|seiscient(?:os|as)|setecient(?:os|as)|ochocient(?:os|as)|novecient(?:os|as)|mil|mill[oó]n|millones)\b/iu;

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

const normalizeFactPlaceholderAliases = (template: string, catalog: FactCatalog): string =>
  template.replace(PLACEHOLDER_PATTERN, (match, id: string) => {
    if (catalog.has(id)) return match;
    if (id.endsWith('_basis_points')) {
      const normalizedId = `${id.slice(0, -'_basis_points'.length)}_percent`;
      if (catalog.has(normalizedId)) return `{{fact:${normalizedId}}}`;
    }
    return match;
  });

const normalizeNumericToken = (token: string): string | null => {
  const clean = token.replace(/[^\d.,+-]/gu, '');
  if (!clean || !/\d/u.test(clean)) return null;

  const sign = clean.startsWith('-') ? -1 : 1;
  const unsigned = clean.replace(/^[+-]/u, '');
  const lastComma = unsigned.lastIndexOf(',');
  const lastDot = unsigned.lastIndexOf('.');
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = unsigned
      .replaceAll(thousandsSeparator, '')
      .replace(decimalSeparator, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator = lastComma >= 0 ? ',' : '.';
    const parts = unsigned.split(separator);
    const fractionalLength = parts.at(-1)?.length ?? 0;
    if (parts.length > 2 || fractionalLength === 3) {
      normalized = parts.join('');
    } else {
      normalized = unsigned.replace(separator, '.');
    }
  } else {
    normalized = unsigned;
  }

  const number = Number(normalized) * sign;
  return Number.isFinite(number) ? String(number) : null;
};

const parseSpanishNumber = (phrase: string): number | null => {
  const tokens = normalizedSearchText(phrase)
    .split(/\s+/u)
    .filter((token) => token !== 'y');
  if (tokens.length === 0) return null;

  let total = 0;
  let group = 0;
  let sawNumber = false;
  for (const token of tokens) {
    if (token === 'mil' || token === 'millon' || token === 'millones') {
      const multiplier = token === 'mil' ? 1_000 : 1_000_000;
      total += (group || 1) * multiplier;
      group = 0;
      sawNumber = true;
      continue;
    }
    const value = SPANISH_NUMBER_VALUES[token];
    if (value === undefined) return null;
    group += value;
    sawNumber = true;
  }

  return sawNumber ? total + group : null;
};

const normalizedSearchText = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR');

const addEvidenceId = (usedIds: string[], id: string): void => {
  if (usedIds.includes(id)) return;
  if (usedIds.length < 500) {
    usedIds.push(id);
  }
};

export interface UnsupportedClaimsReport {
  unsupportedNumberWords: string[];
  unsupportedNumericTokens: string[];
  hasUnsupportedClaims: boolean;
}

export const inspectPotentialUnsupportedClaims = (
  text: string,
  catalog: FactCatalog
): UnsupportedClaimsReport => {
  const numericIndex = new Map<string, string[]>();
  for (const [id, fact] of catalog) {
    if (typeof fact.rawValue === 'number') {
      const normalized = normalizeNumericToken(String(fact.rawValue));
      if (normalized) {
        const ids = numericIndex.get(normalized) ?? [];
        if (!ids.includes(id)) ids.push(id);
        numericIndex.set(normalized, ids);
      }
      for (const formattedToken of fact.formatted.match(NUMERIC_TOKEN_PATTERN) ?? []) {
        const normFormatted = normalizeNumericToken(formattedToken);
        if (normFormatted) {
          const ids = numericIndex.get(normFormatted) ?? [];
          if (!ids.includes(id)) ids.push(id);
          numericIndex.set(normFormatted, ids);
        }
      }
    }
    if (typeof fact.rawValue === 'string' && id.endsWith('.label')) {
      for (const labelToken of fact.rawValue.match(NUMERIC_TOKEN_PATTERN) ?? []) {
        const normLabel = normalizeNumericToken(labelToken);
        if (normLabel) {
          const ids = numericIndex.get(normLabel) ?? [];
          if (!ids.includes(id)) ids.push(id);
          numericIndex.set(normLabel, ids);
        }
      }
    }
  }

  const unsupportedNumberWords: string[] = [];
  const textWithNumberWordsRemoved = text.replace(
    SPANISH_NUMBER_SEQUENCE_PATTERN,
    (phrase) => {
      const parsed = parseSpanishNumber(phrase);
      if (parsed === null) return phrase;
      const matchingIds = numericIndex.get(String(parsed));
      if (!matchingIds || matchingIds.length === 0) {
        unsupportedNumberWords.push(phrase);
      }
      return ' ';
    }
  );

  const unsupportedNumericTokens: string[] = [];
  for (const token of textWithNumberWordsRemoved.match(NUMERIC_TOKEN_PATTERN) ?? []) {
    const normalized = normalizeNumericToken(token);
    const matchingIds = normalized ? numericIndex.get(normalized) : undefined;
    if (!matchingIds || matchingIds.length === 0) {
      unsupportedNumericTokens.push(token);
    }
  }

  return {
    unsupportedNumberWords,
    unsupportedNumericTokens,
    hasUnsupportedClaims: unsupportedNumberWords.length > 0 || unsupportedNumericTokens.length > 0
  };
};

const addTrustedLiteralEvidence = (
  text: string,
  catalog: FactCatalog,
  usedIds: string[],
  strict = false
): void => {
  const numericIndex = new Map<string, string[]>();
  const addIndexValue = (value: string, id: string): void => {
    const normalized = normalizeNumericToken(value);
    if (!normalized) return;
    const ids = numericIndex.get(normalized) ?? [];
    if (!ids.includes(id)) ids.push(id);
    numericIndex.set(normalized, ids);
  };

  for (const [id, fact] of catalog) {
    if (typeof fact.rawValue === 'number') {
      addIndexValue(String(fact.rawValue), id);
      for (const formattedToken of fact.formatted.match(NUMERIC_TOKEN_PATTERN) ?? []) {
        addIndexValue(formattedToken, id);
      }
    }
    if (typeof fact.rawValue === 'string' && id.endsWith('.label')) {
      for (const labelToken of fact.rawValue.match(NUMERIC_TOKEN_PATTERN) ?? []) {
        addIndexValue(labelToken, id);
      }
    }
  }

  const textWithNumberWordsRemoved = text.replace(
    SPANISH_NUMBER_SEQUENCE_PATTERN,
    (phrase) => {
      const parsed = parseSpanishNumber(phrase);
      if (parsed === null) return phrase;
      const matchingIds = numericIndex.get(String(parsed));
      if (!matchingIds || matchingIds.length === 0) {
        if (strict) throw new UngroundedAnswerFailure('literal_number');
        return phrase;
      }
      for (const id of matchingIds) addEvidenceId(usedIds, id);
      return ' ';
    }
  );
  if (strict && NUMBER_WORD_PATTERN.test(textWithNumberWordsRemoved)) {
    throw new UngroundedAnswerFailure('literal_number');
  }

  for (const token of text.match(NUMERIC_TOKEN_PATTERN) ?? []) {
    const normalized = normalizeNumericToken(token);
    const matchingIds = normalized ? numericIndex.get(normalized) : undefined;
    if (!matchingIds || matchingIds.length === 0) {
      if (strict) throw new UngroundedAnswerFailure('literal_number');
      continue;
    }
    for (const id of matchingIds) addEvidenceId(usedIds, id);
  }

  const normalizedText = normalizedSearchText(text);
  for (const [id, fact] of catalog) {
    if (typeof fact.rawValue !== 'string' || fact.rawValue.length < 3) continue;
    const formatted = normalizedSearchText(fact.formatted);
    if (formatted.length >= 3 && normalizedText.includes(formatted)) {
      addEvidenceId(usedIds, id);
    }
  }
};

export const renderGroundedAnswer = (
  template: string | null,
  catalog: FactCatalog,
  options: { allowLiteralNumbers?: boolean; strictLiteralNumbers?: boolean } = {}
): { answer: string; evidence: ExactEvidence[] } => {
  const trimmed = template?.trim() ?? '';
  if (!trimmed) throw new UngroundedAnswerFailure('empty_answer');
  const normalizedTemplate = stripRedundantFactSuffixes(
    normalizeKnownFactPlaceholders(
      normalizeFactPlaceholderAliases(groundTrustedMonthYears(trimmed, catalog), catalog),
      catalog
    )
  );

  const usedIds: string[] = [];
  const withoutPlaceholders = normalizedTemplate.replace(PLACEHOLDER_PATTERN, (_match, id: string) => {
    const fact = catalog.get(id);
    if (!fact) throw new UngroundedAnswerFailure('unknown_fact', id);
    if (!usedIds.includes(id) && usedIds.length < 500) {
      usedIds.push(id);
    }
    return '';
  });

  const unresolvedMatch = withoutPlaceholders.match(UNRESOLVED_PLACEHOLDER_PATTERN);
  if (unresolvedMatch) {
    throw new UngroundedAnswerFailure('unknown_fact', unresolvedMatch[0]);
  }

  const isStrict = options.strictLiteralNumbers ?? false;
  addTrustedLiteralEvidence(withoutPlaceholders, catalog, usedIds, isStrict);

  const answer = normalizedTemplate.replace(
    PLACEHOLDER_PATTERN,
    (_match, id: string) => catalog.get(id)!.formatted
  );
  if (answer.length > 16_000) throw new UngroundedAnswerFailure('empty_answer');
  return {
    answer,
    evidence: usedIds.map((id) => {
      const { rawValue: _rawValue, ...evidence } = catalog.get(id)!;
      return evidence;
    })
  };
};
