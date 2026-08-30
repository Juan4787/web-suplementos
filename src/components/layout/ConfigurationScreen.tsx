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
        <h1 className="mt-5 font-display text-3xl font-black tracking-tight">Falta conectar la tienda</h1>
        <p className="mt-3 leading-7 text-ink-600">
          Este entorno fue publicado sin la dirección y la clave pública de Supabase. Por seguridad, no mostramos datos de demostración en producción.
        </p>
        <p className="mt-4 rounded-2xl bg-cream-100 p-4 text-sm font-semibold text-ink-800">
          Próximo paso: configurá <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>, y volvé a desplegar.
        </p>
      </section>
    </main>
  );
}

