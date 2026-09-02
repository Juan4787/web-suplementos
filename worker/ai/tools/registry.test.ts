import { describe, expect, it } from 'vitest';
import { toCanonicalToolResult, TOOL_REGISTRY, validateToolCall } from './registry';

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
      p_limit: 12,
      p_query: null
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

  it('construye un ToolResult canónico con datos, facts autorizados y reglas', () => {
    const rawData = { success: true, count: 25 };
    const safeResult = {
      schemaVersion: 'ai-facts/v1' as const,
      tool: 'get_product_catalog',
      facts: {
        'catalog.returned_product_count': 25
      }
    };
    const rules = ['catalog.price_rank: 1 es el más caro'];

    const canonicalResult = toCanonicalToolResult('get_product_catalog', rawData, safeResult, rules);

    expect(canonicalResult.data).toEqual(rawData);
    expect(canonicalResult.facts).toHaveLength(1);
    expect(canonicalResult.facts[0]?.id).toBe('catalog.returned_product_count');
    expect(canonicalResult.facts[0]?.value).toBe(25);
    expect(canonicalResult.interpretationRules).toEqual(rules);
  });

  it('verifica que todas las herramientas usan el subconjunto común y seguro de JSON Schema', () => {
    for (const [toolName, spec] of Object.entries(TOOL_REGISTRY)) {
      const params = spec.definition.parameters;
      expect(params.type, `${toolName} debe ser type: object`).toBe('object');
      expect(params.additionalProperties, `${toolName} debe ser additionalProperties: false`).toBe(false);

      for (const [propName, propDef] of Object.entries(params.properties as Record<string, Record<string, unknown>>)) {
        const allowedTypes = ['string', 'integer', 'number', 'boolean', 'array'];
        expect(allowedTypes, `${toolName}.${propName} type invalido`).toContain(propDef.type);
        expect(propDef.oneOf, `${toolName}.${propName} no debe tener oneOf`).toBeUndefined();
        expect(propDef.anyOf, `${toolName}.${propName} no debe tener anyOf`).toBeUndefined();
        expect(propDef.allOf, `${toolName}.${propName} no debe tener allOf`).toBeUndefined();
      }
    }
  });
});
