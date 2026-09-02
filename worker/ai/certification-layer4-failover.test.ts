import { describe, expect, it, vi } from 'vitest';
import { ProviderCircuitBreaker } from './circuit-breaker';
import { Deadline } from './deadline';
import { ProviderFailure } from './errors';
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

class MockProviderWithTiming implements AIProvider {
  constructor(
    readonly key: 'groq' | 'cloudflare',
    private readonly actions: Array<{
      delayMs?: number;
      response?: CanonicalAIResponse;
      failure?: ProviderFailure;
    }>,
    private readonly advanceClock?: (ms: number) => void
  ) {}

  public recordedRequests: CanonicalAIRequest[] = [];
  public remainingDeadlines: number[] = [];

  async generate(
    _model: ModelDefinition,
    request: CanonicalAIRequest,
    deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    this.recordedRequests.push(request);
    this.remainingDeadlines.push(deadline.remainingMs());

    const next = this.actions.shift();
    if (!next) throw new Error(`Sin acciones encoladas para ${this.key}`);

    if (next.delayMs && this.advanceClock) {
      this.advanceClock(next.delayMs);
    }

    if (next.failure) throw next.failure;
    return next.response!;
  }
}

describe('Certificación Capa 4: Failover Robusto GPT-OSS -> GLM', () => {
  it('Falla antes de hacer nada (503): conmuta limpiamente a GLM preservando la política sticky', async () => {
    const groq = new MockProviderWithTiming('groq', [
      {
        failure: new ProviderFailure('groq', 'server', {
          retrySameProvider: false,
          fallbackEligible: true
        })
      }
    ]);

    const cloudflare = new MockProviderWithTiming('cloudflare', [
      {
        response: {
          modelKey: 'glm_4_7_flash_cf_v1',
          provider: 'cloudflare',
          text: 'Hola, soy el asistente comercial. ¿En qué te puedo asesorar hoy?',
          toolCalls: [],
          finishReason: 'complete'
        }
      }
    ]);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: vi.fn(),
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: 'Buenas tardes',
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    expect(result.provider).toBe('cloudflare');
    expect(result.modelKey).toBe('glm_4_7_flash_cf_v1');
    expect(result.fallbackUsed).toBe(true);
    expect(result.providerTransitions).toBe(1);
    expect(result.answer).toContain('asistente comercial');
  });

  it('Falla por 429 (rate limit): GLM toma el control y responde con éxito', async () => {
    const groq = new MockProviderWithTiming('groq', [
      {
        failure: new ProviderFailure('groq', 'rate_limit', {
          retrySameProvider: false,
          fallbackEligible: true,
          openCircuitMs: 60_000
        })
      }
    ]);

    const cloudflare = new MockProviderWithTiming('cloudflare', [
      {
        response: {
          modelKey: 'glm_4_7_flash_cf_v1',
          provider: 'cloudflare',
          text: 'Tus ventas cobradas están en orden.',
          toolCalls: [],
          finishReason: 'complete'
        }
      }
    ]);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: vi.fn(),
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: '¿Cómo viene el día?',
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);
    expect(result.provider).toBe('cloudflare');
    expect(result.fallbackUsed).toBe(true);
    expect(result.providerTransitions).toBe(1);
  });

  it('Timeout compartido: GPT consume parte del deadline y GLM recibe estrictamente el tiempo restante', async () => {
    let nowTime = 1000;
    const fakeNow = () => nowTime;
    const advance = (ms: number) => {
      nowTime += ms;
    };

    const deadline = new Deadline(25_000, fakeNow);

    // Groq demora 15.000 ms y arroja timeout
    const groq = new MockProviderWithTiming(
      'groq',
      [
        {
          delayMs: 15_000,
          failure: new ProviderFailure('groq', 'timeout', {
            retrySameProvider: false,
            fallbackEligible: true
          })
        }
      ],
      advance
    );

    // Cloudflare recibe la petición con el tiempo restante (~10.000 ms), demora 3.000 ms y responde
    const cloudflare = new MockProviderWithTiming(
      'cloudflare',
      [
        {
          delayMs: 3_000,
          response: {
            modelKey: 'glm_4_7_flash_cf_v1',
            provider: 'cloudflare',
            text: 'Respuesta completada dentro del tiempo remanente.',
            toolCalls: [],
            finishReason: 'complete'
          }
        }
      ],
      advance
    );

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: vi.fn(),
      deadline,
      now: fakeNow,
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: 'Consulta de stock',
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    expect(result.provider).toBe('cloudflare');
    expect(result.fallbackUsed).toBe(true);

    // Verificamos que GLM recibió estrictamente el tiempo restante de la ventana de 25s
    expect(cloudflare.remainingDeadlines[0]).toBeLessThanOrEqual(10_000);
    expect(cloudflare.remainingDeadlines[0]).toBeGreaterThanOrEqual(9_900);

    // El tiempo total consumido (15.000 + 3.000 = 18.000 ms) respetó el deadline global de 25s
    expect(nowTime - 1000).toBe(18_000);
  });

  it('Falla DESPUÉS de una tool: Groq ejecuta tool, cae con 503, GLM recibe transcript canónico completo, no repite tool y FactLedger no duplica evidence', async () => {
    const inventoryResult = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_inventory_status',
      facts: { 'inventory.returned_product_count': 1 },
      products: [
        {
          ref: 'product:CREA300',
          label: 'Creatina 300g',
          facts: {
            'stock.available_units': 4,
            'stock.suggested_purchase_units': 6
          }
        }
      ]
    };

    // 1. Groq pide tool
    // 2. Groq recibe resultado pero luego se cae con 503 al redactar
    const groq = new MockProviderWithTiming('groq', [
      {
        response: {
          modelKey: 'gpt_oss_120b_groq_v1',
          provider: 'groq',
          text: 'Consultando inventario...',
          toolCalls: [
            {
              id: 'call_inv_123',
              name: 'get_inventory_status',
              argumentsJson: '{"limit":5}'
            }
          ],
          finishReason: 'tool_call'
        }
      },
      {
        failure: new ProviderFailure('groq', 'server', {
          retrySameProvider: false,
          fallbackEligible: true
        })
      }
    ]);

    // 3. GLM toma el relevo: debe ver en su transcript la tool call y el tool result, sin volver a llamar la tool
    const cloudflare = new MockProviderWithTiming('cloudflare', [
      {
        response: {
          modelKey: 'glm_4_7_flash_cf_v1',
          provider: 'cloudflare',
          text:
            'Te quedan {{fact:product:CREA300.stock.available_units}} unidades de {{fact:product:CREA300.label}} ' +
            'y la compra sugerida es de {{fact:product:CREA300.stock.suggested_purchase_units}} unidades.',
          toolCalls: [],
          finishReason: 'complete'
        }
      }
    ]);

    const executeToolMock = vi.fn(async () => inventoryResult);

    const deps: OrchestratorDependencies = {
      providers: { groq, cloudflare },
      executeTool: executeToolMock,
      circuitBreaker: new ProviderCircuitBreaker()
    };

    const input: OrchestratorInput = {
      message: '¿Cuánto stock me queda de creatina?',
      history: [],
      context: testContext
    };

    const result = await orchestrate(input, deps);

    // La herramienta se ejecutó EXACTAMENTE 1 vez (GLM no la volvió a pedir)
    expect(executeToolMock).toHaveBeenCalledTimes(1);

    // El resultado final proviene de Cloudflare
    expect(result.provider).toBe('cloudflare');
    expect(result.modelKey).toBe('glm_4_7_flash_cf_v1');
    expect(result.fallbackUsed).toBe(true);
    expect(result.providerTransitions).toBe(1);

    // GLM recibió el transcript canónico completo con el mensaje tool
    const cfRequest = cloudflare.recordedRequests[0];
    expect(cfRequest).toBeDefined();
    const toolMsg = cfRequest?.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe('call_inv_123');
    expect(toolMsg?.content).toContain('CREA300');

    // La respuesta contiene los datos correctos
    expect(result.answer).toContain('4');
    expect(result.answer).toContain('Creatina 300g');
    expect(result.answer).toContain('6');

    // FactLedger no duplicó evidencias
    const availableEvidences = result.evidence.filter((e) => e.id.includes('stock.available_units'));
    expect(availableEvidences).toHaveLength(1);
    expect(availableEvidences[0]?.value).toBe(4);
  });
});
