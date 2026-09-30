import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { demoOrders } from '@/data/demo-data';
import type { AdminProduct, CartLine, CheckoutData, StoreSettings } from '@/domain/types';
import { buildWhatsAppProtocol } from '@/domain/whatsapp';
import ImportOrderPage from './ImportOrderPage';

const api = vi.hoisted(() => ({ listAdminProducts: vi.fn(), confirmImportedOrder: vi.fn() }));
const navigation = vi.hoisted(() => vi.fn<(options: { enableBeforeUnload: boolean;
  shouldBlockFn: (input: { current: { pathname: string }; next: { pathname: string } }) => boolean }) => void>());
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: navigation,
  Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>
}));

const product: AdminProduct = {
  id: 'hidden-product', sku: 'HIDDEN-01', slug: 'hidden-01', name: 'Producto oculto',
  presentation: '30 cápsulas', description: '', priceCents: 100000, imageUrl: '/test.svg',
  imageAlt: 'Producto oculto', availability: 'out_of_stock', maxOrderQuantity: 0,
  category: 'Prueba', featured: false, active: true, published: false,
  reorderPoint: 0, safetyStock: 0, leadTimeDays: 7, onHand: 0, reserved: 0,
  incoming: 0, incomingAvailable: 0, currentCostCents: null, updatedAt: '2026-09-28T00:00:00Z'
};
const settings: StoreSettings = {
  storeName: 'Tienda de Suplementos', tagline: '', whatsappPhone: '+5493415555555',
  transferAlias: 'tienda', transferAccount: '0000000000000000000000',
  standardShippingCents: 0, expressShippingCents: 0, taxRateBasisPoints: 0, currency: 'ARS'
};
const checkout: CheckoutData = {
  customerFirstName: 'Cliente', customerLastName: 'Prueba', customerName: 'Cliente Prueba',
  paymentMethod: 'cash', deliveryMethod: 'pickup', shippingType: null
};
const line: CartLine = {
  productId: product.id, sku: product.sku, slug: product.slug, name: product.name,
  presentation: product.presentation, imageUrl: product.imageUrl, quantity: 1, unitPriceCents: product.priceCents
};

const renderPage = async (
  products: AdminProduct[],
  message = buildWhatsAppProtocol(checkout, [line], settings).message,
  expectReview = true
) => {
  api.listAdminProducts.mockResolvedValue(products);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><ImportOrderPage /></QueryClientProvider>);
  fireEvent.change(screen.getByLabelText('Mensaje de WhatsApp'), {
    target: { value: message }
  });
  const analyze = screen.getByRole('button', { name: 'Analizar pedido' });
  await waitFor(() => expect(analyze).toBeEnabled());
  fireEvent.click(analyze);
  if (expectReview) {
    await screen.findByRole('heading', { name: 'Revisá el pedido' });
  }
  return queryClient;
};

afterEach(() => {
  cleanup();
  api.listAdminProducts.mockReset();
  api.confirmImportedOrder.mockReset();
  vi.restoreAllMocks();
});

