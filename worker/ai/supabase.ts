import { z } from 'zod';
import type { Deadline } from './deadline';
import { ToolDependencyFailure } from './errors';
import { parseJsonSafely, readLimitedResponseText } from './response-limits';
import type { RequestContext } from './types';
import type { ValidatedToolCall } from './tools/registry';

const allowedClaimSchema = z.object({
  allowed: z.literal(true),
  requestId: z.string().uuid(),
  context: z.object({
    currentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.literal('America/Argentina/Buenos_Aires'),
    currency: z.literal('ARS')
  })
});

const deniedClaimSchema = z.object({
  allowed: z.literal(false),
  requestId: z.string().uuid(),
  retryAfter: z.enum(['next_minute', 'next_utc_day'])
});

const claimSchema = z.discriminatedUnion('allowed', [allowedClaimSchema, deniedClaimSchema]);

export type ClaimResult =
  | { allowed: true; requestId: string; context: RequestContext }
  | { allowed: false; requestId: string; retryAfter: 'next_minute' | 'next_utc_day' };

const validateSupabaseUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co')) {
    throw new Error('INVALID_SUPABASE_URL');
  }
  return url.toString().replace(/\/$/, '');
};

export class SupabaseAIClient {
  private readonly baseUrl: string;

  constructor(
    env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = validateSupabaseUrl(env.SUPABASE_URL);
    if (env.SUPABASE_ANON_KEY.length < 20) throw new Error('INVALID_SUPABASE_KEY');
    if (accessToken.length < 20 || accessToken.length > 4096) throw new ToolDependencyFailure('auth');
    this.anonKey = env.SUPABASE_ANON_KEY;
  }

  private readonly anonKey: string;

  private async rpc(
    name: string,
    args: Record<string, unknown>,
    deadline: Deadline,
    maxResponseBytes: number
  ): Promise<unknown> {
    const timeout = deadline.signal(Math.min(5_000, deadline.remainingMs()));
    const fetchImpl = this.fetchImpl;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(args),
        signal: timeout.signal
      });
    } catch (error) {
      throw new ToolDependencyFailure('temporary', error);
    } finally {
      timeout.cleanup();
    }

    let text: string;
    try {
      text = await readLimitedResponseText(response, maxResponseBytes);
    } catch (error) {
      throw new ToolDependencyFailure('temporary', error);
    }

    if (!response.ok) {
      if (response.status === 401) throw new ToolDependencyFailure('auth');
      if (response.status === 403 || /FORBIDDEN/i.test(text)) {
        throw new ToolDependencyFailure('permission');
      }
      throw new ToolDependencyFailure('temporary');
    }

    if (text === '') return null;
    const payload = parseJsonSafely(text);
    if (payload === undefined) throw new ToolDependencyFailure('temporary');
    return payload;
  }

  async claim(inputChars: number, deadline: Deadline): Promise<ClaimResult> {
    const payload = await this.rpc('claim_ai_request', { p_input_chars: inputChars }, deadline, 8_000);
    const parsed = claimSchema.safeParse(payload);
    if (!parsed.success) throw new ToolDependencyFailure('temporary', parsed.error);
    return parsed.data;
  }

  async executeTool(validated: ValidatedToolCall, deadline: Deadline): Promise<unknown> {
    return this.rpc(
      validated.spec.rpcName,
      validated.spec.toRpcArgs(validated.args),
      deadline,
      32_000
    );
  }

  async completeAudit(
    requestId: string,
    audit: {
      status: 'success' | 'dependency_error' | 'invalid_request';
      modelUsed: string | null;
      toolNames: string[];
      providerTransitions: 0 | 1;
      durationMs: number;
    },
    deadline: Deadline
  ): Promise<void> {
    await this.rpc(
      'complete_ai_request',
      {
        p_request_id: requestId,
        p_status: audit.status,
        p_model_used: audit.modelUsed,
        p_tool_names: audit.toolNames,
        p_provider_transitions: audit.providerTransitions,
        p_duration_ms: Math.min(Math.max(Math.round(audit.durationMs), 0), 120_000)
      },
      deadline,
      8_000
    );
  }
}
