import type { StockMovement } from './types';

export function stockMovementEffect(movement: Pick<StockMovement, 'physicalDelta' | 'reservedDelta'> & Partial<Pick<StockMovement, 'kind' | 'reason'>>): {
  label: string; detail: string; tone: 'neutral' | 'positive' | 'negative'; title?: string;
} {
  const physical = movement.physicalDelta;
  const reserved = movement.reservedDelta;
  const units = (n: number) => `${Math.abs(n)} ${Math.abs(n) === 1 ? 'unidad' : 'unidades'}`;
  if (physical === 0 && movement.kind === 'reservation_release' && movement.reason?.startsWith('Corrección automática de historial ·')) {
    return { label: 'Historial corregido', detail: 'Stock y reservas actuales sin cambios', tone: 'neutral', title: 'Corrección de historial' };
  }
  if (physical === 0 && reserved !== 0) return {
    label: `${units(reserved)} ${reserved > 0 ? (reserved === 1 ? 'apartada' : 'apartadas') : (reserved === -1 ? 'liberada' : 'liberadas')}`,
    detail: 'Stock físico sin cambios',
    tone: 'neutral' as const
  };
  if (physical !== 0) return {
    label: `${units(physical)} ${physical > 0 ? (physical === 1 ? 'ingresada' : 'ingresadas') : (physical === -1 ? 'retirada' : 'retiradas')}`,
    detail: reserved === 0 ? 'Reservas sin cambios' : `${units(reserved)} ${reserved > 0 ? (reserved === 1 ? 'apartada' : 'apartadas') : (reserved === -1 ? 'descontada de las reservas' : 'descontadas de las reservas')}`,
    tone: physical > 0 ? 'positive' as const : 'negative' as const
  };
  return { label: 'Sin cambio de cantidades', detail: 'Stock físico y reservas sin cambios', tone: 'neutral' as const };
}
