import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes
} from 'react';
import { cn } from '@/lib/cn';
import { useField } from './field-context';

export interface CurrencyInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'> {
  value?: number | null | undefined;
  onChange?: (value: number | undefined) => void;
}

const controlClass =
  'min-h-12 w-full rounded-2xl border border-ink-950/15 bg-white px-4 text-[15.5px] font-semibold text-ink-950 shadow-sm transition placeholder:text-ink-600/70 hover:border-ink-950/25 focus:border-brand-600 focus:ring-2 focus:ring-brand-500/20';

function formatNumber(num: number): string {
  return new Intl.NumberFormat('es-AR').format(num);
}

function getFormattedAndCursor(rawValue: string, rawCursor: number) {
  let digitsBeforeCursor = 0;
  for (let i = 0; i < rawCursor; i++) {
    const char = rawValue[i];
    if (char && /\d/.test(char)) digitsBeforeCursor++;
  }

  const digits = rawValue.replace(/\D/g, '');
  if (!digits) return { formatted: '', cursor: 0, numeric: undefined };

  const num = parseInt(digits, 10);
  if (Number.isNaN(num)) return { formatted: '', cursor: 0, numeric: undefined };

  const formatted = formatNumber(num);

  let newCursor = 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i++) {
    const char = formatted[i];
    if (char && /\d/.test(char)) count++;
    if (count === digitsBeforeCursor) {
      newCursor = i + 1;
      break;
    }
  }
  if (digitsBeforeCursor === 0) newCursor = 0;
  if (count < digitsBeforeCursor) newCursor = formatted.length;

  return { formatted, cursor: newCursor, numeric: num };
}

export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    { value, onChange, onKeyDown, onFocus, className, placeholder = '25.000', ...props },
    forwardedRef
  ) {
    const field = useField();
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

    const pendingCursorRef = useRef<number | null>(null);

    const formatInitial = useCallback((val: number | null | undefined): string => {
      if (val === undefined || val === null || Number.isNaN(val)) return '';
      if (val === 0) return '0';
      return formatNumber(val);
    }, []);

    const [displayValue, setDisplayValue] = useState<string>(() => formatInitial(value));

    // Synchronize when value changes externally (e.g. form reset or editing another product)
    useEffect(() => {
      const nextFormatted = formatInitial(value);
      setDisplayValue((prev) => {
        const prevNum = prev ? parseInt(prev.replace(/\D/g, ''), 10) : undefined;
        const propNum =
          value !== undefined && value !== null && !Number.isNaN(value) ? value : undefined;
        if (prevNum === propNum) return prev;
        return nextFormatted;
      });
    }, [value, formatInitial]);

    // Restore cursor position synchronously before browser paint to eliminate jumpiness/flicker
    useLayoutEffect(() => {
      if (pendingCursorRef.current !== null && inputRef.current) {
        const pos = Math.min(pendingCursorRef.current, inputRef.current.value.length);
        inputRef.current.setSelectionRange(pos, pos);
        pendingCursorRef.current = null;
      }
    });

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      const input = inputRef.current;
      if (!input) return;

      const { selectionStart, selectionEnd, value: currentVal } = input;
      const isCollapsed = selectionStart !== null && selectionStart === selectionEnd;

      // Handle Backspace directly after a thousand dot (e.g. "25.|000")
      if (e.key === 'Backspace' && isCollapsed && selectionStart > 0) {
        if (currentVal[selectionStart - 1] === '.') {
          e.preventDefault();

          let digitsBefore = 0;
          for (let i = 0; i < selectionStart - 2; i++) {
            const char = currentVal[i];
            if (char && /\d/.test(char)) digitsBefore++;
          }

          const cleanRemaining = (
            currentVal.slice(0, selectionStart - 2) + currentVal.slice(selectionStart)
          ).replace(/\D/g, '');

          if (!cleanRemaining) {
            input.value = '';
            setDisplayValue('');
            pendingCursorRef.current = 0;
            onChange?.(undefined);
            return;
          }

          const num = parseInt(cleanRemaining, 10);
          const formatted = formatNumber(num);

          let newCursor = 0;
          let count = 0;
          for (let i = 0; i < formatted.length; i++) {
            const char = formatted[i];
            if (char && /\d/.test(char)) count++;
            if (count === digitsBefore) {
              newCursor = i + 1;
              break;
            }
          }
          if (digitsBefore === 0) newCursor = 0;
          if (count < digitsBefore) newCursor = formatted.length;

          input.value = formatted;
          input.setSelectionRange(newCursor, newCursor);
          pendingCursorRef.current = newCursor;
          setDisplayValue(formatted);
          onChange?.(num);
          return;
        }
      }

      // Handle Delete directly before a thousand dot (e.g. "25|.000")
      if (
        e.key === 'Delete' &&
        isCollapsed &&
        selectionStart !== null &&
        selectionStart < currentVal.length
      ) {
        if (currentVal[selectionStart] === '.') {
          e.preventDefault();

          let digitsBefore = 0;
          for (let i = 0; i < selectionStart; i++) {
            const char = currentVal[i];
            if (char && /\d/.test(char)) digitsBefore++;
          }

          const cleanRemaining = (
            currentVal.slice(0, selectionStart) + currentVal.slice(selectionStart + 2)
          ).replace(/\D/g, '');

          if (!cleanRemaining) {
            input.value = '';
            setDisplayValue('');
            pendingCursorRef.current = 0;
            onChange?.(undefined);
            return;
          }

          const num = parseInt(cleanRemaining, 10);
          const formatted = formatNumber(num);

          let newCursor = 0;
          let count = 0;
          for (let i = 0; i < formatted.length; i++) {
            const char = formatted[i];
            if (char && /\d/.test(char)) count++;
            if (count === digitsBefore) {
              newCursor = i + 1;
              break;
            }
          }
          if (digitsBefore === 0) newCursor = 0;
          if (count < digitsBefore) newCursor = formatted.length;

          input.value = formatted;
          input.setSelectionRange(newCursor, newCursor);
          pendingCursorRef.current = newCursor;
          setDisplayValue(formatted);
          onChange?.(num);
          return;
        }
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const rawValue = e.target.value;
      const rawCursor = e.target.selectionStart ?? rawValue.length;

      const { formatted, cursor, numeric } = getFormattedAndCursor(rawValue, rawCursor);

      e.target.value = formatted;
      pendingCursorRef.current = cursor;
      setDisplayValue(formatted);
      onChange?.(numeric);
    };

    return (
      <input
        ref={inputRef}
        id={field?.id}
        aria-label={field?.label}
        aria-invalid={field?.invalid}
        aria-describedby={field?.descriptionId}
        type="text"
        inputMode="numeric"
        value={displayValue}
        placeholder={placeholder}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={(e) => {
          onFocus?.(e);
        }}
        className={cn(controlClass, className)}
        {...props}
      />
    );
  }
);
