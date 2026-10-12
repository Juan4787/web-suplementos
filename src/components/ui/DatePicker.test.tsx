import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
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
    fireEvent.mouseDown(nextBtn);
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
  it('enforces inclusive bounds for days, month navigation and shortcuts', () => {
    const onChange=vi.fn();
    render(<DatePicker value="2026-09-16" minDate="2026-09-15" maxDate="2026-09-17" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('datepicker-trigger'));
    expect(screen.getByRole('button',{name:/14 septiembre 2026/})).toBeDisabled();
    expect(screen.getByRole('button',{name:/18 septiembre 2026/})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Mes anterior'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Mes siguiente'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:/18 septiembre 2026/}));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:/15 septiembre 2026/}));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-09-15');
  });
  it('selecting a leap day through custom year/month lists preserves the exact calendar date', () => {
    const onChange=vi.fn();
    render(<DatePicker value="2026-09-15" showMonthYearControls minDate="2000-01-01" maxDate="2100-12-31" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('datepicker-trigger'));
    const calendar=screen.getByRole('dialog',{name:'Elegir fecha'});
    fireEvent.click(within(calendar).getByRole('button',{name:'Año del calendario'}));
    fireEvent.click(screen.getByRole('option',{name:'2028'}));
    fireEvent.click(within(calendar).getByRole('button',{name:'Mes del calendario'}));
    fireEvent.click(screen.getByRole('option',{name:'febrero'}));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(calendar).getByRole('button',{name:/29 febrero 2028/}));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2028-02-29');
  });
  it('discarding a fast navigation into another month reopens at the saved day without committing', async () => {
    const onChange=vi.fn();
    render(<DatePicker value="2028-02-29" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('datepicker-trigger'));
    fireEvent.keyDown(screen.getByRole('button',{name:/29 febrero 2028/}),{key:'ArrowDown'});
    fireEvent.keyDown(window,{key:'Escape'});
    fireEvent.click(screen.getByTestId('datepicker-trigger'));
    await waitFor(()=>expect(screen.getByRole('button',{name:/29 febrero 2028/})).toHaveFocus());
    expect(onChange).not.toHaveBeenCalled();
  });
});
