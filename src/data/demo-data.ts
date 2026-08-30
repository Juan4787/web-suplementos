import { formatISO, subDays, subMonths } from 'date-fns';
import { availabilityFromQuantity, inventoryStatus, suggestedPurchase } from '@/domain/inventory';
import { calculateBasisPoints, pesosToCents } from '@/domain/money';
import type {
  AdminProduct,
  AppUser,
  Customer,
  InventoryItem,
  Order,
  Purchase,
  StockMovement,
  StoreSettings
} from '@/domain/types';

const now = new Date('2026-08-28T15:30:00-03:00');
const isoDaysAgo = (days: number): string => formatISO(subDays(now, days));

export const demoOwner: AppUser = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Sofía',
  email: 'duena@demo.local',
  role: 'owner',
  active: true
};

export const demoStaff: AppUser = {
  id: '00000000-0000-4000-8000-000000000002',
  displayName: 'Micaela',
  email: 'recepcion@demo.local',
  role: 'staff',
  active: true
};

export const demoSettings: StoreSettings = {
  storeName: 'Impulso',
  tagline: 'Suplementos para sostener tu ritmo',
  whatsappPhone: '5491112345678',
  transferAlias: 'IMPULSO.SUPLE',
  transferAccount: 'CVU 0000000000000000000000',
  standardShippingCents: pesosToCents(2500),
  expressShippingCents: pesosToCents(4500),
  taxRateBasisPoints: 350,
  currency: 'ARS'
};

const product = (
  partial: Omit<
    AdminProduct,
    'availability' | 'maxOrderQuantity' | 'updatedAt' | 'active' | 'published'
  > &
    Partial<Pick<AdminProduct, 'active' | 'published'>>
): AdminProduct => {
  const available = partial.onHand - partial.reserved;
  return {
    ...partial,
    active: partial.active ?? true,
    published: partial.published ?? true,
    availability: availabilityFromQuantity(available, partial.reorderPoint),
    maxOrderQuantity: Math.max(0, Math.min(20, available)),
    updatedAt: isoDaysAgo(1)
  };
};

