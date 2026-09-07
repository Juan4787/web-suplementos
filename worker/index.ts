import {
  errorResponse,
  isSameOrigin,
  jsonResponse,
  methodNotAllowed,
  noContentResponse
} from './http';
import { handleAIRequest } from './ai/handler';

const AI_DISABLED_ERROR = {
  kind: 'temporary' as const,
  message: 'El asistente todavía no está habilitado.',
  nextAction: 'Falta confirmar que el proveedor principal no conserve las consultas.',
  retryable: false
};

const handleAiRoute = async (request: Request, env: Env): Promise<Response> => {
  if (!isSameOrigin(request)) {
    return errorResponse(
      {
        kind: 'permission',
        message: 'No se puede usar el asistente desde este sitio.',
        retryable: false
      },
      403,
    );
  }

  if (request.method === 'OPTIONS') return noContentResponse();
  if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');

  if (String(env.AI_ENABLED) !== 'true') return errorResponse(AI_DISABLED_ERROR, 503);
  return handleAIRequest(request, env);
};

const handleApiRoute = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/api/ai') return handleAiRoute(request, env);
  if (url.pathname === '/api/health') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return jsonResponse({ status: 'ok' });
  }
  return errorResponse(
    {
      kind: 'validation',
      message: 'No encontramos esa operación.',
      retryable: false
    },
    404,
  );
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApiRoute(request, env);
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-cache, no-store, must-revalidate');
      headers.set('pragma', 'no-cache');
      headers.set('expires', '0');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    return response;
  }
} satisfies ExportedHandler<Env>;
