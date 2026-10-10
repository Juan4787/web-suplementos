import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrencyInput } from './CurrencyInput';
afterEach(cleanup);
describe('pesos enteros para envío', () => {
  it.each(['-15.000','+15000','15.000,50','15.50','abc','1e3','1..000'])('rechaza pegar %s sin cambiar el monto guardado', text => {
    const onChange=vi.fn();render(<CurrencyInput aria-label="Envío" wholePesosOnly value={12500} onChange={onChange} />);
    fireEvent.paste(screen.getByRole('textbox'),{clipboardData:{getData:()=>text}});
    expect(screen.getByRole('textbox')).toHaveValue('12.500');
    expect(onChange).not.toHaveBeenCalled();expect(screen.getByRole('status')).toHaveTextContent('sin letras, signos ni centavos');
  });
  it('formatea miles y admite borrar el campo opcional', () => {
    const onChange=vi.fn();render(<CurrencyInput aria-label="Envío" wholePesosOnly onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'15000'}});
    expect(screen.getByRole('textbox')).toHaveValue('15.000');expect(onChange).toHaveBeenLastCalledWith(15000);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:''}});
    expect(screen.getByRole('textbox')).toHaveValue('');expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
  it.each(['-','+','e',',','.','a'])('no admite la tecla %s', key => {
    render(<CurrencyInput aria-label="Envío" wholePesosOnly />);
    expect(fireEvent.keyDown(screen.getByRole('textbox'),{key})).toBe(false);
  });
  it('no convierte un importe negativo recibido por un evento en positivo', () => {
    const onChange=vi.fn();render(<CurrencyInput aria-label="Envío" wholePesosOnly value={12500} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'-15000'}});
    expect(onChange).not.toHaveBeenCalled();expect(screen.getByRole('textbox')).toHaveValue('12.500');
  });
  it('pega un importe con miles reemplazando la selección y conserva el cursor', () => {
    const onChange=vi.fn();render(<CurrencyInput aria-label="Envío" wholePesosOnly value={12500} onChange={onChange} />);
    const input=screen.getByRole('textbox') as HTMLInputElement;input.setSelectionRange(0,input.value.length);
    fireEvent.paste(input,{clipboardData:{getData:()=> ' 15.000 '}});
    expect(input).toHaveValue('15.000');expect(onChange).toHaveBeenLastCalledWith(15000);
    expect(input.selectionStart).toBe(6);
  });
});
