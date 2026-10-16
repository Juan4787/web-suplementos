import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { QuoteCartEtaResult } from '@/domain/types';
import { IncomingStockNotice } from './IncomingStockNotice';

afterEach(cleanup);
const quote: QuoteCartEtaResult = { ok: true, requiresIncoming: true, quotedEta: '2030-01-01T15:00:00Z', hasUnspecifiedEta: false };

it('describe la fecha como llegada estimada al local y conserva la confirmación de entrega', () => {
  render(<IncomingStockNotice quote={quote} />);
  expect(screen.getByText('Productos pendientes de recibir')).toBeVisible();
  expect(screen.getByText(/Llegada estimada al local:.*La entrega se confirma por WhatsApp/)).toBeVisible();
  expect(screen.queryByText(/se entregará|se despachará/)).not.toBeInTheDocument();
});

it.each([
  { ...quote, hasUnspecifiedEta: true },
  { ...quote, quotedEta: null },
  { ...quote, quotedEta: 'fecha inválida' }
])('no atribuye una fecha completa si alguna compra no la tiene o no es válida: %j', value => {
  render(<IncomingStockNotice quote={value} theme="dark" />);
  expect(screen.getByText('La disponibilidad y la fecha se confirman por WhatsApp.')).toBeVisible();
  expect(screen.queryByText(/Llegada estimada/)).not.toBeInTheDocument();
});

it.each([undefined, { ...quote, requiresIncoming: false }, { ...quote, ok: false }])('no muestra un aviso de reposición sin información confirmada: %j', value => {
  const { container } = render(<IncomingStockNotice quote={value} />);
  expect(container).toBeEmptyDOMElement();
});
