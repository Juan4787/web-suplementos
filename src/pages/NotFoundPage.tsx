import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { buttonStyles } from '@/components/ui/Button';

export default function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-cream-100 px-4 text-center">
      <div>
        <div className="flex justify-center"><Logo /></div>
        <p className="mt-10 font-display text-8xl font-black tracking-[-0.08em] text-coral-400">404</p>
        <h1 className="mt-2 font-display text-3xl font-black">Esta página no está acá</h1>
        <p className="mt-3 text-ink-600">Volvé a la tienda para seguir navegando.</p>
        <Link to="/" className={buttonStyles({ variant: 'dark', className: 'mt-7' })}><ArrowLeft className="size-4" /> Ir a la tienda</Link>
      </div>
    </main>
  );
}

