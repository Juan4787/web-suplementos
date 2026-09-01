import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DatePicker } from './DatePicker';

describe('DatePicker component', () => {
  it('renders placeholder when no value is provided', () => {
    const { container } = render(<DatePicker placeholder="Cuándo debería llegar" />);
    expect(container.textContent).toContain('Cuándo debería llegar');
  });

  it('formats and displays provided YYYY-MM-DD date value', () => {
    const { container } = render(<DatePicker value="2026-09-15" />);
    expect(container.textContent).toContain('15/09/2026');
  });

  it('renders disabled state correctly', () => {
    const { container } = render(<DatePicker value="2026-09-15" disabled />);
    const button = container.querySelector('button');
    expect(button).toBeDisabled();
  });
});
