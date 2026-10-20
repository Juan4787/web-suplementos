import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppConfirmationProvider } from '@/components/ui/AppConfirmation';
import { demoOrders, demoProducts } from '@/data/demo-data';
import type { Order } from '@/domain/types';
import EditOrderPage from './EditOrderPage';

const api = vi.hoisted(() => ({
  getOrder: vi.fn(),
  listAdminProducts: vi.fn(),
  updateOrderItems: vi.fn()
}));
const navigateMock = vi.hoisted(() => vi.fn());
const blockerMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ orderId: 'order-edit-test' }),
  useNavigate: () => navigateMock,
  useBlocker: blockerMock,
  Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>
}));
vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { active: true, role: 'owner' } })
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

it('renders order items, allows adding and updating quantities, respects packedQuantity minimum, and saves changes', async () => {
  const prodA = { ...demoProducts[0]!, id: 'prod-a', sku: 'SKU-A', name: 'Whey Protein Isolate', onHand: 10, reserved: 2, incoming: 0, incomingAvailable: 0, priceCents: 2500000, active: true };
  const prodB = { ...demoProducts[1]!, id: 'prod-b', sku: 'SKU-B', name: 'Creatina Monohidrato', onHand: 8, reserved: 0, incoming: 0, incomingAvailable: 0, priceCents: 1800000, active: true };

  const order: Order = {
    ...demoOrders[0]!,
    id: 'order-edit-test',
    number: 1050,
    customerName: 'Valentina Torres',
    orderState: 'confirmed',
    paymentState: 'pending',
    preparationState: 'preparing',
    fulfillmentState: 'pending',
    actionRevision: 3,
    packingRevision: 1,
    packingTracked: true,
    shippingFeeCents: 0,
    subtotalCents: prodA.priceCents * 2,
    totalCents: prodA.priceCents * 2,
    items: [
      {
        id: 'item-a',
        productId: prodA.id,
        sku: prodA.sku,
        productName: prodA.name,
        presentation: prodA.presentation,
        quantity: 2,
        packedQuantity: 1,
        physicalReservedQuantity: 2,
        incomingQuantity: 0,
        uncoveredQuantity: 0,
        unitPriceCents: prodA.priceCents,
        unitCostCents: 1200000,
        subtotalCents: prodA.priceCents * 2
      }
    ]
  };

  api.getOrder.mockResolvedValue(order);
  api.listAdminProducts.mockResolvedValue([prodA, prodB]);
  api.updateOrderItems.mockImplementation(async (input) => ({
    ...order,
    actionRevision: 4,
    items: input.items.map((i: { productId: string; quantity: number }) => ({
      id: `item-${i.productId}`,
      productId: i.productId,
      sku: i.productId === prodA.id ? prodA.sku : prodB.sku,
      productName: i.productId === prodA.id ? prodA.name : prodB.name,
      presentation: '1 kg',
      quantity: i.quantity,
      unitPriceCents: i.productId === prodA.id ? prodA.priceCents : prodB.priceCents,
      subtotalCents: (i.productId === prodA.id ? prodA.priceCents : prodB.priceCents) * i.quantity
    }))
  }));

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppConfirmationProvider>
        <EditOrderPage />
      </AppConfirmationProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByText(/Editar productos del Pedido #1050/i)).toBeInTheDocument();
  expect(screen.getByTestId('draft-qty-SKU-A')).toHaveTextContent('2');

  // Decrease prodA from 2 to 1 (packedQuantity is 1, so 1 is minimum)
  fireEvent.click(screen.getByRole('button', { name: /Disminuir cantidad de Whey Protein Isolate/i }));
  expect(screen.getByTestId('draft-qty-SKU-A')).toHaveTextContent('1');
  expect(screen.getByRole('button', { name: /Disminuir cantidad de Whey Protein Isolate/i })).toBeDisabled();
  expect(screen.getByText(/Mínimo 1 u\. porque ya están en la bolsita/i)).toBeInTheDocument();

  // Add prodB from catalog
  const addButtons = screen.getAllByRole('button', { name: /Agregar/i });
  fireEvent.click(addButtons[0]!);
  expect(screen.getByTestId('draft-qty-SKU-B')).toHaveTextContent('1');

  // Save changes
  const saveButton = screen.getByTestId('save-order-edit-button');
  expect(saveButton).toBeEnabled();
  fireEvent.click(saveButton);

  await waitFor(() => expect(api.updateOrderItems).toHaveBeenCalledTimes(1));
  expect(api.updateOrderItems.mock.calls[0]![0]).toMatchObject({
    orderId: 'order-edit-test',
    expectedActionRevision: 3,
    items: [
      { productId: 'prod-a', quantity: 1 },
      { productId: 'prod-b', quantity: 1 }
    ]
  });
  expect(navigateMock).toHaveBeenCalledWith({
    to: '/app/pedidos',
    search: { search: '1050' }
  });
  client.clear();
});

it('shows a clear block card with instructions when the order is already paid', async () => {
  const paidOrder: Order = {
    ...demoOrders[0]!,
    id: 'order-edit-test',
    number: 1099,
    customerName: 'Cliente Pagado',
    orderState: 'confirmed',
    paymentState: 'paid',
    fulfillmentState: 'pending'
  };

  api.getOrder.mockResolvedValue(paidOrder);
  api.listAdminProducts.mockResolvedValue(demoProducts);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppConfirmationProvider>
        <EditOrderPage />
      </AppConfirmationProvider>
    </QueryClientProvider>
  );

  const blockedCard = await screen.findByTestId('edit-order-blocked-card');
  expect(blockedCard).toHaveTextContent(/Ya figura cobrado/i);
  expect(blockedCard).toHaveTextContent(/Deshacer cobro/i);
  client.clear();
});

