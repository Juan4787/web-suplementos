import { describe, expect, it, vi } from 'vitest';
import { Deadline } from './deadline';
import { ProviderFailure } from './errors';
import {
  collectFactsFromToolResult,
  createFact,
  FactLedger,
  inferKind,
  inferUnit
} from './fact-ledger';
import {
  addToolFacts,
  formatFact,
  humanizeFactId,
  inspectPotentialUnsupportedClaims,
  renderGroundedAnswer,
  sanitizeToolResult,
  type FactCatalog
} from './facts';
import { MODEL_POLICY, MODEL_REGISTRY } from './model-registry';
import { orchestrate, type OrchestratorDependencies, type OrchestratorInput } from './orchestrator';
import { PROMPT_VERSION, buildSystemMessage } from './prompt';
import type { AIProvider } from './providers/provider';
import { TOOL_REGISTRY, toCanonicalToolResult } from './tools/registry';
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

const baseInput: OrchestratorInput = {
  message: '¿Cómo vienen las ventas y qué me sugerís para el fin de semana?',
  history: [],
  context: testContext
};

class MockProvider implements AIProvider {
  constructor(
    readonly key: 'groq' | 'cloudflare',
    private readonly responses: Array<CanonicalAIResponse | Error>
  ) {}

  public readonly recordedRequests: CanonicalAIRequest[] = [];

