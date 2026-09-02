import type { ExactEvidence } from './types';
import type { SafeToolResult } from './facts';

export type FactKind = 'observed' | 'derived';

export type FactUnit =
  | 'currency'
  | 'units'
  | 'percentage'
  | 'count'
  | 'days'
  | 'ratio';

export interface BusinessFact {
  id: string;
  kind: FactKind;
  label: string;
  value: number | string;
  unit?: FactUnit;
  displayValue: string;
  sourceTool: string;
}

export const inferUnit = (id: string): FactUnit | undefined => {
  if (id.endsWith('_cents') || id === 'sales.revenue_cents' || id === 'sales.cost_cents') return 'currency';
  if (id.endsWith('_units') || id.endsWith('.units')) return 'units';
  if (id.endsWith('_percent') || id.endsWith('.percent')) return 'percentage';
  if (id.endsWith('_count') || id.endsWith('.order_count') || id.endsWith('.count')) return 'count';
  if (id.endsWith('_days') || id.endsWith('.days')) return 'days';
  if (id.endsWith('_ratio') || id.endsWith('.ratio')) return 'ratio';
  return undefined;
};

export const inferKind = (id: string): FactKind => {
  if (
    id.startsWith('change.') ||
    id.includes('_percent') ||
    id.includes('estimated_margin') ||
    id.includes('coverage_days') ||
    id.includes('suggested_purchase') ||
    id.includes('average_ticket')
  ) {
    return 'derived';
  }
  return 'observed';
};

export const createFact = (params: {
  id: string;
  label: string;
  value: number | string;
  kind?: FactKind;
  unit?: FactUnit;
  displayValue?: string;
  sourceTool: string;
}): BusinessFact => {
  const kind = params.kind ?? inferKind(params.id);
  const unit = params.unit ?? inferUnit(params.id);
  const displayValue = params.displayValue ?? String(params.value);

  return {
    id: params.id,
    kind,
    label: params.label,
    value: params.value,
    ...(unit !== undefined ? { unit } : {}),
    displayValue,
    sourceTool: params.sourceTool
  };
};

export const deduplicateFacts = (facts: readonly BusinessFact[]): BusinessFact[] => {
  const map = new Map<string, BusinessFact>();
  for (const fact of facts) {
    map.set(fact.id, fact);
  }
  return Array.from(map.values());
};

export type PrimitiveFact = string | number | boolean | null;

export const collectFactsFromToolResult = (
  toolName: string,
  result: SafeToolResult,
  helpers?: {
    humanizeFactId?: (id: string) => string;
    formatFact?: (id: string, value: PrimitiveFact) => string;
  }
): BusinessFact[] => {
  const facts: BusinessFact[] = [];
  const humanize = helpers?.humanizeFactId ?? ((id: string) => id.replaceAll('.', ' ').replaceAll('_', ' '));
  const format = helpers?.formatFact ?? ((_id: string, value: PrimitiveFact) => String(value ?? 'Sin dato'));

  for (const [id, value] of Object.entries(result.facts ?? {})) {
    if (value === undefined) continue;
    facts.push(
      createFact({
        id,
        label: humanize(id),
        value: typeof value === 'number' || typeof value === 'string' ? value : String(value ?? ''),
        displayValue: format(id, value),
        sourceTool: toolName
      })
    );
  }

  for (const product of result.products ?? []) {
    const labelId = `${product.ref}.label`;
    facts.push(
      createFact({
        id: labelId,
        label: 'Producto',
        value: product.label,
        displayValue: product.label,
        sourceTool: toolName
      })
    );

    const prefix = `${product.ref}.`;
    for (const [id, value] of Object.entries(product.facts)) {
      if (value === undefined) continue;
      const rawFactId = id.startsWith(prefix) ? id.slice(prefix.length) : id;
      facts.push(
        createFact({
          id,
          label: `${product.label}: ${humanize(rawFactId)}`,
          value: typeof value === 'number' || typeof value === 'string' ? value : String(value ?? ''),
          displayValue: format(rawFactId, value),
          sourceTool: toolName
        })
      );
    }
  }

  return facts;
};

export class FactLedger {
  private readonly facts = new Map<string, BusinessFact>();

  add(fact: BusinessFact): void {
    this.facts.set(fact.id, fact);
  }

  addAll(facts: readonly BusinessFact[]): void {
    for (const fact of facts) {
      this.facts.set(fact.id, fact);
    }
  }

  get(id: string): BusinessFact | undefined {
    return this.facts.get(id);
  }

  has(id: string): boolean {
    return this.facts.has(id);
  }

  getAll(): BusinessFact[] {
    return Array.from(this.facts.values());
  }

  size(): number {
    return this.facts.size;
  }

  toClient(): ExactEvidence[] {
    return Array.from(this.facts.values()).map((fact) => ({
      id: fact.id,
      label: fact.label,
      value: fact.value,
      formatted: fact.displayValue
    }));
  }

  serializeFactsForModel(): string {
    if (this.facts.size === 0) return '';
    return Array.from(this.facts.values())
      .map((fact) => `- ${fact.label}: ${fact.displayValue}`)
      .join('\n');
  }
}
