import { describe, expect, it, vi } from 'vitest';
import { ProviderCircuitBreaker } from './circuit-breaker';
import { ProviderFailure, ToolDependencyFailure } from './errors';
import { MODEL_REGISTRY } from './model-registry';
import { orchestrate, type OrchestratorDependencies } from './orchestrator';
import type { AIProvider } from './providers/provider';
import type {
  CanonicalAIRequest,
  CanonicalAIResponse,
  ModelDefinition,
  ProviderKey
} from './types';

type QueuedResult =
  | Error
  | ((model: ModelDefinition, request: CanonicalAIRequest) => CanonicalAIResponse);

class QueueProvider implements AIProvider {
  readonly calls: Array<{ model: ModelDefinition; request: CanonicalAIRequest }> = [];

  constructor(readonly key: ProviderKey, private readonly queue: QueuedResult[]) {}

  async generate(model: ModelDefinition, request: CanonicalAIRequest): Promise<CanonicalAIResponse> {
    this.calls.push({ model, request });
    const next = this.queue.shift();
    if (!next) throw new Error(`No queued response for ${this.key}`);
    if (next instanceof Error) throw next;
    return next(model, request);
  }
}

const final = (text: string) => (model: ModelDefinition): CanonicalAIResponse => ({
  text,
  toolCalls: [],
  finishReason: 'complete',
  modelKey: model.key,
  provider: model.provider
});

const tool = (name: string, argumentsJson = '{}') => (model: ModelDefinition): CanonicalAIResponse => ({
  text: null,
  toolCalls: [{ id: `${name}_call`, name, argumentsJson }],
  finishReason: 'tool_call',
  modelKey: model.key,
  provider: model.provider
});

const input = {
  message: '¿Qué producto necesita reposición?',
  history: [],
  context: {
    currentDate: '2026-09-01',
    timezone: 'America/Argentina/Buenos_Aires' as const,
    currency: 'ARS' as const
  }
};

const inventoryResult = {
  schemaVersion: 'ai-facts/v1',
  tool: 'get_inventory_status',
  products: [
    {
      ref: 'product:CREA300',
      label: 'Creatina · 300 g',
      status: 'low',
      facts: { 'stock.available_units': 4, 'stock.suggested_purchase_units': 6 }
    }
  ]
};

const dependencies = (
  groq: QueueProvider,
  cloudflare: QueueProvider,
  executeTool: OrchestratorDependencies['executeTool'] = vi.fn(async () => inventoryResult)
) => ({
  providers: { groq, cloudflare },
  executeTool,
  circuitBreaker: new ProviderCircuitBreaker(),
  sleep: async () => undefined,
  random: () => 0
});

