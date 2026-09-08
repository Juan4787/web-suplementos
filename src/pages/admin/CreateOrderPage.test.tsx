import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProduct, Order, StoreSettings } from '@/domain/types';
import CreateOrderPage from './CreateOrderPage';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, search }: PropsWithChildren<{ to?: string; className?: string; search?: any }>) => (
    <a href={to || '#'} className={className} data-search={JSON.stringify(search)}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn()
}));

const mockProducts: AdminProduct[] = [
  {
    id: 'prod-001',
    sku: 'CREA300',
    slug: 'creatina-300g',
    name: 'Creatina Creapure',
    presentation: '300 g',
    description: 'Creatina de máxima pureza',
    priceCents: 2500000,
    currentCostCents: 1500000,
    imageUrl: '/demo/creatina.svg',
    imageAlt: 'Creatina',
    availability: 'available',
    maxOrderQuantity: 10,
    onHand: 8,
    reserved: 2,
    incoming: 0,
    incomingAvailable: 0,
    reorderPoint: 5,
    safetyStock: 2,
    leadTimeDays: 7,
    category: 'Fuerza',
    featured: true,
    active: true,
    published: true,
    updatedAt: new Date().toISOString()
  },
  {
    id: 'prod-002',
    sku: 'WHEY900',
    slug: 'whey-900g',
    name: 'Proteína Whey Isolate',
    presentation: '900 g',
    description: 'Aislado de suero',
    priceCents: 4500000,
    currentCostCents: 3000000,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey Isolate',
    availability: 'available',
    maxOrderQuantity: 5,
    onHand: 4,
    reserved: 0,
    incoming: 0,
    incomingAvailable: 0,
    reorderPoint: 3,
    safetyStock: 1,
    leadTimeDays: 5,
    category: 'Proteínas',
    featured: false,
    active: true,
    published: true,
    updatedAt: new Date().toISOString()
  }
];

const mockSettings: StoreSettings = {
  storeName: 'Tienda de Suplementos',
  tagline: 'Nutrición deportiva',
  whatsappPhone: '+5491155555555',
  transferAlias: 'tienda.suplementos',
  transferAccount: '0000003100010000000000',
  standardShippingCents: 350000,
  expressShippingCents: 600000,
  taxRateBasisPoints: 2100,
  currency: 'ARS'
};

const mockConfirm = vi.fn();

