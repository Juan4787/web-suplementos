import {
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Search,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Drawer } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney } from '@/domain/money';
import { can } from '@/domain/permissions';
import type { Customer } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';

export default function CustomersPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  const customersQuery = useBusinessQuery({
    queryKey: queryKeys.customers(page),
    queryFn: (api) => api.listCustomers(page, 30)
  });

  const ordersQuery = useBusinessQuery({
    queryKey: queryKeys.orders(1),
    queryFn: (api) => api.listOrders(1, 100)
  });

  const financial = can(user, 'view_financials');

  const filteredCustomers = useMemo(() => {
    const raw = customersQuery.data?.items ?? [];
    // Consolidar clientes duplicados por teléfono (si existe) o por nombre normalizado
    const customerMap = new Map<string, Customer>();

    for (const c of raw) {
      const key = c.phone && c.phone.trim() !== ''
        ? `phone:${c.phone.replace(/[^0-9]/g, '')}`
        : `name:${c.name.trim().toLowerCase()}`;

      const existing = customerMap.get(key);
      if (!existing) {
        customerMap.set(key, { ...c });
      } else {
        const isMoreRecent = new Date(c.lastOrderAt) > new Date(existing.lastOrderAt);
        const isEarlierFirst = new Date(c.firstOrderAt) < new Date(existing.firstOrderAt);

        customerMap.set(key, {
          ...existing,
          id: isMoreRecent ? c.id : existing.id,
          name: isMoreRecent ? c.name : existing.name,
          phone: existing.phone || c.phone,
          lastOrderAt: isMoreRecent ? c.lastOrderAt : existing.lastOrderAt,
          firstOrderAt: isEarlierFirst ? c.firstOrderAt : existing.firstOrderAt,
          orderCount: (existing.orderCount || 0) + (c.orderCount || 0),
          totalPaidCents:
            existing.totalPaidCents !== null || c.totalPaidCents !== null
              ? (existing.totalPaidCents ?? 0) + (c.totalPaidCents ?? 0)
              : null
        });
      }
    }

    const consolidated = Array.from(customerMap.values()).sort(
      (a, b) => new Date(b.lastOrderAt).getTime() - new Date(a.lastOrderAt).getTime()
    );

    if (!search.trim()) return consolidated;
    const term = search.toLowerCase();
    return consolidated.filter(
      (c) => c.name.toLowerCase().includes(term) || (c.phone ?? '').includes(term)
    );
  }, [customersQuery.data?.items, search]);

  const selectedCustomerOrders = useMemo(() => {
    if (!selectedCustomer) return [];
    return (ordersQuery.data?.items ?? []).filter(
      (o) =>
        (selectedCustomer.id && o.customerId === selectedCustomer.id) ||
        (selectedCustomer.phone && o.customerPhone && o.customerPhone === selectedCustomer.phone) ||
        (o.customerName &&
          selectedCustomer.name &&
          o.customerName.trim().toLowerCase() === selectedCustomer.name.trim().toLowerCase())
    );
  }, [selectedCustomer, ordersQuery.data?.items]);

  const selectedCustomerPhone = useMemo(() => {
    if (!selectedCustomer) return null;
    if (selectedCustomer.phone && selectedCustomer.phone.trim() !== '') {
      return selectedCustomer.phone;
    }
    const orderWithPhone = selectedCustomerOrders.find(
      (o) => Boolean(o.customerPhone && o.customerPhone.trim() !== '')
    );
    return orderWithPhone?.customerPhone ?? null;
  }, [selectedCustomer, selectedCustomerOrders]);

  const selectedCustomerFirstOrder = useMemo(() => {
    if (!selectedCustomer) return null;
    if (selectedCustomerOrders.length === 0) return selectedCustomer.firstOrderAt;
    return selectedCustomerOrders.reduce(
      (earliest, o) => (new Date(o.createdAt) < new Date(earliest) ? o.createdAt : earliest),
      selectedCustomer.firstOrderAt
    );
  }, [selectedCustomer, selectedCustomerOrders]);

  const selectedCustomerPendingOrders = useMemo(() => {
    return selectedCustomerOrders.filter(
      (o) => o.paymentState === 'pending' && o.orderState !== 'cancelled'
    );
  }, [selectedCustomerOrders]);

  const selectedCustomerPaidOrders = useMemo(() => {
    return selectedCustomerOrders.filter(
      (o) => o.paymentState === 'paid' && o.orderState !== 'cancelled'
    );
  }, [selectedCustomerOrders]);

  const selectedCustomerTotalPaidCents = useMemo(() => {
    if (!selectedCustomer) return 0;
    if (selectedCustomerOrders.length > 0) {
      return selectedCustomerPaidOrders.reduce((sum, o) => sum + o.totalCents, 0);
    }
    return selectedCustomer.totalPaidCents ?? 0;
  }, [selectedCustomer, selectedCustomerOrders.length, selectedCustomerPaidOrders]);

  const selectedCustomerOrderCount = useMemo(() => {
    if (!selectedCustomer) return 0;
    if (selectedCustomerOrders.length > 0) {
      const nonCancelled = selectedCustomerOrders.filter((o) => o.orderState !== 'cancelled');
      return nonCancelled.length > 0 ? nonCancelled.length : selectedCustomerOrders.length;
    }
    return selectedCustomer.orderCount;
  }, [selectedCustomer, selectedCustomerOrders]);

  return (
    <div className="page-enter">
      <PageHeader
        title="Clientes"
        description="Consultá datos e historial de pedidos de cada cliente."
      />

      {/* Buscador de clientes ergonómico */}
      <div className="mb-6 max-w-sm">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar cliente o teléfono…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-4 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {customersQuery.isPending ? <LoadingState label="Cargando clientes…" /> : null}
      {customersQuery.isError ? (
        <ErrorState error={customersQuery.error} onRetry={() => void customersQuery.refetch()} />
      ) : null}

      {customersQuery.data ? (
        <>
          <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
            <div className="hidden grid-cols-[1.5fr_1.2fr_1fr_1fr_2rem] gap-4 border-b border-ink-950/8 bg-cream-50/80 px-6 py-3.5 text-[13.5px] font-black uppercase tracking-wider text-ink-700 sm:grid">
              <span>Cliente</span>
              <span>Teléfono</span>
              <span>Último pedido</span>
              <span>Estado</span>
              <span></span>
            </div>

            <div className="divide-y divide-ink-950/6">
              {filteredCustomers.map((customer) => {
                const customerOrders = (ordersQuery.data?.items ?? []).filter(
                  (o) =>
                    o.customerId === customer.id ||
                    o.customerName.toLowerCase() === customer.name.toLowerCase()
                );
                const hasPending = customerOrders.some(
                  (o) => o.paymentState === 'pending' && o.orderState !== 'cancelled'
                );

                return (
                  <article
                    key={customer.id}
                    onClick={() => setSelectedCustomer(customer)}
                    className="grid min-h-[3.75rem] cursor-pointer gap-3 p-4 transition hover:bg-cream-50/80 sm:grid-cols-[1.5fr_1.2fr_1fr_1fr_2rem] sm:items-center sm:px-6 sm:py-3.5"
                  >
                    <div>
                      <h3 className="text-[16px] font-black text-ink-950">{customer.name}</h3>
                      <span className="text-[14px] text-ink-700 font-semibold sm:hidden">
                        {customer.phone ?? 'Sin teléfono'}
                      </span>
                    </div>

                    <div className="hidden sm:block text-[15px] font-bold text-ink-800">
                      {customer.phone ? (
                        <span>{customer.phone}</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </div>

                    <div className="text-[14.5px] font-semibold text-ink-800">
                      <span className="sm:hidden text-ink-600 font-bold">Último: </span>
                      {new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' }).format(
                        new Date(customer.lastOrderAt)
                      )}
                    </div>

                    <div>
                      {hasPending ? (
                        <StatusChip label="Pago pendiente" tone="warning" />
                      ) : null}
                    </div>

                    <div className="flex items-center justify-end text-ink-400">
                      <ChevronRight className="size-5" />
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          {filteredCustomers.length === 0 ? (
            <div className="rounded-2xl border border-ink-950/8 bg-white p-8 text-center text-sm font-semibold text-ink-600 shadow-sm">
              No hay clientes que coincidan con la búsqueda.
            </div>
          ) : null}

          {customersQuery.data.total > customersQuery.data.pageSize ? (
            <nav
              className="mt-5 flex items-center justify-between rounded-xl border border-ink-950/8 bg-white p-3.5 shadow-sm"
              aria-label="Páginas de clientes"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft className="size-4" /> Anterior
              </Button>
              <span className="text-sm font-bold text-ink-700">
                Página {page} de {Math.ceil(customersQuery.data.total / customersQuery.data.pageSize)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page * customersQuery.data.pageSize >= customersQuery.data.total}
                onClick={() => setPage((current) => current + 1)}
              >
                Siguiente <ChevronRight className="size-4" />
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}

      {/* DRAWER: Overlay real de viewport con tipografía de alto contraste */}
      {selectedCustomer ? (
        <Drawer isOpen={true} onClose={() => setSelectedCustomer(null)} ariaLabelledBy="customer-drawer-title">
          <div className="flex items-start justify-between">
            <div>
              <h2
                id="customer-drawer-title"
                className="font-display text-2xl font-black text-ink-950"
              >
                {selectedCustomer.name}
              </h2>
                <p className="mt-1 text-[14.5px] font-bold text-ink-700">
                  Cliente desde {new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(
                    new Date(selectedCustomerFirstOrder ?? selectedCustomer.firstOrderAt)
                  )}
                </p>
              </div>
              <button
                className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition"
                onClick={() => setSelectedCustomer(null)}
                aria-label="Cerrar panel"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="mt-6 space-y-5 flex-1">
              {/* Bloque: Contacto y WhatsApp */}
              <div className="rounded-2xl bg-cream-50 p-5 border border-ink-950/6 space-y-3">
                <h4 className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">Datos</h4>
                <div className="text-[14.5px] space-y-1.5 font-semibold text-ink-900">
                  <p>
                    <span className="text-ink-600">Teléfono:</span>{' '}
                    {selectedCustomerPhone ?? 'Sin registrar'}
                  </p>
                </div>

                {selectedCustomerPhone ? (
                  <div className="pt-1.5">
                    <a
                      href={buildWhatsAppUrl(
                        selectedCustomerPhone,
                        `Hola ${selectedCustomer.name}, te escribimos de Impulso Suplementos.`
                      )}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-[14px] font-black text-white shadow-sm hover:bg-emerald-700 transition"
                    >
                      <MessageCircle className="size-4" /> Abrir WhatsApp
                    </a>
                  </div>
                ) : null}
              </div>

              {/* Bloque: Pagos pendientes */}
              <div className="rounded-2xl border border-ink-950/8 bg-white p-5 space-y-2.5">
                <h4 className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">
                  Pagos pendientes
                </h4>

                {selectedCustomerPendingOrders.length === 0 ? (
                  <div className="rounded-xl bg-emerald-50 p-3.5 border border-emerald-200/80 text-[14px] font-bold text-emerald-900">
                    ✓ Al día · Sin pagos pendientes
                  </div>
                ) : (
                  <div className="rounded-xl bg-amber-50 p-3.5 border border-amber-200/80 text-[14px] space-y-1">
                    <p className="font-black text-amber-900">
                      {selectedCustomerPendingOrders.length === 1
                        ? '1 pedido pendiente'
                        : `${selectedCustomerPendingOrders.length} pedidos pendientes`} · {formatMoney(
                        selectedCustomerPendingOrders.reduce((sum, o) => sum + o.totalCents, 0)
                      )}
                    </p>
                    <p className="text-amber-800 font-semibold text-xs">
                      {selectedCustomerPendingOrders.map((o) => `#${o.number}`).join(', ')} (pendiente de cobro)
                    </p>
                  </div>
                )}
              </div>

              {/* Bloque: Pedidos */}
              <div className="rounded-2xl border border-ink-950/8 bg-white p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">
                    Pedidos
                  </h4>
                  <span className="text-sm font-bold text-ink-700">
                    {selectedCustomerOrderCount}{' '}
                    {selectedCustomerOrderCount === 1 ? 'pedido' : 'pedidos'}
                  </span>
                </div>

                {financial ? (
                  <div className="rounded-xl bg-cream-50 p-3.5 border border-ink-950/6 text-[14px] flex justify-between items-center">
                    <span className="font-bold text-ink-700">Total cobrado:</span>
                    <strong className="font-display text-lg font-black text-ink-950">
                      {formatMoney(selectedCustomerTotalPaidCents)}
                    </strong>
                  </div>
                ) : null}

                <div className="space-y-2 pt-1">
                  {selectedCustomerOrders.map((ord) => (
                    <div
                      key={ord.id}
                      className="flex items-center justify-between rounded-xl bg-cream-50 p-3 text-[14px]"
                    >
                      <div>
                        <p className="font-bold text-ink-950">Pedido #{ord.number}</p>
                        <p className="text-[13px] text-ink-600 font-medium">
                          {new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' }).format(
                            new Date(ord.createdAt)
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <strong className="font-black text-ink-950">
                          {formatMoney(ord.totalCents)}
                        </strong>
                        <p className="text-[12px] font-bold">
                          {ord.orderState === 'cancelled' ? (
                            <span className="text-rose-600">Cancelado</span>
                          ) : ord.paymentState === 'paid' ? (
                            <span className="text-emerald-700">Pagado</span>
                          ) : ord.paymentState === 'refunded' ? (
                            <span className="text-amber-700">Reintegrado</span>
                          ) : (
                            <span className="text-amber-600">Pendiente</span>
                          )}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-8 flex justify-end border-t border-ink-950/8 pt-4">
              <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(null)}>
                Cerrar
              </Button>
            </div>
        </Drawer>
      ) : null}
    </div>
  );
}