  async generate(
    _model: ModelDefinition,
    request: CanonicalAIRequest,
    _deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    this.recordedRequests.push(request);
    const next = this.responses.shift();
    if (!next) {
      throw new Error(`MockProvider [${this.key}] sin respuestas encoladas`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

describe('AI Certification Suite - Asesor Comercial Impulso', () => {
  it('certifica la versión del prompt y modelo de políticas unificado', () => {
    expect(PROMPT_VERSION).toBe('impulso_business_advisor_v2');
    expect(MODEL_POLICY.primary).toBe('gpt_oss_120b_groq_v1');
    expect(MODEL_POLICY.fallback).toBe('glm_4_7_flash_cf_v1');
    expect(MODEL_POLICY.maxProviderSwitches).toBe(1);

    const systemPrompt = buildSystemMessage(testContext).content;
    expect(systemPrompt).toContain('asesor comercial de Impulso Suplementos');
    expect(systemPrompt).toContain('español rioplatense');
    expect(systemPrompt).toContain('LIBERTAD DE ANÁLISIS');
    expect(systemPrompt).toContain('Podés proponer libremente estrategias, descuentos hipotéticos, combos');
  });

  it('certifica que FactLedger distingue con precisión hechos observados de derivados', () => {
    const rawObserved = createFact({
      id: 'sales.revenue_cents',
      label: 'Facturación cobrada',
      value: 12500000,
      displayValue: '$ 125.000',
      sourceTool: 'get_sales_summary'
    });
    const rawDerived = createFact({
      id: 'change.revenue_percent',
      label: 'Variación de facturación',
      value: 15.5,
      displayValue: '+15.5 %',
      sourceTool: 'compare_sales_periods'
    });

    expect(inferKind(rawObserved.id)).toBe('observed');
    expect(inferUnit(rawObserved.id)).toBe('currency');

    expect(inferKind(rawDerived.id)).toBe('derived');
    expect(inferUnit(rawDerived.id)).toBe('percentage');

    const ledger = new FactLedger();
    ledger.addAll([rawObserved, rawDerived]);
    expect(ledger.size()).toBe(2);

    const clientEvidence = ledger.toClient();
    expect(clientEvidence).toEqual([
      {
        id: 'sales.revenue_cents',
        label: 'Facturación cobrada',
        value: 12500000,
        formatted: '$ 125.000'
      },
      {
        id: 'change.revenue_percent',
        label: 'Variación de facturación',
        value: 15.5,
        formatted: '+15.5 %'
      }
    ]);
  });

  it('certifica la libertad conversacional para formular propuestas comerciales sin censura', () => {
    const catalog: FactCatalog = new Map();
    const safeToolData = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_sales_summary',
        facts: {
          'sales.revenue_cents': 20000000,
          'sales.estimated_margin_cents': 6000000
        }
      },
      'get_sales_summary'
    );
    addToolFacts(catalog, safeToolData);

    const strategicAnswer =
      'Las ventas cobradas fueron de {{fact:sales.revenue_cents}} con un margen de {{fact:sales.estimated_margin_cents}}. ' +
      'Para el fin de semana te recomiendo armar 2 combos promocionales con 15% de descuento en creatinas ' +
      'para mover stock parado y apuntar a sumar 10 pedidos adicionales.';

    const rendered = renderGroundedAnswer(strategicAnswer, catalog);
    expect(rendered.answer).toContain('200.000');
    expect(rendered.answer).toContain('60.000');
    expect(rendered.answer).toContain('2 combos promocionales');
    expect(rendered.answer).toContain('15% de descuento');
    expect(rendered.answer).toContain('10 pedidos adicionales');
    expect(rendered.evidence.length).toBeGreaterThanOrEqual(2);

    const auditReport = inspectPotentialUnsupportedClaims(rendered.answer, catalog);
    expect(auditReport.hasUnsupportedClaims).toBe(true);
    expect(auditReport.unsupportedNumericTokens).toContain('2');
    expect(auditReport.unsupportedNumericTokens).toContain('15');
    expect(auditReport.unsupportedNumericTokens).toContain('10');
  });

  it('certifica el ciclo completo con GPT-OSS resolviendo tool y respondiendo con análisis', async () => {
    const salesSummaryData = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_sales_summary',
      facts: {
        'sales.revenue_cents': 50000000,
        'sales.units': 25,
        'sales.order_count': 18
      }
    };

    const groq = new MockProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: 'Voy a consultar el resumen de ventas reciente.',
        toolCalls: [
          {
            id: 'call_sales_summary',
            name: 'get_sales_summary',
            argumentsJson: '{"from":"2026-08-01","to":"2026-09-01"}'
          }
        ],
        finishReason: 'tool_call'
      },
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text:
          'En el último mes registraste {{fact:sales.revenue_cents}} en 18 pedidos cobrados (25 unidades). ' +
          'El ticket promedio viene sólido. Para acelerar rotación este finde, podrías probar una promo 2x1 ' +
          'en los productos de menor movimiento y comunicar por WhatsApp a las 18 clientas habituales.',
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);

    const cloudflare = new MockProvider('cloudflare', []);

    const executeToolMock = vi.fn(async () => salesSummaryData);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: executeToolMock
    };

    const result = await orchestrate(baseInput, deps);

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('groq');
    expect(result.modelKey).toBe('gpt_oss_120b_groq_v1');
    expect(result.fallbackUsed).toBe(false);
    expect(result.providerTransitions).toBe(0);
    expect(result.usedTools).toEqual(['get_sales_summary']);
    expect(result.answer).toContain('500.000');
    expect(result.answer).toContain('promo 2x1');
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);
    expect(result.evidence.some((item) => item.label.includes('Facturación cobrada'))).toBe(true);
  });

  it('certifica el failover transparente de Groq a Cloudflare conservando el contexto multi-ronda', async () => {
    const catalogData = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_product_catalog',
      facts: {
        'catalog.active_product_count': 3,
        'catalog.returned_product_count': 3
      },
      products: [
        {
          ref: 'product:WHEY1000',
          label: 'Proteína Whey 1 kg',
          facts: {
            'catalog.price_cents': 3500000,
            'catalog.price_rank': 1
          }
        }
      ]
    };

    // Groq ejecuta la tool pero luego sufre una falla de red o límite 429
    const groq = new MockProvider('groq', [
      {
        modelKey: 'gpt_oss_120b_groq_v1',
        provider: 'groq',
        text: 'Consulto el catálogo para ver precios.',
        toolCalls: [
          {
            id: 'call_catalog_1',
            name: 'get_product_catalog',
            argumentsJson: '{}'
          }
        ],
        finishReason: 'tool_call'
      },
      new ProviderFailure('groq', 'rate_limit', {
        retrySameProvider: false,
        fallbackEligible: true
      })
    ]);

    // Cloudflare / GLM toma el transcript canónico y finaliza la respuesta
    const cloudflare = new MockProvider('cloudflare', [
      {
        modelKey: 'glm_4_7_flash_cf_v1',
        provider: 'cloudflare',
        text:
          'El producto de mayor valor es {{fact:product:WHEY1000.label}} a {{fact:product:WHEY1000.catalog.price_cents}}. ' +
          'Representa tu tope de gama. Si querés aumentar el volumen de ventas, te propongo ofrecer un 10% de beneficio ' +
          'por pago en efectivo o transferencia directa.',
        toolCalls: [],
        finishReason: 'complete'
      }
    ]);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: vi.fn(async () => catalogData)
    };

    const result = await orchestrate(
      { ...baseInput, message: '¿Cuál es el producto más caro y qué estrategia de precio me recomendás?' },
      deps
    );

    expect(result.provider).toBe('cloudflare');
    expect(result.modelKey).toBe('glm_4_7_flash_cf_v1');
    expect(result.fallbackUsed).toBe(true);
    expect(result.providerTransitions).toBe(1);
    expect(result.usedTools).toEqual(['get_product_catalog']);
    expect(result.answer).toContain('35.000');
    expect(result.answer).toContain('10% de beneficio');
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);

    // Verifica que Cloudflare recibió en el transcript el resultado de la tool ejecutada previamente por Groq
    const cfRequest = cloudflare.recordedRequests[0];
    expect(cfRequest).toBeDefined();
    const toolResultMessage = cfRequest?.messages.find((message) => message.role === 'tool');
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.content).toContain('WHEY1000');
  });

  it('certifica la existencia y subconjunto seguro JSON Schema de las 6 herramientas canónicas', () => {
    const requiredTools = [
      'get_sales_summary',
      'compare_sales_periods',
      'get_product_catalog',
      'get_inventory_status',
      'get_product_performance',
      'get_top_selling_products'
    ];

    for (const toolName of requiredTools) {
      const toolSpec = TOOL_REGISTRY[toolName];
      expect(toolSpec, `Falta la herramienta ${toolName}`).toBeDefined();
      expect(toolSpec?.definition.name).toBe(toolName);
      expect(toolSpec?.definition.parameters.type).toBe('object');
      expect(toolSpec?.definition.parameters.additionalProperties).toBe(false);
      expect(toolSpec?.interpretationRules).toBeDefined();
      expect(toolSpec?.interpretationRules?.length).toBeGreaterThan(0);
    }
  });
});
