import { Deadline } from './deadline';
import {
  AgentDeadlineFailure,
  AgentLoopLimitFailure,
  ProviderFailure,
  ToolDependencyFailure
} from './errors';
import { assertProductionModelsReady } from './model-registry';
import { orchestrate } from './orchestrator';
import { GroqProvider } from './providers/groq';
import { WorkersAIProvider } from './providers/workers-ai';
import { countInputCharacters, parseAIRequest, readBearerToken } from './request';
import { SupabaseAIClient } from './supabase';
import { errorResponse, jsonResponse } from '../http';

const publicValidationError = () =>
  errorResponse(
    {
      kind: 'validation',
      message: 'No pudimos interpretar esa consulta.',
      nextAction: 'Escribí una pregunta breve y volvé a intentarlo.',
      retryable: false
    },
    400
  );

const publicErrorFor = (error: unknown): Response => {
  if (error instanceof ToolDependencyFailure) {
    if (error.kind === 'auth') {
      return errorResponse(
        {
          kind: 'auth',
          message: 'Tu sesión venció.',
          nextAction: 'Volvé a ingresar para continuar.',
          retryable: false
        },
        401
      );
    }
    if (error.kind === 'permission') {
      return errorResponse(
        {
          kind: 'permission',
          message: 'El asistente está disponible únicamente para la dueña.',
          nextAction: 'Ingresá con una cuenta de dueña habilitada.',
          retryable: false
        },
        403
      );
    }
  }

  if (
    error instanceof ProviderFailure ||
    error instanceof AgentDeadlineFailure ||
    error instanceof AgentLoopLimitFailure ||
    error instanceof ToolDependencyFailure
  ) {
    return errorResponse(
      {
        kind: 'temporary',
        message: 'El asistente no está disponible en este momento.',
        nextAction: 'Volvé a intentarlo más tarde. El resto de la aplicación sigue disponible.',
        retryable: true
      },
      503
    );
  }

  return errorResponse(
    {
      kind: 'unexpected',
      message: 'No pudimos completar la consulta.',
      nextAction: 'Volvé a intentarlo. Tus datos no fueron modificados.',
      retryable: true
    },
    500
  );
};

export const handleAIRequest = async (request: Request, env: Env): Promise<Response> => {
  if (String(env.AI_ENABLED) !== 'true') {
    return errorResponse(
      {
        kind: 'temporary',
        message: 'El asistente todavía no está habilitado.',
        nextAction: 'Falta confirmar que el proveedor principal no conserve las consultas.',
        retryable: false
      },
      503
    );
  }

  let accessToken: string;
  try {
    accessToken = readBearerToken(request);
  } catch (error) {
    return errorResponse(
      {
        kind: 'auth',
        message: 'Necesitás ingresar para usar el asistente.',
        nextAction: 'Iniciá sesión y volvé a intentarlo.',
        retryable: false
      },
      401
    );
  }

  try {
    assertProductionModelsReady(env);
  } catch {
    return errorResponse(
      {
        kind: 'temporary',
        message: 'El asistente todavía no está listo para usar datos reales.',
        nextAction: 'La certificación y los controles de privacidad deben quedar verificados.',
        retryable: false
      },
      503
    );
  }

  let input;
  try {
    input = await parseAIRequest(request);
  } catch {
    return publicValidationError();
  }

  const startedAt = Date.now();
  const requestDeadline = new Deadline(30_000);
  let requestId: string | null = null;
  let supabase: SupabaseAIClient | null = null;

  try {
    const client = new SupabaseAIClient(env, accessToken);
    supabase = client;
    const claim = await client.claim(countInputCharacters(input), requestDeadline);
    requestId = claim.requestId;

    if (!claim.allowed) {
      return errorResponse(
        {
          kind: 'temporary',
          message: 'El asistente alcanzó el límite de uso por ahora.',
          nextAction:
            claim.retryAfter === 'next_minute'
              ? 'Esperá un minuto antes de volver a intentarlo.'
              : 'Volvé a intentarlo mañana. El resto de la aplicación sigue disponible.',
          retryable: true
        },
        429
      );
    }

    const result = await orchestrate(
      { message: input.message, history: input.history, context: claim.context },
      {
        providers: {
          groq: new GroqProvider(env.GROQ_API_KEY),
          cloudflare: new WorkersAIProvider(env.AI)
        },
        executeTool: (call, deadline) => client.executeTool(call, deadline),
        deadline: requestDeadline
      }
    );

    await client.completeAudit(
      requestId,
      {
        status: 'success',
        modelUsed: result.modelKey,
        toolNames: result.usedTools,
        providerTransitions: result.providerTransitions,
        durationMs: Date.now() - startedAt
      },
      new Deadline(3_000)
    );

    return jsonResponse({
      answer: result.answer,
      model: result.modelLabel,
      provider: result.providerLabel,
      fallback: result.fallbackUsed,
      usedTools: result.usedTools,
      evidence: result.evidence.map(({ id: _id, ...evidence }) => evidence)
    });
  } catch (error) {
    if (requestId && supabase) {
      try {
        await supabase.completeAudit(
          requestId,
          {
            status: 'dependency_error',
            modelUsed: null,
            toolNames: [],
            providerTransitions: 0,
            durationMs: Date.now() - startedAt
          },
          new Deadline(3_000)
        );
      } catch {
        console.error(JSON.stringify({ event: 'ai_audit_completion_failed' }));
      }
    }
    return publicErrorFor(error);
  }
};
