import { Link } from '@tanstack/react-router';
import { ArrowRight, Menu, ShoppingBag, X } from 'lucide-react';
import { useState, type PropsWithChildren } from 'react';
import { useCart } from '@/features/cart/CartProvider';
import { buttonStyles } from '@/components/ui/Button';
import { Logo } from '@/components/brand/Logo';
import { DemoBanner } from './DemoBanner';

export function PublicShell({ children }: PropsWithChildren) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { itemCount } = useCart();
  return (
    <div className="relative min-h-screen">
      <DemoBanner />
      <header className="sticky top-0 z-40 border-b border-ink-950/8 bg-white/95 backdrop-blur-xl shadow-[0_1px_3px_rgba(11,19,36,0.03)] md:bg-cream-50/90">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 md:h-20 lg:px-8">
          <Logo />
          <nav className="hidden items-center gap-8 text-sm font-extrabold text-ink-800 md:flex" aria-label="Tienda">
            <Link to="/" hash="productos" className="transition hover:text-brand-600">Productos</Link>
            <Link to="/" hash="como-comprar" className="transition hover:text-brand-600">Cómo comprar</Link>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              to="/carrito"
              className="relative inline-flex size-11 items-center justify-center rounded-full border border-ink-950/10 bg-white text-ink-950 transition hover:border-brand-500/30 hover:text-brand-600 active:scale-95"
              aria-label={`Carrito, ${itemCount} ${itemCount === 1 ? 'unidad' : 'unidades'}`}
            >
              <ShoppingBag className="size-5" aria-hidden="true" />
              {itemCount > 0 ? (
                <span className="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[11px] font-black leading-none text-white shadow-sm ring-2 ring-white">
                  {itemCount}
                </span>
              ) : null}
            </Link>
            <button
              className="inline-flex size-11 items-center justify-center rounded-full text-ink-950 transition hover:bg-cream-200/60 active:scale-95 md:hidden"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'}
            >
              {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav className="border-t border-ink-950/8 bg-cream-50 px-4 py-5 md:hidden" aria-label="Tienda móvil">
            <div className="flex flex-col gap-2">
              <Link to="/" hash="productos" className="rounded-2xl px-4 py-3 font-bold hover:text-brand-600" onClick={() => setMenuOpen(false)}>Productos</Link>
              <Link to="/" hash="como-comprar" className="rounded-2xl px-4 py-3 font-bold hover:text-brand-600" onClick={() => setMenuOpen(false)}>Cómo comprar</Link>
            </div>
          </nav>
        ) : null}
      </header>
      <main>{children}</main>
      <footer className="bg-ink-950 text-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1fr_auto] md:items-end lg:px-8">
          <div>
            <Logo inverted />
            <p className="mt-4 max-w-md text-sm leading-6 text-white/65">
              Suplementos diseñados a medida en laboratorio.
            </p>
          </div>
          <p className="text-xs font-semibold text-white/45">© 2026 Impulso Suplementos</p>
        </div>
      </footer>
    </div>
  );
}
