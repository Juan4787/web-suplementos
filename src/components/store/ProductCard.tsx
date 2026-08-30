import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney } from '@/domain/money';
import type { StorefrontProduct } from '@/domain/types';
import { useCart } from '@/features/cart/CartProvider';

const availabilityLabel: Record<StorefrontProduct['availability'], string> = {
  available: 'Disponible',
  low: 'Últimas unidades',
  out_of_stock: 'Sin stock'
};

export function ProductCard({ product }: { product: StorefrontProduct }) {
  const { lines, add, setQuantity } = useCart();
  const soldOut = product.availability === 'out_of_stock';

  const currentLine = lines.find((line) => line.productId === product.id);
  const cartQty = currentLine?.quantity ?? 0;
  const maxStock = product.maxOrderQuantity;
  const isMaxStock = cartQty >= maxStock;

  const handleAddFirst = (e: React.MouseEvent) => {
    e.preventDefault();
    if (soldOut || maxStock <= 0) return;
    add(product, 1);
  };

  const handleIncrement = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isMaxStock) return;
    setQuantity(product.id, cartQty + 1);
  };

  const handleDecrement = (e: React.MouseEvent) => {
    e.preventDefault();
    setQuantity(product.id, cartQty - 1);
  };

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-[2rem] border border-ink-950/8 bg-white shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-soft">
      <Link
        to="/producto/$slug"
        params={{ slug: product.slug }}
        className="relative block aspect-[1.05] overflow-hidden bg-cream-100"
        aria-label={`Ver ${product.name}`}
      >
        <img
          src={product.imageUrl}
          alt={product.imageAlt}
          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
          loading="lazy"
          width="720"
          height="720"
        />
        <span className="absolute right-4 top-4 grid size-10 place-items-center rounded-full bg-white/90 text-ink-950 shadow-sm backdrop-blur transition group-hover:rotate-6">
          <ArrowUpRight className="size-4" aria-hidden="true" />
        </span>
      </Link>
      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-bold text-ink-600">{product.category}</span>
          {product.availability !== 'available' ? (
            <StatusChip
              label={availabilityLabel[product.availability]}
              tone={product.availability === 'low' ? 'warning' : 'danger'}
            />
          ) : null}
        </div>
        <Link to="/producto/$slug" params={{ slug: product.slug }} className="mt-4">
          <h3 className="font-display text-xl font-black leading-tight tracking-[-0.025em] text-ink-950 sm:text-2xl">{product.name}</h3>
        </Link>
        <p className="mt-2 text-sm font-bold text-ink-600">{product.presentation}</p>
        <div className="mt-auto flex items-end justify-between gap-3 pt-6">
          <div>
            <p className="font-display text-2xl font-black tracking-tight">{formatMoney(product.priceCents)}</p>
            {isMaxStock && cartQty > 0 ? (
              <p className="mt-1 text-[11px] font-extrabold text-brand-700">Máx. disponible</p>
            ) : null}
          </div>

          {cartQty > 0 ? (
            <div
              className="inline-flex h-11 w-[116px] shrink-0 items-center justify-between rounded-full bg-brand-600 px-1 text-white shadow-md select-none transition-all duration-200"
              aria-label={`Contador de ${product.name}: ${cartQty} en el carrito`}
            >
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full text-white/90 transition hover:bg-white/20 active:scale-90"
                onClick={handleDecrement}
                aria-label={`Restar una unidad de ${product.name}`}
              >
                <Minus className="size-4 stroke-[2.5]" />
              </button>
              <span className="min-w-6 text-center font-display text-base font-black leading-none text-white">
                {cartQty}
              </span>
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full text-white/90 transition hover:bg-white/20 active:scale-90 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                onClick={handleIncrement}
                disabled={isMaxStock}
                title={isMaxStock ? `Solo quedan ${maxStock} unidades` : undefined}
                aria-label={`Sumar una unidad de ${product.name}`}
              >
                <Plus className="size-4 stroke-[2.5]" />
              </button>
            </div>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="min-h-[44px] rounded-full px-3.5 sm:px-4"
              onClick={handleAddFirst}
              disabled={soldOut}
              aria-label={`Agregar ${product.name} al carrito`}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{soldOut ? 'Agotado' : 'Agregar'}</span>
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
