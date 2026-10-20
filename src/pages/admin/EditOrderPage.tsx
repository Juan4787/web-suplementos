import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Lock,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { useAppConfirmation } from '@/components/ui/AppConfirmation';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ClearSearchButton } from '@/components/ui/ClearSearchButton';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Input } from '@/components/ui/Field';
import { AppError } from '@/domain/errors';
import { formatMoney } from '@/domain/money';
import { orderEditBlock } from '@/domain/order-actions';
import { orderableQuantity } from '@/domain/order-shipping';
import { can } from '@/domain/permissions';
import type { AdminProduct, Order, UpdateOrderItemsInput } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';
import { cleanSearchTerm } from '@/lib/search';
import { getBusinessApi } from '@/services/business-api';

type EditableOrderLine = {
  productId: string;
  sku: string;
  name: string;
  presentation: string;
  imageUrl: string;
  unitPriceCents: number;
  unitCostCents: number;
  quantity: number;
  initialQuantity: number;
  packedQuantity: number;
};

export default function EditOrderPage() {
  const { user } = useAuth();
  const params = useParams({ strict: false }) as { orderId?: string };
  const orderId = params.orderId ?? '';
  const queryClient = useQueryClient();
  const askConfirmation = useAppConfirmation();
  const navigate = useNavigate();

  const orderQuery = useBusinessQuery({
    queryKey: queryKeys.order(orderId),
    queryFn: (api) => api.getOrder(orderId)
  });

  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.products,
    queryFn: (api) => api.listAdminProducts()
  });

  const [searchProduct, setSearchProduct] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [draftItems, setDraftItems] = useState<EditableOrderLine[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const initializedOrderRef = useRef<string | null>(null);
  const operationDraft = useRef<{ operationId: string; fingerprint: string } | null>(null);

  const order = orderQuery.data;
  const products = productsQuery.data ?? [];
  const canManagePricing = can(user, 'manage_pricing');

  const buildInitialLines = (sourceOrder: Order, catalog: AdminProduct[]): EditableOrderLine[] =>
    sourceOrder.items.map((item) => {
      const product = catalog.find((p) => p.id === item.productId);
      const unitCost =
        item.unitCostCents ??
        product?.currentCostCents ??
        product?.costCents ??
        item.unitPriceCents;
      return {
        productId: item.productId,
        sku: item.sku || product?.sku || '',
        name: item.productName,
        presentation: item.presentation || product?.presentation || '',
        imageUrl: product?.imageUrl ?? '',
        unitPriceCents: item.unitPriceCents,
        unitCostCents: unitCost,
        quantity: item.quantity,
        initialQuantity: item.quantity,
        packedQuantity: item.packedQuantity ?? 0
      };
    });

  useEffect(() => {
    if (!order || productsQuery.isLoading) return;
    const key = `${order.id}:${order.actionRevision ?? 0}`;
    if (initializedOrderRef.current !== key) {
      initializedOrderRef.current = key;
      setDraftItems(buildInitialLines(order, products));
      setValidationError(null);
    }
  }, [order, products, productsQuery.isLoading]);

  const stockSource = order?.stockSource ?? 'normal';

  const productById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );

  const initialItemByProductId = useMemo(
    () => new Map((order?.items ?? []).map((item) => [item.productId, item])),
    [order?.items]
  );

  const getProductBounds = (productId: string) => {
    const initialItem = initialItemByProductId.get(productId);
    const initialQty = initialItem?.quantity ?? 0;
    const packedQty = initialItem?.packedQuantity ?? 0;
    const product = productById.get(productId);
    const additionalAvail = product?.active ? orderableQuantity(product, stockSource) : 0;
    const physFree =
      stockSource === 'incoming_only'
        ? 0
        : product
          ? Math.max(0, product.onHand - product.reserved)
          : 0;
    const incomingFree = product
      ? Math.max(0, product.incomingAvailable ?? product.incoming - (product.incomingReserved ?? 0))
      : 0;
    return {
      initialQty,
      packedQty,
      additionalAvail,
      maxCapacity: initialQty + additionalAvail,
      minCapacity: packedQty,
      physFree,
      incomingFree
    };
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set).sort();
  }, [products]);

  const filteredProducts = useMemo(() => {
    const term = searchProduct.trim().toLowerCase();
    return products.filter((p) => {
      const inOriginalOrder = initialItemByProductId.has(p.id);
      if (!p.active && !inOriginalOrder) return false;
      if (
        stockSource === 'incoming_only' &&
        (p.incomingAvailable ?? 0) <= 0 &&
        !inOriginalOrder
      ) {
        return false;
      }
      if (selectedCategory !== 'all' && p.category !== selectedCategory) return false;
      if (!term) return true;
      return (
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        p.presentation.toLowerCase().includes(term) ||
        p.category.toLowerCase().includes(term)
      );
    });
  }, [products, searchProduct, selectedCategory, stockSource, initialItemByProductId]);

  const hasChanges = useMemo(() => {
    if (!order) return false;
    if (draftItems.length !== order.items.length) return true;
    return draftItems.some((line) => {
      const orig = initialItemByProductId.get(line.productId);
      return !orig || orig.quantity !== line.quantity;
    });
  }, [draftItems, order, initialItemByProductId]);

  const removedInitialItems = useMemo(() => {
    if (!order) return [];
    const activeIds = new Set(draftItems.map((i) => i.productId));
    return order.items.filter((item) => !activeIds.has(item.productId));
  }, [order, draftItems]);

  const invalidItems = useMemo(
    () =>
      draftItems.filter((item) => {
        const bounds = getProductBounds(item.productId);
        return item.quantity > bounds.maxCapacity || item.quantity < bounds.minCapacity;
      }),
    [draftItems, products, order]
  );

  const summaryTotals = useMemo(() => {
    if (!order) {
      return { subtotalCents: 0, shippingFeeCents: 0, totalCents: 0, units: 0, deltaCents: 0 };
    }
    const isGift = order.saleType === 'gift' || order.paymentState === 'gifted';
    const isCost = order.saleType === 'cost' || order.isCostSale === true;
    const rawSubtotal = draftItems.reduce((sum, item) => {
      const unit = isGift ? 0 : isCost ? item.unitCostCents : item.unitPriceCents;
      return sum + unit * item.quantity;
    }, 0);
    const shippingFeeCents = isGift ? 0 : order.shippingFeeCents;
    const subtotalCents = isGift ? 0 : rawSubtotal;
    const totalCents = isGift ? 0 : subtotalCents + shippingFeeCents;
    const units = draftItems.reduce((sum, item) => sum + item.quantity, 0);
    return {
      subtotalCents,
      shippingFeeCents,
      totalCents,
      units,
      deltaCents: totalCents - order.totalCents
    };
  }, [draftItems, order]);

  const handleAddOrIncrementProduct = (product: AdminProduct) => {
    if (!order) return;
    setValidationError(null);
    const bounds = getProductBounds(product.id);
    if (bounds.maxCapacity <= 0) return;

    setDraftItems((current) => {
      const existing = current.find((i) => i.productId === product.id);
      if (existing) {
        if (existing.quantity >= bounds.maxCapacity) return current;
        return current.map((i) =>
          i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      const initialItem = initialItemByProductId.get(product.id);
      const restoreQty = initialItem ? Math.min(initialItem.quantity, bounds.maxCapacity) : 1;
      const unitCost =
        initialItem?.unitCostCents ??
        product.currentCostCents ??
        product.costCents ??
        product.priceCents;
      const unitPrice =
        order.saleType === 'gift' || order.paymentState === 'gifted'
          ? 0
          : order.saleType === 'cost' || order.isCostSale === true
            ? unitCost
            : initialItem?.unitPriceCents ?? product.priceCents;
      return [
        ...current,
        {
          productId: product.id,
          sku: product.sku,
          name: product.name,
          presentation: product.presentation,
          imageUrl: product.imageUrl,
          unitPriceCents: unitPrice,
          unitCostCents: unitCost,
          quantity: Math.max(1, restoreQty),
          initialQuantity: initialItem?.quantity ?? 0,
          packedQuantity: initialItem?.packedQuantity ?? 0
        }
      ];
    });
  };

  const handleUpdateQuantity = (productId: string, delta: number) => {
    setValidationError(null);
    const bounds = getProductBounds(productId);
    setDraftItems((current) =>
      current
        .map((item) => {
          if (item.productId !== productId) return item;
          const nextQty = item.quantity + delta;
          if (delta < 0 && nextQty < bounds.minCapacity) {
            return item;
          }
          if (nextQty <= 0) {
            return null;
          }
          if (delta > 0 && nextQty > bounds.maxCapacity) {
            return item;
          }
          return { ...item, quantity: nextQty };
        })
        .filter((item): item is EditableOrderLine => item !== null)
    );
  };

  const handleRemoveProduct = (productId: string) => {
    setValidationError(null);
    const bounds = getProductBounds(productId);
    if (bounds.minCapacity > 0) {
      setValidationError(
        `No podés quitar este producto porque ya tiene ${bounds.minCapacity} u. guardadas en la bolsita. Desarmá primero la bolsita en Pedidos.`
      );
      return;
    }
    setDraftItems((current) => current.filter((i) => i.productId !== productId));
  };

  const handleRestoreRemovedItem = (productId: string) => {
    setValidationError(null);
    const orig = initialItemByProductId.get(productId);
    if (!orig) return;
    const product = productById.get(productId);
    const bounds = getProductBounds(productId);
    const unitCost =
      orig.unitCostCents ?? product?.currentCostCents ?? product?.costCents ?? orig.unitPriceCents;
    setDraftItems((current) => [
      ...current,
      {
        productId: orig.productId,
        sku: orig.sku || product?.sku || '',
        name: orig.productName,
        presentation: orig.presentation || product?.presentation || '',
        imageUrl: product?.imageUrl ?? '',
        unitPriceCents: orig.unitPriceCents,
        unitCostCents: unitCost,
        quantity: Math.min(orig.quantity, Math.max(1, bounds.maxCapacity)),
        initialQuantity: orig.quantity,
        packedQuantity: orig.packedQuantity ?? 0
      }
    ]);
  };

  const handleResetToOriginal = () => {
    if (!order) return;
    setValidationError(null);
    setDraftItems(buildInitialLines(order, products));
  };

  const completedSaveRef = useRef(false);

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateOrderItemsInput) => {
      completedSaveRef.current = false;
      const api = await getBusinessApi();
      return api.updateOrderItems(input);
    },
    onError: async (error) => {
      if (error instanceof AppError && error.kind === 'business') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.order(orderId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.products })
        ]);
      }
    },
    onSuccess: async (updatedOrder) => {
      completedSaveRef.current = true;
      queryClient.setQueryData(queryKeys.order(orderId), updatedOrder);
      initializedOrderRef.current = `${updatedOrder.id}:${updatedOrder.actionRevision ?? 0}`;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
        queryClient.invalidateQueries({ queryKey: ['movements'] })
      ]);
      navigate({
        to: '/app/pedidos',
        search: { search: String(updatedOrder.number) } as any
      });
    }
  });

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (updateMutation.isPending && !completedSaveRef.current) {
        return !(await askConfirmation({
          title: 'Guardando cambios del pedido',
          description:
            'Salir ahora no cancela el guardado en curso. Esperá unos segundos o revisá el pedido en la lista al volver.',
          confirmLabel: 'Salir de todos modos',
          cancelLabel: 'Seguir esperando'
        }));
      }
      return false;
    },
    enableBeforeUnload: updateMutation.isPending && !completedSaveRef.current
  });

  const handleSubmit = () => {
    if (!order || updateMutation.isPending) return;
    setValidationError(null);

    if (draftItems.length === 0) {
      setValidationError(
        'El pedido debe conservar al menos un producto. Si el cliente no quiere nada, cancelá el pedido desde Pedidos.'
      );
      return;
    }

    if (invalidItems.length > 0) {
      setValidationError(
        'Revisá los productos marcados en rojo: superan el stock disponible o bajan de lo guardado en la bolsita.'
      );
      return;
    }

    const payloadItems = draftItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity
    }));

    const fingerprint = JSON.stringify({
      orderId: order.id,
      expectedActionRevision: order.actionRevision ?? 0,
      items: [...payloadItems].sort((a, b) => a.productId.localeCompare(b.productId))
    });

    if (operationDraft.current?.fingerprint !== fingerprint) {
      operationDraft.current = {
        operationId: crypto.randomUUID(),
        fingerprint
      };
    }

    updateMutation.mutate({
      orderId: order.id,
      expectedActionRevision: order.actionRevision ?? 0,
      operationId: operationDraft.current.operationId,
      items: payloadItems
    });
  };

  if (!can(user, 'operate_orders')) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Editar pedido"
          description="Tu cuenta no tiene permisos para modificar pedidos."
        />
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
          No tenés permisos para modificar pedidos. Pedile acceso a una administradora.
        </div>
      </div>
    );
  }

  if (orderQuery.isLoading || productsQuery.isLoading) {
    return <LoadingState label="Cargando pedido y catálogo de productos..." />;
  }

  if (orderQuery.error || !order) {
    return (
      <ErrorState
        error={orderQuery.error ?? new Error('No encontramos el pedido.')}
        onRetry={() => orderQuery.refetch()}
      />
    );
  }

  if (productsQuery.error) {
    return <ErrorState error={productsQuery.error} onRetry={() => productsQuery.refetch()} />;
  }

  const blockReason = orderEditBlock(order, canManagePricing);

  if (blockReason) {
    return (
      <div className="mx-auto max-w-2xl py-6 space-y-6">
        <PageHeader
          title={`Editar pedido #${order.number} · ${order.customerName}`}
          description="Revisión previa antes de modificar productos."
          action={
            <Link
              to="/app/pedidos"
              search={{ search: String(order.number) } as any}
              className={buttonStyles({ variant: 'secondary' })}
            >
              <ArrowLeft className="h-4 w-4" />
              Volver al pedido
            </Link>
          }
        />

        <div
          data-testid="edit-order-blocked-card"
          className="rounded-xl border border-amber-200 bg-amber-50/90 p-5 shadow-sm space-y-4"
        >
          <div className="flex items-start gap-3">
            <Lock className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h2 className="text-base font-bold text-amber-950">
                Ahora no se pueden editar los productos del Pedido #{order.number}
              </h2>
              <p className="text-sm text-amber-900">{blockReason}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              to="/app/pedidos"
              search={{ search: String(order.number) } as any}
              className={buttonStyles({ variant: 'primary' })}
            >
              Ir al Pedido #{order.number}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title={`Editar productos del Pedido #${order.number}`}
        description={`Cliente: ${order.customerName} · Agregá productos, ajustá cantidades o quitá ítems conservando el mismo número de pedido y sus reservas.`}
        action={
          <Link
            to="/app/pedidos"
            search={{ search: String(order.number) } as any}
            className={buttonStyles({ variant: 'secondary' })}
          >
            <ArrowLeft className="h-4 w-4" />
            Volver a Pedidos
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr] items-start">
        {/* COLUMNA IZQUIERDA: CATÁLOGO DE PRODUCTOS */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200/90 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-950">1. Catálogo de productos</h2>
                <p className="text-xs text-slate-500">
                  Sumá nuevos productos o tocá los que ya están en el pedido para ajustar unidades.
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold border',
                  stockSource === 'incoming_only'
                    ? 'border-sky-200 bg-sky-50 text-sky-800'
                    : 'border-slate-200 bg-slate-100 text-slate-700'
                )}
              >
                {stockSource === 'incoming_only'
                  ? 'Origen: solo compra en camino'
                  : 'Origen: stock local + en camino'}
              </span>
            </div>

            {/* Buscador y filtros */}
            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  type="search"
                  placeholder="Buscar por nombre, código SKU o categoría..."
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(cleanSearchTerm(e.target.value))}
                  className="pl-10 pr-9"
                  data-testid="edit-order-search-input"
                />
                <ClearSearchButton value={searchProduct} onClear={() => setSearchProduct('')} />
              </div>

              {categories.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedCategory('all')}
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-xs font-medium transition',
                      selectedCategory === 'all'
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    )}
                  >
                    Todos ({products.filter((p) => p.active).length})
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={cn(
                        'rounded-lg px-2.5 py-1 text-xs font-medium transition',
                        selectedCategory === cat
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      )}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Grilla de productos */}
            {filteredProducts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center">
                <Package className="mx-auto h-8 w-8 text-slate-400 mb-2" />
                <p className="text-sm font-medium text-slate-700">No se encontraron productos</p>
                <p className="text-xs text-slate-500 mt-1">
                  Probá con otro término o limpiá el filtro de categoría.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[600px] overflow-y-auto pr-1">
                {filteredProducts.map((product) => {
                  const bounds = getProductBounds(product.id);
                  const selected = draftItems.find((i) => i.productId === product.id);
                  const displayPrice =
                    order.saleType === 'gift' || order.paymentState === 'gifted'
                      ? 0
                      : order.saleType === 'cost' || order.isCostSale === true
                        ? (product.currentCostCents ?? product.costCents ?? product.priceCents)
                        : product.priceCents;
                  const canAddMore = selected
                    ? selected.quantity < bounds.maxCapacity
                    : bounds.maxCapacity > 0;
                  const canReduceOnCard = selected
                    ? selected.quantity > bounds.minCapacity
                    : false;

                  return (
                    <div
                      key={product.id}
                      data-testid={`catalog-product-${product.sku}`}
                      className={cn(
                        'flex flex-col justify-between rounded-xl border p-3.5 transition',
                        selected
                          ? 'border-amber-400 bg-amber-50/35 shadow-sm'
                          : bounds.maxCapacity <= 0
                            ? 'border-slate-200 bg-slate-50 opacity-60'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                      )}
                    >
                      <div className="flex gap-3">
                        {product.imageUrl ? (
                          <img
                            src={product.imageUrl}
                            alt={product.imageAlt || product.name}
                            className="h-14 w-14 rounded-lg object-cover border border-slate-200 bg-slate-100 shrink-0"
                          />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-400 shrink-0">
                            <Package className="h-6 w-6" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-1">
                            <p className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
                              {product.name}
                            </p>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {product.presentation} · <span className="font-mono">{product.sku}</span>
                          </p>
                          <p className="text-sm font-bold text-slate-950 mt-1">
                            {formatMoney(displayPrice)}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {bounds.initialQty > 0 && (
                            <span className="inline-flex items-center rounded-md bg-slate-200/80 px-2 py-0.5 text-[11px] font-semibold text-slate-800">
                              En pedido: {bounds.initialQty} u.
                            </span>
                          )}
                          {bounds.additionalAvail > 0 ? (
                            <span
                              className={cn(
                                'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold',
                                bounds.physFree > 0
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
                                  : 'bg-sky-50 text-sky-700 border border-sky-200/60'
                              )}
                            >
                              +{bounds.additionalAvail} disp.
                            </span>
                          ) : bounds.initialQty > 0 ? (
                            <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                              Sin stock extra
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                              Sin stock
                            </span>
                          )}
                        </div>

                        {selected ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleUpdateQuantity(product.id, -1)}
                              disabled={!canReduceOnCard}
                              title={
                                !canReduceOnCard && bounds.packedQty > 0
                                  ? `Mínimo ${bounds.packedQty} u. en bolsita`
                                  : 'Restar 1 unidad'
                              }
                              aria-label={`Restar ${product.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="min-w-[2rem] text-center text-xs font-bold text-slate-900">
                              {selected.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleUpdateQuantity(product.id, 1)}
                              disabled={!canAddMore}
                              title={!canAddMore ? 'Tope de stock disponible' : 'Sumar 1 unidad'}
                              aria-label={`Sumar ${product.name}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant={bounds.initialQty > 0 ? 'secondary' : 'primary'}
                            disabled={!canAddMore}
                            onClick={() => handleAddOrIncrementProduct(product)}
                            className="h-8 px-3 text-xs"
                          >
                            {bounds.initialQty > 0 ? (
                              <>
                                <RotateCcw className="h-3.5 w-3.5" />
                                Restaurar
                              </>
                            ) : (
                              <>
                                <Plus className="h-3.5 w-3.5" />
                                Agregar
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* COLUMNA DERECHA: RESUMEN DEL PEDIDO Y CAMBIOS */}
        <div className="space-y-4 lg:sticky lg:top-6">
          <div className="rounded-xl border border-slate-200/90 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <ShoppingBag className="h-4 w-4 text-amber-600" />
                  <h2 className="text-base font-semibold text-slate-950">
                    2. Productos en el Pedido #{order.number}
                  </h2>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                  {order.deliveryMethod === 'shipping' ? (
                    <>
                      <Truck className="h-3.5 w-3.5 text-slate-400" />
                      Envío a domicilio
                    </>
                  ) : (
                    <>
                      <Store className="h-3.5 w-3.5 text-slate-400" />
                      Retiro en local
                    </>
                  )}
                  <span>·</span>
                  <span>
                    {summaryTotals.units} {summaryTotals.units === 1 ? 'unidad' : 'unidades'}
                  </span>
                </p>
              </div>
              {hasChanges && (
                <button
                  type="button"
                  onClick={handleResetToOriginal}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restaurar original
                </button>
              )}
            </div>

            {draftItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-5 text-center space-y-2">
                <p className="text-sm font-medium text-amber-950">
                  Quitaste todos los productos del pedido.
                </p>
                <p className="text-xs text-amber-800">
                  Agregá o restaurá al menos un producto para guardar. Si el cliente canceló la compra, usá Cancelar pedido en Pedidos.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                {draftItems.map((item) => {
                  const bounds = getProductBounds(item.productId);
                  const isNew = item.initialQuantity === 0;
                  const isChanged = !isNew && item.quantity !== item.initialQuantity;
                  const atMinPacked = bounds.minCapacity > 0 && item.quantity <= bounds.minCapacity;
                  const atMaxStock = item.quantity >= bounds.maxCapacity;
                  const linePrice =
                    order.saleType === 'gift' || order.paymentState === 'gifted'
                      ? 0
                      : order.saleType === 'cost' || order.isCostSale === true
                        ? item.unitCostCents
                        : item.unitPriceCents;

                  return (
                    <div
                      key={item.productId}
                      data-testid={`draft-line-${item.sku}`}
                      className={cn(
                        'rounded-lg border p-3 transition space-y-2',
                        isNew
                          ? 'border-emerald-200 bg-emerald-50/30'
                          : isChanged
                            ? 'border-amber-200 bg-amber-50/30'
                            : 'border-slate-200 bg-slate-50/60'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-sm font-semibold text-slate-900">{item.name}</p>
                            {isNew && (
                              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">
                                Nuevo
                              </span>
                            )}
                            {isChanged && (
                              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                                Antes: {item.initialQuantity} u.
                              </span>
                            )}
                            {bounds.packedQty > 0 && (
                              <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-900">
                                En bolsita: {bounds.packedQty} u.
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500">
                            {item.presentation} · {formatMoney(linePrice)} c/u
                          </p>
                        </div>

                        <p className="text-sm font-bold text-slate-900 shrink-0">
                          {formatMoney(linePrice * item.quantity)}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleUpdateQuantity(item.productId, -1)}
                            disabled={atMinPacked}
                            aria-label={`Disminuir cantidad de ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span
                            data-testid={`draft-qty-${item.sku}`}
                            className="min-w-[2.25rem] text-center text-sm font-bold text-slate-900"
                          >
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleUpdateQuantity(item.productId, 1)}
                            disabled={atMaxStock}
                            aria-label={`Aumentar cantidad de ${item.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRemoveProduct(item.productId)}
                          disabled={bounds.minCapacity > 0}
                          aria-label={`Quitar ${item.name}`}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Quitar
                        </button>
                      </div>

                      {bounds.minCapacity > 0 && atMinPacked && (
                        <p className="text-[11px] text-sky-900 bg-sky-50/90 rounded px-2 py-1 border border-sky-200/70">
                          Mínimo {bounds.minCapacity} u. porque ya están en la bolsita. Para bajar más, desarmá primero la bolsita en Pedidos.
                        </p>
                      )}
                      {atMaxStock && (
                        <p className="text-[11px] text-slate-600">
                          Tope disponible alcanzado ({bounds.maxCapacity} u.).
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Ítems quitados con botón rápido para restaurar */}
            {removedInitialItems.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 space-y-2">
                <p className="text-xs font-semibold text-rose-900">
                  Se quitarán del pedido ({removedInitialItems.length}):
                </p>
                <div className="space-y-1.5">
                  {removedInitialItems.map((removed) => (
                    <div
                      key={removed.productId}
                      className="flex items-center justify-between gap-2 text-xs text-rose-950"
                    >
                      <span className="line-clamp-1">
                        {removed.productName} ({removed.quantity} u.)
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRestoreRemovedItem(removed.productId)}
                        className="inline-flex items-center gap-1 font-semibold text-rose-800 hover:underline shrink-0"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Restaurar
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Totales antes y después */}
            <div className="border-t border-slate-200 pt-3 space-y-1.5 text-sm">
              <div className="flex justify-between text-slate-600">
                <span>Subtotal productos</span>
                <span className="font-medium text-slate-900">
                  {formatMoney(summaryTotals.subtotalCents)}
                </span>
              </div>
              {order.deliveryMethod === 'shipping' && (
                <div className="flex justify-between text-slate-600">
                  <span>Envío registrado</span>
                  <span className="font-medium text-slate-900">
                    {formatMoney(summaryTotals.shippingFeeCents)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-xs text-slate-500 pt-1">
                <span>Total anterior</span>
                <span>{formatMoney(order.totalCents)}</span>
              </div>
              <div className="flex justify-between items-baseline border-t border-slate-100 pt-2 text-base font-bold text-slate-950">
                <span>Nuevo total</span>
                <div className="text-right">
                  <span data-testid="edit-order-new-total">
                    {formatMoney(summaryTotals.totalCents)}
                  </span>
                  {summaryTotals.deltaCents !== 0 && (
                    <span
                      className={cn(
                        'ml-2 text-xs font-semibold',
                        summaryTotals.deltaCents > 0 ? 'text-amber-700' : 'text-emerald-700'
                      )}
                    >
                      ({summaryTotals.deltaCents > 0 ? '+' : ''}
                      {formatMoney(summaryTotals.deltaCents)})
                    </span>
                  )}
                </div>
              </div>
              {order.shippingFeeMethod === 'percentage' && hasChanges && (
                <p className="text-xs text-amber-800 pt-1">
                  El envío por porcentaje se revisará en Pedidos antes de registrar el cobro.
                </p>
              )}
            </div>

            {validationError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{validationError}</span>
              </div>
            )}

            {updateMutation.error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-semibold">
                    {updateMutation.error instanceof Error
                      ? updateMutation.error.message
                      : 'No pudimos guardar los cambios.'}
                  </p>
                  {updateMutation.error instanceof AppError && updateMutation.error.nextAction && (
                    <p>{updateMutation.error.nextAction}</p>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2 pt-1">
              <Button
                type="button"
                variant="primary"
                className="w-full justify-center"
                disabled={
                  !hasChanges ||
                  draftItems.length === 0 ||
                  invalidItems.length > 0 ||
                  updateMutation.isPending
                }
                onClick={handleSubmit}
                data-testid="save-order-edit-button"
              >
                <Check className="h-4 w-4" />
                {updateMutation.isPending ? 'Guardando cambios...' : 'Guardar cambios del pedido'}
              </Button>
              {!hasChanges && (
                <p className="text-center text-xs text-slate-500">
                  Modificá cantidades o agregá productos para habilitar el guardado.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