it('prices new items at unit cost and reflects cost subtotal for isCostSale orders', async () => {
  const prodA = { ...demoProducts[0]!, id: 'prod-a', sku: 'SKU-A', name: 'Whey Protein Isolate', onHand: 10, reserved: 1, incoming: 0, incomingAvailable: 0, priceCents: 2500000, currentCostCents: 1500000, active: true };
  const prodB = { ...demoProducts[1]!, id: 'prod-b', sku: 'SKU-B', name: 'Creatina Monohidrato', onHand: 8, reserved: 0, incoming: 0, incomingAvailable: 0, priceCents: 1800000, currentCostCents: 1100000, active: true };

  const costOrder: Order = {
    ...demoOrders[0]!,
    id: 'order-cost-edit-test',
    number: 1055,
    customerName: 'Cliente Costo',
    orderState: 'confirmed',
    paymentState: 'pending',
    preparationState: 'pending',
    fulfillmentState: 'pending',
    isCostSale: true,
    actionRevision: 1,
    shippingFeeCents: 0,
    subtotalCents: 1500000,
    totalCents: 1500000,
    items: [
      {
        id: 'item-a',
        productId: prodA.id,
        sku: prodA.sku,
        productName: prodA.name,
        presentation: prodA.presentation,
        quantity: 1,
        packedQuantity: 0,
        unitPriceCents: 1500000,
        unitCostCents: 1500000,
        subtotalCents: 1500000
      }
    ]
  };

  api.getOrder.mockResolvedValue(costOrder);
  api.listAdminProducts.mockResolvedValue([prodA, prodB]);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppConfirmationProvider>
        <EditOrderPage />
      </AppConfirmationProvider>
    </QueryClientProvider>
  );

  expect(await screen.findByText(/Editar productos del Pedido #1055/i)).toBeInTheDocument();

  // Add prodB from catalog
  const addButtons = screen.getAllByRole('button', { name: /Agregar/i });
  fireEvent.click(addButtons[0]!);

  // New total should be prodA cost (1500000) + prodB cost (1100000) = 2600000 -> $ 26.000
  expect(screen.getByTestId('edit-order-new-total')).toHaveTextContent(/26\.000/);
  client.clear();
});
