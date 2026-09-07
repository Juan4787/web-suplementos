import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowRight, MessageCircle, PackageCheck, Search, ShoppingBag, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ProductCard } from '@/components/store/ProductCard';
import { buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { PublicShell } from '@/components/layout/PublicShell';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { useCart } from '@/features/cart/CartProvider';

const TARRO_SLUGS = new Set([
  'acid-support',
  'andro-support',
  'b-complex-active',
  'climateric-support',
  'd-40-support',
  'deep-dreams-x-100',
  'deep-dreams-x-30',
  'femme-balance',
  'gastro-support',
  'hepato-support',
  'magnesio-dual-action',
  'metaboglyc',
  'sleep-support',
  'vitality-support'
]);

const AFTER_THYROID_SLUGS = new Set([
  'msm',
  'omega-3',
  'omega-pure-nutrition-ultra',
  'probiovance-i5'
]);

const SACHET_SLUGS = new Set([
  'colageno-hidrolizado',
  'creatina',
  'glicina',
  'glutamina',
  'inositol-care',
  'ormux-ar',
  'vitamina-c'
]);

function getProductSortPriority(slug: string): number {
  if (TARRO_SLUGS.has(slug)) return 1;
  if (slug === 'thyroid-support') return 2;
  if (AFTER_THYROID_SLUGS.has(slug)) return 3;
  if (SACHET_SLUGS.has(slug)) return 4;
  return 5;
}

export default function StorefrontPage() {
  const { itemCount } = useCart();
  const hasItems = itemCount > 0;

  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.storefrontProducts,
    queryFn: (api) => api.listStorefrontProducts()
  });
  const [searchQuery, setSearchQuery] = useState('');

  const products = useMemo(() => {
    if (!productsQuery.data) return [];
    const query = searchQuery.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let list = productsQuery.data;
    if (query) {
      list = list.filter((product) => {
        const name = product.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const description = (product.description || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const presentation = (product.presentation || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const category = (product.category || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return (
          name.includes(query) ||
          description.includes(query) ||
          presentation.includes(query) ||
          category.includes(query)
        );
      });
    }

    return [...list].sort((a, b) => {
      const pA = getProductSortPriority(a.slug);
      const pB = getProductSortPriority(b.slug);
      if (pA !== pB) return pA - pB;
      return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
    });
  }, [productsQuery.data, searchQuery]);

  return (
    <PublicShell>
      <section className="relative overflow-hidden bg-brand-950 text-white">
        <div className="surface-grid absolute inset-0 opacity-25" />
        <div className="pointer-events-none absolute -left-24 top-20 size-80 rounded-full bg-brand-500/15 blur-3xl sm:size-[30rem]" />
        <div className="pointer-events-none absolute -right-24 -top-16 size-80 rounded-full bg-brand-600/30 blur-3xl sm:size-[28rem]" />
        <div className="absolute right-[18%] top-[18%] hidden size-28 rotate-12 rounded-[2rem] border-[18px] border-brand-500/20 lg:block" />
        <div className="relative mx-auto grid min-h-[42rem] max-w-7xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:px-8 lg:py-20">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-brand-400/30 bg-gradient-to-r from-brand-500/20 via-brand-500/10 to-brand-400/5 px-4 py-2 text-xs font-black uppercase tracking-[0.2em] text-brand-300 shadow-[0_0_20px_rgba(59,130,246,0.2)] backdrop-blur-md">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(96,165,250,0.9)]" />
              </span>
              <span>Nutrición celular</span>
            </div>
            <h1 className="mt-6 font-display text-[clamp(3.2rem,7.5vw,6.8rem)] font-black leading-[0.92] tracking-[-0.055em] text-white">
              TU BIENESTAR,
              <span className="mt-1 block bg-gradient-to-r from-brand-300 via-brand-400 to-sky-200 bg-clip-text text-transparent drop-shadow-[0_4px_24px_rgba(96,165,250,0.3)]">
                DESDE ADENTRO.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg lg:text-xl">
              Fórmulas seleccionadas para acompañar tu{' '}
              <span className="font-semibold text-white">salud</span>, tu{' '}
              <span className="font-semibold text-white">vitalidad</span> y tu{' '}
              <span className="font-semibold text-white">bienestar</span> en cada etapa de tu vida.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3.5">
              <a href="#productos" className={buttonStyles({ size: 'lg', className: 'shadow-lg shadow-brand-600/30 hover:shadow-brand-600/50 hover:scale-[1.02] transition-all' })}>
                Ver productos <ArrowDown className="size-4" />
              </a>
              <a
                href="#como-comprar"
                className="inline-flex min-h-13 items-center justify-center rounded-full border border-white/25 bg-white/10 px-7 py-3.5 text-base font-extrabold text-white shadow-sm backdrop-blur-md transition-all hover:scale-[1.02] hover:border-white/50 hover:bg-white/20 hover:text-white active:scale-[0.98]"
              >
                Cómo comprar
              </a>
            </div>
            <div className="mt-8 flex justify-center lg:hidden" aria-hidden="true">
              <img
                src="/logo-tiendadesuplementos.png"
                alt="Tienda de Suplementos"
                className="size-48 object-contain drop-shadow-[0_15px_25px_rgba(0,0,0,0.35)]"
                width="192"
                height="192"
              />
            </div>
          </div>
          <div className="relative mx-auto hidden w-full max-w-md lg:block" aria-hidden="true">
            <div className="absolute -inset-8 rotate-6 rounded-[4rem] border-2 border-dashed border-brand-500/20" />
            <img
              src="/logo-tiendadesuplementos.png"
              alt="Tienda de Suplementos"
              className="relative aspect-square w-full -rotate-3 object-contain drop-shadow-[0_25px_35px_rgba(0,0,0,0.4)] transition-transform duration-500 hover:scale-105"
              width="720"
              height="720"
            />
            <div className="absolute -bottom-8 -left-14 rounded-[1.5rem] bg-white p-5 text-ink-950 shadow-soft">
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-600">Compra simple</p>
              <p className="mt-1 font-display text-2xl font-black">Sin registros.</p>
              <p className="text-sm font-semibold text-ink-600">Terminás por WhatsApp.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="productos" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-brand-600">Elegidos para todos los días</p>
          <h2 className="mt-3 max-w-2xl font-display text-4xl font-black tracking-[-0.055em] sm:text-5xl">
            Suplementación diseñada a medida
          </h2>
        </div>

        <div className="mt-8 mb-12 sm:mt-10 sm:mb-14 max-w-xl">
          <label htmlFor="search-products" className="sr-only">
            Buscar suplementos
          </label>
          <div className="relative group">
            <Search className="pointer-events-none absolute left-4.5 top-1/2 size-5 -translate-y-1/2 text-ink-400 transition group-focus-within:text-brand-600" />
            <input
              id="search-products"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar por nombre o beneficio (ej. Creatina, Magnesio...)"
              className="w-full rounded-2xl border border-ink-950/12 bg-white py-4 pl-12 pr-12 text-base font-semibold text-ink-950 placeholder:text-ink-400/90 shadow-soft transition duration-200 hover:border-ink-950/20 focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-xl p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-800"
              >
                <X className="size-4.5" />
              </button>
            ) : null}
          </div>
          {searchQuery && productsQuery.isSuccess ? (
            <p className="mt-2.5 pl-1 text-xs font-bold text-ink-500">
              {products.length === 1
                ? '1 suplemento encontrado'
                : `${products.length} suplementos encontrados`}
            </p>
          ) : null}
        </div>

        {productsQuery.isPending ? <LoadingState label="Buscando productos…" /> : null}
        {productsQuery.isError ? (
          <div className="mt-10">
            <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} />
          </div>
        ) : null}
        {productsQuery.isSuccess ? (
          products.length > 0 ? (
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => <ProductCard key={product.id} product={product} />)}
            </div>
          ) : (
            <div className="mt-10 rounded-[2rem] border border-ink-950/7 bg-white p-12 text-center shadow-card">
              <PackageCheck className="mx-auto size-12 text-brand-500/70" />
              <p className="mt-4 font-display text-2xl font-black text-ink-950">
                {searchQuery ? 'No encontramos coincidencias' : 'No hay productos disponibles'}
              </p>
              <p className="mt-2 text-sm text-ink-600">
                {searchQuery ? (
                  <>
                    No se encontraron suplementos para &ldquo;<span className="font-semibold text-ink-900">{searchQuery}</span>&rdquo;.
                  </>
                ) : (
                  'Pronto agregaremos nuevos suplementos al catálogo.'
                )}
              </p>
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="mt-5 inline-flex items-center gap-2 rounded-full bg-brand-600 px-5 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:bg-brand-700 active:scale-95"
                >
                  Limpiar búsqueda
                </button>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      <section id="como-comprar" className="scroll-mt-24 bg-cream-100 py-20 lg:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:items-start">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-brand-600">Compra simple</p>
              <h2 className="mt-3 font-display text-4xl font-black tracking-[-0.055em] sm:text-5xl">Tres pasos. Una conversación real.</h2>
              <p className="mt-5 text-base leading-7 text-ink-600">Armás el carrito acá y una persona confirma por WhatsApp. Sin cuentas, sin contraseñas, sin sorpresas.</p>
            </div>
            <ol className="grid gap-4 sm:grid-cols-3">
              {[
                { icon: ShoppingBag, number: '01', title: 'Elegí', text: 'Sumá productos y ajustá cantidades.' },
                { icon: PackageCheck, number: '02', title: 'Completá', text: 'Elegí cómo pagar y cómo recibirlo.' },
                { icon: MessageCircle, number: '03', title: 'Enviá', text: 'Continuá por WhatsApp para terminar el pedido.' }
              ].map((step) => {
                const Icon = step.icon;
                return (
                  <li key={step.number} className="rounded-[2rem] bg-white p-6 shadow-card">
                    <div className="flex items-center justify-between">
                      <span className="grid size-11 place-items-center rounded-2xl bg-brand-100 text-brand-700"><Icon className="size-5" /></span>
                      <span className="font-display text-2xl font-black text-ink-950/14">{step.number}</span>
                    </div>
                    <h3 className="mt-8 font-display text-2xl font-black">{step.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-ink-600">{step.text}</p>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-[2.5rem] bg-brand-900 px-6 py-12 text-white sm:px-12 lg:flex lg:items-center lg:justify-between lg:py-16">
          <div className="absolute -right-10 -top-16 size-48 rounded-full border-[28px] border-white/10" aria-hidden="true" />
          <div className="relative max-w-2xl">
            {hasItems ? (
              <>
                <h2 className="font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
                  Tenés {itemCount} {itemCount === 1 ? 'unidad' : 'unidades'} en tu carrito
                </h2>
                <p className="mt-3 text-base text-white/80">
                  Tu pedido está listo para elegir el pago y coordinar la entrega por WhatsApp.
                </p>
              </>
            ) : (
              <>
                <h2 className="font-display text-4xl font-black tracking-[-0.05em] sm:text-5xl">
                  Elegí tus productos
                </h2>
                <p className="mt-3 text-base text-white/80">
                  Sumá lo que necesitás para tu rutina y armá tu pedido en segundos.
                </p>
              </>
            )}
          </div>
          {hasItems ? (
            <Link to="/carrito" className={buttonStyles({ variant: 'primary', size: 'lg', className: 'relative mt-7 lg:mt-0' })}>
              Revisar carrito <ArrowRight className="size-4" />
            </Link>
          ) : (
            <a href="#productos" className={buttonStyles({ variant: 'primary', size: 'lg', className: 'relative mt-7 lg:mt-0' })}>
              Ver productos <ArrowDown className="size-4" />
            </a>
          )}
        </div>
      </section>
    </PublicShell>
  );
}
