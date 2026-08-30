import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ToastProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string | undefined;
  duration?: number | undefined;
  variant?: 'success' | 'error' | 'info' | undefined;
}

export function Toast({
  open,
  onClose,
  title,
  description,
  duration = 5000,
  variant = 'success'
}: ToastProps) {
  const [isHovered, setIsHovered] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const remainingTimeRef = useRef<number>(duration);

  // Gestión de temporizador con pausa al hacer hover
  useEffect(() => {
    if (!open) return;

    remainingTimeRef.current = duration;
    startTimeRef.current = Date.now();

    const startTimer = () => {
      timerRef.current = setTimeout(() => {
        onClose();
      }, remainingTimeRef.current);
    };

    if (!isHovered) {
      startTimer();
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [open, duration, onClose, isHovered]);

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      const elapsed = Date.now() - startTimeRef.current;
      remainingTimeRef.current = Math.max(500, remainingTimeRef.current - elapsed);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    startTimeRef.current = Date.now();
  };

  if (!open) return null;

  const variantStyles = {
    success: {
      border: 'border-emerald-500/20 bg-white/95',
      iconBg: 'bg-emerald-50 text-emerald-600 border-emerald-200/60',
      icon: <CheckCircle2 className="size-5" aria-hidden="true" />,
      bar: 'bg-emerald-600',
      barBg: 'bg-emerald-100/60'
    },
    error: {
      border: 'border-red-500/20 bg-white/95',
      iconBg: 'bg-red-50 text-red-600 border-red-200/60',
      icon: <AlertCircle className="size-5" aria-hidden="true" />,
      bar: 'bg-red-600',
      barBg: 'bg-red-100/60'
    },
    info: {
      border: 'border-brand-500/20 bg-white/95',
      iconBg: 'bg-brand-50 text-brand-600 border-brand-200/60',
      icon: <Info className="size-5" aria-hidden="true" />,
      bar: 'bg-brand-600',
      barBg: 'bg-brand-100/60'
    }
  }[variant];

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'toast-enter fixed top-5 right-5 z-50 flex max-w-md w-[calc(100vw-2.5rem)] sm:w-auto items-start gap-3.5 rounded-2xl border p-4 shadow-[0_16px_40px_rgba(11,19,36,0.14)] backdrop-blur-md transition-all select-none',
        variantStyles.border
      )}
    >
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-xl border',
          variantStyles.iconBg
        )}
      >
        {variantStyles.icon}
      </span>

      <div className="flex-1 pt-0.5 pr-2">
        <h4 className="font-display text-[15px] font-black text-ink-950 leading-tight">
          {title}
        </h4>
        {description ? (
          <p className="mt-1 text-[13.5px] font-medium leading-snug text-ink-600">
            {description}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Cerrar mensaje"
        className="grid size-8 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-ink-100 hover:text-ink-900 active:scale-90 transition"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      {/* Barra de progreso temporal de auto-cierre */}
      <div
        className={cn(
          'absolute bottom-0 left-4 right-4 h-0.5 overflow-hidden rounded-full',
          variantStyles.barBg
        )}
      >
        <div
          className={cn('h-full w-full', variantStyles.bar)}
          style={{
            animation: !isHovered ? `toast-progress ${duration}ms linear forwards` : 'none'
          }}
        />
      </div>
    </div>
  );
}
