import { cn } from '@/lib/cn';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-[13.5px] font-black tracking-tight select-none',
        tone === 'success' && 'bg-emerald-50 text-emerald-800 border border-emerald-300/80',
        tone === 'warning' && 'bg-amber-50 text-amber-900 border border-amber-300/80',
        tone === 'danger' && 'bg-red-50 text-red-800 border border-red-300/80',
        tone === 'info' && 'bg-brand-50 text-brand-800 border border-brand-300/80',
        tone === 'neutral' && 'bg-ink-950/6 text-ink-800 border border-ink-950/15'
      )}
    >
      {label}
    </span>
  );
}