describe('sticky AI orchestration', () => {
  it('ejecuta una tool validada y renderiza únicamente hechos exactos', async () => {
    const groq = new QueueProvider('groq', [
      tool('get_inventory_status'),
      final('Conviene reponer {{fact:product:CREA300.stock.suggested_purchase_units}} unidades de Creatina.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', []);

    const result = await orchestrate(input, dependencies(groq, cloudflare));
    expect(result.answer).toBe('Conviene reponer 6 unidades de Creatina.');
    expect(result.evidence).toHaveLength(1);
    expect(result.usedTools).toEqual(['get_inventory_status']);
    expect(result.providerTransitions).toBe(0);
    expect(groq.calls).toHaveLength(2);
    expect(cloudflare.calls).toHaveLength(0);
    expect(groq.calls[0]?.request.tools.map((tool) => tool.name)).toEqual(['get_inventory_status']);
  });

  it('cambia una sola vez y mantiene el fallback durante las rondas restantes', async () => {
    const groq = new QueueProvider('groq', [
      new ProviderFailure('groq', 'timeout', { retrySameProvider: false, fallbackEligible: true })
    ]);
    const cloudflare = new QueueProvider('cloudflare', [
      tool('get_inventory_status'),
      final('Hay {{fact:product:CREA300.stock.available_units}} unidades disponibles.')
    ]);

    const result = await orchestrate(input, dependencies(groq, cloudflare));
    expect(result.answer).toBe('Hay 4 unidades disponibles.');
    expect(result.providerTransitions).toBe(1);
    expect(result.fallbackUsed).toBe(true);
    expect(groq.calls).toHaveLength(1);
    expect(cloudflare.calls).toHaveLength(2);
  });

  it('hace como máximo un retry corto antes del fallback', async () => {
    const groq = new QueueProvider('groq', [
      new ProviderFailure('groq', 'server', { retrySameProvider: true, fallbackEligible: true }),
      final('No encontré información para resumir.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', []);

    const result = await orchestrate(
      { ...input, message: 'hola' },
      dependencies(groq, cloudflare)
    );
    expect(result.providerTransitions).toBe(0);
    expect(groq.calls).toHaveLength(2);
  });

  it('trata argumentos inválidos como salida del modelo y los reintenta en el fallback', async () => {
    const groq = new QueueProvider('groq', [tool('get_inventory_status', '{mal json')]);
    const cloudflare = new QueueProvider('cloudflare', [
      tool('get_inventory_status'),
      final('La compra sugerida es {{fact:product:CREA300.stock.suggested_purchase_units}}.')
    ]);
    const executeTool = vi.fn(async () => inventoryResult);

    const result = await orchestrate(input, dependencies(groq, cloudflare, executeTool));
    expect(result.providerTransitions).toBe(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('no cambia de modelo ante un error de autorización o base', async () => {
    const groq = new QueueProvider('groq', [tool('get_inventory_status')]);
    const cloudflare = new QueueProvider('cloudflare', []);
    const executeTool = vi.fn(async () => Promise.reject(new ToolDependencyFailure('permission')));

    await expect(orchestrate(input, dependencies(groq, cloudflare, executeTool))).rejects.toMatchObject({
      kind: 'permission'
    });
    expect(cloudflare.calls).toHaveLength(0);
  });

  it('no hace ping-pong cuando ambos proveedores fallan', async () => {
    const groq = new QueueProvider('groq', [
      new ProviderFailure('groq', 'timeout', { retrySameProvider: false, fallbackEligible: true })
    ]);
    const cloudflare = new QueueProvider('cloudflare', [
      new ProviderFailure('cloudflare', 'capacity', { retrySameProvider: false, fallbackEligible: true })
    ]);

    await expect(orchestrate(input, dependencies(groq, cloudflare))).rejects.toBeInstanceOf(
      ProviderFailure
    );
    expect(groq.calls).toHaveLength(1);
    expect(cloudflare.calls).toHaveLength(1);
  });

  it('rescata con datos exactos si el modelo insiste en llamar tools', async () => {
    const groq = new QueueProvider('groq', [
      tool('get_inventory_status'),
      tool('get_inventory_status'),
      tool('get_inventory_status')
    ]);
    const cloudflare = new QueueProvider('cloudflare', [tool('get_inventory_status')]);
    const executeTool = vi.fn(async () => inventoryResult);

    const result = await orchestrate(input, dependencies(groq, cloudflare, executeTool));
    expect(result.answer).toContain('Creatina');
    expect(result.answer).toContain('6');
    expect(result.providerTransitions).toBe(1);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(groq.calls).toHaveLength(3);
    expect(cloudflare.calls).toHaveLength(1);
  });

  it('rechaza una cifra literal y permite que el fallback la corrija', async () => {
    const groq = new QueueProvider('groq', [final('Hay 99 unidades.')]);
    const cloudflare = new QueueProvider('cloudflare', [
      tool('get_inventory_status'),
      final('Hay {{fact:product:CREA300.stock.available_units}} unidades.')
    ]);

    const result = await orchestrate(
      { ...input, message: '¿Qué stock tengo?' },
      dependencies(groq, cloudflare)
    );
    expect(result.providerTransitions).toBe(1);
    expect(result.answer).not.toContain('99');
  });

  it('usa el último resultado exacto si el proveedor cae durante la redacción', async () => {
    const groq = new QueueProvider('groq', [
      tool('get_inventory_status'),
      new ProviderFailure('groq', 'server', { retrySameProvider: false, fallbackEligible: true })
    ]);
    const cloudflare = new QueueProvider('cloudflare', [
      new ProviderFailure('cloudflare', 'server', { retrySameProvider: false, fallbackEligible: true })
    ]);

    const result = await orchestrate(input, dependencies(groq, cloudflare));
    expect(result.answer).toContain('Creatina');
    expect(result.answer).toContain('6');
    expect(result.usedTools).toEqual(['get_inventory_status']);
    expect(result.providerTransitions).toBe(1);
  });

  it('rechaza una respuesta factual vaga después de usar una tool y conserva sus hechos en el fallback', async () => {
    const groq = new QueueProvider('groq', [
      tool('get_inventory_status'),
      final('Conviene revisar el producto con menor cobertura.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', [
      final('La compra sugerida es {{fact:product:CREA300.stock.suggested_purchase_units}}.')
    ]);

    const result = await orchestrate(input, dependencies(groq, cloudflare));
    expect(result.answer).toBe('La compra sugerida es 6.');
    expect(result.evidence).toHaveLength(1);
    expect(result.providerTransitions).toBe(1);
    expect(cloudflare.calls[0]?.request.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('no acepta una respuesta comercial sin consultar una tool', async () => {
    const groq = new QueueProvider('groq', [final('No dispongo de precios.')]);
    const cloudflare = new QueueProvider('cloudflare', [
      tool('get_product_catalog'),
      final('El catálogo incluye {{fact:product:CREA300.label}} a {{fact:product:CREA300.catalog.price_cents}}.')
    ]);
    const catalogResult = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_product_catalog',
      facts: { 'catalog.active_product_count': 1, 'catalog.returned_product_count': 1 },
      products: [
        {
          ref: 'product:CREA300',
          label: 'Creatina · 300 g',
          facts: { 'catalog.price_cents': 5000000, 'catalog.price_rank': 1 }
        }
      ]
    };

    const result = await orchestrate(
      { ...input, message: '¿Cuál es el más caro?' },
      dependencies(groq, cloudflare, vi.fn(async () => catalogResult))
    );

    expect(result.answer).toContain('Creatina · 300 g');
    expect(result.answer).toContain('$');
    expect(result.providerTransitions).toBe(1);
    expect(result.usedTools).toEqual(['get_product_catalog']);
    expect(cloudflare.calls[0]?.request.tools.map((tool) => tool.name)).toEqual(['get_product_catalog']);
  });

  it('mantiene una segunda inferencia natural aunque el resultado esté vacío', async () => {
    const groq = new QueueProvider('groq', [
      tool(
        'get_top_selling_products',
        '{"from":"2026-01-01","to":"2026-09-01","limit":10}'
      ),
      final('No hay productos con ventas cobradas en el período consultado. Productos con ventas: {{fact:performance.returned_product_count}}.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', []);
    const emptyPerformance = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_top_selling_products',
      period: {
        from: '2026-01-01',
        to: '2026-09-01',
        timezone: 'America/Argentina/Buenos_Aires'
      },
      facts: {
        'performance.returned_product_count': 0,
        'performance.returned_units': 0
      },
      products: []
    };
    const executeTool = vi.fn(async () => emptyPerformance);

    const result = await orchestrate(
      { ...input, message: '¿Cuál se vendió más?' },
      dependencies(groq, cloudflare, executeTool)
    );

    expect(result.answer).toContain('No hay productos con ventas cobradas');
    expect(result.evidence).toHaveLength(1);
    expect(result.usedTools).toEqual(['get_top_selling_products']);
    expect(groq.calls).toHaveLength(2);
    expect(cloudflare.calls).toHaveLength(0);
  });

  it('mantiene una conversación general sin exigir una consulta de la tienda', async () => {
    const groq = new QueueProvider('groq', [
      final('Sí. Podés trabajar la propuesta de valor, la prueba social y el seguimiento de consultas.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', []);

    const result = await orchestrate(
      { ...input, message: '¿Sabés técnicas de venta?' },
      dependencies(groq, cloudflare)
    );

    expect(result.answer).toContain('propuesta de valor');
    expect(result.usedTools).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.providerTransitions).toBe(0);
    expect(groq.calls[0]?.request.tools).toHaveLength(0);
    expect(groq.calls[0]?.request.maxCompletionTokens).toBe(
      MODEL_REGISTRY.gpt_oss_120b_groq_v1.maxCompletionTokens
    );
  });

  it('conserva contexto reciente sin reenviar una conversación ilimitada al proveedor', async () => {
    const groq = new QueueProvider('groq', [final('Puedo seguir con ese tema.')]);
    const cloudflare = new QueueProvider('cloudflare', []);
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `mensaje ${index + 1}`
    }));

    await orchestrate(
      { ...input, message: 'hola', history },
      dependencies(groq, cloudflare)
    );

    expect(groq.calls[0]?.request.messages.filter((message) => message.role !== 'system')).toHaveLength(5);
    expect(groq.calls[0]?.request.messages.at(1)?.content).toBe('mensaje 3');
  });

  it('permite números ilustrativos en una respuesta general sin hechos de la tienda', async () => {
    const groq = new QueueProvider('groq', [
      final('Podés probar tres técnicas y medir cuál genera más consultas.')
    ]);
    const cloudflare = new QueueProvider('cloudflare', []);

    const result = await orchestrate(
      { ...input, message: '¿Cómo mejoro mi estrategia comercial?' },
      dependencies(groq, cloudflare)
    );

    expect(result.answer).toContain('tres técnicas');
    expect(result.usedTools).toEqual([]);
  });
});
