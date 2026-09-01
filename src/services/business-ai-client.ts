import { AppError, type AppErrorKind } from '@/domain/errors';
import type { AIAnswer } from './business-api';

type PublicErrorPayload = {
  kind: AppErrorKind;
  message: string;
  nextAction?: string;
  retryable: boolean;
};

const PUBLIC_ERROR_KINDS = new Set<AppErrorKind>([
  'validation',
  'auth',
  'permission',
  'business',
  'temporary',
  'unexpected'
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsePublicError = (payload: unknown): PublicErrorPayload | null => {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const error = payload.error;
  if (
    typeof error.kind !== 'string' ||
    !PUBLIC_ERROR_KINDS.has(error.kind as AppErrorKind) ||
    typeof error.message !== 'string' ||
    error.message.length < 1 ||
    error.message.length > 300 ||
    typeof error.retryable !== 'boolean' ||
    (error.nextAction !== undefined &&
      (typeof error.nextAction !== 'string' || error.nextAction.length > 300))
  ) {
    return null;
  }
  return {
    kind: error.kind as AppErrorKind,
    message: error.message,
    retryable: error.retryable,
    ...(typeof error.nextAction === 'string' ? { nextAction: error.nextAction } : {})
  };
};

const parseSuccess = (payload: unknown): AIAnswer | null => {
  if (
    !isRecord(payload) ||
    typeof payload.answer !== 'string' ||
    payload.answer.length < 1 ||
    payload.answer.length > 4000 ||
    typeof payload.model !== 'string' ||
    payload.model.length > 100 ||
    typeof payload.provider !== 'string' ||
    payload.provider.length > 100 ||
    typeof payload.fallback !== 'boolean' ||
    !Array.isArray(payload.usedTools) ||
    payload.usedTools.length > 4 ||
    !payload.usedTools.every((tool) => typeof tool === 'string' && tool.length <= 64) ||
    !Array.isArray(payload.evidence) ||
    payload.evidence.length > 60
  ) {
    return null;
  }

  const evidence = payload.evidence.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.label !== 'string' ||
      item.label.length < 1 ||
      item.label.length > 300 ||
      typeof item.formatted !== 'string' ||
      item.formatted.length > 120 ||
      !(
        item.value === null ||
        typeof item.value === 'string' ||
        typeof item.value === 'number' ||
        typeof item.value === 'boolean'
      )
    ) {
      throw new Error('INVALID_AI_RESPONSE');
    }
    return { label: item.label, value: item.value, formatted: item.formatted };
  });

  return {
    answer: payload.answer,
    model: payload.model,
    provider: payload.provider,
    fallback: payload.fallback,
    usedTools: [...payload.usedTools] as string[],
    evidence
  };
};

export const requestBusinessAI = async (
  input: {
    message: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    accessToken: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<AIAnswer> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 40_000);
  let response: Response;

  try {
    response = await fetchImpl('/api/ai', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        message: input.message,
        history: input.history,
        modelPreference: 'auto'
      }),
      signal: controller.signal
    });
  } catch (error) {
    throw new AppError('temporary', 'No pudimos comunicarnos con el asistente.', {
      cause: error,
      retryable: true,
      nextAction: 'Revisá tu conexión y volvé a intentarlo. Tus datos no fueron modificados.'
    });
  } finally {
    window.clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AppError('unexpected', 'El asistente devolvió una respuesta incompleta.', {
      cause: error,
      retryable: true,
      nextAction: 'Volvé a intentarlo.'
    });
  }

  if (!response.ok) {
    const publicError = parsePublicError(payload);
    if (publicError) {
      throw new AppError(publicError.kind, publicError.message, {
        retryable: publicError.retryable,
        ...(publicError.nextAction ? { nextAction: publicError.nextAction } : {})
      });
    }
    throw new AppError('temporary', 'El asistente no está disponible en este momento.', {
      retryable: true,
      nextAction: 'Volvé a intentarlo más tarde. El resto de la aplicación sigue disponible.'
    });
  }

  let parsed: AIAnswer | null;
  try {
    parsed = parseSuccess(payload);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new AppError('unexpected', 'El asistente devolvió una respuesta incompleta.', {
      retryable: true,
      nextAction: 'Volvé a intentarlo.'
    });
  }
  return parsed;
};
