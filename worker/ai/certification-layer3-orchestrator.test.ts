import { describe, expect, it, vi } from 'vitest';
import { ProviderCircuitBreaker } from './circuit-breaker';
import { Deadline } from './deadline';
import {
  inspectPotentialUnsupportedClaims,
  type FactCatalog
} from './facts';
import { orchestrate, type OrchestratorDependencies, type OrchestratorInput } from './orchestrator';
import type { AIProvider } from './providers/provider';
import type {
  CanonicalAIRequest,
  CanonicalAIResponse,
  ModelDefinition,
  RequestContext
} from './types';

const testContext: RequestContext = {
  currentDate: '2026-09-02',
  timezone: 'America/Argentina/Buenos_Aires',
  currency: 'ARS'
};

class ScriptedProvider implements AIProvider {
  constructor(
    readonly key: 'groq' | 'cloudflare',
    private readonly script: Array<CanonicalAIResponse | Error>
  ) {}

  public recordedCalls: CanonicalAIRequest[] = [];

  async generate(
    _model: ModelDefinition,
    request: CanonicalAIRequest,
    _deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    this.recordedCalls.push(request);
    const next = this.script.shift();
    if (!next) {
      throw new Error(`ScriptedProvider [${this.key}] no tiene más respuestas programadas`);
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('Certificación Capa 3: Tests Completos del Orquestador', () => {
  it('Camino normal sin tools: responde directamente a consultas conceptuales sin exigir hechos', async () => {
    const userMessage = '¿Qué estrategias suelen funcionar para vender productos de baja rotación?';
    const advisoryResponse =
      'Para productos con baja rotación te recomiendo tres caminos:\n' +
      '1. Armar combos con un producto estrella (ancla).\n' +
      '2. Lanzar promociones con fecha límite para generar urgencia.\n' +
      '3. Comunicar los beneficios específicos a clientes que ya te compran categorías afines.';

    const groq = new ScriptedProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: advisoryResponse,
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);
    const cloudflare = new ScriptedProvider('cloudflare', []);

    const executeToolMock = vi.fn();
    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: executeToolMock,
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: userMessage,
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    expect(executeToolMock).not.toHaveBeenCalled();
    expect(result.usedTools).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(result.provider).toBe('groq');
    expect(result.fallbackUsed).toBe(false);
    expect(result.answer).toContain('combos con un producto estrella');
  });

  it('Camino factual: consulta métricas de negocio mediante tool en 1 ronda con evidencia estricta', async () => {
    const userMessage = '¿Cuánto vendí este mes?';

    const groq = new ScriptedProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: 'Consulto las ventas registradas este mes.',
        toolCalls: [
          {
            id: 'call_sales_month',
            name: 'get_sales_summary',
            argumentsJson: '{"from":"2026-09-01","to":"2026-09-02"}'
          }
        ],
        finishReason: 'tool_call'
      },
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: 'En lo que va del mes registraste {{fact:sales.revenue_cents}} cobrados en {{fact:sales.units}} unidades.',
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);
    const cloudflare = new ScriptedProvider('cloudflare', []);

    const salesRpcResult = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_sales_summary',
      facts: {
        'sales.revenue_cents': 18500000,
        'sales.units': 12,
        'sales.order_count': 9
      }
    };

    const executeToolMock = vi.fn(async () => salesRpcResult);
    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: executeToolMock,
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: userMessage,
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(result.usedTools).toEqual(['get_sales_summary']);
    expect(result.provider).toBe('groq');
    expect(result.fallbackUsed).toBe(false);
    expect(result.answer).toContain('185.000');
    expect(result.answer).toContain('12');
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence.some((e) => e.id === 'sales.revenue_cents')).toBe(true);
  });

  it('Estratégica basada en datos: consulta rendimiento y formula recomendaciones libres basadas en hechos reales', async () => {
    const userMessage = '¿Qué producto mío promocionarías este fin de semana?';

    const rankingData = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_top_selling_products',
      facts: { 'ranking.returned_product_count': 2 },
      products: [
        {
          ref: 'product:CREA300',
          label: 'Creatina 300g',
          facts: { 'product.units': 35, 'product.revenue_cents': 150500000 }
        },
        {
          ref: 'product:WHEY1000',
          label: 'Proteína Whey 1kg',
          facts: { 'product.units': 8, 'product.revenue_cents': 28000000 }
        }
      ]
    };

    const groq = new ScriptedProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: 'Voy a revisar qué productos tienen mayor y menor rotación.',
        toolCalls: [
          {
            id: 'call_ranking',
            name: 'get_top_selling_products',
            argumentsJson: '{"from":"2026-08-01","to":"2026-09-02","limit":5}'
          }
        ],
        finishReason: 'tool_call'
      },
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text:
          'Tu líder indiscutido es {{fact:product:CREA300.label}} con {{fact:product:CREA300.product.units}} unidades vendidas. ' +
          'En cambio, {{fact:product:WHEY1000.label}} viene rezagado con solo {{fact:product:WHEY1000.product.units}} unidades. ' +
          'Yo promocionaría un combo: comprando la Creatina, llevás la Proteína con 20% de descuento. ' +
          'Aprovechás el tirón del producto estrella para traccionar el de menor salida.',
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);
    const cloudflare = new ScriptedProvider('cloudflare', []);

    const executeToolMock = vi.fn(async () => rankingData);
    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: executeToolMock,
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: userMessage,
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    expect(result.usedTools).toEqual(['get_top_selling_products']);
    expect(result.answer).toContain('Creatina 300g');
    expect(result.answer).toContain('Proteína Whey 1kg');
    expect(result.answer).toContain('combo');
    expect(result.answer).toContain('20% de descuento'); // Propuesta libre no censurada
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('Número hipotético: acepta propuestas como "10% de descuento" sin arrojar literal_number failure', async () => {
    const userMessage = '¿Qué opinás de hacer un 10% de descuento para liquidar el stock remanente?';

    const groq = new ScriptedProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text:
          'Un 10% de descuento es una táctica prudente porque no compromete severamente tu margen unitario ' +
          'y ofrece un estímulo psicológico suficiente para clientes indecisos. ' +
          'Te sugeriría ponerle vigencia de 48 horas para forzar la decisión de compra.',
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);
    const cloudflare = new ScriptedProvider('cloudflare', []);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: vi.fn(),
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: userMessage,
      history: [],
      context: testContext
    };

    // No debe arrojar excepción por "10%" ni por "48"
    const result = await orchestrate(input, deps);
    expect(result.answer).toContain('10%');
    expect(result.answer).toContain('48 horas');
    expect(result.provider).toBe('groq');
  });

  it('Número factual falso: el oráculo de auditoría detecta una afirmación falsa sin que producción falle', () => {
    const catalog: FactCatalog = new Map();
    // La base solo conoce estos datos reales:
    catalog.set('sales.estimated_margin_cents', {
      id: 'sales.estimated_margin_cents',
      label: 'Margen estimado',
      value: 3000000,
      formatted: '$ 30.000',
      rawValue: 3000000
    });

    // El modelo hipotéticamente alucina una cifra factual no respaldada: "Tu margen actual es 52%."
    const hallucinatedText = 'Tu margen actual es 52%. Deberías cuidarlo más.';

    // En producción: se entrega sin romper la experiencia
    const productionOutput = inspectPotentialUnsupportedClaims(hallucinatedText, catalog);

    // En auditoría/eval: se marca como FACTUALITY FAIL
    expect(productionOutput.hasUnsupportedClaims).toBe(true);
    expect(productionOutput.unsupportedNumericTokens).toContain('52');
  });
});
