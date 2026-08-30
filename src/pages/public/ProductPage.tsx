import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Check, Minus, Plus, ShieldCheck, ShoppingBag, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PublicShell } from '@/components/layout/PublicShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney } from '@/domain/money';
import { useCart } from '@/features/cart/CartProvider';

export default function ProductPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const { add } = useCart();
  const productQuery = useBusinessQuery({
    queryKey: queryKeys.storefrontProduct(slug),
    queryFn: (api) => api.getStorefrontProduct(slug)
  });

  const isOutOfStock = productQuery.data?.availability === 'out_of_stock';
  const maxAvailable = productQuery.data?.maxOrderQuantity ?? 10;
  const maxAllowed = Math.max(1, maxAvailable);

  const handleIncrement = () => {
    setQuantity((prev) => Math.min(maxAllowed, prev + 1));
  };

  const handleDecrement = () => {
    setQuantity((prev) => Math.max(1, prev - 1));
  };

  return (
    <PublicShell>
      <div className="mx-auto min-h-[70vh] max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
        <Link to="/" hash="productos" className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-600 hover:text-brand-600 transition-colors">
          <ArrowLeft className="size-4" /> Volver a productos
        </Link>
        {productQuery.isPending ? <LoadingState label="Abriendo producto…" /> : null}
        {productQuery.isError ? <div className="mt-8"><ErrorState error={productQuery.error} onRetry={() => void productQuery.refetch()} /></div> : null}
        {productQuery.isSuccess && !productQuery.data ? (
          <div className="mt-10 rounded-[2rem] bg-white p-10 text-center shadow-card">
            <h1 className="font-display text-3xl font-black">Este producto ya no está publicado</h1>
            <p className="mt-3 text-ink-600">Podés volver a la tienda para ver las opciones disponibles.</p>
            <Link to="/" className={buttonStyles({ className: 'mt-6' })}>Ver productos</Link>
          </div>
        ) : null}
        {productQuery.data ? (
          <article className="page-enter mt-8 grid gap-8 lg:grid-cols-2 lg:gap-14">
            <div className="overflow-hidden rounded-[2.5rem] border border-ink-950/7 bg-white p-3 shadow-card sm:p-5">
              <img
                src={productQuery.data.imageUrl}
                alt={productQuery.data.imageAlt}
                className="aspect-square w-full rounded-[2rem] object-cover"
                width="720"
                height="720"
              />
            </div>
            <div className="flex flex-col justify-center py-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-brand-50 px-3.5 py-1 text-xs font-black uppercase tracking-[0.16em] text-brand-600 border border-brand-200/60">
                  {productQuery.data.category}
                </span>
                {productQuery.data.availability !== 'available' ? (
                  <StatusChip
                    label={productQuery.data.availability === 'low' ? 'Últimas unidades' : 'Sin stock'}
                    tone={productQuery.data.availability === 'low' ? 'warning' : 'danger'}
                  />
                ) : null}
              </div>

              <h1 className="mt-4 font-display text-4xl font-black leading-[0.98] tracking-[-0.055em] sm:text-6xl text-ink-950">
                {productQuery.data.name}
              </h1>
              
              <div className="mt-3 inline-flex items-center gap-2">
                <span className="rounded-xl bg-cream-100 px-3 py-1.5 text-sm font-extrabold text-ink-800">
                  {productQuery.data.presentation}
                </span>
              </div>

              <p className="mt-6 text-base leading-relaxed text-ink-700 font-medium whitespace-pre-line">
                {productQuery.data.description}
              </p>

              <div className="mt-7 grid gap-2 sm:grid-cols-2 rounded-2xl bg-cream-50 p-4 border border-ink-950/6">
                <div className="flex items-center gap-2.5 text-xs font-bold text-ink-800">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                    <Check className="size-3.5" />
                  </span>
                  Pedido sin registros molestos
                </div>
                <div className="flex items-center gap-2.5 text-xs font-bold text-ink-800">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                    <ShieldCheck className="size-3.5" />
                  </span>
                  Pureza y calidad testeada
                </div>
                <div className="flex items-center gap-2.5 text-xs font-bold text-ink-800">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                    <Sparkles className="size-3.5" />
                  </span>
                  Fórmula pura sin rellenos
                </div>
                <div className="flex items-center gap-2.5 text-xs font-bold text-ink-800">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-100 text-brand-700">
                    <Check className="size-3.5" />
                  </span>
                  Atención humana por WhatsApp
                </div>
              </div>

              <div className="mt-8 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                <p className="font-display text-4xl sm:text-5xl font-black tracking-tight text-ink-950 transition-all">
                  {formatMoney(productQuery.data.priceCents * (isOutOfStock ? 0 : Math.max(1, quantity)))}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {!isOutOfStock && quantity > 1 ? (
                    <span className="rounded-md bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-700 border border-brand-200/60">
                      {quantity} × {formatMoney(productQuery.data.priceCents)}
                    </span>
                  ) : null}
                  <span className="text-xs font-semibold text-ink-600">Precio final con impuestos incluidos</span>
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <div className="inline-flex h-13 items-center justify-between rounded-full border border-ink-950/15 bg-white px-2 shadow-sm select-none">
                  <button
                    type="button"
                    className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-700 active:scale-90 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    onClick={handleDecrement}
                    disabled={quantity <= 1 || isOutOfStock}
                    aria-label="Restar una unidad"
                  >
                    <Minus className="size-4" />
                  </button>
                  <span className="min-w-10 text-center font-black text-ink-950 text-lg">
                    {isOutOfStock ? 0 : quantity}
                  </span>
                  <button
                    type="button"
                    className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-700 active:scale-90 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    onClick={handleIncrement}
                    disabled={quantity >= maxAllowed || isOutOfStock}
                    aria-label="Sumar una unidad"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
                <Button
                  size="lg"
                  className="flex-1 shadow-[0_8px_24px_rgba(37,99,235,0.28)]"
                  disabled={isOutOfStock}
                  onClick={() => {
                    add(productQuery.data!, quantity);
                    setAdded(true);
                  }}
                >
                  <ShoppingBag className="size-5" /> {added ? '¡Agregado al carrito!' : 'Agregar al carrito'}
                </Button>
              </div>
              {quantity >= maxAllowed && maxAllowed > 1 && !isOutOfStock ? (
                <p className="mt-2 text-xs font-semibold text-amber-600">
                  Límite máximo disponible seleccionado ({maxAllowed} unidades).
                </p>
              ) : null}
              {added ? <Link to="/carrito" className={buttonStyles({ variant: 'ghost', className: 'mt-3 text-brand-600 font-black' })}>Ver carrito y finalizar pedido →</Link> : null}
            </div>
          </article>
        ) : null}
      </div>
    </PublicShell>
  );
}
