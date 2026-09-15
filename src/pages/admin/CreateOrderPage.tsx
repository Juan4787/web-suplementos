import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Gift,
  Minus,
  Package,
  Plus,
  RotateCcw,
  Search,
  ShoppingBag,
  Store,
  Tag,
  Trash2,
  Truck
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { parseShippingAddress } from '@/domain/checkout';
import { AppError } from '@/domain/errors';
import { formatMoney } from '@/domain/money';
import type {
  AdminProduct,
  CartLine,
  CheckoutData,
  DeliveryMethod,
  ImportOrderInput,
  Order,
  PaymentMethod,
  SaleType,
  ShippingType
} from '@/domain/types';
import { buildWhatsAppProtocol, createOrderFingerprint } from '@/domain/whatsapp';
import { cn } from '@/lib/cn';
import { cleanSearchTerm } from '@/lib/search';
import { getBusinessApi } from '@/services/business-api';

type SelectedItem = CartLine & {
  physAvail: number;
  incomingAvail: number;
  maxOrderable: number;
};

export default function CreateOrderPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Consultas de datos requeridos
  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.products,
    queryFn: (api) => api.listAdminProducts()
  });

  const settingsQuery = useBusinessQuery({
    queryKey: queryKeys.settings,
    queryFn: (api) => api.getSettings()
  });

  // Estado del formulario
  const [searchProduct, setSearchProduct] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [items, setItems] = useState<SelectedItem[]>([]);

  // Datos del cliente
  const [customerFirstName, setCustomerFirstName] = useState('');
  const [customerLastName, setCustomerLastName] = useState('');
  const [phone, setPhone] = useState('');

  // Entrega y pago
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('pickup');
  const [shippingType, setShippingType] = useState<ShippingType>('standard');
  const [isSantaFeOrNearby, setIsSantaFeOrNearby] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [saleType, setSaleType] = useState<SaleType>('retail');

  // Estado de finalización y errores
  const protocolDraft = useRef<{ orderId: string; fingerprint: string } | null>(null);
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const products = productsQuery.data ?? [];
  const settings = settingsQuery.data;

  // Categorías disponibles para filtrar
  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set).sort();
  }, [products]);

  // Filtrado de productos en catálogo
  const filteredProducts = useMemo(() => {
    const term = searchProduct.trim().toLowerCase();
    return products.filter((p) => {
      if (!p.active || !p.published) return false;
      if (selectedCategory !== 'all' && p.category !== selectedCategory) return false;
      if (!term) return true;
      return (
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        p.presentation.toLowerCase().includes(term) ||
        p.category.toLowerCase().includes(term)
      );
    });
  }, [products, searchProduct, selectedCategory]);

  // Cálculos de totales y stock
  const totals = useMemo(() => {
    const rawSubtotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
    const subtotal = saleType === 'gift' || paymentMethod === 'gift' ? 0 : rawSubtotal;
    const shipping = 0;
    return {
      subtotal,
      rawSubtotal,
      shipping,
      total: subtotal,
      units: items.reduce((sum, item) => sum + item.quantity, 0)
    };
  }, [items, paymentMethod, saleType]);

  // Análisis de disponibilidad de stock para los items seleccionados
  const stockReadiness = useMemo(() => {
    let requiresIncoming = false;
    for (const item of items) {
      if (item.quantity > item.physAvail) {
        requiresIncoming = true;
        break;
      }
    }
    return requiresIncoming ? 'waiting_incoming' : 'ready';
  }, [items]);

  const handleSaleTypeChange = (nextType: SaleType) => {
    setSaleType(nextType);
    if (nextType === 'gift') {
      setPaymentMethod('gift');
    } else if (paymentMethod === 'gift') {
      setPaymentMethod('transfer');
    }
    setItems((current) =>
      current.map((item) => {
        const product = products.find((p) => p.id === item.productId);
        const cost = product?.costCents ?? (product as any)?.currentCostCents ?? item.unitPriceCents;
        const unitPriceCents = nextType === 'cost' ? cost : (product?.priceCents ?? item.unitPriceCents);
        return {
          ...item,
          unitPriceCents
        };
      })
    );
  };

  // Agregar producto al pedido
  const handleAddProduct = (product: AdminProduct) => {
    setValidationError(null);
    const physAvail = Math.max(0, product.onHand - product.reserved);
    const incomingAvail = product.incomingAvailable ?? 0;
    const maxOrderable = Math.max(0, physAvail + incomingAvail);

    if (maxOrderable <= 0) return;

    setItems((current) => {
      const existing = current.find((i) => i.productId === product.id);
      if (existing) {
        if (existing.quantity >= maxOrderable) {
          return current;
        }
        return current.map((i) =>
          i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      const cost = product.costCents ?? (product as any)?.currentCostCents ?? product.priceCents;
      const unitPriceCents = saleType === 'cost' ? cost : product.priceCents;
      const newItem: SelectedItem = {
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents,
        quantity: 1,
        physAvail,
        incomingAvail,
        maxOrderable
      };
      return [...current, newItem];
    });
  };

  // Modificar cantidad
  const handleUpdateQuantity = (productId: string, delta: number) => {
    setValidationError(null);
    setItems((current) =>
      current
        .map((item) => {
          if (item.productId !== productId) return item;
          const nextQty = item.quantity + delta;
          if (nextQty <= 0) return null;
          if (nextQty > item.maxOrderable) return item;
          return { ...item, quantity: nextQty };
        })
        .filter((item): item is SelectedItem => item !== null)
    );
  };

  // Eliminar producto
  const handleRemoveProduct = (productId: string) => {
    setValidationError(null);
    setItems((current) => current.filter((i) => i.productId !== productId));
  };

  // Mutación para confirmar el pedido
  const confirmMutation = useMutation({
    mutationFn: async (input: ImportOrderInput) => {
      const api = await getBusinessApi();
      return api.confirmImportedOrder(input);
    },
    onSuccess: async (order) => {
      setCreatedOrder(order);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products })
      ]);
    }
  });

  // Validación y envío del formulario
  const handleSubmit = () => {
    if (confirmMutation.isPending) return;
    setValidationError(null);

    if (items.length === 0) {
      setValidationError('Seleccioná al menos un producto para el pedido.');
      return;
    }

    const trimmedFirst = customerFirstName.trim();
    if (!trimmedFirst) {
      setValidationError('Ingresá el nombre del cliente.');
      return;
    }

    const trimmedLast = customerLastName.trim();
    if (!trimmedLast) {
      setValidationError('Ingresá el apellido del cliente.');
      return;
    }

    const trimmedName = `${trimmedFirst} ${trimmedLast}`.trim();

    const trimmedPhone = phone.trim();
    const phoneDigits = trimmedPhone.replace(/[^0-9]/g, '');

    if (deliveryMethod === 'shipping') {
      if (phoneDigits.length < 8) {
        setValidationError(
          'Para pedidos con envío a domicilio, el teléfono del cliente es obligatorio y debe tener al menos 8 dígitos para coordinar la entrega.'
        );
        return;
      }
      if (address.trim().length < 3) {
        setValidationError('Ingresá la calle de destino (mínimo 3 letras).');
        return;
      }
      if (!addressNumber.trim()) {
        setValidationError('Ingresá la altura de la dirección (o "S/N" si no tiene).');
        return;
      }
      if (isSantaFeOrNearby === null) {
        setValidationError('Respondé si el envío es dentro de Santa Fe Capital o alguna localidad cercana.');
        return;
      }
      if (isSantaFeOrNearby === false) {
        if (!email.trim()) {
          setValidationError('Ingresá el correo electrónico del cliente para el link de seguimiento.');
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          setValidationError('Ingresá un correo electrónico válido.');
          return;
        }
      }
    }

    if (!settings) {
      setValidationError('Aguardá mientras se carga la configuración de la tienda.');
      return;
    }

    if (trimmedName.length > 100) {
      setValidationError('El nombre del cliente debe tener como máximo 100 caracteres.');
      return;
    }

    // Armar líneas de carrito limpias
    const lines: CartLine[] = items.map((i) => ({
      productId: i.productId,
      sku: i.sku,
      slug: i.slug,
      name: i.name,
      presentation: i.presentation,
      imageUrl: i.imageUrl,
      unitPriceCents: i.unitPriceCents,
      quantity: i.quantity
    }));

    const isGift = saleType === 'gift' || paymentMethod === 'gift';
    const isCost = saleType === 'cost' && !isGift;
    const finalPaymentMethod: PaymentMethod = isGift ? 'gift' : paymentMethod;
    const fullAddress = deliveryMethod === 'shipping'
      ? (addressNumber.trim() ? `${address.trim()} ${addressNumber.trim()}` : address.trim())
      : null;
    const finalAddress = fullAddress && isSantaFeOrNearby === false && email.trim()
      ? `${fullAddress} · Seguimiento: ${email.trim()}`
      : fullAddress;

    const checkoutData: CheckoutData = {
      customerFirstName: trimmedFirst,
      customerLastName: trimmedLast,
      customerName: trimmedName,
      phone: trimmedPhone || null,
      deliveryMethod,
      shippingType: deliveryMethod === 'shipping' ? shippingType : null,
      isSantaFeOrNearby: deliveryMethod === 'shipping' ? isSantaFeOrNearby : null,
      email: deliveryMethod === 'shipping' && isSantaFeOrNearby === false ? email.trim() : null,
      address: finalAddress,
      addressNumber: null,
      paymentMethod: finalPaymentMethod
    };

    // Generar protocolo determinista válido para la API
    const fingerprint = `${createOrderFingerprint(checkoutData, lines, totals.shipping)}__${trimmedPhone}`;
    const previousId = protocolDraft.current?.fingerprint === fingerprint ? protocolDraft.current.orderId : undefined;
    const protocol = buildWhatsAppProtocol(checkoutData, lines, settings, previousId);
    protocolDraft.current = { fingerprint, orderId: protocol.orderId };

    const payload: ImportOrderInput = {
      ...checkoutData,
      lines,
      saleType: isGift ? 'gift' : saleType,
      isCostSale: isCost,
      shippingFeeCents: totals.shipping,
      quotedSubtotalCents: totals.subtotal,
      quotedTotalCents: totals.total,
      protocolOrderId: protocol.orderId,
      protocolChecksum: protocol.checksum
    };

    confirmMutation.mutate(payload);
  };

  const handleReset = () => {
    protocolDraft.current = null;
    confirmMutation.reset();
    setCreatedOrder(null);
    setItems([]);
    setCustomerFirstName('');
    setCustomerLastName('');
    setPhone('');
    setAddress('');
    setAddressNumber('');
    setIsSantaFeOrNearby(null);
    setEmail('');
    setDeliveryMethod('pickup');
    setShippingType('standard');
    setPaymentMethod('cash');
    setSaleType('retail');
    setValidationError(null);
  };

  if (productsQuery.isPending || settingsQuery.isPending) {
    return <LoadingState label="Cargando catálogo de productos y configuración…" />;
  }

  if (productsQuery.isError) {
    return <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} />;
  }

  if (settingsQuery.isError) return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;

  return (
    <div className="page-enter min-w-0">
      <div className="mb-4">
        <Link
          to="/app/pedidos"
          className="inline-flex items-center gap-1.5 text-sm font-bold text-ink-600 transition hover:text-brand-600"
        >
          <ArrowLeft className="size-4" /> Volver a Pedidos
        </Link>
      </div>

      <PageHeader
        title={createdOrder ? 'Pedido registrado' : 'Cargar pedido manual'}
        description={
          createdOrder
            ? `El pedido #${createdOrder.number} fue registrado y las unidades fueron reservadas.`
            : 'Registrá un pedido recibido por teléfono, mostrador o WhatsApp sin que el cliente use la web.'
        }
      />

      {/* Pantalla de Éxito al Confirmar */}
      {createdOrder ? (
        <div className="max-w-2xl">
          <section className="rounded-3xl border border-emerald-950/10 bg-white p-6 shadow-card sm:p-8">
            <div className="flex items-center gap-4">
              <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-emerald-100 text-emerald-700 shadow-sm">
                <CheckCircle2 className="size-8" />
              </span>
              <div>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black uppercase tracking-wider text-emerald-800">
                  Confirmado con éxito
                </span>
                <h2 className="mt-2 font-display text-2xl font-black tracking-tight text-ink-950 sm:text-3xl">
                  Pedido #{createdOrder.number}
                </h2>
              </div>
            </div>

            <div className="mt-6 rounded-2xl bg-cream-50 p-5 space-y-3 text-sm">
              <div className="flex justify-between font-medium">
                <span className="text-ink-600">Cliente:</span>
                <span className="font-bold text-ink-950">{createdOrder.customerName}</span>
              </div>
              {createdOrder.customerPhone ? (
                <div className="flex justify-between font-medium">
                  <span className="text-ink-600">Teléfono:</span>
                  <span className="font-bold text-ink-950">{createdOrder.customerPhone}</span>
                </div>
              ) : null}
              <div className="flex justify-between font-medium">
                <span className="text-ink-600">Entrega:</span>
                <span className="font-bold text-ink-950">
                  {createdOrder.deliveryMethod === 'pickup'
                    ? 'Retiro en el local'
                    : 'Envío a domicilio'}
                </span>
              </div>
              {createdOrder.shippingAddress ? (() => {
                const shippingInfo = parseShippingAddress(createdOrder.shippingAddress);
                return (
                  <>
                    {shippingInfo.streetAddress ? (
                      <div className="flex justify-between font-medium">
                        <span className="text-ink-600">Dirección:</span>
                        <span className="font-bold text-ink-950 text-right">
                          {shippingInfo.streetAddress}
                        </span>
                      </div>
                    ) : null}
                    {shippingInfo.trackingEmail ? (
                      <div className="flex justify-between font-medium">
                        <span className="text-ink-600">Email de seguimiento:</span>
                        <span className="font-bold text-ink-950 text-right break-all">
                          {shippingInfo.trackingEmail}
                        </span>
                      </div>
                    ) : null}
                  </>
                );
              })() : null}
              <div className="flex justify-between font-medium">
                <span className="text-ink-600">Modalidad:</span>
                <span className="font-bold text-ink-950">
                  {createdOrder.saleType === 'cost' || createdOrder.isCostSale
                    ? 'Venta al costo'
                    : createdOrder.paymentMethod === 'gift' || createdOrder.saleType === 'gift'
                      ? 'Regalo / Cortesía'
                      : 'Precio regular'}
                </span>
              </div>
              <div className="flex justify-between font-medium">
                <span className="text-ink-600">Medio de pago:</span>
                <span className="font-bold text-ink-950">
                  {createdOrder.paymentMethod === 'cash'
                    ? 'Efectivo'
                    : createdOrder.paymentMethod === 'gift' || createdOrder.saleType === 'gift'
                      ? 'Sin cargo (Cortesía)'
                      : 'Transferencia'}
                </span>
              </div>
              <div className="border-t border-ink-950/8 pt-3 flex justify-between font-black text-base text-ink-950">
                <span>Total:</span>
                <span className="font-display text-xl text-brand-700">
                  {formatMoney(createdOrder.totalCents)}
                </span>
              </div>
            </div>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/app/pedidos"
                search={{ search: cleanSearchTerm(createdOrder.number) } as any}
                className={buttonStyles({
                  variant: 'primary',
                  size: 'lg',
                  className: 'flex-1 shadow-sm'
                })}
              >
                Ver pedido #{createdOrder.number} en la lista
              </Link>
              <Button
                variant="secondary"
                size="lg"
                className="flex-1 border-ink-950/15"
                onClick={handleReset}
              >
                <RotateCcw className="size-4" /> Cargar otro pedido
              </Button>
            </div>
          </section>
        </div>
      ) : (
        /* Formulario de Carga Manual */
        <div className="grid min-w-0 gap-6 lg:gap-8 lg:grid-cols-[1.1fr_0.9fr] xl:grid-cols-[1.2fr_0.8fr] items-start">
          {/* Columna Izquierda: Selección de Productos y Carrito */}
          <div className="min-w-0 space-y-6">
            {/* Buscador de Productos */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-display text-lg font-black text-ink-950">
                    1. Elegir productos del catálogo
                  </h2>
                  <p className="text-xs font-semibold text-ink-600 mt-0.5">
                    Buscá suplementos por nombre, código o categoría. Solo aparecen productos activos y publicados; podés revisar su visibilidad en Productos.
                  </p>
                </div>
                {categories.length > 0 ? (
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="h-10 w-full sm:w-auto rounded-xl border border-ink-950/15 bg-white px-3 text-xs font-bold text-ink-800 focus:border-brand-500 focus:outline-none shrink-0"
                  >
                    <option value="all">Todas las categorías</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              <div className="relative mt-4">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-500" />
                <input
                  type="search"
                  placeholder="Buscar creatina, proteína, colágeno, SKU…"
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(e.target.value)}
                  className="h-11 w-full rounded-2xl border border-ink-950/15 bg-cream-50 pl-10 pr-4 text-sm font-semibold text-ink-950 placeholder:text-ink-400 focus:border-brand-600 focus:bg-white focus:outline-none"
                />
              </div>

              {/* Lista de productos para agregar */}
              <div className="mt-4 max-h-80 overflow-y-auto divide-y divide-ink-950/6 rounded-2xl border border-ink-950/8 bg-cream-50/50 p-2">
                {filteredProducts.length === 0 ? (
                  <div className="p-8 text-center text-sm font-semibold text-ink-600">
                    No se encontraron productos disponibles con esa búsqueda.
                  </div>
                ) : (
                  filteredProducts.map((p) => {
                    const physAvail = Math.max(0, p.onHand - p.reserved);
                    const incomingAvail = p.incomingAvailable ?? 0;
                    const maxOrderable = Math.max(0, physAvail + incomingAvail);
                    const inCart = items.find((i) => i.productId === p.id);
                    const canAdd = maxOrderable > (inCart?.quantity ?? 0);

                    return (
                      <div
                        key={p.id}
                        className="flex flex-col gap-2.5 p-3 rounded-xl border border-ink-950/6 bg-white/70 sm:flex-row sm:items-center sm:justify-between sm:p-2.5 sm:border-0 sm:bg-transparent sm:hover:bg-white transition"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt={p.imageAlt || p.name}
                              className="size-12 rounded-xl object-contain bg-white p-1 border border-ink-950/8 shrink-0"
                            />
                          ) : (
                            <div className="size-12 rounded-xl bg-cream-200 grid place-items-center shrink-0">
                              <Package className="size-5 text-ink-500" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <h4 className="font-bold text-sm text-ink-950 truncate">{p.name}</h4>
                            <p className="text-xs text-ink-600 truncate">
                              {p.presentation} • <span className="font-mono text-ink-500">{p.sku}</span>
                            </p>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                              {physAvail > 0 ? (
                                <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 font-bold text-emerald-700 border border-emerald-200">
                                  {physAvail} en stock
                                </span>
                              ) : incomingAvail > 0 ? (
                                <span className="rounded-md bg-amber-50 px-1.5 py-0.5 font-bold text-amber-700 border border-amber-200">
                                  {incomingAvail} en camino
                                </span>
                              ) : (
                                <span className="rounded-md bg-rose-50 px-1.5 py-0.5 font-bold text-rose-700 border border-rose-200">
                                  Sin stock
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-3 border-t border-ink-950/6 pt-2 sm:border-t-0 sm:pt-0 sm:justify-end shrink-0">
                          <div className="text-right">
                            <span className="font-display font-black text-sm text-ink-950 block">
                              {saleType === 'gift'
                                ? '$ 0'
                                : formatMoney(saleType === 'cost' ? (p.costCents ?? (p as any).currentCostCents ?? p.priceCents) : p.priceCents)}
                            </span>
                            {saleType === 'cost' ? (
                              <span className="text-[10px] font-black text-amber-800 uppercase tracking-wider block">
                                al costo
                              </span>
                            ) : saleType === 'gift' ? (
                              <span className="text-[10px] font-black text-purple-800 uppercase tracking-wider block">
                                cortesía
                              </span>
                            ) : null}
                          </div>
                          <Button
                            size="sm"
                            variant={inCart ? 'secondary' : 'primary'}
                            disabled={!canAdd}
                            onClick={() => handleAddProduct(p)}
                            className="h-9 px-3 text-xs font-bold shrink-0"
                          >
                            <Plus className="size-3.5" />
                            {inCart ? `Agregar (+${inCart.quantity})` : 'Agregar'}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Carrito de Productos Seleccionados */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-display text-lg font-black text-ink-950">
                    2. Productos cargados en el pedido
                  </h2>
                  <p className="text-xs font-semibold text-ink-600 mt-0.5">
                    {items.length === 0
                      ? 'Todavía no agregaste ningún producto.'
                      : `${totals.units} ${totals.units === 1 ? 'unidad seleccionada' : 'unidades seleccionadas'}.`}
                  </p>
                </div>
                {items.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setItems([])}
                    className="text-xs font-bold text-rose-600 hover:text-rose-700 transition"
                  >
                    Vaciar lista
                  </button>
                ) : null}
              </div>

              {items.length === 0 ? (
                <div className="rounded-2xl border-2 border-dashed border-ink-950/10 p-8 text-center">
                  <ShoppingBag className="mx-auto size-10 text-ink-400" />
                  <p className="mt-2 text-sm font-bold text-ink-700">El pedido está vacío</p>
                  <p className="text-xs text-ink-500 mt-1">
                    Seleccioná productos del catálogo arriba para comenzar.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map((item) => {
                    const willUseIncoming = item.quantity > item.physAvail;
                    return (
                      <div
                        key={item.productId}
                        className="flex flex-col gap-3 p-3.5 rounded-2xl border border-ink-950/8 bg-cream-50/50 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              className="size-11 rounded-xl object-contain bg-white p-1 border border-ink-950/8 shrink-0"
                            />
                          ) : (
                            <div className="size-11 rounded-xl bg-cream-200 grid place-items-center shrink-0">
                              <Package className="size-5 text-ink-500" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <h4 className="font-bold text-sm text-ink-950 truncate">{item.name}</h4>
                            <p className="text-xs text-ink-600 truncate">
                              {item.presentation} • {saleType === 'gift' ? 'Obsequio' : `${formatMoney(item.unitPriceCents)} c/u`}
                            </p>
                            {willUseIncoming ? (
                              <p className="mt-1 text-[11px] font-bold text-amber-700">
                                ⚠️ Requiere {item.quantity - item.physAvail} unidad(es) de compra en camino
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-3 border-t border-ink-950/6 pt-2 sm:border-t-0 sm:pt-0 sm:justify-end shrink-0">
                          {/* Controles de Cantidad */}
                          <div className="flex items-center rounded-xl border border-ink-950/15 bg-white shadow-2xs">
                            <button
                              type="button"
                              onClick={() => handleUpdateQuantity(item.productId, -1)}
                              className="grid size-8 place-items-center text-ink-700 transition hover:bg-cream-100 rounded-l-xl"
                              aria-label="Disminuir cantidad"
                            >
                              <Minus className="size-3.5" />
                            </button>
                            <span className="min-w-8 text-center text-xs font-black text-ink-950">
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleUpdateQuantity(item.productId, 1)}
                              disabled={item.quantity >= item.maxOrderable}
                              className="grid size-8 place-items-center text-ink-700 transition hover:bg-cream-100 rounded-r-xl disabled:opacity-40"
                              aria-label="Aumentar cantidad"
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </div>

                          <div className="text-right min-w-16 sm:min-w-20">
                            <span className="block font-display font-black text-sm text-ink-950">
                              {saleType === 'gift' ? '$ 0' : formatMoney(item.unitPriceCents * item.quantity)}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleRemoveProduct(item.productId)}
                            className="grid size-8 place-items-center rounded-lg text-ink-400 hover:bg-rose-50 hover:text-rose-600 transition"
                            aria-label="Eliminar producto"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          {/* Columna Derecha: Datos del Cliente, Entrega, Pago y Confirmación */}
          <div className="min-w-0 space-y-6">
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <h2 className="font-display text-lg font-black text-ink-950 mb-4">
                3. Datos del cliente
              </h2>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Nombre *"
                    htmlFor="customerFirstName"
                    hint="Primer nombre del cliente."
                  >
                    <Input
                      id="customerFirstName"
                      placeholder="Ej. Marta"
                      value={customerFirstName}
                      onChange={(e) => {
                        setCustomerFirstName(e.target.value);
                        setValidationError(null);
                      }}
                    />
                  </Field>

                  <Field
                    label="Apellido *"
                    htmlFor="customerLastName"
                    hint="Apellido del cliente."
                  >
                    <Input
                      id="customerLastName"
                      placeholder="Ej. Gómez"
                      value={customerLastName}
                      onChange={(e) => {
                        setCustomerLastName(e.target.value);
                        setValidationError(null);
                      }}
                    />
                  </Field>
                </div>

                <Field
                  label={deliveryMethod === 'shipping' ? 'Teléfono de contacto *' : 'Teléfono (opcional)'}
                  htmlFor="customerPhone"
                  hint={
                    deliveryMethod === 'shipping'
                      ? 'Requerido para coordinar el envío (mínimo 8 dígitos).'
                      : 'Útil para enviar aviso o comprobante por WhatsApp.'
                  }
                >
                  <Input
                    id="customerPhone"
                    type="tel"
                    placeholder="Ej. 11 4567-8901"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setValidationError(null);
                    }}
                  />
                </Field>
              </div>
            </section>

            {/* Entrega */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <h2 className="font-display text-lg font-black text-ink-950 mb-4">
                4. Forma de entrega
              </h2>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setDeliveryMethod('pickup');
                    setValidationError(null);
                  }}
                  className={cn(
                    'flex flex-col items-center justify-center p-3.5 rounded-2xl border text-center transition',
                    deliveryMethod === 'pickup'
                      ? 'border-brand-600 bg-brand-50/70 text-brand-950 ring-2 ring-brand-500/20'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                >
                  <Store className="size-6 mb-1.5 text-brand-600" />
                  <span className="text-sm font-black">Retiro en local</span>
                  <span className="text-xs text-ink-500">Sin costo ($0)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDeliveryMethod('shipping');
                    setValidationError(null);
                  }}
                  className={cn(
                    'flex flex-col items-center justify-center p-3.5 rounded-2xl border text-center transition',
                    deliveryMethod === 'shipping'
                      ? 'border-brand-600 bg-brand-50/70 text-brand-950 ring-2 ring-brand-500/20'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                >
                  <Truck className="size-6 mb-1.5 text-brand-600" />
                  <span className="text-sm font-black">Envío a domicilio</span>
                  <span className="text-xs text-ink-500">A coordinar</span>
                </button>
              </div>

              {deliveryMethod === 'shipping' ? (
                <div className="space-y-4 pt-2 border-t border-ink-950/8">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-2">
                    <div className="sm:col-span-2">
                      <Field label="Calle / Dirección *" htmlFor="address">
                        <Input
                          id="address"
                          placeholder="Ej. Av. Corrientes"
                          value={address}
                          onChange={(e) => {
                            setAddress(e.target.value);
                            setValidationError(null);
                          }}
                        />
                      </Field>
                    </div>
                    <div>
                      <Field label="Altura / Piso *" htmlFor="addressNumber">
                        <Input
                          id="addressNumber"
                          placeholder="Ej. 1420 3°B"
                          value={addressNumber}
                          onChange={(e) => {
                            setAddressNumber(e.target.value);
                            setValidationError(null);
                          }}
                        />
                      </Field>
                    </div>
                  </div>

                  {/* Zona de Entrega (Santa Fe Capital / Alrededores vs Resto del País) */}
                  <div className="pt-5 border-t border-ink-950/10 space-y-3">
                    <p className="text-sm font-black text-ink-950">
                      ¿El envío es dentro de la ciudad de Santa Fe Capital o alguna localidad cercana?
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setIsSantaFeOrNearby(true);
                          setEmail('');
                          setValidationError(null);
                        }}
                        className={cn(
                          'flex items-center gap-3 rounded-xl border-2 p-3 text-left transition cursor-pointer',
                          isSantaFeOrNearby === true
                            ? 'border-brand-600 bg-brand-50/70 text-ink-950 ring-2 ring-brand-500/20 shadow-xs'
                            : 'border-ink-950/10 bg-white text-ink-700 hover:border-brand-500/30 hover:bg-cream-50'
                        )}
                      >
                        <Building2 className={cn('size-5 shrink-0', isSantaFeOrNearby === true ? 'text-brand-600' : 'text-ink-500')} />
                        <div className="min-w-0 flex-1">
                          <span className="block text-xs font-black tracking-wider uppercase">SÍ</span>
                          <span className="block text-xs font-semibold text-ink-600 truncate">Santa Fe y cercanías</span>
                        </div>
                        {isSantaFeOrNearby === true ? <Check className="size-4 shrink-0 text-brand-600 stroke-[3]" /> : null}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setIsSantaFeOrNearby(false);
                          setValidationError(null);
                        }}
                        className={cn(
                          'flex items-center gap-3 rounded-xl border-2 p-3 text-left transition cursor-pointer',
                          isSantaFeOrNearby === false
                            ? 'border-brand-600 bg-brand-50/70 text-ink-950 ring-2 ring-brand-500/20 shadow-xs'
                            : 'border-ink-950/10 bg-white text-ink-700 hover:border-brand-500/30 hover:bg-cream-50'
                        )}
                      >
                        <Truck className={cn('size-5 shrink-0', isSantaFeOrNearby === false ? 'text-brand-600' : 'text-ink-500')} />
                        <div className="min-w-0 flex-1">
                          <span className="block text-xs font-black tracking-wider uppercase">NO</span>
                          <span className="block text-xs font-semibold text-ink-600 truncate">Resto del país</span>
                        </div>
                        {isSantaFeOrNearby === false ? <Check className="size-4 shrink-0 text-brand-600 stroke-[3]" /> : null}
                      </button>
                    </div>

                    {isSantaFeOrNearby === false ? (
                      <div className="pt-2">
                        <Field
                          label="Correo electrónico del cliente *"
                          htmlFor="clientEmail"
                          hint="Es para poder enviarte el link de seguimiento de tu pedido"
                        >
                          <Input
                            id="clientEmail"
                            type="email"
                            placeholder="cliente@correo.com"
                            value={email}
                            onChange={(e) => {
                              setEmail(e.target.value);
                              setValidationError(null);
                            }}
                          />
                        </Field>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            {/* Modalidad de Venta */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <h2 className="font-display text-lg font-black text-ink-950 mb-1">
                5. Modalidad de venta
              </h2>
              <p className="text-xs text-ink-600 font-medium mb-4">
                Elegí si el pedido es a precio regular, a precio de costo o un regalo de cortesía.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => handleSaleTypeChange('retail')}
                  className={cn(
                    'flex items-center gap-3 p-3.5 rounded-2xl border text-left transition',
                    saleType === 'retail'
                      ? 'border-brand-600 bg-brand-50/70 text-brand-950 ring-2 ring-brand-500/20'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                >
                  <ShoppingBag className="size-5 text-brand-600 shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-black">Precio regular</span>
                    <span className="text-[11px] text-ink-500">Precio habitual de lista</span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleSaleTypeChange('cost')}
                  className={cn(
                    'flex items-center gap-3 p-3.5 rounded-2xl border text-left transition',
                    saleType === 'cost'
                      ? 'border-amber-600 bg-amber-50/70 text-amber-950 ring-2 ring-amber-500/20'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                >
                  <Tag className="size-5 text-amber-600 shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-black">Venta al costo</span>
                    <span className="text-[11px] text-amber-800">A precio de reposición</span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleSaleTypeChange('gift')}
                  className={cn(
                    'flex items-center gap-3 p-3.5 rounded-2xl border text-left transition',
                    saleType === 'gift'
                      ? 'border-purple-600 bg-purple-50/70 text-purple-950 ring-2 ring-purple-500/20'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                >
                  <Gift className="size-5 text-purple-600 shrink-0" />
                  <div className="min-w-0">
                    <span className="block text-sm font-black">Regalo / Cortesía</span>
                    <span className="text-[11px] text-purple-800">Obsequio sin cargo ($ 0)</span>
                  </div>
                </button>
              </div>
            </section>

            {/* Medio de Pago */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/8 bg-white p-4 sm:p-6 shadow-sm min-w-0">
              <h2 className="font-display text-lg font-black text-ink-950 mb-1">
                6. Medio de pago acordado
              </h2>

              {saleType === 'gift' ? (
                <div className="mt-3 flex items-center gap-3 rounded-2xl border border-purple-200 bg-purple-50/70 p-4 text-purple-950">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-purple-100 text-purple-700">
                    <Gift className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <span className="block text-sm font-black text-purple-950">
                      Sin cobro monetario
                    </span>
                    <p className="text-xs text-purple-800 mt-0.5">
                      No se requiere medio de pago porque este pedido es una atención de cortesía ($ 0).
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs text-ink-600 font-medium mb-4">
                    Seleccioná cómo abonará el cliente.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMethod('cash')}
                      className={cn(
                        'flex items-center gap-3 p-3.5 rounded-2xl border text-left transition',
                        paymentMethod === 'cash'
                          ? 'border-brand-600 bg-brand-50/70 text-brand-950 ring-2 ring-brand-500/20'
                          : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                      )}
                    >
                      <Banknote className="size-5 text-emerald-600 shrink-0" />
                      <div className="min-w-0">
                        <span className="block text-sm font-black">Efectivo</span>
                        <span className="text-[11px] text-ink-500">Cobro en entrega</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setPaymentMethod('transfer')}
                      className={cn(
                        'flex items-center gap-3 p-3.5 rounded-2xl border text-left transition',
                        paymentMethod === 'transfer'
                          ? 'border-brand-600 bg-brand-50/70 text-brand-950 ring-2 ring-brand-500/20'
                          : 'border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                      )}
                    >
                      <CreditCard className="size-5 text-blue-600 shrink-0" />
                      <div className="min-w-0">
                        <span className="block text-sm font-black">Transferencia</span>
                        <span className="text-[11px] text-ink-500">Alias o CBU</span>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* Resumen Económico y Botón de Confirmación */}
            <section className="rounded-2xl sm:rounded-3xl border border-ink-950/10 bg-white p-5 sm:p-6 shadow-card min-w-0">
              <h3 className="font-display text-xl font-black text-ink-950 mb-4">
                Resumen del pedido
              </h3>

              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between font-semibold text-ink-700">
                  <span>Productos ({totals.units} unidades)</span>
                  <span className="font-bold text-ink-950">
                    {saleType === 'gift' ? '$0 (Cortesía)' : formatMoney(totals.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold text-ink-700">
                  <span>
                    Envío {deliveryMethod === 'shipping' ? '(A domicilio)' : '(Retiro)'}
                  </span>
                  <span className="font-bold text-ink-950">
                    {deliveryMethod === 'shipping'
                      ? totals.shipping > 0
                        ? formatMoney(totals.shipping)
                        : 'A coordinar'
                      : '$0 (Retiro)'}
                  </span>
                </div>
              </div>

              <div className="my-4 border-t border-ink-950/8" />

              <div className="flex items-baseline justify-between mb-4">
                <span className="text-xs font-black uppercase tracking-wider text-ink-700">
                  {saleType === 'gift' ? 'Total cortesía' : 'Total a cobrar'}
                </span>
                <span
                  className={cn(
                    'font-display text-3xl font-black',
                    saleType === 'gift' ? 'text-purple-700' : 'text-ink-950'
                  )}
                >
                  {formatMoney(totals.total)}
                </span>
              </div>

              {saleType === 'cost' ? (
                <div className="mb-4 rounded-xl bg-amber-50 p-3.5 border border-amber-200/80 text-xs font-semibold text-amber-950 flex items-start gap-2.5">
                  <Tag className="size-4 shrink-0 text-amber-700 mt-0.5" />
                  <span>
                    Venta al costo: el pedido se cobra al valor de reposición de la mercadería ({formatMoney(totals.subtotal)}), sin recargo comercial adicional.
                  </span>
                </div>
              ) : null}

              {saleType === 'gift' ? (
                <div className="mb-4 rounded-xl bg-purple-50 p-3.5 border border-purple-200/80 text-xs font-semibold text-purple-950 flex items-start gap-2.5">
                  <Gift className="size-4 shrink-0 text-purple-700 mt-0.5" />
                  <span>
                    Pedido de regalo / cortesía: se entrega sin cargo ($ 0) al destinatario. Descontará el stock real del inventario.
                  </span>
                </div>
              ) : null}

              {stockReadiness === 'waiting_incoming' ? (
                <div className="mb-4 rounded-xl bg-amber-50 p-3 border border-amber-200/60 text-xs font-semibold text-amber-800 flex items-start gap-2">
                  <AlertCircle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                  <span>
                    El pedido contiene unidades que se cubrirán con stock de compra en camino.
                  </span>
                </div>
              ) : null}

              {validationError ? (
                <div className="mb-4 rounded-xl bg-rose-50 p-3 border border-rose-200 text-xs font-bold text-rose-800">
                  {validationError}
                </div>
              ) : null}

              {confirmMutation.error ? (
                <div className="mb-4">
                  <ErrorState error={confirmMutation.error} />
                </div>
              ) : null}

              {items.length === 0 ? (
                <p className="mb-3 rounded-xl bg-cream-100 p-2.5 text-center text-xs font-bold text-ink-600">
                  Agregá al menos un producto al pedido para poder confirmar.
                </p>
              ) : !customerFirstName.trim() || !customerLastName.trim() ? (
                <p className="mb-3 rounded-xl bg-amber-50 p-2.5 text-center text-xs font-bold text-amber-800 border border-amber-200">
                  Completá el nombre y el apellido del cliente para habilitar la confirmación.
                </p>
              ) : null}

              <Button
                size="lg"
                className={cn(
                  'w-full text-base font-black shadow-sm',
                  saleType === 'gift'
                    ? 'bg-purple-700 hover:bg-purple-800 text-white'
                    : saleType === 'cost'
                      ? 'bg-amber-700 hover:bg-amber-800 text-white'
                      : ''
                )}
                loading={confirmMutation.isPending}
                disabled={items.length === 0 || !customerFirstName.trim() || !customerLastName.trim() || confirmMutation.isPending}
                onClick={handleSubmit}
              >
                {saleType === 'gift'
                  ? 'Confirmar regalo / cortesía'
                  : saleType === 'cost'
                    ? 'Confirmar venta al costo'
                    : 'Confirmar pedido manual'}
              </Button>
              <p className="mt-2.5 text-center text-xs font-semibold text-ink-500">
                Al confirmar, el stock se reserva inmediatamente en el inventario.
              </p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
