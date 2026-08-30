export const formatUnits = (count: number): string =>
  `${count} ${count === 1 ? 'unidad' : 'unidades'}`;

export const formatProducts = (count: number): string =>
  `${count} ${count === 1 ? 'producto' : 'productos'}`;