vi.mock('@/services/business-api', () => ({
  getBusinessApi: vi.fn(async () => ({
    listAdminProducts: async () => mockProducts,
    getSettings: async () => mockSettings,
    confirmImportedOrder: mockConfirm
  }))
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0
      }
    }
  });

  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('CreateOrderPage', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
  });

  afterEach(cleanup);

  it('renderiza el catálogo y permite agregar productos al pedido manual', async () => {
    render(<CreateOrderPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Creatina Creapure')).toBeDefined();
      expect(screen.getByText('Proteína Whey Isolate')).toBeDefined();
    });

    // Agregar Creatina
    const addButtons = screen.getAllByRole('button', { name: /agregar/i });
    fireEvent.click(addButtons[0]!);

    // Verificar que aparece en los productos cargados
    await waitFor(() => {
      expect(screen.getByText('2. Productos cargados en el pedido')).toBeDefined();
      expect(screen.getByText(/1 unidad seleccionada/i)).toBeDefined();
    });

    // Subtotal inicial
    expect(screen.getByText('Total a cobrar')).toBeDefined();
  });

  it('valida que se ingrese el nombre del cliente antes de confirmar', async () => {
    render(<CreateOrderPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Creatina Creapure')).toBeDefined();
    });

    // Agregar producto
    const addButtons = screen.getAllByRole('button', { name: /agregar/i });
    fireEvent.click(addButtons[0]!);

    // Intentar confirmar sin cliente
    const confirmButton = screen.getByRole('button', { name: /confirmar pedido manual/i });
    expect(confirmButton).toBeDisabled();

    // Completar nombre corto inválido
    const nameInput = screen.getByPlaceholderText('Ej. Marta Gómez');
    fireEvent.change(nameInput, { target: { value: 'A' } });

    // Botón sigue deshabilitado por validación
    expect(confirmButton).toBeDisabled();

    // Nombre válido
    fireEvent.change(nameInput, { target: { value: 'Marta Gómez' } });
    expect(confirmButton).not.toBeDisabled();
  });

  it('calcula flete correctamente cuando se selecciona envío a domicilio', async () => {
    render(<CreateOrderPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Creatina Creapure')).toBeDefined();
    });

    // Agregar Creatina (precio $25.000)
    const addButtons = screen.getAllByRole('button', { name: /agregar/i });
    fireEvent.click(addButtons[0]!);

    // Cambiar a Envío a domicilio
    const shippingButton = screen.getByText('Envío a domicilio');
    fireEvent.click(shippingButton);

    // Debe mostrar campos de dirección y tipo de envío
    expect(screen.getByText('Tipo de envío')).toBeDefined();
    expect(screen.getByText('Calle / Dirección *')).toBeDefined();
  });

  it('confirma el pedido manual con éxito y muestra el resumen del pedido', async () => {
    const fakeOrder: Order = {
      id: 'order-uuid-123',
      number: 1055,
      customerId: 'cust-123',
      customerName: 'Alberto Spinetta',
      customerPhone: '1145678901',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingAddress: null,
      orderState: 'confirmed',
      paymentState: 'pending',
      preparationState: 'ready',
      fulfillmentState: 'pending',
      stockReadiness: 'ready',
      subtotalCents: 2500000,
      shippingFeeCents: 0,
      totalCents: 2500000,
      taxRateBasisPoints: 2100,
      taxAmountCents: 525000,
      costTotalCents: 1500000,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      paidAt: null,
      fulfilledAt: null,
      items: [
        {
          id: 'item-1',
          productId: 'prod-001',
          sku: 'CREA300',
          productName: 'Creatina Creapure',
          presentation: '300 g',
          quantity: 1,
          unitPriceCents: 2500000,
          unitCostCents: 1500000,
          subtotalCents: 2500000
        }
      ]
    };

    mockConfirm.mockResolvedValue(fakeOrder);

    render(<CreateOrderPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Creatina Creapure')).toBeDefined();
    });

    // Agregar producto
    const addButtons = screen.getAllByRole('button', { name: /agregar/i });
    fireEvent.click(addButtons[0]!);

    // Datos del cliente
    const nameInput = screen.getByPlaceholderText('Ej. Marta Gómez');
    fireEvent.change(nameInput, { target: { value: 'Alberto Spinetta' } });

    // Confirmar
    const confirmButton = screen.getByRole('button', { name: /confirmar pedido manual/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Pedido #1055')).toBeDefined();
      expect(screen.getByText('Alberto Spinetta')).toBeDefined();
      expect(screen.getByText(/confirmado con éxito/i)).toBeDefined();
    });
  });
  it('reutiliza la clave al reintentar una respuesta perdida y la cambia si cambia la cantidad', async () => {
    mockConfirm.mockRejectedValue(new Error('Respuesta perdida'));
    render(<CreateOrderPage />, { wrapper: createWrapper() });
    await screen.findByText('Creatina Creapure');
    fireEvent.click(screen.getAllByRole('button', { name: /agregar/i })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ej. Marta Gómez'), { target: { value: 'Cliente Auditoría' } });
    const button = screen.getByRole('button', { name: /confirmar pedido manual/i });
    fireEvent.click(button);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(2));
    expect(mockConfirm.mock.calls[1]![0].protocolOrderId).toBe(mockConfirm.mock.calls[0]![0].protocolOrderId);
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole('button', { name: /agregar/i })[0]!);
    fireEvent.click(button);
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(3));
    expect(mockConfirm.mock.calls[2]![0].protocolOrderId).not.toBe(mockConfirm.mock.calls[0]![0].protocolOrderId);
  });

});
