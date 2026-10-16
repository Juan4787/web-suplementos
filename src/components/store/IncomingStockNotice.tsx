import { Truck } from 'lucide-react';
import type { QuoteCartEtaResult } from '@/domain/types';
import { cn } from '@/lib/cn';

export function IncomingStockNotice({ quote, theme = 'light' }: {
  quote: QuoteCartEtaResult | undefined;
  theme?: 'light' | 'dark';
}) {
  if (!quote?.ok || !quote.requiresIncoming) return null;
  const time = quote.quotedEta ? new Date(quote.quotedEta).getTime() : NaN;
  const date = quote.hasUnspecifiedEta === false && Number.isFinite(time)
    ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(time)) : null;

  return <div className={cn('mt-5 flex items-start gap-3 rounded-xl border p-4 text-sm leading-6',
    theme === 'dark' ? 'border-amber-300/30 bg-amber-300/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-950')}>
    <Truck className="mt-1 size-4 shrink-0" aria-hidden="true" />
    <div className="min-w-0">
      <p className="font-bold">Productos pendientes de recibir</p>
      <p className="mt-1">{date
        ? `Llegada estimada al local: ${date}. La entrega se confirma por WhatsApp.`
        : 'La disponibilidad y la fecha se confirman por WhatsApp.'}</p>
    </div>
  </div>;
}
