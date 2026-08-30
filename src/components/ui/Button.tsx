import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg';

export const buttonStyles = ({
  variant = 'primary',
  size = 'md',
  className
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
} = {}): string =>
  cn(
    'inline-flex min-h-12 items-center justify-center gap-2 rounded-full font-extrabold transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 select-none',
    variant === 'primary' &&
      'bg-brand-600 text-white shadow-[0_8px_20px_rgba(37,99,235,0.28)] hover:bg-brand-700 active:bg-brand-800',
    variant === 'secondary' &&
      'border border-ink-950/15 bg-white text-ink-950 hover:border-brand-500/40 hover:bg-brand-50/40 hover:text-brand-700',
    variant === 'ghost' && 'text-ink-800 hover:bg-brand-50 hover:text-brand-700',
    variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
    variant === 'dark' && 'bg-ink-950 text-white hover:bg-brand-900',
    size === 'sm' && 'min-h-11 px-4 text-[14.5px]',
    size === 'md' && 'min-h-12 px-5 py-2.5 text-[15.5px]',
    size === 'lg' && 'min-h-13 px-7 py-3.5 text-base',
    className
  );

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading = false, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={buttonStyles({ variant, size, className })}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
