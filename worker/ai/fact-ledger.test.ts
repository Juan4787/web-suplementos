import { describe, expect, it } from 'vitest';
import {
  collectFactsFromToolResult,
  createFact,
  deduplicateFacts,
  FactLedger,
  inferKind,
  inferUnit,
  type BusinessFact
} from './fact-ledger';
import { formatFact, humanizeFactId, sanitizeToolResult } from './facts';

describe('Canonical BusinessFact & FactLedger contract', () => {
  it('infiere unidades y tipos observed vs derived correctamente', () => {
    expect(inferUnit('sales.revenue_cents')).toBe('currency');
    expect(inferUnit('stock.available_units')).toBe('units');
    expect(inferUnit('change.revenue_percent')).toBe('percentage');
    expect(inferUnit('sales.order_count')).toBe('count');
    expect(inferUnit('stock.coverage_days')).toBe('days');

    expect(inferKind('sales.revenue_cents')).toBe('observed');
    expect(inferKind('stock.available_units')).toBe('observed');
    expect(inferKind('change.revenue_percent')).toBe('derived');
    expect(inferKind('sales.estimated_margin_cents')).toBe('derived');
    expect(inferKind('stock.coverage_days')).toBe('derived');
  });

  it('crea instancias canónicas de BusinessFact', () => {
    const fact = createFact({
      id: 'stock.available_units',
      label: 'Stock disponible',
      value: 4,
      displayValue: '4 unidades',
      sourceTool: 'get_inventory_status'
    });

    expect(fact).toEqual<BusinessFact>({
      id: 'stock.available_units',
      kind: 'observed',
      label: 'Stock disponible',
      value: 4,
      unit: 'units',
      displayValue: '4 unidades',
      sourceTool: 'get_inventory_status'
    });
  });

  it('deduplica y acumula hechos en FactLedger de forma determinística', () => {
    const ledger = new FactLedger();
    const fact1 = createFact({
      id: 'catalog.price_cents',
      label: 'Precio',
      value: 1900000,
      displayValue: '$ 19.000',
      sourceTool: 'get_product_catalog'
    });
    const fact2 = createFact({
      id: 'catalog.price_cents',
      label: 'Precio actualizado',
      value: 1900000,
      displayValue: '$ 19.000',
      sourceTool: 'get_product_catalog'
    });
    const fact3 = createFact({
      id: 'stock.available_units',
      label: 'Stock disponible',
      value: 12,
      displayValue: '12',
      sourceTool: 'get_inventory_status'
    });

    ledger.add(fact1);
    expect(ledger.size()).toBe(1);
    expect(ledger.get('catalog.price_cents')?.label).toBe('Precio');

    // Sobreescribe id duplicado
    ledger.add(fact2);
    expect(ledger.size()).toBe(1);
    expect(ledger.get('catalog.price_cents')?.label).toBe('Precio actualizado');

    ledger.addAll([fact1, fact3]);
    expect(ledger.size()).toBe(2);
    expect(ledger.has('stock.available_units')).toBe(true);

    const deduped = deduplicateFacts([fact1, fact2, fact3]);
    expect(deduped).toHaveLength(2);
  });

  it('genera formato para cliente toClient() compatible con ExactEvidence', () => {
    const ledger = new FactLedger();
    ledger.addAll([
      createFact({
        id: 'stock.available_units',
        label: 'Stock disponible',
        value: 4,
        displayValue: '4 unidades',
        sourceTool: 'get_inventory_status'
      }),
      createFact({
        id: 'sales.revenue_cents',
        label: 'Facturación cobrada',
        value: 15000000,
        displayValue: '$ 150.000',
        sourceTool: 'get_sales_summary'
      })
    ]);

    const clientEvidence = ledger.toClient();
    expect(clientEvidence).toEqual([
      {
        id: 'stock.available_units',
        label: 'Stock disponible',
        value: 4,
        formatted: '4 unidades'
      },
      {
        id: 'sales.revenue_cents',
        label: 'Facturación cobrada',
        value: 15000000,
        formatted: '$ 150.000'
      }
    ]);
  });

  it('serializa hechos limpios para el modelo en formato texto', () => {
    const ledger = new FactLedger();
    ledger.add(
      createFact({
        id: 'stock.available_units',
        label: 'Stock disponible',
        value: 4,
        displayValue: '4 unidades',
        sourceTool: 'get_inventory_status'
      })
    );

    expect(ledger.serializeFactsForModel()).toBe('- Stock disponible: 4 unidades');
  });

  it('extrae hechos desde SafeToolResult usando collectFactsFromToolResult', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_inventory_status',
        facts: {
          'inventory.returned_product_count': 1
        },
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            facts: {
              'stock.available_units': 4,
              'stock.suggested_purchase_units': 6
            }
          }
        ]
      },
      'get_inventory_status'
    );

    const facts = collectFactsFromToolResult('get_inventory_status', safe, {
      humanizeFactId,
      formatFact
    });

    expect(facts.length).toBe(4);
    const ledger = new FactLedger();
    ledger.addAll(facts);

    expect(ledger.has('inventory.returned_product_count')).toBe(true);
    expect(ledger.has('product:CREA300.label')).toBe(true);
    expect(ledger.has('product:CREA300.stock.available_units')).toBe(true);
    expect(ledger.has('product:CREA300.stock.suggested_purchase_units')).toBe(true);

    const available = ledger.get('product:CREA300.stock.available_units');
    expect(available?.displayValue).toBe('4');
    expect(available?.label).toContain('Creatina · 300 g');
    expect(available?.kind).toBe('observed');
    expect(available?.unit).toBe('units');
  });
});
