import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatePicker } from './DatePicker';

describe('DatePicker component', () => {
  afterEach(cleanup);

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

  it('changes month when clicking next and previous month buttons', () => {
    const { getByTestId, getByLabelText, getByText } = render(
      <DatePicker value="2026-09-15" />
    );

    // Open popover
    fireEvent.click(getByTestId('datepicker-trigger'));

    // Should display September 2026
    expect(getByText(/septiembre 2026/i)).toBeInTheDocument();

    // Click next month
    const nextBtn = getByLabelText('Mes siguiente');
    fireEvent.click(nextBtn);

    // Should now display October 2026 without closing
    expect(getByText(/octubre 2026/i)).toBeInTheDocument();

    // Click prev month twice
    const prevBtn = getByLabelText('Mes anterior');
    fireEvent.click(prevBtn);
    fireEvent.click(prevBtn);

    // Should now display August 2026
    expect(getByText(/agosto 2026/i)).toBeInTheDocument();
  });

  it('calls onChange when shortcut is clicked', () => {
    const handleChange = vi.fn();
    const { getByTestId, getByText } = render(
      <DatePicker value="2026-09-15" onChange={handleChange} />
    );

    fireEvent.click(getByTestId('datepicker-trigger'));
    fireEvent.click(getByText('Hoy'));

    expect(handleChange).toHaveBeenCalled();
  });
});