it('keeps the submitted review locked until the result and preserves it after a failed request', async () => {
  let reject!: (error: Error) => void;
  api.confirmImportedOrder.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const client = await renderPage([{ ...product, onHand: 3 }]);
  fireEvent.click(screen.getByRole('button', { name: /Corregir datos del pedido/ }));
  const firstName = screen.getByRole('textbox', { name: 'Nombre *' });
  fireEvent.change(firstName, { target: { value: 'Natalia' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar pedido' }));
  await waitFor(() => expect(api.confirmImportedOrder).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Volver' })).toBeDisabled();
  expect(firstName).toBeDisabled();
  const blocked = navigation.mock.lastCall![0];
  expect(blocked.enableBeforeUnload).toBe(true);
  const dialog = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(blocked.shouldBlockFn({ current: { pathname: '/app/pedidos/importar' }, next: { pathname: '/app/inventario' } })).toBe(true);
  expect(dialog).toHaveBeenCalledWith(expect.stringContaining('pedido se está guardando'));
  fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
  expect(screen.getByRole('heading', { name: 'Revisá el pedido' })).toBeInTheDocument();
  expect(api.confirmImportedOrder.mock.calls[0]![0].customerFirstName).toBe('Natalia');
  await act(async () => reject(new Error('Sin conexión')));
  expect(firstName).toHaveValue('Natalia');
  await waitFor(() => expect(firstName).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Volver' })).toBeEnabled();
  expect(navigation.mock.lastCall![0].enableBeforeUnload).toBe(false);
  expect(screen.queryByRole('heading', { name: 'Pedido confirmado' })).not.toBeInTheDocument();
  client.clear();
});

it('muestra la falta real y no permite confirmar unidades que no están libres ni en camino', async () => {
  const client = await renderPage([product]);
  expect(screen.getByText(/Producto oculto: faltan 1 u\./i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirmar pedido' })).toBeDisabled();
  expect(screen.queryByText(/se reservarán de una compra en camino/i)).not.toBeInTheDocument();
  expect(api.confirmImportedOrder).not.toHaveBeenCalled();
  client.clear();
});

it('acepta el producto activo oculto y distingue un reintento de una reserva nueva', async () => {
  const client = await renderPage([{ ...product, onHand: 1, maxOrderQuantity: 1 }]);
  api.confirmImportedOrder.mockResolvedValue({
    ...demoOrders[0]!, number: 2544, customerName: 'Cliente Prueba',
    alreadyImported: true, items: [{ ...demoOrders[0]!.items[0]!, quantity: 1 }]
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar pedido' }));
  expect(await screen.findByRole('heading', { name: 'Pedido ya cargado', level: 1 })).toBeInTheDocument();
  expect(screen.getByText(/No se reservaron unidades nuevamente/i)).toBeInTheDocument();
  expect(api.confirmImportedOrder).toHaveBeenCalledTimes(1);
  client.clear();
});

it('muestra regalo como regalo en la revisión, sin confundirlo con transferencia', async () => {
  const message = buildWhatsAppProtocol({ ...checkout, paymentMethod: 'gift' }, [line], settings).message;
  const client = await renderPage([{ ...product, onHand: 1 }], message);
  expect(screen.getByText('Regalo / Cortesía')).toBeInTheDocument();
  expect(screen.queryByText('Transferencia bancaria')).not.toBeInTheDocument();
  expect(screen.getByText(/se registrará sin cobro \(\$0\)/i)).toBeInTheDocument();
  expect(screen.getByText('Total cortesía').parentElement).toHaveTextContent('$ 0');
  expect(screen.queryByText('$1.000')).not.toBeInTheDocument();
  client.clear();
});

it('explica el campo repetido sin abrir una revisión ambigua', async () => {
  const message = buildWhatsAppProtocol(checkout, [line], settings).message.replace(
    '\n\nCódigo de control\n', '\n\nNombre\nOtro Cliente\n\nCódigo de control\n'
  );
  const client = await renderPage([{ ...product, onHand: 1 }], message, false);
  expect(await screen.findByText(/La sección Nombre aparece más de una vez/i)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Revisá el pedido' })).not.toBeInTheDocument();
  expect(api.confirmImportedOrder).not.toHaveBeenCalled();
  client.clear();
});

it('advierte si el último mensaje del chat está incompleto en vez de mostrar el pedido anterior', async () => {
  const previous = buildWhatsAppProtocol(checkout, [line], settings).message;
  const latest = buildWhatsAppProtocol({
    ...checkout, customerFirstName: 'Otra', customerLastName: 'Persona', customerName: 'Otra Persona'
  }, [line], settings).message;
  const message = `${previous}\n\n${latest.slice(0, latest.lastIndexOf('\n\nCódigo de control\n'))}`;
  const client = await renderPage([{ ...product, onHand: 1 }], message, false);
  expect(await screen.findByText(/El último pedido copiado está incompleto/i)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Revisá el pedido' })).not.toBeInTheDocument();
  client.clear();
});
