import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Info,
  Minus,
  Plus,
  ShoppingBag,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PublicShell } from '@/components/layout/PublicShell';
import { buttonStyles } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/DataState';
import { formatMoney } from '@/domain/money';
import { formatUnits } from '@/domain/quantity';
import type { CartRevalidationResult } from '@/features/cart/CartProvider';
import { useCart } from '@/features/cart/CartProvider';

export default function CartPage() {
  const {
    lines,
    itemCount,
    subtotalCents,
    setQuantity,
    remove,
    expiredNotice,
    dismissExpiredNotice,
    syncWithLiveCatalog
  } = useCart();

  const [validationResult, setValidationResult] = useState<CartRevalidationResult | null>(null);

  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.storefrontProducts,
    queryFn: (api) => api.listStorefrontProducts()
  });

  useEffect(() => {
    if (productsQuery.data && lines.length > 0) {
      const result = syncWithLiveCatalog(productsQuery.data);
      setValidationResult(result);
    }
  }, [productsQuery.data, syncWithLiveCatalog, lines.length]);

  const productStatusMap = useMemo(() => {
    const map = new Map<string, { status: 'ok' | 'out_of_stock' | 'unavailable' | 'partial'; available?: number }>();
    if (!productsQuery.data) return map;

    for (const line of lines) {
      const product = productsQuery.data.find((p) => p.id === line.productId);
      if (!product) {
        map.set(line.productId, { status: 'unavailable' });
      } else if (product.availability === 'out_of_stock' || product.maxOrderQuantity <= 0) {
        map.set(line.productId, { status: 'out_of_stock' });
      } else if (line.quantity > product.maxOrderQuantity) {
        map.set(line.productId, { status: 'partial', available: product.maxOrderQuantity });
      } else {
        map.set(line.productId, { status: 'ok' });
      }
    }
    return map;
  }, [productsQuery.data, lines]);

  const hasBlockingIssues = useMemo(() => {
    for (const item of productStatusMap.values()) {
      if (item.status !== 'ok') return true;
    }
    return false;
  }, [productStatusMap]);

  return (
    <PublicShell>
      <div className="mx-auto min-h-[70vh] max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
        <Link
          to="/"
          hash="productos"
          className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-600 hover:text-brand-600"
        >
          <ArrowLeft className="size-4" /> Seguir eligiendo
        </Link>

        <div className="mt-7 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl font-black tracking-[-0.055em] sm:text-5xl">
              Carrito <span className="text-ink-950/25">({itemCount})</span>
            </h1>
          </div>
        </div>

        {/* Aviso de Carrito Vencido tras 24hs de Inactividad */}
        {expiredNotice ? (
          <div className="mt-6 flex items-start justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 size-5 shrink-0 text-amber-700" />
              <p className="text-sm font-bold">{expiredNotice}</p>
            </div>
            <button
              type="button"
              onClick={dismissExpiredNotice}
              className="rounded-lg p-1 hover:bg-amber-200/60 text-amber-800"
              aria-label="Cerrar aviso"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : null}

        {/* Alerta de Cambios de Precio en Vivo */}
        {validationResult && validationResult.priceChanges.length > 0 ? (
          <div className="mt-6 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-blue-950">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 size-5 shrink-0 text-blue-700" />
              <div>
                <p className="text-sm font-bold">
                  Actualizamos tu pedido con los precios vigentes del catálogo:
                </p>
                <ul className="mt-1 list-inside list-disc text-xs font-semibold text-blue-900 space-y-0.5">
                  {validationResult.priceChanges.map((change) => (
                    <li key={change.name}>
                      <strong>{change.name}</strong>: {formatMoney(change.oldPriceCents)} → {formatMoney(change.newPriceCents)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        {lines.length === 0 ? (
          <div className="mt-10">
            <EmptyState
              title="Tu carrito está vacío"
              description="Elegí uno o más productos y volvé cuando quieras. Guardamos tu selección en este dispositivo durante 24 horas."
              action={
                <Link to="/" hash="productos" className={buttonStyles()}>
                  Ver productos
                </Link>
              }
            />
          </div>
        ) : (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_23rem] lg:items-start">
            <div className="space-y-4">
              {lines.map((line) => {
                const status = productStatusMap.get(line.productId);
                const isOutOfStock = status?.status === 'out_of_stock';
                const isUnavailable = status?.status === 'unavailable';
                const isPartial = status?.status === 'partial';

                return (
                  <article
                    key={line.productId}
                    className={`grid grid-cols-[5.5rem_1fr] gap-4 rounded-[1.75rem] border p-4 shadow-card sm:grid-cols-[7rem_1fr_auto] sm:items-center sm:p-5 ${
                      isOutOfStock || isUnavailable
                        ? 'border-red-300 bg-red-50/40'
                        : isPartial
                          ? 'border-amber-300 bg-amber-50/30'
                          : 'border-ink-950/8 bg-white'
                    }`}
                  >
                    <img
                      src={line.imageUrl}
                      alt=""
                      className="aspect-square w-full rounded-2xl bg-cream-100 object-cover"
                      width="160"
                      height="160"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-display text-lg font-black sm:text-xl">{line.name}</h2>
                        {isOutOfStock ? (
                          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-black text-red-700">
                            Sin stock
                          </span>
                        ) : null}
                        {isUnavailable ? (
                          <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-black text-red-700">
                            No disponible
                          </span>
                        ) : null}
                        {isPartial ? (
                          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-black text-amber-800">
                            Solo quedan {status?.available} u.
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-1 text-sm font-semibold text-ink-600">{line.presentation}</p>
                      <p className="mt-1 text-xs font-bold text-ink-500">
                        {formatMoney(line.unitPriceCents)} c/u
                      </p>

                      {isOutOfStock ? (
                        <p className="mt-2 text-xs font-bold text-red-700">
                          Este producto se quedó sin stock. Quitalo para continuar.
                        </p>
                      ) : null}
                      {isUnavailable ? (
                        <p className="mt-2 text-xs font-bold text-red-700">
                          Este producto ya no está disponible en la tienda. Quitalo para continuar.
                        </p>
                      ) : null}
                      {isPartial ? (
                        <p className="mt-2 text-xs font-bold text-amber-800">
                          Ahora quedan {status?.available} unidades. Elegí una cantidad disponible.
                        </p>
                      ) : null}

                      {!isOutOfStock && !isUnavailable ? (
                        <div className="mt-4 inline-flex items-center rounded-full border border-ink-950/12 bg-cream-50 p-1">
                          <button
                            className="grid size-9 place-items-center rounded-full hover:bg-white"
                            onClick={() => setQuantity(line.productId, line.quantity - 1)}
                            aria-label={`Restar ${line.name}`}
                          >
                            <Minus className="size-3.5" />
                          </button>
                          <span className="min-w-9 text-center text-sm font-black">{line.quantity}</span>
                          <button
                            className="grid size-9 place-items-center rounded-full hover:bg-white"
                            onClick={() => setQuantity(line.productId, line.quantity + 1)}
                            aria-label={`Sumar ${line.name}`}
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="col-span-2 flex items-center justify-between border-t border-ink-950/8 pt-4 sm:col-span-1 sm:block sm:border-0 sm:pt-0 sm:text-right">
                      <p className="hidden font-display text-xl font-black sm:block">
                        {formatMoney(line.unitPriceCents * line.quantity)}
                      </p>
                      <button
                        className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-sm font-bold text-red-700 hover:bg-red-50 sm:mt-5"
                        onClick={() => remove(line.productId)}
                      >
                        <Trash2 className="size-4" /> Quitar
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <aside className="sticky top-6 rounded-[2rem] bg-ink-950 p-6 text-white shadow-soft sm:p-7">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-2xl bg-brand-600 text-white">
                  <ShoppingBag className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-white/70">Resumen</p>
                  <p className="font-display text-xl font-black">{formatUnits(itemCount)}</p>
                </div>
              </div>
              <div className="my-6 border-t border-white/10" />
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-white/60">Subtotal</span>
                <strong className="font-display text-2xl">{formatMoney(subtotalCents)}</strong>
              </div>
              <p className="mt-3 text-xs leading-5 text-white/50">
                El envío, si corresponde, se calcula en el siguiente paso.
              </p>

              {hasBlockingIssues ? (
                <div className="mt-5 rounded-2xl bg-amber-500/20 border border-amber-400/30 p-3 text-xs text-amber-200">
                  <p className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="size-4 shrink-0 text-amber-300" />
                    Revisá los productos marcados antes de continuar.
                  </p>
                </div>
              ) : null}

              <Link
                to="/checkout"
                disabled={hasBlockingIssues}
                className={buttonStyles({
                  size: 'lg',
                  className: `mt-6 w-full ${hasBlockingIssues ? 'pointer-events-none opacity-50' : ''}`
                })}
              >
                Continuar <ArrowRight className="size-4" />
              </Link>
            </aside>
          </div>
        )}
      </div>
    </PublicShell>
  );
}

