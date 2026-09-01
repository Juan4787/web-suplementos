import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/cn';

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean | undefined;
};

export type SelectProps = {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onChange?: ((event: { target: { value: string; name?: string | undefined } }) => void) | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  name?: string | undefined;
  id?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  options?: SelectOption[] | undefined;
  children?: ReactNode | undefined;
  'aria-label'?: string | undefined;
  searchable?: boolean | undefined;
  size?: 'sm' | 'md' | undefined;
};

/**
 * Recursively extracts plain text from any ReactNode (strings, numbers, arrays, elements)
 */
function getNodeText(node: ReactNode): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join('');
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return getNodeText(props.children);
  }
  return '';
}

/**
 * Normalizes text for robust accent-insensitive and case-insensitive search
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function Select({
  value: controlledValue,
  defaultValue = '',
  onChange,
  onValueChange,
  name,
  id,
  placeholder = 'Seleccionar…',
  disabled = false,
  className,
  options: explicitOptions,
  children,
  'aria-label': ariaLabel,
  searchable,
  size = 'md'
}: SelectProps) {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const activeValue = isControlled ? controlledValue : internalValue;

  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Extract options from either props or option children
  const options: SelectOption[] = useMemo(() => {
    if (explicitOptions) return explicitOptions;
    const extracted: SelectOption[] = [];
    Children.forEach(children, (child) => {
      if (isValidElement(child) && child.type === 'option') {
        const optionProps = child.props as {
          value?: string;
          children?: ReactNode;
          disabled?: boolean;
        };
        extracted.push({
          value: String(optionProps.value ?? ''),
          label: optionProps.children ?? String(optionProps.value ?? ''),
          disabled: optionProps.disabled
        });
      }
    });
    return extracted;
  }, [explicitOptions, children]);

  // Selected option label
  const selectedOption = options.find((opt) => opt.value === activeValue);

  // Auto-enable search if there are more than 7 items and not explicitly disabled
  const showSearch = searchable ?? options.length > 7;

  // Filtered options with accent-insensitive and node-text extraction
  const filteredOptions = useMemo(() => {
    const term = normalizeText(searchTerm);
    if (!term) return options;

    return options.filter((opt) => {
      // If user is searching, hide empty placeholder options (e.g. value === "")
      if (opt.value === '' && term) return false;

      const labelText = normalizeText(getNodeText(opt.label));
      const valText = normalizeText(String(opt.value ?? ''));

      return labelText.includes(term) || valText.includes(term);
    });
  }, [options, searchTerm]);

  const handleSelect = (val: string) => {
    if (!isControlled) {
      setInternalValue(val);
    }
    onChange?.({ target: { value: val, name } });
    onValueChange?.(val);
    setIsOpen(false);
    setSearchTerm('');
  };

  // Close when clicking outside with composedPath support
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
        setSearchTerm('');
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchTerm('');
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

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && showSearch) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 60);
      return () => clearTimeout(timer);
    }
  }, [isOpen, showSearch]);

  return (
    <div ref={containerRef} className={cn('relative w-full select-none', className)}>
      {/* Hidden native input for form compatibility */}
      <input type="hidden" name={name} id={id} value={activeValue} />

      {/* Trigger button */}
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          if (!disabled) {
            setIsOpen((prev) => !prev);
            setSearchTerm('');
          }
        }}
        className={cn(
          'flex w-full items-center justify-between gap-2.5 rounded-2xl border bg-white text-left font-bold text-ink-950 shadow-sm transition outline-none',
          size === 'sm'
            ? 'min-h-10 px-3.5 py-2 text-[14px]'
            : 'min-h-12 px-4 py-2.5 text-[15px]',
          isOpen
            ? 'border-brand-600 ring-2 ring-brand-500/20'
            : 'border-ink-950/15 hover:border-ink-950/30 hover:bg-cream-50/40',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <span
          className={cn(
            'text-left break-words leading-tight line-clamp-2',
            !selectedOption || selectedOption.value === ''
              ? 'text-ink-500 font-medium'
              : 'text-ink-950 font-bold'
          )}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            'size-4.5 shrink-0 text-ink-500 transition-transform duration-200',
            isOpen && 'rotate-180 text-brand-600'
          )}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-[calc(100%+6px)] z-50 flex max-h-80 w-full min-w-full sm:min-w-[340px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-ink-950/10 bg-white/95 p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
        >
          {/* Search bar for large option lists */}
          {showSearch && (
            <div className="p-1.5 border-b border-ink-950/8 mb-1">
              <div className="relative flex items-center">
                <Search className="absolute left-3 size-4 text-ink-400 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Buscar opción…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="h-9 w-full rounded-xl bg-cream-50 pl-9 pr-3 text-[13.5px] font-bold text-ink-950 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>
          )}

          {/* Options list */}
          <div className="overflow-y-auto flex-1 space-y-0.5 p-0.5 custom-scrollbar">
            {filteredOptions.length === 0 ? (
              <div className="py-4 text-center text-xs font-bold text-ink-500">
                No se encontraron opciones
              </div>
            ) : (
              filteredOptions.map((option) => {
                const isSelected = option.value === activeValue;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    onClick={() => !option.disabled && handleSelect(option.value)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-[14px] transition active:scale-[0.99]',
                      isSelected
                        ? 'bg-brand-50 text-brand-700 font-black shadow-xs'
                        : 'text-ink-800 font-bold hover:bg-cream-100 hover:text-ink-950',
                      option.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent'
                    )}
                  >
                    <span className="text-left break-words leading-snug whitespace-normal">{option.label}</span>
                    {isSelected && <Check className="size-4 shrink-0 text-brand-600 ml-2" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
