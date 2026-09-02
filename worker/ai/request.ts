import { z } from 'zod';

const historyUserMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z.string().trim().min(1).max(1200)
  })
  .strict();

// Assistant answers can be longer than a user's question. They are still
// untrusted context, so they remain bounded and can never introduce a new
// role or privileged field.
const historyAssistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: z.string().trim().min(1).max(16_000)
  })
  .strict();

const historyMessageSchema = z.discriminatedUnion('role', [
  historyUserMessageSchema,
  historyAssistantMessageSchema
]);

const aiRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(1200),
    history: z.array(historyMessageSchema).max(6).default([]),
    modelPreference: z.literal('auto').default('auto')
  })
  .strict();

export type ValidatedAIRequest = z.infer<typeof aiRequestSchema>;

const MAX_REQUEST_BYTES = 64_000;

const readLimitedBody = async (request: Request): Promise<string> => {
  const declaredLength = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error('REQUEST_TOO_LARGE');
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
};

export const parseAIRequest = async (request: Request): Promise<ValidatedAIRequest> => {
  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('INVALID_CONTENT_TYPE');

  const body = await readLimitedBody(request);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('INVALID_JSON');
  }

  const parsed = aiRequestSchema.safeParse(payload);
  if (!parsed.success) throw new Error('INVALID_AI_REQUEST');
  return parsed.data;
};

export const readBearerToken = (request: Request): string => {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match || match[1]!.length < 20 || match[1]!.length > 4096) {
    throw new Error('MISSING_BEARER_TOKEN');
  }
  return match[1]!;
};

export const countInputCharacters = (request: ValidatedAIRequest): number =>
  request.message.length + request.history.reduce((total, message) => total + message.content.length, 0);
