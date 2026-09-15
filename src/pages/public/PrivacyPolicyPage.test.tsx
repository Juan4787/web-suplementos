import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartProvider } from '@/features/cart/CartProvider';
import PrivacyPolicyPage from './PrivacyPolicyPage';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, href, ...props }: any) => (
    <a href={to || href || '#'} {...props}>
      {children}
    </a>
  )
}));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  });
  return (
    <QueryClientProvider client={client}>
      <CartProvider>{children}</CartProvider>
    </QueryClientProvider>
  );
}

describe('PrivacyPolicyPage (Legislación Argentina Ley 25.326)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renderiza el título principal y el marco normativo argentino', () => {
    render(<PrivacyPolicyPage />, { wrapper: Wrapper });

    expect(
      screen.getByRole('heading', {
        name: /política de privacidad y protección de datos personales/i,
        level: 1
      })
    ).toBeInTheDocument();

    const leyMentions = screen.getAllByText(/ley nacional nº 25\.326/i);
    expect(leyMentions.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/marco legal · república argentina/i)).toBeInTheDocument();
  });

  it('contiene la cláusula legal obligatoria de la AAIP (Disposición DNPDP 10/2008)', () => {
    render(<PrivacyPolicyPage />, { wrapper: Wrapper });

    expect(
      screen.getByText(/disposición dnpdp nº 10\/2008 · cláusula legal obligatoria/i)
    ).toBeInTheDocument();

    expect(
      screen.getByText(/el titular de los datos personales tiene la facultad de ejercer el derecho de acceso/i)
    ).toBeInTheDocument();

    expect(
      screen.getByText(/la agencia de acceso a la información pública, en su carácter de órgano de control/i)
    ).toBeInTheDocument();
  });

  it('detalla los derechos ARCO y los datos pertinentes recolectados', () => {
    render(<PrivacyPolicyPage />, { wrapper: Wrapper });

    // Derechos ARCO
    expect(screen.getByText(/derecho de acceso \(art\. 14\)/i)).toBeInTheDocument();
    expect(screen.getByText(/derecho de rectificación \(art\. 16\)/i)).toBeInTheDocument();
    expect(screen.getByText(/derecho de supresión \(art\. 16\)/i)).toBeInTheDocument();

    // Datos recolectados y no sensibles
    expect(screen.getByText(/nombre y apellido:/i)).toBeInTheDocument();
    expect(screen.getByText(/teléfono de contacto \/ whatsapp:/i)).toBeInTheDocument();
    expect(screen.getByText(/datos sensibles/i)).toBeInTheDocument();
  });

  it('incluye botón de navegación de retorno a la tienda', () => {
    render(<PrivacyPolicyPage />, { wrapper: Wrapper });

    const backLinks = screen.getAllByRole('link', { name: /volver a la tienda/i });
    expect(backLinks.length).toBeGreaterThanOrEqual(1);
    expect(backLinks[0]).toHaveAttribute('href', '/');
  });
});
