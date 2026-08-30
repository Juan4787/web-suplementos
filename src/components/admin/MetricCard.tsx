import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  accent = 'sapphire'
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  accent?: 'sapphire' | 'coral' | 'sun' | 'blue';
}) {
  return (
    <article className="rounded-[1.75rem] border border-ink-950/8 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[14.5px] font-black text-ink-700">{label}</p>
          <p className="mt-2.5 font-display text-3xl sm:text-4xl font-black tracking-[-0.03em] text-ink-950">{value}</p>
          <p className="mt-2 text-[14px] font-semibold text-ink-700">{detail}</p>
        </div>
        <span
          className={cn(
            'grid size-12 shrink-0 place-items-center rounded-2xl',
            (accent === 'sapphire' || accent === 'blue') && 'bg-brand-100 text-brand-700',
            accent === 'coral' && 'bg-rose-100 text-rose-700',
            accent === 'sun' && 'bg-amber-100 text-amber-800'
          )}
        >
          <Icon className="size-6" aria-hidden="true" />
        </span>
      </div>
    </article>
  );
}
