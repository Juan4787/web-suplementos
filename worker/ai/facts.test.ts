import { describe, expect, it } from 'vitest';
import {
  addToolFacts,
  prepareToolResultForModel,
  renderGroundedAnswer,
  sanitizeToolResult,
  type FactCatalog
} from './facts';
import { UngroundedAnswerFailure } from './errors';

describe('exact facts contract', () => {
  it('reduce el resultado a campos autorizados y renderiza cifras desde PostgreSQL', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_inventory_status',
        phone: 'no debe salir',
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            phone: 'no debe salir',
            facts: {
              'stock.available_units': 4,
              'stock.suggested_purchase_units': 6
            }
          }
        ]
      },
      'get_inventory_status'
    );
    expect(JSON.stringify(safe)).not.toContain('phone');
    expect(safe.products?.[0]?.facts).toEqual({
      'product:CREA300.stock.available_units': 4,
      'product:CREA300.stock.suggested_purchase_units': 6
    });

    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);
    const rendered = renderGroundedAnswer(
      'Quedan {{fact:product:CREA300.stock.available_units}} unidades y conviene comprar {{fact:product:CREA300.stock.suggested_purchase_units}}.',
      catalog
    );

    expect(rendered.answer).toBe('Quedan 4 unidades y conviene comprar 6.');
    expect(rendered.evidence).toHaveLength(2);
    expect(rendered.evidence[0]?.label).toContain('Creatina');
  });

  it('rechaza cifras literales y facts inexistentes', () => {
    const catalog: FactCatalog = new Map();
    expect(() => renderGroundedAnswer('Vendiste 10 unidades.', catalog)).toThrow(UngroundedAnswerFailure);
    expect(() => renderGroundedAnswer('{{fact:sales.inventado}}', catalog)).toThrow(
      UngroundedAnswerFailure
    );
  });

  it('verifica cantidades de negocio escritas con palabras contra los facts', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_sales_summary',
        facts: { 'sales.units': 10, 'sales.units_total': 34 }
      },
      'get_sales_summary'
    );
    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);

    const spelled = renderGroundedAnswer('Vendiste diez unidades.', catalog);
    expect(spelled.answer).toBe('Vendiste diez unidades.');
    expect(spelled.evidence).toHaveLength(1);
    const composite = renderGroundedAnswer('Vendiste treinta y cuatro unidades.', catalog);
    expect(composite.answer).toBe('Vendiste treinta y cuatro unidades.');
    expect(composite.evidence).toHaveLength(1);
    expect(() => renderGroundedAnswer('Vendiste una unidad.', catalog)).toThrow(
      UngroundedAnswerFailure
    );
    expect(renderGroundedAnswer('Vendiste {{fact:sales.units}} unidades.', catalog).answer).toBe(
      'Vendiste 10 unidades.'
    );
  });

  it('normaliza solo placeholders sin prefijo que coinciden exactamente con una fact conocida', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_inventory_status',
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina',
            facts: { 'stock.available_units': 4 }
          }
        ]
      },
      'get_inventory_status'
    );
    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);

    expect(
      renderGroundedAnswer(
        'Hay {{product:CREA300.stock.available_units}} unidades disponibles.',
        catalog
      ).answer
    ).toBe('Hay 4 unidades disponibles.');
    expect(() => renderGroundedAnswer('Hay {{product:INVENTADO.stock.available_units}}.', catalog)).toThrow(
      UngroundedAnswerFailure
    );
  });

  it('entrega etiquetas legibles al modelo y conserva su grounding', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        facts: { 'catalog.active_product_count': 1 },
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina monohidrato · 300 g',
            facts: {}
          }
        ]
      },
      'get_product_catalog'
    );
    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);

    expect(prepareToolResultForModel(safe).products?.[0]?.label).toBe('Creatina monohidrato · 300 g');
    expect(
      renderGroundedAnswer('Tenés {{fact:product:CREA300.label}}.', catalog).answer
    ).toBe('Tenés Creatina monohidrato · 300 g.');
  });

  it('formatea precios del catálogo y contadores vacíos como evidencia exacta', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        facts: { 'catalog.returned_product_count': 1 },
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            facts: { 'catalog.price_cents': 5000000, 'catalog.price_rank': 1 }
          }
        ]
      },
      'get_product_catalog'
    );
    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);

    const rendered = renderGroundedAnswer(
      '{{fact:product:CREA300.label}} cuesta {{fact:product:CREA300.catalog.price_cents}}.',
      catalog
    );
    expect(rendered.answer).toContain('Creatina · 300 g');
    expect(rendered.answer).toContain('$');
    expect(rendered.evidence).toHaveLength(2);
  });

  it('rechaza referencias internas o resultados sobredimensionados', () => {
    expect(() =>
      sanitizeToolResult(
        {
          schemaVersion: 'ai-facts/v1',
          tool: 'get_inventory_status',
          products: [{ ref: 'product:uuid-no-permitido', label: 'Producto', facts: {} }]
        },
        'get_inventory_status'
      )
    ).toThrow('INVALID_TOOL_RESULT');
  });

  it('convierte basis points internos a un porcentaje inequívoco antes del modelo', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'compare_sales_periods',
        facts: { 'change.revenue_basis_points': 1250 }
      },
      'compare_sales_periods'
    );
    expect(safe.facts).toEqual({ 'change.revenue_percent': 12.5 });

    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);
    expect(renderGroundedAnswer('{{fact:change.revenue_percent}}', catalog).answer).toBe('12,5 %');
    expect(renderGroundedAnswer('{{fact:change.revenue_percent}}%', catalog).answer).toBe('12,5 %');
    expect(renderGroundedAnswer('{{fact:change.revenue_percent}} puntos básicos', catalog).answer).toBe(
      '12,5 %'
    );
  });

  it('conserva como sin dato un porcentaje no calculable por falta de ventas', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'compare_sales_periods',
        facts: { 'change.revenue_basis_points': null }
      },
      'compare_sales_periods'
    );
    expect(safe.facts).toEqual({ 'change.revenue_percent': null });

    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);
    expect(renderGroundedAnswer('{{fact:change.revenue_percent}}', catalog).answer).toBe('Sin dato');
  });

  it('fundamenta un año unido a un mes solo cuando coincide con el período consultado', () => {
    const safe = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_sales_summary',
        period: {
          from: '2026-08-01',
          to: '2026-08-31',
          timezone: 'America/Argentina/Buenos_Aires'
        },
        facts: { 'sales.revenue_cents': 12345600 }
      },
      'get_sales_summary'
    );
    expect(safe.facts?.['period.from_year']).toBe('2026');

    const catalog: FactCatalog = new Map();
    addToolFacts(catalog, safe);
    const rendered = renderGroundedAnswer(
      'En agosto de 2026 vendiste {{fact:sales.revenue_cents}}.',
      catalog
    );
    expect(rendered.answer).toContain('agosto de 2026');
    expect(rendered.evidence).toHaveLength(2);
    expect(() => renderGroundedAnswer('Vendiste 2026 unidades.', catalog)).toThrow(
      UngroundedAnswerFailure
    );
    expect(() => renderGroundedAnswer('En agosto de 2025 vendiste mucho.', catalog)).toThrow(
      UngroundedAnswerFailure
    );
  });
});