export const demoProducts: AdminProduct[] = [
  product({
    id: '10000000-0000-4000-8000-000000000001',
    sku: 'CREA300',
    slug: 'creatina-monohidratada-300g',
    name: 'Creatina Monohidratada',
    presentation: '300 g · Sin sabor · 60 servicios',
    description: 'Creatina 100% monohidratada y micronizada (Mesh 200) de máxima pureza. Diseñada para saturar los depósitos de fosfocreatina muscular, aumentando la fuerza máxima, la potencia en series intensas y acelerando la recuperación entre esfuerzos. Sin aditivos, sin saborizantes ni azúcares añadidos; se disuelve al instante en agua o batidos. Modo de uso: 5 g diarios (1 scoop raso) de forma constante, idealmente post-entreno.',
    priceCents: pesosToCents(25_000),
    currentCostCents: pesosToCents(15_000),
    imageUrl: '/products/creatina.jpg',
    imageAlt: 'Pote profesional de Creatina Monohidratada Impulso',
    category: 'Rendimiento',
    featured: true,
    reorderPoint: 8,
    safetyStock: 5,
    leadTimeDays: 7,
    onHand: 7,
    reserved: 3,
    incoming: 0
  }),
  product({
    id: '10000000-0000-4000-8000-000000000002',
    sku: 'WHEY908',
    slug: 'whey-protein-vainilla-908g',
    name: 'Whey Protein',
    presentation: '908 g · Vainilla suave · 30 servicios',
    description: 'Concentrado de proteína de suero de leche de alto valor biológico con perfil completo de aminoácidos esenciales, rico en BCAA y glutamina natural. Formulado para estimular la síntesis proteica muscular y optimizar la recuperación post-esfuerzo con textura cremosa y digestión ligera. Modo de uso: 1 scoop (30 g) en 250 ml de agua o leche descremada tras el entrenamiento o como colación proteica.',
    priceCents: pesosToCents(39_500),
    currentCostCents: pesosToCents(25_900),
    imageUrl: '/products/whey.jpg',
    imageAlt: 'Pote profesional de Whey Protein Vainilla Impulso',
    category: 'Proteínas',
    featured: true,
    reorderPoint: 6,
    safetyStock: 3,
    leadTimeDays: 10,
    onHand: 18,
    reserved: 2,
    incoming: 8
  }),
  product({
    id: '10000000-0000-4000-8000-000000000003',
    sku: 'OMEGA90',
    slug: 'omega-3-90-capsulas',
    name: 'Omega 3',
    presentation: '90 cápsulas blandas · 45 servicios',
    description: 'Aceite de pescado de aguas frías purificado por destilación molecular, libre de metales pesados. Aporta una concentración balanceada de ácidos grasos esenciales EPA (500 mg) y DHA (250 mg) por porción. Favorece la salud cardiovascular, modula la respuesta inflamatoria articular y apoya la función cerebral y cognitiva. Modo de uso: 2 cápsulas blandas diarias junto a una comida principal.',
    priceCents: pesosToCents(18_900),
    currentCostCents: pesosToCents(11_400),
    imageUrl: '/products/omega.jpg',
    imageAlt: 'Frasco profesional de Omega 3 Impulso',
    category: 'Bienestar',
    featured: false,
    reorderPoint: 7,
    safetyStock: 4,
    leadTimeDays: 8,
    onHand: 22,
    reserved: 1,
    incoming: 12
  }),
  product({
    id: '10000000-0000-4000-8000-000000000004',
    sku: 'MAG120',
    slug: 'magnesio-bisglicinato-120',
    name: 'Magnesio Bisglicinato',
    presentation: '120 cápsulas · 60 servicios',
    description: 'Magnesio quelado 100% biodisponible unido a moléculas de glicina, asegurando máxima absorción intestinal sin molestias digestivas ni efecto laxante. Esencial para relajar la musculatura, prevenir calambres, regular el sistema nervioso y promover un sueño profundo y reparador. Modo de uso: 2 cápsulas por la noche, 40 minutos antes de dormir.',
    priceCents: pesosToCents(21_200),
    currentCostCents: pesosToCents(13_100),
    imageUrl: '/products/magnesio.jpg',
    imageAlt: 'Frasco profesional de Magnesio Bisglicinato Impulso',
    category: 'Bienestar',
    featured: true,
    reorderPoint: 6,
    safetyStock: 3,
    leadTimeDays: 12,
    onHand: 16,
    reserved: 1,
    incoming: 6
  }),
  product({
    id: '10000000-0000-4000-8000-000000000005',
    sku: 'PRE300',
    slug: 'pre-entreno-citrus-300g',
    name: 'Pre Entreno Focus',
    presentation: '300 g · Citrus fresco · 30 servicios',
    description: 'Fórmula ergogénica avanzada con cafeína anhidra, beta-alanina, L-citrulina malato y taurina en proporciones balanceadas. Aporta un incremento sostenido de energía, enfoque mental y congestión muscular limpia, sin taquicardia ni caídas bruscas. Modo de uso: 1 scoop (10 g) en 250 ml de agua fresca 20-30 minutos antes del entrenamiento.',
    priceCents: pesosToCents(28_600),
    currentCostCents: pesosToCents(17_800),
    imageUrl: '/products/pre.jpg',
    imageAlt: 'Pote profesional de Pre Entreno Focus Impulso',
    category: 'Rendimiento',
    featured: false,
    reorderPoint: 5,
    safetyStock: 2,
    leadTimeDays: 9,
    onHand: 0,
    reserved: 0,
    incoming: 10
  }),
  product({
    id: '10000000-0000-4000-8000-000000000006',
    sku: 'MULTI60',
    slug: 'multivitaminico-60-capsulas',
    name: 'Multivitamínico Daily',
    presentation: '60 comprimidos · 60 servicios',
    description: 'Complejo micronutricional integral con 13 vitaminas esenciales y 9 minerales quelados de alta absorción, reforzado con Vitamina C, Zinc, Selenio y complejo B completo. Diseñado para cubrir requerimientos aumentados por la actividad física, reforzar defensas y optimizar el metabolismo energético. Modo de uso: 1 comprimido al día preferentemente con el desayuno.',
    priceCents: pesosToCents(16_500),
    currentCostCents: pesosToCents(9_700),
    imageUrl: '/products/multi.jpg',
    imageAlt: 'Frasco profesional de Multivitamínico Daily Impulso',
    category: 'Bienestar',
    featured: false,
    reorderPoint: 7,
    safetyStock: 4,
    leadTimeDays: 7,
    onHand: 13,
    reserved: 2,
    incoming: 0
  })
];

