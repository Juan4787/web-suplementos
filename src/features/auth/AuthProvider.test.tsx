import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthProvider';

const mock = vi.hoisted(() => ({
  getSession: vi.fn(), rpc: vi.fn(), signOut: vi.fn(), signInWithPassword: vi.fn(),
  listener: null as null | ((event: string, session: unknown) => void)
}));
vi.mock('@/app/env', () => ({ appEnv: { mode: 'supabase', isDemo: false } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: () => ({
  rpc: mock.rpc, auth: { getSession: mock.getSession, signOut: mock.signOut, signInWithPassword: mock.signInWithPassword,
    onAuthStateChange: (listener: typeof mock.listener) => { mock.listener = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; }
  }
}) }));
const owner = { id: 'owner', role: 'owner', displayName: 'Dueña', email: 'owner@example.test', active: true };
const session = { user: { id: owner.id, email: owner.email } };
function Probe() {
  const auth = useAuth();
  return <><span>{auth.loading ? 'Verificando' : auth.user?.role ?? 'Sin sesión'}</span>
    <button onClick={() => void auth.signOut()}>Salir</button></>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mock.listener = null;
  mock.getSession.mockResolvedValue({ data: { session }, error: null });
  mock.rpc.mockResolvedValue({ data: owner, error: null });
  mock.signOut.mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe('aislamiento y vigencia de sesión', () => {
  it('no habilita el panel con un perfil almacenado antes de comprobar la sesión', async () => {
    localStorage.setItem('suplementos_auth_profile', JSON.stringify(owner));
    mock.getSession.mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByText('Verificando')).toBeVisible();
    expect(screen.queryByText('owner')).not.toBeInTheDocument();
  });
  it('elimina consultas financieras al cerrar sesión', async () => {
    const client = setup();
    await screen.findByText('owner');
    client.setQueryData(['admin-products'], [{ currentCostCents: 12345 }]);
    fireEvent.click(screen.getByText('Salir'));
    await screen.findByText('Sin sesión');
    expect(client.getQueryData(['admin-products'])).toBeUndefined();
  });
  it('descarta una respuesta de perfil que llega después de cerrar sesión', async () => {
    let resolveProfile!: (value: unknown) => void;
    mock.rpc.mockReturnValue(new Promise(resolve => { resolveProfile = resolve; }));
    setup();
    await waitFor(() => expect(mock.rpc).toHaveBeenCalled());
    act(() => mock.listener?.('SIGNED_OUT', null));
    await act(async () => resolveProfile({ data: owner, error: null }));
    expect(screen.getByText('Sin sesión')).toBeVisible();
  });
  it('no invoca APIs de sesión dentro de la notificación de autenticación', async () => {
    setup(); await screen.findByText('owner');
    mock.getSession.mockClear(); mock.rpc.mockClear();
    act(() => mock.listener?.('TOKEN_REFRESHED', session));
    expect(mock.getSession).not.toHaveBeenCalled();
    expect(mock.rpc).not.toHaveBeenCalled();
    await waitFor(() => expect(mock.rpc).toHaveBeenCalled());
  });
});
