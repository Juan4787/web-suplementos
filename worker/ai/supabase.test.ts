import { describe, expect, it, vi } from 'vitest';
import { Deadline } from './deadline';
import { SupabaseAIClient } from './supabase';
import { validateToolCall } from './tools/registry';

const toolCall = validateToolCall({
  id: 'catalog_call',
  name: 'get_product_catalog',
  argumentsJson: '{}'
});

const environment = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'a'.repeat(40)
} as const;

describe('Supabase AI read-only boundary', () => {
  it('reintenta una tool read-only ante una falla temporal de transporte', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary' }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schemaVersion: 'ai-facts/v1',
            tool: 'get_product_catalog',
            products: []
          }),
          { status: 200 }
        )
      );

    const client = new SupabaseAIClient(environment, 't'.repeat(40), fetchMock);
    const result = await client.executeTool(toolCall, new Deadline(5_000));

    expect(result).toMatchObject({ schemaVersion: 'ai-facts/v1', tool: 'get_product_catalog' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('no reintenta cuando la sesión carece de permiso', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('FORBIDDEN', { status: 403 })
    );
    const client = new SupabaseAIClient(environment, 't'.repeat(40), fetchMock);

    await expect(client.executeTool(toolCall, new Deadline(5_000))).rejects.toMatchObject({
      kind: 'permission'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
