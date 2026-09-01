import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const controlClass =
  'min-h-12 w-full rounded-2xl border border-ink-950/15 bg-white px-4 text-[15.5px] font-semibold text-ink-950 shadow-sm transition placeholder:text-ink-600/70 hover:border-ink-950/25 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/20';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
  htmlFor?: string | undefined;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-[15px] font-extrabold text-ink-950">
        {label}
      </label>
      {children}
      {error ? <p className="mt-2 text-[14px] font-semibold text-red-700">{error}</p> : null}
      {!error && hint ? <p className="mt-2 text-[14px] leading-relaxed text-ink-700 font-medium">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(controlClass, className)} {...props} />;
  }
);

export { Select, type SelectOption, type SelectProps } from './Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(controlClass, 'min-h-28 py-3.5', className)} {...props} />;
  }
);