const orderItem = (
  index: number,
  productIndex: number,
  quantity: number
): Order['items'][number] => {
  const source = demoProducts[productIndex]!;
  return {
    id: `21000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    productId: source.id,
    sku: source.sku,
    productName: source.name,
    presentation: source.presentation,
    quantity,
    unitPriceCents: source.priceCents,
    unitCostCents: source.currentCostCents,
    subtotalCents: source.priceCents * quantity
  };
};

const makeOrder = (partial: {
  index: number;
  number: number;
  customer: string;
  phone?: string;
  daysAgo: number;
  items: Array<[number, number]>;
  paymentState?: Order['paymentState'];
  preparationState?: Order['preparationState'];
  fulfillmentState?: Order['fulfillmentState'];
  deliveryMethod?: Order['deliveryMethod'];
}): Order => {
  const items = partial.items.map(([productIndex, quantity], index) =>
    orderItem(partial.index * 10 + index, productIndex, quantity)
  );
  const subtotalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);
  const deliveryMethod = partial.deliveryMethod ?? 'pickup';
  const shippingFeeCents = deliveryMethod === 'shipping' ? demoSettings.standardShippingCents : 0;
  const taxAmountCents = calculateBasisPoints(subtotalCents + shippingFeeCents, demoSettings.taxRateBasisPoints);
  const costTotalCents = items.reduce(
    (sum, item) => sum + (item.unitCostCents ?? 0) * item.quantity,
    0
  );
  const createdAt = isoDaysAgo(partial.daysAgo);
  const paymentState = partial.paymentState ?? 'pending';
  const fulfillmentState = partial.fulfillmentState ?? 'pending';
  return {
    id: `20000000-0000-4000-8000-${String(partial.index).padStart(12, '0')}`,
    number: partial.number,
    customerId: `30000000-0000-4000-8000-${String(partial.index).padStart(12, '0')}`,
    customerName: partial.customer,
    customerPhone: partial.phone ?? '11 5555 0101',
    paymentMethod: partial.index % 2 === 0 ? 'transfer' : 'cash',
    deliveryMethod,
    shippingType: deliveryMethod === 'shipping' ? 'standard' : null,
    shippingAddress: deliveryMethod === 'shipping' ? 'Av. Rivadavia 3200' : null,
    orderState: 'confirmed',
    paymentState,
    preparationState: partial.preparationState ?? 'pending',
    fulfillmentState,
    subtotalCents,
    shippingFeeCents,
    totalCents: subtotalCents + shippingFeeCents,
    taxRateBasisPoints: demoSettings.taxRateBasisPoints,
    taxAmountCents,
    costTotalCents,
    createdAt,
    confirmedAt: createdAt,
    paidAt: paymentState === 'paid' ? createdAt : null,
    fulfilledAt: fulfillmentState === 'delivered' ? createdAt : null,
    items
  };
};

export const demoOrders: Order[] = [
  makeOrder({
    index: 1,
    number: 1048,
    customer: 'Camila Torres',
    daysAgo: 0,
    items: [[0, 1], [2, 1]],
    paymentState: 'paid',
    preparationState: 'preparing',
    deliveryMethod: 'shipping'
  }),
  makeOrder({
    index: 2,
    number: 1047,
    customer: 'Nicolás Vega',
    daysAgo: 0,
    items: [[1, 1]],
    preparationState: 'ready'
  }),
  makeOrder({
    index: 3,
    number: 1046,
    customer: 'Valentina Díaz',
    daysAgo: 1,
    items: [[3, 2]],
    paymentState: 'paid',
    preparationState: 'ready',
    fulfillmentState: 'shipped',
    deliveryMethod: 'shipping'
  }),
  makeOrder({
    index: 4,
    number: 1045,
    customer: 'Lucas Romero',
    daysAgo: 4,
    items: [[0, 1], [5, 1]],
    paymentState: 'paid',
    preparationState: 'ready',
    fulfillmentState: 'delivered'
  }),
  makeOrder({
    index: 5,
    number: 1044,
    customer: 'Martina Silva',
    daysAgo: 11,
    items: [[1, 1], [2, 2]],
    paymentState: 'paid',
    preparationState: 'ready',
    fulfillmentState: 'delivered',
    deliveryMethod: 'shipping'
  }),
  makeOrder({
    index: 6,
    number: 1043,
    customer: 'Juan Cruz Molina',
    daysAgo: 34,
    items: [[0, 2]],
    paymentState: 'paid',
    preparationState: 'ready',
    fulfillmentState: 'delivered'
  })
];

export const demoPurchases: Purchase[] = [
  {
    id: '40000000-0000-4000-8000-000000000001',
    number: 88,
    supplierName: 'Distribuidora Norte',
    state: 'ordered',
    orderedAt: isoDaysAgo(3),
    expectedAt: isoDaysAgo(-4),
    receivedAt: null,
    totalCostCents: pesosToCents(256_800),
    notes: 'Confirmar bultos antes de firmar la recepción.',
    items: [
      {
        id: '41000000-0000-4000-8000-000000000001',
        productId: demoProducts[2]!.id,
        productName: demoProducts[2]!.name,
        quantity: 12,
        unitCostCents: demoProducts[2]!.currentCostCents ?? 0
      },
      {
        id: '41000000-0000-4000-8000-000000000002',
        productId: demoProducts[3]!.id,
        productName: demoProducts[3]!.name,
        quantity: 6,
        unitCostCents: demoProducts[3]!.currentCostCents ?? 0
      }
    ]
  },
  {
    id: '40000000-0000-4000-8000-000000000002',
    number: 87,
    supplierName: 'Nutri Wholesale',
    state: 'received',
    orderedAt: isoDaysAgo(20),
    expectedAt: isoDaysAgo(12),
    receivedAt: isoDaysAgo(11),
    totalCostCents: pesosToCents(207_200),
    notes: null,
    items: [
      {
        id: '41000000-0000-4000-8000-000000000003',
        productId: demoProducts[1]!.id,
        productName: demoProducts[1]!.name,
        quantity: 8,
        unitCostCents: demoProducts[1]!.currentCostCents ?? 0
      }
    ]
  }
];

export const demoMovements: StockMovement[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    productId: demoProducts[1]!.id,
    productName: demoProducts[1]!.name,
    kind: 'purchase_received',
    physicalDelta: 8,
    reservedDelta: 0,
    reason: 'Compra #87 recibida',
    orderId: null,
    purchaseId: demoPurchases[1]!.id,
    createdAt: isoDaysAgo(11),
    createdByName: demoOwner.displayName
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    productId: demoProducts[0]!.id,
    productName: demoProducts[0]!.name,
    kind: 'sale',
    physicalDelta: -1,
    reservedDelta: -1,
    reason: 'Pedido #1045 entregado',
    orderId: demoOrders[3]!.id,
    purchaseId: null,
    createdAt: isoDaysAgo(4),
    createdByName: demoStaff.displayName
  }
];

export const demoCustomers: Customer[] = demoOrders.map((order) => ({
  id: order.customerId!,
  name: order.customerName,
  phone: order.customerPhone,
  firstOrderAt: order.createdAt,
  lastOrderAt: order.createdAt,
  orderCount: 1,
  totalPaidCents: order.paymentState === 'paid' ? order.totalCents : 0
}));

export const demoInflation = [
  {
    period: formatISO(subMonths(new Date('2026-08-01T00:00:00-03:00'), 2), {
      representation: 'date'
    }),
    indexValue: 12_140.42,
    sourceUrl: 'https://www.indec.gob.ar/',
    publishedAt: '2026-07-14T12:00:00-03:00'
  },
  {
    period: formatISO(subMonths(new Date('2026-08-01T00:00:00-03:00'), 1), {
      representation: 'date'
    }),
    indexValue: 12_381.1,
    sourceUrl: 'https://www.indec.gob.ar/',
    publishedAt: '2026-08-13T12:00:00-03:00'
  }
];

export const toDemoInventory = (products: AdminProduct[]): InventoryItem[] =>
  products.map((item, index) => {
    const available = item.onHand - item.reserved;
    const averageDailySales = [0.62, 0.28, 0.19, 0.24, 0.12, 0.17][index] ?? 0.1;
    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      presentation: item.presentation,
      imageUrl: item.imageUrl,
      onHand: item.onHand,
      reserved: item.reserved,
      available,
      incoming: item.incoming,
      projected: available + item.incoming,
      reorderPoint: item.reorderPoint,
      safetyStock: item.safetyStock,
      leadTimeDays: item.leadTimeDays,
      averageDailySales,
      coverageDays: averageDailySales > 0 ? Math.round((available / averageDailySales) * 10) / 10 : null,
      suggestedPurchase: suggestedPurchase(
        available,
        item.incoming,
        averageDailySales,
        item.leadTimeDays,
        item.safetyStock
      ),
      status: inventoryStatus(available, item.reorderPoint, item.safetyStock)
    };
  });
