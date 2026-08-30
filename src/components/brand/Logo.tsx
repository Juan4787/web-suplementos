import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/cn';

export function Logo({ compact = false, inverted = false }: { compact?: boolean; inverted?: boolean }) {
  return (
    <Link to="/" className="inline-flex items-center gap-2.5" aria-label="Impulso, ir a la tienda">
      <span
        className={cn(
          'relative grid size-9 place-items-center overflow-hidden rounded-[0.85rem] bg-brand-600 shadow-sm',
          compact && 'size-8'
        )}
      >
        <span className="absolute h-6 w-2.5 -rotate-35 rounded-full bg-brand-950" />
        <span className="absolute h-2.5 w-6 rotate-35 rounded-full bg-brand-300" />
      </span>
      <span
        className={cn(
          'font-display text-xl font-black tracking-[-0.04em]',
          inverted ? 'text-white' : 'text-ink-950',
          compact && 'text-lg'
        )}
      >
        IMPULSO<span className="text-brand-500">.</span>
      </span>
    </Link>
  );
}
