import { Check } from 'lucide-react';
import { StatusChip } from '@/components/ui/StatusChip';
import type { Order } from '@/domain/types';

export function OrderStatus({ order, compact = false }: { order: Order; compact?: boolean }) {
  if (order.orderState === 'cancelled') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label="Cancelado" tone="danger" />
      </div>
    );
  }

  // Estado completado: chip discreto y suave pero perfectamente legible
  if (order.fulfillmentState === 'delivered' && order.paymentState === 'paid') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-300 px-3 py-1 text-[13.5px] font-black text-emerald-800 select-none">
          <Check className="size-4" /> Completado
        </span>
      </div>
    );
  }

  const chips = [];

  // 1. Estado de Entrega
  if (order.fulfillmentState === 'delivered') {
    chips.push(<StatusChip key="deliv" label="Entregado" tone="success" />);
  } else if (order.fulfillmentState === 'shipped') {
    chips.push(<StatusChip key="ship" label="Enviado" tone="info" />);
  } else {
    chips.push(<StatusChip key="deliv-pend" label="Falta entregar" tone="warning" />);
  }

  // 2. Estado de Cobro
  if (order.paymentState === 'paid') {
    chips.push(<StatusChip key="paid" label="Cobrado" tone="success" />);
  } else if (order.paymentState === 'refunded') {
    chips.push(<StatusChip key="ref" label="Reintegrado" tone="neutral" />);
  } else {
    chips.push(<StatusChip key="pay" label="Pago pendiente" tone="warning" />);
  }

  // 3. Estado de Stock / Reposición
  if (order.stockReadiness === 'waiting_incoming') {
    const etaFormatted = order.expectedArrivalAt
      ? ` · ${new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit' }).format(new Date(order.expectedArrivalAt))}`
      : '';
    chips.push(<StatusChip key="stock-incoming" label={`En camino${etaFormatted}`} tone="info" />);
  } else if (order.stockReadiness === 'uncovered') {
    chips.push(<StatusChip key="stock-uncovered" label="Faltante proveedor" tone="danger" />);
  }

  return <div className="flex flex-wrap items-center gap-2">{chips}</div>;
}
