import type { ClipboardEvent, FormEvent } from 'react';

export const acceptsWholeUnitDraft = (value: string): boolean => /^\d*$/.test(value);

// Keep deletion, selection and shortcuts intact; reject an invalid insertion whole.
export const wholeUnitInputProps = {
  type: 'text' as const,
  inputMode: 'numeric' as const,
  pattern: '[0-9]*',
  onBeforeInput: (event: FormEvent<HTMLInputElement>) => {
    const text = (event.nativeEvent as InputEvent).data;
    if (typeof text === 'string' && !acceptsWholeUnitDraft(text)) event.preventDefault();
  },
  onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
    if (!acceptsWholeUnitDraft(event.clipboardData.getData('text'))) event.preventDefault();
  }
};
