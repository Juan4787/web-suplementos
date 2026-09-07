import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/cn';

export function Logo({
  compact = false,
  inverted = false,
  className,
  textClassName
}: {
  compact?: boolean;
  inverted?: boolean;
  className?: string;
  textClassName?: string;
}) {
  return (
    <Link
      to="/"
      className={cn('inline-flex items-center gap-2.5 min-w-0', className)}
      aria-label="TIENDA DE SUPLEMENTOS, ir al inicio"
    >
      <img
        src="/logo-tiendadesuplementos.png"
        alt="Logo Tienda de Suplementos"
        className={cn('size-10 object-contain shrink-0', compact && 'size-8')}
        width="40"
        height="40"
      />
      <span
        className={cn(
          'font-display font-black tracking-[-0.03em] whitespace-nowrap',
          textClassName
            ? textClassName
            : compact
              ? 'text-sm sm:text-base'
              : 'text-base sm:text-xl',
          inverted ? 'text-white' : 'text-ink-950'
        )}
      >
        TIENDA DE SUPLEMENTOS
      </span>
    </Link>
  );
}
