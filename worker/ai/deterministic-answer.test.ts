import { describe, expect, it } from 'vitest';
import { sanitizeToolResult } from './facts';
import {
  buildDeterministicAnswerTemplate,
  requiresBusinessEvidence
} from './deterministic-answer';

describe('deterministic business answers', () => {
  it('exige evidencia para lecturas comerciales pero no para saludos ni escrituras rechazadas', () => {
    expect(requiresBusinessEvidence('¿Cuál es el más caro?')).toBe(true);
    expect(requiresBusinessEvidence('¿Cuál se vendió más?')).toBe(true);
    expect(requiresBusinessEvidence('¿Qué productos tengo?')).toBe(true);
    expect(requiresBusinessEvidence('hola')).toBe(false);
    expect(requiresBusinessEvidence('¿Sabés técnicas de venta?')).toBe(false);
    expect(requiresBusinessEvidence('¿Cómo puedo mejorar mis ventas?')).toBe(false);
    expect(requiresBusinessEvidence('Subí el precio de la creatina')).toBe(false);
  });

  it('construye un rescate de catálogo solo con facts exactas, sin mirar la pregunta', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            facts: { 'catalog.price_cents': 5000000, 'catalog.price_rank': 1 }
          },
          {
            ref: 'product:MAG60',
            label: 'Magnesio · 60 cápsulas',
            facts: { 'catalog.price_cents': 1500000, 'catalog.price_rank': 2 }
          }
        ]
      },
      'get_product_catalog'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:product:CREA300.label}}');
    expect(template).toContain('{{fact:product:CREA300.catalog.price_cents}}');
    expect(template).toContain('{{fact:product:MAG60.label}}');
  });

  it('entiende una formulación coloquial sobre qué producto está caro', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
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

    expect(buildDeterministicAnswerTemplate('¿Cuál te parece que está caro?', result)).toBe(
      buildDeterministicAnswerTemplate('¿Cuál es el producto más caro?', result)
    );
  });

  it('convierte un período sin ventas en una respuesta válida y auditable', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_top_selling_products',
        facts: {
          'performance.returned_product_count': 0,
          'performance.returned_units': 0
        },
        products: []
      },
      'get_top_selling_products'
    );

    expect(buildDeterministicAnswerTemplate('¿Cuál se vendió más?', result)).toBe(
      'No hay productos con ventas cobradas en el período consultado. Productos con ventas: {{fact:performance.returned_product_count}}.'
    );
  });

  it('construye un resumen de catálogo como rescate, sin depender de una segunda inferencia', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            facts: { 'catalog.price_cents': 5000000, 'catalog.price_rank': 1 }
          },
          {
            ref: 'product:MAG60',
            label: 'Magnesio · 60 cápsulas',
            facts: { 'catalog.price_cents': 1500000, 'catalog.price_rank': 2 }
          }
        ]
      },
      'get_product_catalog'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:product:CREA300.label}}');
    expect(template).toContain('{{fact:product:CREA300.catalog.price_cents}}');
    expect(template).toContain('{{fact:product:MAG60.label}}');
  });

  it('mantiene compacto el rescate cuando el catálogo es grande', () => {
    const products = Array.from({ length: 8 }, (_, index) => ({
      ref: `product:PROD${String(index + 1).padStart(2, '0')}`,
      label: `Producto ${index + 1}`,
      facts: { 'catalog.price_cents': (index + 1) * 100000 }
    }));
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        facts: { 'catalog.returned_product_count': products.length },
        products
      },
      'get_product_catalog'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:product:PROD01.label}}');
    expect(template).toContain('{{fact:product:PROD05.label}}');
    expect(template).not.toContain('{{fact:product:PROD06.label}}');
    expect(template).toContain('revisar otro producto');
  });

  it('resuelve un precio específico aunque la persona use un prefijo del producto', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_product_catalog',
        products: [
          {
            ref: 'product:CREATINA',
            label: 'Creatina monohidrato · 300 g',
            facts: { 'catalog.price_cents': 5000000, 'catalog.price_rank': 1 }
          },
          {
            ref: 'product:MAGNESIO',
            label: 'Magnesio · 60 cápsulas',
            facts: { 'catalog.price_cents': 1500000, 'catalog.price_rank': 2 }
          }
        ]
      },
      'get_product_catalog'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:product:CREATINA.label}}');
    expect(template).toContain('{{fact:product:CREATINA.catalog.price_cents}}');
  });

  it('deja un rescate de inventario con los hechos exactos', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_inventory_status',
        facts: {
          'inventory.attention_product_count': 1,
          'inventory.returned_product_count': 1
        },
        products: [
          {
            ref: 'product:CREATINA',
            label: 'Creatina · 300 g',
            status: 'critical',
            facts: {
              'stock.available_units': 1,
              'stock.incoming_units': 0,
              'stock.suggested_purchase_units': 8,
              'stock.coverage_days': 2
            }
          }
        ]
      },
      'get_inventory_status'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:inventory.returned_product_count}}');
    expect(template).toContain('{{fact:product:CREATINA.stock.suggested_purchase_units}}');
    expect(template).toContain('{{fact:product:CREATINA.stock.coverage_days}} días');
  });

  it('construye el producto más vendido a partir del máximo calculado', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_top_selling_products',
        facts: { 'performance.returned_product_count': 2 },
        products: [
          {
            ref: 'product:CREA300',
            label: 'Creatina · 300 g',
            facts: { 'performance.units': 8 }
          },
          {
            ref: 'product:MAG60',
            label: 'Magnesio · 60 cápsulas',
            facts: { 'performance.units': 2 }
          }
        ]
      },
      'get_top_selling_products'
    );

    const template = buildDeterministicAnswerTemplate(result);
    expect(template).toContain('{{fact:product:CREA300.label}}');
    expect(template).toContain('{{fact:product:CREA300.performance.units}}');
    expect(template).toContain('{{fact:product:MAG60.label}}');
  });

  it('resume una comparación con todos los cambios calculados por la base', () => {
    const result = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'compare_sales_periods',
        periods: {
          first: { from: '2026-07-01', to: '2026-07-31' },
          second: { from: '2026-08-01', to: '2026-08-31' },
          timezone: 'America/Argentina/Buenos_Aires'
        },
        facts: {
          'first.revenue_cents': 1000000,
          'first.estimated_margin_cents': 300000,
          'first.order_count': 10,
          'first.units': 25,
          'second.revenue_cents': 1200000,
          'second.estimated_margin_cents': 360000,
          'second.order_count': 12,
          'second.units': 30,
          'change.revenue_cents': 200000,
          'change.revenue_basis_points': 2000,
          'change.margin_cents': 60000,
          'change.margin_basis_points': 2000,
          'change.order_count': 2,
          'change.units': 5
        }
      },
      'compare_sales_periods'
    );

    expect(buildDeterministicAnswerTemplate('Compará las ventas', result)).toBe(
      'Período base ({{fact:period.first.from}} a {{fact:period.first.to}}): facturación {{fact:first.revenue_cents}}, margen {{fact:first.estimated_margin_cents}}, pedidos {{fact:first.order_count}} y unidades {{fact:first.units}}. Período comparado ({{fact:period.second.from}} a {{fact:period.second.to}}): facturación {{fact:second.revenue_cents}}, margen {{fact:second.estimated_margin_cents}}, pedidos {{fact:second.order_count}} y unidades {{fact:second.units}}. Cambio del segundo respecto del primero: facturación {{fact:change.revenue_cents}} ({{fact:change.revenue_percent}}), margen {{fact:change.margin_cents}} ({{fact:change.margin_percent}}), pedidos {{fact:change.order_count}} y unidades {{fact:change.units}}.'
    );
  });
});
