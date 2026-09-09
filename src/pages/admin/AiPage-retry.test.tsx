import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppError } from '@/domain/errors';
import AiPage from './AiPage';

const api = vi.hoisted(() => ({ askBusinessAi: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/app/env', () => ({ appEnv: { aiEnabled: true } }));
vi.mock('@/components/layout/AdminShell', () => ({ PageHeader: () => <h1>Asistente</h1> }));
vi.mock('@/components/layout/RoleGate', () => ({ RoleGate: ({ children }: PropsWithChildren) => <>{children}</> }));
afterEach(cleanup);

it('reintenta la misma pregunta y contexto sin duplicar mensajes ni perderla', async () => {
  api.askBusinessAi.mockRejectedValueOnce(new AppError('temporary', 'El asistente tardó demasiado en responder.', { retryable: true }))
    .mockResolvedValue({ answer: 'Creatina: $ 30.000.', usedTools: ['get_product_catalog'], evidence: [], model: 'Catálogo', fallback: false });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AiPage /></QueryClientProvider>);
  const question = '¿Qué precio tiene la creatina?';
  fireEvent.change(screen.getByRole('textbox'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar pregunta' }));
  fireEvent.click(await screen.findByRole('button', { name: /Intentar de nuevo/ }));
  await screen.findByText('Creatina: $ 30.000.');
  expect(screen.getAllByText(question)).toHaveLength(1);
  expect(api.askBusinessAi.mock.calls).toEqual([[question, []], [question, []]]);
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  client.clear();
});
