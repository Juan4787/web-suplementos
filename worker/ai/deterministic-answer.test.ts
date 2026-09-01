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
    expect(requiresBusinessEvidence('Subí el precio de la creatina')).toBe(false);
  });

  it('construye la respuesta de mayor precio solo con facts exactas', () => {
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

    expect(buildDeterministicAnswerTemplate('¿Cuál es el más caro?', result)).toBe(
      'El producto con mayor precio es {{fact:product:CREA300.label}}, a {{fact:product:CREA300.catalog.price_cents}}.'
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

    expect(buildDeterministicAnswerTemplate('¿Cuál se vendió más?', result)).toBe(
      'El producto más vendido en el período consultado fue {{fact:product:CREA300.label}}, con {{fact:product:CREA300.performance.units}} unidades vendidas.'
    );
  });
});
