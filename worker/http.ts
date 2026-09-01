export type PublicErrorKind =
  | 'validation'
  | 'auth'
  | 'permission'
  | 'business'
  | 'temporary'
  | 'unexpected';

export type PublicError = {
  kind: PublicErrorKind;
  message: string;
  nextAction?: string;
  retryable: boolean;
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

export const jsonResponse = <T>(body: T, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(JSON_HEADERS);
  if (headers) {
    new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

export const errorResponse = (
  error: PublicError,
  status: number,
  headers?: HeadersInit
): Response => jsonResponse({ error }, status, headers);

export const methodNotAllowed = (allow: string): Response =>
  errorResponse(
    {
      kind: 'validation',
      message: 'Esta acción no está disponible de esa manera.',
      nextAction: 'Usá el formulario de la aplicación para volver a intentarlo.',
      retryable: false
    },
    405,
    { Allow: allow }
  );

export const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
};

export const noContentResponse = (): Response =>
  new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
