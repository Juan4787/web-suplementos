import { cleanup, fireEvent, render } from '@testing-library/react';
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
    fireEvent.click(option);

    expect(handleChange).toHaveBeenCalledWith({
      target: { value: '2', name: undefined }
    });
  });
});
