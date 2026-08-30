import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { unknownToAppError } from '@/domain/errors';
import { Button } from './Button';

export function LoadingState({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex min-h-56 items-center justify-center" role="status">
      <div className="flex items-center gap-3 rounded-full bg-white px-5 py-3 text-sm font-bold text-ink-600 shadow-card">
        <span className="size-2.5 animate-pulse rounded-full bg-brand-600" />
        {label}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const appError = unknownToAppError(error);
  return (
    <div className="rounded-[1.75rem] border border-red-200 bg-red-50 p-6" role="alert">
      <div className="flex gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-700">
          <AlertCircle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="font-extrabold text-red-950">{appError.message}</p>
          {appError.nextAction ? <p className="mt-1 text-sm text-red-800">{appError.nextAction}</p> : null}
          {onRetry && appError.retryable ? (
            <Button className="mt-4" variant="secondary" size="sm" onClick={onRetry}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Intentar de nuevo
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[1.75rem] border border-dashed border-ink-950/20 bg-white/60 px-6 py-12 text-center">
      <Inbox className="mx-auto size-8 text-ink-600" aria-hidden="true" />
      <h3 className="mt-4 font-display text-xl font-black text-ink-950">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-600">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
