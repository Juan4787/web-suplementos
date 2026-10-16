import { expect, it } from 'vitest';
import { stockMovementEffect } from './stock-movement';

it.each([
  [0, 2, '2 unidades apartadas', 'Stock físico sin cambios', 'neutral'],
  [0, -1, '1 unidad liberada', 'Stock físico sin cambios', 'neutral'],
  [1, 0, '1 unidad ingresada', 'Reservas sin cambios', 'positive'],
  [-2, -2, '2 unidades retiradas', '2 unidades descontadas de las reservas', 'negative'],
  [2, 2, '2 unidades ingresadas', '2 unidades apartadas', 'positive'],
  [0, 0, 'Sin cambio de cantidades', 'Stock físico y reservas sin cambios', 'neutral']
] as const)('explica el efecto físico y de reservas sin mezclarlo (%s, %s)', (physicalDelta, reservedDelta, label, detail, tone) => {
  expect(stockMovementEffect({ physicalDelta, reservedDelta })).toEqual({ label, detail, tone });
});

it('una corrección histórica no se presenta como stock recién liberado', () => {
  expect(stockMovementEffect({ physicalDelta: 0, reservedDelta: -1, kind: 'reservation_release', reason: 'Corrección automática de historial · Pedido #2413 ya cancelado.' }))
    .toMatchObject({ label: 'Historial corregido', detail: 'Stock y reservas actuales sin cambios', tone: 'neutral' });
});
