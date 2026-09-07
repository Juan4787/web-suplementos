import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrencyInput } from './CurrencyInput';

describe('CurrencyInput component', () => {
  afterEach(cleanup);

  it('formats thousands automatically with dot while typing (e.g. 25000 -> 25.000)', () => {
    const handleChange = vi.fn();
    const { container } = render(<CurrencyInput onChange={handleChange} />);
    const input = container.querySelector('input')!;

    fireEvent.change(input, { target: { value: '25000', selectionStart: 5 } });

    expect(input.value).toBe('25.000');
    expect(handleChange).toHaveBeenCalledWith(25000);
  });

  it('clears cleanly to empty string and undefined when all text is removed', () => {
    const handleChange = vi.fn();
    const { container } = render(<CurrencyInput value={25000} onChange={handleChange} />);
    const input = container.querySelector('input')!;

    expect(input.value).toBe('25.000');

    fireEvent.change(input, { target: { value: '', selectionStart: 0 } });

    expect(input.value).toBe('');
    expect(handleChange).toHaveBeenCalledWith(undefined);
  });

  it('formats initial numeric value correctly', () => {
    const { container } = render(<CurrencyInput value={1500000} />);
    const input = container.querySelector('input')!;

    expect(input.value).toBe('1.500.000');
  });

  it('handles backspace after a dot without getting stuck or blocking deletion', () => {
    const handleChange = vi.fn();
    const { container } = render(<CurrencyInput value={25000} onChange={handleChange} />);
    const input = container.querySelector('input')!;

    // Cursor right after the dot: "25.|000" (index 3)
    input.setSelectionRange(3, 3);

    fireEvent.keyDown(input, { key: 'Backspace' });

    // Should remove the '5' before the dot -> 2000 -> "2.000"
    expect(input.value).toBe('2.000');
    expect(handleChange).toHaveBeenCalledWith(2000);
  });

  it('handles delete key right before a dot', () => {
    const handleChange = vi.fn();
    const { container } = render(<CurrencyInput value={25000} onChange={handleChange} />);
    const input = container.querySelector('input')!;

    // Cursor right before the dot: "25|.000" (index 2)
    input.setSelectionRange(2, 2);

    fireEvent.keyDown(input, { key: 'Delete' });

    // Should remove the '0' after the dot -> 2500 -> "2.500"
    expect(input.value).toBe('2.500');
    expect(handleChange).toHaveBeenCalledWith(2500);
  });
});
