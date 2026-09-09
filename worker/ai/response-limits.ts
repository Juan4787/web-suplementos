import { withAbortSignal } from '../../src/lib/abortable';

export const readLimitedResponseText = async (response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> => {
  const declaredLength = Number.parseInt(response.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  let complete = false;

  try {
    while (true) {
      const { done, value } = await (signal ? withAbortSignal(() => reader.read(), signal) : reader.read());
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

export const parseJsonSafely = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
