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
import { useField } from './field-context';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from './use-popover-position';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Select } from './Select';

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
  align?: 'left' | 'right' | undefined;
  showMonthYearControls?: boolean | undefined;
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
  showShortcuts = true,
  align = 'left',
  showMonthYearControls = false
}: DatePickerProps) {
  const field = useField();
  const generatedId = useId();
  const inputId = id || field?.id || generatedId;
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const pendingDayFocus = useRef<string | null>(null);
  const position = usePopoverPosition(isOpen, containerRef, { align, minWidth: 312, maxHeight: 520, centerOnMobile: true });

  // Parse current selected date
  const parsedValue = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseISO(value) : null;
  const selectedDate = parsedValue && isValid(parsedValue) ? parsedValue : null;

  // View state for month navigation
  const [viewDate, setViewDate] = useState<Date>(() => selectedDate || new Date());
  const min = minDate && isValid(parseISO(minDate)) ? parseISO(minDate) : null;
  const max = maxDate && isValid(parseISO(maxDate)) ? parseISO(maxDate) : null;
  const allowed = (date: Date) => isValid(date) && (!min || format(date,'yyyy-MM-dd') >= format(min,'yyyy-MM-dd')) &&
    (!max || format(date,'yyyy-MM-dd') <= format(max,'yyyy-MM-dd'));
  const monthAllowed = (date: Date) => (!min || endOfMonth(date) >= min) && (!max || startOfMonth(date) <= max);
  const clampView = (date: Date) => min && endOfMonth(date) < min ? min : max && startOfMonth(date) > max ? max : date;
  useEffect(() => {
    if (!isOpen) return;
    const target = pendingDayFocus.current;
    if (!target && calendarRef.current?.contains(document.activeElement)) return;
    const selected = target ?? (selectedDate ? format(selectedDate,'yyyy-MM-dd') : null);
    const timer=setTimeout(()=>{
      const day=selected ? calendarRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${selected}"]:not(:disabled)`) : null;
      (day ?? calendarRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
      pendingDayFocus.current=null;
    },0);
    return ()=>clearTimeout(timer);
  },[isOpen,viewDate]);

  useEffect(() => { if (disabled) setIsOpen(false); }, [disabled]);

  // Close when clicking outside with composedPath check to prevent closing when child nodes are re-rendered
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (calendarRef.current?.contains(event.target as Node)) return;
      if (event.target instanceof Element && event.target.closest<HTMLElement>('[data-popover-parent]')?.dataset.popoverParent === inputId + '-calendar') return;
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
      if (event.key === 'Escape' && !containerRef.current?.closest('[inert]')) {
        if (calendarRef.current?.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return;
        event.preventDefault();
        setIsOpen(false);
        containerRef.current?.querySelector('button')?.focus();
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
    if (disabled || !allowed(date) || containerRef.current?.querySelector('button')?.matches(':disabled') || containerRef.current?.closest('[inert]')) return;
    const formatted = format(date, 'yyyy-MM-dd');
    onChange?.(formatted);
    setViewDate(date);
    setIsOpen(false);
    containerRef.current?.querySelector('button')?.focus();
  };

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !containerRef.current?.querySelector('button')?.matches(':disabled')) onChange?.('');
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
        aria-label={field?.label}
        aria-invalid={field?.invalid}
        aria-describedby={field?.descriptionId}
        onClick={() => {
          if (!disabled) {
            if (!isOpen) {
              pendingDayFocus.current = null;
              setViewDate(clampView(selectedDate || new Date()));
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
            formattedDisplay ? 'text-ink-950 font-bold' : 'text-ink-600'
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
              onKeyDown={(e) => ['Enter',' '].includes(e.key) && handleClear(e as unknown as React.MouseEvent)}
              className="grid size-6 place-items-center rounded-full hover:bg-cream-200 hover:text-ink-800 transition"
              aria-label="Borrar fecha seleccionada"
            >
              <X className="size-3.5" />
            </span>
          )}
          <CalendarIcon
            className={`size-5 transition ${
              isOpen ? 'text-brand-600 scale-110' : 'text-ink-600 group-hover:text-ink-700'
            }`}
          />
        </div>
      </button>

      {/* Floating / Centered Calendar Popover */}
      {isOpen && createPortal(
        <>
          {/* Mobile backdrop */}
          <div
            data-modal-popover="backdrop"
            data-dialog-owner={containerRef.current?.closest<HTMLElement>('[data-dialog-surface]')?.dataset.dialogSurface}
            className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-xs sm:hidden animate-in fade-in duration-150"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />

          <div
            ref={calendarRef}
            id={inputId + '-calendar'}
            data-dialog-owner={containerRef.current?.closest<HTMLElement>('[data-dialog-surface]')?.dataset.dialogSurface}
          data-modal-popover="date"
            role="dialog"
            onKeyDown={event=>{
              const steps:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
              const day=(event.target as HTMLElement).dataset?.date;
              if(!day||!steps[event.key])return;
              event.preventDefault();
              const next=addDays(parseISO(day),steps[event.key]!);
              if(!allowed(next))return;
              const nextValue=format(next,'yyyy-MM-dd');
              const target=calendarRef.current?.querySelector<HTMLButtonElement>(`button[data-date="${nextValue}"]`);
              if(target)target.focus();else {pendingDayFocus.current=nextValue;setViewDate(next);}
            }}
            aria-label="Elegir fecha"
            className="overflow-y-auto rounded-[1.75rem] border border-ink-950/10 bg-white p-4 shadow-[0_20px_50px_rgba(15,23,42,0.25)] select-none"
            style={position}
          >
            {/* Quick Shortcuts */}
            {showShortcuts && (
              <div className="mb-3.5 flex flex-wrap gap-1.5 border-b border-ink-950/6 pb-3">
                <button
                  type="button"
                  disabled={!allowed(new Date())}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectDate(new Date());
                  }}
                  className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Hoy
                </button>
                <button
                  type="button"
                  disabled={!allowed(addDays(new Date(), 1))}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectDate(addDays(new Date(), 1));
                  }}
                  className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Mañana
                </button>
                <button
                  type="button"
                  disabled={!allowed(addDays(new Date(), 3))}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectDate(addDays(new Date(), 3));
                  }}
                  className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  En 3 días
                </button>
                <button
                  type="button"
                  disabled={!allowed(addDays(new Date(), 7))}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectDate(addDays(new Date(), 7));
                  }}
                  className="rounded-xl bg-cream-100 px-3 py-1.5 text-[12px] font-black text-ink-700 hover:bg-brand-50 hover:text-brand-700 transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  En 1 sem.
                </button>
              </div>
            )}

            {/* Month & Year Navigation Header */}
            <div className="mb-3 flex items-center justify-between px-1">
              <h4 className="font-display text-[15.5px] font-black capitalize text-ink-950">
                {format(viewDate, 'MMMM yyyy', { locale: es })}
              </h4>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!monthAllowed(subMonths(viewDate, 1))}
                  onClick={handlePrevMonth}
                  className="grid size-8 place-items-center rounded-xl text-ink-600 hover:bg-cream-100 hover:text-ink-950 transition active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Mes anterior"
                >
                  <ChevronLeft className="size-4.5" />
                </button>
                <button
                  type="button"
                  disabled={!monthAllowed(addMonths(viewDate, 1))}
                  onClick={handleNextMonth}
                  className="grid size-8 place-items-center rounded-xl text-ink-600 hover:bg-cream-100 hover:text-ink-950 transition active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label="Mes siguiente"
                >
                  <ChevronRight className="size-4.5" />
                </button>
              </div>
            </div>

            {showMonthYearControls ? <div className="mb-3 grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
              <Select id={inputId + '-month'} aria-label="Mes del calendario" size="sm" searchable={false}
                value={String(viewDate.getMonth())}
                onValueChange={month => setViewDate(clampView(new Date(viewDate.getFullYear(), Number(month), 1)))}
                options={Array.from({length:12},(_,month)=>({value:String(month),label:format(new Date(2026,month,1),'MMMM',{locale:es}),
                  disabled:!monthAllowed(new Date(viewDate.getFullYear(),month,1))}))} />
              <Select id={inputId + '-year'} aria-label="Año del calendario" size="sm"
                value={String(viewDate.getFullYear())}
                onValueChange={year => setViewDate(clampView(new Date(Number(year),viewDate.getMonth(),1)))}
                options={Array.from({length:(max?.getFullYear() ?? viewDate.getFullYear()+100)-(min?.getFullYear() ?? viewDate.getFullYear()-100)+1},(_,index)=>{
                  const year=(min?.getFullYear() ?? viewDate.getFullYear()-100)+index;
                  return {value:String(year),label:String(year)};
                })} />
            </div> : null}

            {/* Weekday headers */}
            <div className="mb-2 grid grid-cols-7 gap-1 text-center">
              {weekDayLabels.map((dayLabel, idx) => (
                <span key={idx} className="text-[11px] font-black uppercase tracking-wider text-ink-600 py-0.5">
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
                    aria-label={format(day,'EEEE d MMMM yyyy',{locale:es})}
                    data-date={format(day,'yyyy-MM-dd')}
                    disabled={!allowed(day)}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectDate(day);
                    }}
                    className={`relative grid h-9.5 w-full place-items-center rounded-xl text-[13.5px] font-bold tabular-nums select-none disabled:opacity-30 disabled:cursor-not-allowed ${
                      isSelected
                        ? 'bg-ink-950 text-white font-black shadow-sm scale-105 z-10'
                        : isCurrentDay
                          ? 'border border-brand-500 font-black text-brand-600 hover:bg-brand-50'
                          : isCurrentMonth
                            ? 'text-ink-950 hover:bg-cream-100 hover:text-ink-950 active:scale-95'
                            : 'text-ink-600 hover:bg-cream-50 hover:text-ink-950'
                    }`}
                  >
                    {format(day, 'd')}
                  </button>
                );
              })}
            </div>

            {/* Mobile close button */}
            <div className="mt-3 flex justify-end border-t border-ink-950/6 pt-2.5 sm:hidden">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                }}
                className="w-full rounded-xl bg-cream-100 hover:bg-cream-200 py-2.5 text-center text-xs font-black text-ink-800 active:scale-95 transition"
              >
                Cerrar
              </button>
            </div>
          </div>
        </>, document.body
      )}
    </div>
  );
}
