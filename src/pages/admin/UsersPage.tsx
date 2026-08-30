import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Crown, Shield, UserCog } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Select } from '@/components/ui/Field';
import { StatusChip } from '@/components/ui/StatusChip';
import type { UserRole } from '@/domain/types';
import { getBusinessApi } from '@/services/business-api';
import { useBusinessQuery } from '@/app/use-business-query';

export default function UsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useBusinessQuery({ queryKey: ['store-users'], queryFn: (api) => api.listUsers() });
  const [draftRoles, setDraftRoles] = useState<Record<string, UserRole>>({});
  const [draftActive, setDraftActive] = useState<Record<string, boolean>>({});
  const update = useMutation({
    mutationFn: async ({ id, role, active }: { id: string; role: UserRole; active: boolean }) =>
      (await getBusinessApi()).updateUserAccess(id, role, active),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['store-users'] }); }
  });
  return (
    <RoleGate capability="manage_users">
      <div className="page-enter">
        <PageHeader title="Usuarios y permisos" description="Los permisos viven en la base y se vuelven a comprobar en cada operación sensible." />
        {usersQuery.isPending ? <LoadingState label="Comprobando accesos…" /> : null}
        {usersQuery.isError ? <ErrorState error={usersQuery.error} onRetry={() => void usersQuery.refetch()} /> : null}
        {update.error ? <div className="mb-5"><ErrorState error={update.error} /></div> : null}
        <div className="space-y-4">{usersQuery.data?.map((user) => {
          const role = draftRoles[user.id] ?? user.role;
          const active = draftActive[user.id] ?? user.active;
          const changed = role !== user.role || active !== user.active;
          return <article key={user.id} className="grid gap-4 rounded-[1.75rem] bg-white p-5 shadow-card sm:grid-cols-[auto_1fr_12rem_10rem_auto] sm:items-center sm:p-6"><span className={`grid size-12 place-items-center rounded-2xl ${user.role === 'owner' ? 'bg-brand-600 text-white' : 'bg-cream-100 text-ink-800'}`}>{user.role === 'owner' ? <Crown className="size-5" /> : <UserCog className="size-5" />}</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-black">{user.displayName}</h2><StatusChip label={user.role === 'owner' ? 'Dueña' : 'Personal'} tone={user.role === 'owner' ? 'success' : 'neutral'} /><StatusChip label={user.active ? 'Habilitada' : 'Pendiente'} tone={user.active ? 'success' : 'warning'} /></div><p className="mt-1 text-sm text-ink-600">{user.email}</p></div><Select aria-label={`Rol de ${user.displayName}`} value={role} onChange={(event) => setDraftRoles((current) => ({ ...current, [user.id]: event.target.value as UserRole }))}><option value="owner">Dueña</option><option value="staff">Personal</option></Select><Select aria-label={`Acceso de ${user.displayName}`} value={active ? 'active' : 'inactive'} onChange={(event) => setDraftActive((current) => ({ ...current, [user.id]: event.target.value === 'active' }))}><option value="active">Habilitada</option><option value="inactive">Deshabilitada</option></Select><Button size="sm" variant="primary" disabled={!changed} loading={update.isPending && update.variables?.id === user.id} onClick={() => update.mutate({ id: user.id, role, active })}>Guardar</Button></article>;
        })}</div>
        <section className="mt-7 grid gap-4 md:grid-cols-2"><div className="rounded-[1.75rem] bg-ink-950 p-6 text-white"><Crown className="size-6 text-brand-300" /><h2 className="mt-4 font-display text-2xl font-black">Dueña</h2><p className="mt-2 text-sm leading-6 text-white/60">Opera, ve costos y analíticas, exporta, usa IA, configura la tienda y administra permisos.</p></div><div className="rounded-[1.75rem] bg-white p-6 shadow-card"><Shield className="size-6 text-brand-600" /><h2 className="mt-4 font-display text-2xl font-black">Personal</h2><p className="mt-2 text-sm leading-6 text-ink-600">Gestiona catálogo público, stock y pedidos. La base no le entrega costos, margen, facturación, exportaciones ni datos de IA.</p></div></section>
        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">Alta inicial: la persona debe existir primero en Supabase Auth. Después la dueña puede asignar su rol. No se envían SMS ni se incorpora un proveedor pago.</p>
      </div>
    </RoleGate>
  );
}
