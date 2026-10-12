import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

describe('Select component with search', () => {
  afterEach(cleanup);

  const products = [
    { id: '1', name: 'ACID SUPPORT', presentation: '60 CAPS' },
    { id: '2', name: 'ANDRO SUPPORT', presentation: '30 CAPS' },
    { id: '3', name: 'B COMPLEX ACTIVE', presentation: '30 CAPS' },
    { id: '4', name: 'CLIMATERIC SUPPORT', presentation: '30 CAPS' },
    { id: '5', name: 'COLAGENO HIDROLIZADO', presentation: '300 GRS' },
    { id: '6', name: 'CREATINA CREAPURE', presentation: '250 GRS' },
    { id: '7', name: 'OMEGA 3 ULTRA', presentation: '120 CAPS' },
    { id: '8', name: 'PROTEINA ISOLATE', presentation: '1 KG' }
  ];

  it('filters options when typing a product name with JSX array children (e.g. COLAGENO)', () => {
    const { container, getByPlaceholderText, getByText, queryByText } = render(
      <Select placeholder="Seleccionar producto…">
        <option value="">Seleccionar producto…</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} {p.presentation ? `(${p.presentation})` : ''}
          </option>
        ))}
      </Select>
    );

    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);

    const searchInput = getByPlaceholderText('Buscar opción…');
    expect(searchInput).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'COLAGENO' } });

    expect(getByText('COLAGENO HIDROLIZADO (300 GRS)')).toBeInTheDocument();
    expect(queryByText('ACID SUPPORT (60 CAPS)')).not.toBeInTheDocument();
  });

  it('supports accent-insensitive search (e.g. colágeno matches COLAGENO)', () => {
    const { container, getByPlaceholderText, getByText } = render(
      <Select placeholder="Seleccionar producto…">
        <option value="">Seleccionar producto…</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} {p.presentation ? `(${p.presentation})` : ''}
          </option>
        ))}
      </Select>
    );

    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);

    const searchInput = getByPlaceholderText('Buscar opción…');
    fireEvent.change(searchInput, { target: { value: 'colágeno' } });

    expect(getByText('COLAGENO HIDROLIZADO (300 GRS)')).toBeInTheDocument();
  });

  it('selects option and triggers onChange with correct value', () => {
    const handleChange = vi.fn();
    const { container, getByText } = render(
      <Select onChange={handleChange} placeholder="Seleccionar producto…">
        <option value="">Seleccionar producto…</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} {p.presentation ? `(${p.presentation})` : ''}
          </option>
        ))}
      </Select>
    );

    const trigger = container.querySelector('button')!;
    fireEvent.click(trigger);

    const option = getByText('ANDRO SUPPORT (30 CAPS)');
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(handleChange).toHaveBeenCalledWith({
      target: { value: '2', name: undefined }
    });
  });
  it('navigates enabled options without committing; Escape preserves the value and focus', async () => {
    const onChange=vi.fn();
    render(<Select aria-label="Producto" value="a" onChange={onChange} options={[
      {value:'a',label:'Primero'},{value:'b',label:'Agotado',disabled:true},{value:'c',label:'Tercero'}]} />);
    const trigger=screen.getByRole('button',{name:'Producto'});
    fireEvent.keyDown(trigger,{key:'ArrowDown'});
    await waitFor(()=>expect(screen.getByRole('option',{name:'Primero'})).toHaveFocus());
    fireEvent.keyDown(document.activeElement!,{key:'ArrowDown'});
    expect(screen.getByRole('option',{name:'Tercero'})).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!,{key:'Home'});
    expect(screen.getByRole('option',{name:'Primero'})).toHaveFocus();
    fireEvent.keyDown(document.activeElement!,{key:'Escape'});
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('blocks a portalled selection if its enclosing form becomes disabled', () => {
    const onChange=vi.fn();
    const view=render(<fieldset><Select aria-label="Producto" value="a" onChange={onChange}
      options={[{value:'a',label:'Primero'},{value:'c',label:'Tercero'}]} /></fieldset>);
    fireEvent.click(screen.getByRole('button',{name:'Producto'}));
    view.rerender(<fieldset disabled><Select aria-label="Producto" value="a" onChange={onChange}
      options={[{value:'a',label:'Primero'},{value:'c',label:'Tercero'}]} /></fieldset>);
    fireEvent.click(screen.getByRole('option',{name:'Tercero'}));
    expect(onChange).not.toHaveBeenCalled();
  });
  it('explains a disabled control in the app instead of a browser tooltip', () => {
    render(<Select aria-label="Rol" disabled title="No podés cambiar tu propio rol." options={[]} />);
    const trigger=screen.getByRole('button',{name:'Rol'});
    expect(trigger).not.toHaveAttribute('title');
    expect(trigger).toHaveAccessibleDescription('No podés cambiar tu propio rol.');
    expect(screen.getByText('No podés cambiar tu propio rol.')).toBeVisible();
  });
});
