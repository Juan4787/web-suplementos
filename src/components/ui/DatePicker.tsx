import { useState, useRef, useEffect, useId } from 'react';
import {
  format,
  parseISO,
  isValid,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  addMonths,
  subMonths,
  addDays
} from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface DatePickerProps {
  value?: string | undefined; // Format: 'YYYY-MM-DD'
  onChange?: ((value: string) => void) | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  minDate?: string | undefined;
  maxDate?: string | undefined;
  showShortcuts?: boolean | undefined;
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'dd/mm/aaaa',
  disabled = false,
  className = '',
  id,
  minDate,
  maxDate,
  showShortcuts = true
}: DatePickerProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse current selected date
  const parsedValue = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISO(value) : null;
  const selectedDate = parsedValue && isValid(parsedValue) ? parsedValue : null;

  // View state for month navigation
  const [viewDate, setViewDate] = useState<Date>(() => selectedDate || new Date());

  // Close when clicking outside with composedPath check to prevent closing when child nodes are re-rendered
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (
        event.composedPath &&
        containerRef.current &&
        event.composedPath().includes(containerRef.current)
      ) {
        return;
      }
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectDate = (date: Date) => {
    const formatted = format(date, 'yyyy-MM-dd');
    onChange?.(formatted);
    setViewDate(date);
    setIsOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange?.('');
  };

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setViewDate((curr) => subMonths(curr, 1));
  };

  const handleNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setViewDate((curr) => addMonths(curr, 1));
  };

  // Calendar matrix computation
  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(monthStart);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 }); // Monday start
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  const weekDayLabels = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

  const formattedDisplay = selectedDate
    ? format(selectedDate, 'dd/MM/yyyy')
    : '';

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      {/* Trigger Button */}
      <button
        id={inputId}
        data-testid="datepicker-trigger"
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (!isOpen) {
              setViewDate(selectedDate || new Date());
            }
            setIsOpen((prev) => !prev);
          }
        }}
        className={`group flex min-h-12 w-full items-center justify-between rounded-2xl border bg-white px-4 py-3 text-left shadow-sm transition ${
          isOpen
            ? 'border-brand-600 ring-4 ring-brand-500/10'
            : 'border-ink-950/15 hover:border-ink-950/30'
        } ${disabled ? 'cursor-not-allowed opacity-50 bg-cream-100' : 'cursor-pointer'}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span
          className={`text-[15px] font-medium transition ${
            formattedDisplay ? 'text-ink-950 font-bold' : 'text-ink-400'
          }`}
        >
          {formattedDisplay || placeholder}
        </span>

        <div className="flex items-center gap-1.5 text-ink-500">
          {selectedDate && !disabled && (
            <span
              role="button"
              tabIndex={0}
              data-testid="datepicker-clear"
              onClick={handleClear}
              onKeyDown={(e) => e.key === 'Enter' && handleClear(e as unknown as React.MouseEvent)}
              className="grid size-6 place-items-center rounded-full hover:bg-cream-200 hover:text-ink-800 transition"
              aria-label="Borrar fecha seleccionada"
            >
              <X className="size-3.5" />
            </span>
          )}
          <CalendarIcon
            className={`size-5 transition ${
              isOpen ? 'text-brand-600 scale-110' : 'text-ink-400 group-hover:text-ink-700'
            }`}
          />
        </div>
      </button>

      {/* Floating Calendar Popover */}
      {isOpen && (
        <div
          className="absolute left-0 top-full z-50 mt-2 w-full max-w-[340px] rounded-[1.75rem] border border-ink-950/10 bg-white p-4 shadow-[0_20px_50px_rgba(15,23,42,0.18)] transition-all animate-in fade-in zoom-in-95 duration-150 select-none"
          style={{ isolation: 'isolate' }}
        >
          {/* Quick Shortcuts */}
          {showShortcuts && (
            <div className="mb-3.5 flex flex-wrap gap-1.5 border-b border-ink-950/6 pb-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectDate(new Date());
                }}
                className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95"
              >
                Hoy
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectDate(addDays(new Date(), 1));
                }}
                className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95"
              >
                Mañana
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectDate(addDays(new Date(), 3));
                }}
                className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95"
              >
                En 3 días
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelectDate(addDays(new Date(), 7));
                }}
                className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95"
              >
                En 1 sem.
              </button>
            </div>
          )}

          {/* Month & Year Navigation Header */}
          <div className="mb-3 flex items-center justify-between px-1">
            <h4 className="font-display text-[16px] font-black capitalize text-ink-950">
              {format(viewDate, 'MMMM yyyy', { locale: es })}
            </h4>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="grid size-8 place-items-center rounded-xl text-ink-600 hover:bg-cream-100 hover:text-ink-950 transition active:scale-90"
                aria-label="Mes anterior"
              >
                <ChevronLeft className="size-4.5" />
              </button>
              <button
                type="button"
                onClick={handleNextMonth}
                className="grid size-8 place-items-center rounded-xl text-ink-600 hover:bg-cream-100 hover:text-ink-950 transition active:scale-90"
                aria-label="Mes siguiente"
              >
                <ChevronRight className="size-4.5" />
              </button>
            </div>
          </div>

          {/* Weekday headers */}
          <div className="mb-1.5 grid grid-cols-7 text-center">
            {weekDayLabels.map((dayLabel, idx) => (
              <span key={idx} className="text-[11px] font-black uppercase tracking-wider text-ink-400">
                {dayLabel}
              </span>
            ))}
          </div>

          {/* Day Grid */}
          <div className="grid grid-cols-7 gap-1">
            {days.map((day, idx) => {
              const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
              const isCurrentMonth = isSameMonth(day, viewDate);
              const isCurrentDay = isToday(day);

              return (
                <button
                  key={idx}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectDate(day);
                  }}
                  className={`relative grid size-9.5 place-items-center rounded-xl text-[13.5px] font-bold transition ${
                    isSelected
                      ? 'bg-ink-950 text-white font-black shadow-sm scale-105 z-10'
                      : isCurrentDay
                        ? 'border border-brand-500 font-black text-brand-600 hover:bg-brand-50'
                        : isCurrentMonth
                          ? 'text-ink-900 hover:bg-cream-100 hover:text-ink-950 active:scale-95'
                          : 'text-ink-300 hover:bg-cream-50 hover:text-ink-500'
                  }`}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
