import { describe, expect, it } from 'vitest';
import { validateToolCall } from './registry';

describe('AI tool registry', () => {
  it('resuelve el catálogo completo mediante una RPC sin argumentos', () => {
    const validated = validateToolCall({
      id: 'catalog_call',
      name: 'get_product_catalog',
      argumentsJson: '{}'
    });

    expect(validated.args).toEqual({});
    expect(validated.spec.rpcName).toBe('ai_get_product_catalog');
    expect(validated.spec.toRpcArgs(validated.args)).toEqual({});
  });

  it('incluye todo el inventario cuando el modelo omite onlyAttention', () => {
    const validated = validateToolCall({
      id: 'catalog_call',
      name: 'get_inventory_status',
      argumentsJson: '{}'
    });

    expect(validated.args).toEqual({ onlyAttention: false, limit: 12 });
    expect(validated.spec.toRpcArgs(validated.args)).toEqual({
      p_only_attention: false,
      p_limit: 12
    });
  });

  it('separa rendimiento específico del ranking general', () => {
    expect(() =>
      validateToolCall({
        id: 'performance_call',
        name: 'get_product_performance',
        argumentsJson: '{"from":"2026-01-01","to":"2026-09-01"}'
      })
    ).toThrow();

    const ranking = validateToolCall({
      id: 'ranking_call',
      name: 'get_top_selling_products',
      argumentsJson: '{"from":"2026-01-01","to":"2026-09-01"}'
    });
    expect(ranking.args).toEqual({ from: '2026-01-01', to: '2026-09-01', limit: 10 });
    expect(ranking.spec.rpcName).toBe('ai_get_top_selling_products');
  });
});
