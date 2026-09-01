import { Settings2 } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';

export function ConfigurationScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-cream-100 px-4">
      <section className="w-full max-w-xl rounded-[2rem] bg-white p-8 shadow-soft sm:p-10">
        <Logo />
        <span className="mt-10 flex size-12 items-center justify-center rounded-2xl bg-sun-400">
          <Settings2 className="size-6" aria-hidden="true" />
        </span>
        <h1 className="mt-5 font-display text-3xl font-black tracking-tight">Tienda en configuración</h1>
        <p className="mt-3 leading-7 text-ink-600">
          La tienda se encuentra en proceso de conexión. Por seguridad, el acceso a datos comerciales estará disponible en breve.
        </p>
        <p className="mt-4 rounded-2xl bg-cream-100 p-4 text-sm font-semibold text-ink-800">
          Por favor, comunicate con la administración de la tienda para más información.
        </p>
      </section>
    </main>
  );
}

