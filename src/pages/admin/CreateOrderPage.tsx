import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  MapPin,
  Minus,
  Package,
  Plus,
  RotateCcw,
  Search,
  ShoppingBag,
  Store,
  Trash2,
  Truck
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { AppError } from '@/domain/errors';
import { formatMoney } from '@/domain/money';
import type {
  AdminProduct,
  CartLine,
  DeliveryMethod,
  ImportOrderInput,
  Order,
  PaymentMethod,
  ShippingType
} from '@/domain/types';
import { buildWhatsAppProtocol } from '@/domain/whatsapp';
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
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');

  // Entrega y pago
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('pickup');
  const [shippingType, setShippingType] = useState<ShippingType>('standard');
  const [address, setAddress] = useState('');
  const [addressNumber, setAddressNumber] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');

  // Estado de finalización y errores
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
      if (!p.active) return false;
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
    const subtotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
    let shipping = 0;
    if (deliveryMethod === 'shipping' && settings) {
      shipping =
        shippingType === 'express'
          ? settings.expressShippingCents
          : settings.standardShippingCents;
    }
    return {
      subtotal,
      shipping,
      total: subtotal + shipping,
      units: items.reduce((sum, item) => sum + item.quantity, 0)
    };
  }, [items, deliveryMethod, shippingType, settings]);

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
      const newItem: SelectedItem = {
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents: product.priceCents,
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
    setValidationError(null);

    if (items.length === 0) {
      setValidationError('Seleccioná al menos un producto para el pedido.');
      return;
    }

    const trimmedName = customerName.trim();
    if (trimmedName.length < 2) {
      setValidationError('Ingresá el nombre del cliente (mínimo 2 letras).');
      return;
    }

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
    }

    if (!settings) {
      setValidationError('Aguardá mientras se carga la configuración de la tienda.');
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

    const checkoutData = {
      customerName: trimmedName,
      phone: trimmedPhone || null,
      deliveryMethod,
      shippingType: deliveryMethod === 'shipping' ? shippingType : null,
      address: deliveryMethod === 'shipping' ? address.trim() : null,
      addressNumber: deliveryMethod === 'shipping' ? addressNumber.trim() : null,
      paymentMethod
    };

    // Generar protocolo determinista válido para la API
    const protocol = buildWhatsAppProtocol(checkoutData, lines, settings);

    const payload: ImportOrderInput = {
      ...checkoutData,
      lines,
      shippingFeeCents: totals.shipping,
      quotedSubtotalCents: totals.subtotal,
      quotedTotalCents: totals.total,
      protocolOrderId: protocol.orderId,
      protocolChecksum: protocol.checksum
    };

    confirmMutation.mutate(payload);
  };

  const handleReset = () => {
    setCreatedOrder(null);
    setItems([]);
    setCustomerName('');
    setPhone('');
    setAddress('');
    setAddressNumber('');
    setDeliveryMethod('pickup');
    setShippingType('standard');
    setPaymentMethod('cash');
    setValidationError(null);
  };

  if (productsQuery.isPending || settingsQuery.isPending) {
    return <LoadingState label="Cargando catálogo de productos y configuración…" />;
  }

  if (productsQuery.isError) {
    return <ErrorState error={productsQuery.error} />;
  }

  return (
    <div className="page-enter">
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
                    : `Envío a domicilio (${createdOrder.shippingType === 'express' ? 'Express' : 'Estándar'})`}
                </span>
              </div>
              {createdOrder.shippingAddress ? (
                <div className="flex justify-between font-medium">
                  <span className="text-ink-600">Dirección:</span>
                  <span className="font-bold text-ink-950 text-right">
                    {createdOrder.shippingAddress}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between font-medium">
                <span className="text-ink-600">Medio de pago:</span>
                <span className="font-bold text-ink-950">
                  {createdOrder.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'}
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
        <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] xl:grid-cols-[1.2fr_0.8fr] items-start">
          {/* Columna Izquierda: Selección de Productos y Carrito */}
          <div className="space-y-6">
            {/* Buscador de Productos */}
            <section className="rounded-3xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-display text-lg font-black text-ink-950">
                    1. Elegir productos del catálogo
                  </h2>
                  <p className="text-xs font-semibold text-ink-600 mt-0.5">
                    Buscá suplementos por nombre, código o categoría.
                  </p>
                </div>
                {categories.length > 0 ? (
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="h-10 rounded-xl border border-ink-950/15 bg-white px-3 text-xs font-bold text-ink-800 focus:border-brand-500 focus:outline-none"
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
                        className="flex items-center justify-between gap-3 p-2.5 transition rounded-xl hover:bg-white"
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
                          <div className="min-w-0">
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

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-display font-black text-sm text-ink-950">
                            {formatMoney(p.priceCents)}
                          </span>
                          <Button
                            size="sm"
                            variant={inCart ? 'secondary' : 'primary'}
                            disabled={!canAdd}
                            onClick={() => handleAddProduct(p)}
                            className="h-9 px-3 text-xs font-bold"
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
            <section className="rounded-3xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
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
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl border border-ink-950/8 bg-cream-50/50"
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
                          <div className="min-w-0">
                            <h4 className="font-bold text-sm text-ink-950 truncate">{item.name}</h4>
                            <p className="text-xs text-ink-600 truncate">
                              {item.presentation} • {formatMoney(item.unitPriceCents)} c/u
                            </p>
                            {willUseIncoming ? (
                              <p className="mt-1 text-[11px] font-bold text-amber-700">
                                ⚠️ Requiere {item.quantity - item.physAvail} unidad(es) de compra en camino
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-4 shrink-0">
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

                          <div className="text-right min-w-20">
                            <span className="block font-display font-black text-sm text-ink-950">
                              {formatMoney(item.unitPriceCents * item.quantity)}
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
          <div className="space-y-6">
            <section className="rounded-3xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="font-display text-lg font-black text-ink-950 mb-4">
                3. Datos del cliente
              </h2>

              <div className="space-y-4">
                <Field
                  label="Nombre y Apellido *"
                  htmlFor="customerName"
                  hint="Persona a nombre de quien se registra el pedido."
                >
                  <Input
                    id="customerName"
                    placeholder="Ej. Marta Gómez"
                    value={customerName}
                    onChange={(e) => {
                      setCustomerName(e.target.value);
                      setValidationError(null);
                    }}
                  />
                </Field>

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
            <section className="rounded-3xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
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
                  <div className="space-y-2">
                    <label className="block text-xs font-bold text-ink-800 uppercase tracking-wider">
                      Tipo de envío
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setShippingType('standard')}
                        className={cn(
                          'p-2.5 rounded-xl border text-left text-xs transition',
                          shippingType === 'standard'
                            ? 'border-brand-600 bg-brand-50 text-brand-950 font-bold'
                            : 'border-ink-950/15 bg-white text-ink-700 font-semibold'
                        )}
                      >
                        <span className="block font-black">Estándar</span>
                        <span className="text-ink-600">
                          {formatMoney(settings?.standardShippingCents ?? 0)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShippingType('express')}
                        className={cn(
                          'p-2.5 rounded-xl border text-left text-xs transition',
                          shippingType === 'express'
                            ? 'border-brand-600 bg-brand-50 text-brand-950 font-bold'
                            : 'border-ink-950/15 bg-white text-ink-700 font-semibold'
                        )}
                      >
                        <span className="block font-black">Express</span>
                        <span className="text-ink-600">
                          {formatMoney(settings?.expressShippingCents ?? 0)}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
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
                </div>
              ) : null}
            </section>

            {/* Medio de Pago */}
            <section className="rounded-3xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="font-display text-lg font-black text-ink-950 mb-4">
                5. Medio de pago acordado
              </h2>

              <div className="grid grid-cols-2 gap-3">
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
                  <Banknote className="size-5 text-emerald-600" />
                  <div>
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
                  <CreditCard className="size-5 text-blue-600" />
                  <div>
                    <span className="block text-sm font-black">Transferencia</span>
                    <span className="text-[11px] text-ink-500">Alias o CBU</span>
                  </div>
                </button>
              </div>
            </section>

            {/* Resumen Económico y Botón de Confirmación */}
            <section className="rounded-3xl border border-ink-950/10 bg-white p-6 shadow-card">
              <h3 className="font-display text-xl font-black text-ink-950 mb-4">
                Resumen del pedido
              </h3>

              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between font-semibold text-ink-700">
                  <span>Productos ({totals.units} unidades)</span>
                  <span className="font-bold text-ink-950">{formatMoney(totals.subtotal)}</span>
                </div>
                <div className="flex justify-between font-semibold text-ink-700">
                  <span>
                    Envío{' '}
                    {deliveryMethod === 'shipping'
                      ? `(${shippingType === 'express' ? 'Express' : 'Estándar'})`
                      : '(Retiro)'}
                  </span>
                  <span className="font-bold text-ink-950">
                    {totals.shipping > 0 ? formatMoney(totals.shipping) : '$0'}
                  </span>
                </div>
              </div>

              <div className="my-4 border-t border-ink-950/8" />

              <div className="flex items-baseline justify-between mb-4">
                <span className="text-xs font-black uppercase tracking-wider text-ink-700">
                  Total a cobrar
                </span>
                <span className="font-display text-3xl font-black text-ink-950">
                  {formatMoney(totals.total)}
                </span>
              </div>

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

              <Button
                size="lg"
                className="w-full text-base font-black shadow-sm"
                loading={confirmMutation.isPending}
                disabled={items.length === 0 || customerName.trim().length < 2}
                onClick={handleSubmit}
              >
                Confirmar pedido manual
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
