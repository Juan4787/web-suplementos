import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProductImage } from './ProductImage';

afterEach(cleanup);
it('recupera una imagen rota una sola vez y permite cargar una imagen nueva', () => {
  const { rerender } = render(<ProductImage src="/missing.webp" alt="Creatina" />);
  const img = screen.getByRole('img');
  fireEvent.error(img);
  expect(img).toHaveAttribute('src', '/product-placeholder.svg');
  fireEvent.error(img);
  expect(img).toHaveAttribute('src', '/product-placeholder.svg');
  rerender(<ProductImage src="/replaced.webp" alt="Creatina" />);
  expect(img).toHaveAttribute('src', '/replaced.webp');
});
