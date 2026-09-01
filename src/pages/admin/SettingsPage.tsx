import {
  Banknote,
  Check,
  CheckCircle2,
  Crown,
  DatabaseBackup,
  ExternalLink,
  FileSpreadsheet,
  HardDriveDownload,
  ImageOff,
  MessageCircle,
  Save,
  Shield,
  ShieldCheck,
  Store,
  TrendingUp,
  Truck,
  UserCog,
  Users
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { DatePicker, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { StatusChip } from '@/components/ui/StatusChip';
import { Toast } from '@/components/ui/Toast';
import { sanitizeDecimalInput, sanitizeIntegerInput } from '@/domain/inventory';
import type { StoreSettings, UserRole } from '@/domain/types';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

type DraftSettings = {
  storeName: string;
  tagline: string;
  whatsappPhone: string;
  transferAlias: string;
  transferAccount: string;
  standardShippingPesosStr: string;
  expressShippingPesosStr: string;
  taxRatePercentStr: string;
};

type Phase = 'idle' | 'fetching' | 'transforming' | 'writing' | 'done';

const toDraft = (settings: StoreSettings): DraftSettings => ({
  storeName: settings.storeName,
  tagline: settings.tagline,
  whatsappPhone: settings.whatsappPhone,
  transferAlias: settings.transferAlias,
  transferAccount: settings.transferAccount,
  standardShippingPesosStr:
    settings.standardShippingCents > 0
      ? String(settings.standardShippingCents / 100)
      : '',
  expressShippingPesosStr:
    settings.expressShippingCents > 0
      ? String(settings.expressShippingCents / 100)
      : '',
  taxRatePercentStr:
    settings.taxRateBasisPoints > 0
      ? String(settings.taxRateBasisPoints / 100)
      : ''
});

function InflationTab({
  onNotify
}: {
  onNotify?: (title: string, description?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [indexValue, setIndexValue] = useState('');
  const [sourceUrl, setSourceUrl] = useState('https://www.indec.gob.ar/');
  const [publishedAt, setPublishedAt] = useState(new Date().toISOString().slice(0, 10));
  const [justSaved, setJustSaved] = useState(false);

  const indicesQuery = useBusinessQuery({
    queryKey: queryKeys.inflation,
    queryFn: (api) => api.listInflationIndices()
  });

  const saveIndex = useMutation({
    mutationFn: async () => {
      const api = await getBusinessApi();
      return api.saveInflationIndex({
        period: `${period}-01`,
        indexValue: Number(indexValue),
        sourceUrl: sourceUrl.trim(),
        publishedAt: new Date(publishedAt).toISOString()
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.inflation });
      const val = Number(indexValue).toFixed(2);
      const per = period;
      setIndexValue('');
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 3000);
      onNotify?.(
        'Índice de inflación registrado',
        `Se guardó el valor ${val} correspondiente al período ${per}.`
      );
    }
  });

  return (
    <section className="mt-8 rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <TrendingUp className="size-5" />
        </span>
        <div>
          <h3 className="font-display text-xl font-black text-ink-950">Inflación oficial (INDEC)</h3>
          <p className="text-xs text-ink-600">
            Cargá el índice del mes para que los gráficos de Analíticas calculen la facturación en poder de compra real.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Período">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label="Valor del índice">
          <Input
            placeholder="Ej: 5824.2"
            value={indexValue}
            inputMode="decimal"
            onFocus={(e) => e.target.select()}
            onChange={(e) => setIndexValue(sanitizeDecimalInput(e.target.value, indexValue))}
          />
        </Field>
        <Field label="Publicado">
          <DatePicker value={publishedAt} onChange={(val) => setPublishedAt(val)} />
        </Field>
        <Field label="Fuente oficial">
          <Input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </Field>
      </div>

      {saveIndex.error ? <div className="mt-4"><ErrorState error={saveIndex.error} /></div> : null}

      <div className="mt-5 flex justify-end">
        <Button
          size="sm"
          disabled={!indexValue || Number.isNaN(Number(indexValue))}
          loading={saveIndex.isPending}
          className={cn(
            'transition-all duration-300',
            justSaved ? 'bg-emerald-600 hover:bg-emerald-600 text-white shadow-md' : ''
          )}
          onClick={() => saveIndex.mutate()}
        >
          {justSaved ? (
            <>
              <Check className="size-4 animate-in zoom-in" /> ¡Índice guardado!
            </>
          ) : (
            'Guardar índice'
          )}
        </Button>
      </div>

      <div className="mt-6 border-t border-ink-950/8 pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wider text-ink-600">Historial cargado</h4>
        <div className="mt-3 flex flex-wrap gap-2">
          {indicesQuery.data?.map((idx) => (
            <div key={idx.period} className="flex items-center gap-2 rounded-xl bg-cream-100 px-3 py-1.5 text-xs font-bold text-ink-950">
              <span>{idx.period.slice(0, 7)}:</span>
              <span className="text-brand-700 font-black">{idx.indexValue.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BackupsTab() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<unknown>(null);
  const [lastSize, setLastSize] = useState<number | null>(null);

  const exportData = async () => {
    setError(null);
    setPhase('fetching');
    try {
      const api = await getBusinessApi();
      const dataset = await api.getExportDataset();
      const { buildExport, downloadExport } = await import('@/features/export/export-client');
      const result = await buildExport(dataset, setPhase);
      downloadExport(result);
      setLastSize(result.byteLength);
      setPhase('done');
    } catch (caught) {
      setError(caught);
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle' && phase !== 'done';
  const phaseLabel: Record<Phase, string> = {
    idle: 'Descargar respaldo completo en Excel (.xlsx)',
    fetching: 'Reuniendo datos autorizados…',
    transforming: 'Ordenando hojas y relaciones…',
    writing: 'Generando archivo Excel…',
    done: 'Descargar otro respaldo'
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm sm:p-8">
        <span className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <FileSpreadsheet className="size-6" />
        </span>
        <h3 className="mt-4 font-display text-2xl font-black text-ink-950">Respaldo completo en Excel</h3>
        <p className="mt-2 text-sm text-ink-600 leading-relaxed">
          Descargá un archivo de Excel con 13 hojas que contiene toda tu información comercial (productos, stock, pedidos, ventas, compras, clientes e índices).
        </p>

        <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            'Resumen general',
            'Catálogo de productos',
            'Inventario y Stock',
            'Pedidos de clientes',
            'Detalle de pedidos',
            'Ventas cobradas',
            'Compras a proveedores',
            'Detalle de compras',
            'Movimientos físicos',
            'Reservas de stock',
            'Libreta de clientes',
            'Inflación oficial',
            'Usuarios y roles'
          ].map((sheet) => (
            <div key={sheet} className="flex items-center gap-2 rounded-xl bg-cream-50 p-2.5 text-xs font-bold text-ink-950 border border-ink-950/6">
              <CheckCircle2 className="size-3.5 text-brand-600 shrink-0" />
              <span className="truncate">{sheet}</span>
            </div>
          ))}
        </div>

        {error ? <div className="mt-5"><ErrorState error={error} /></div> : null}
        {phase === 'done' ? (
          <div className="mt-5 rounded-xl bg-emerald-50 p-3.5 text-xs font-bold text-emerald-800 border border-emerald-200">
            Respaldo generado correctamente{lastSize ? ` (${Math.ceil(lastSize / 1024)} KB)` : ''}.
          </div>
        ) : null}

        <div className="mt-6">
          <Button size="lg" loading={busy} onClick={() => void exportData()}>
            <HardDriveDownload className="size-5" /> {phaseLabel[phase]}
          </Button>
          <p className="mt-2 text-xs text-ink-600">Exportar es una operación de solo lectura: no altera ni borra información de la tienda.</p>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-2xl bg-ink-950 p-5 text-white">
          <ShieldCheck className="size-5 text-brand-300" />
          <h4 className="mt-3 font-display text-lg font-black">Acceso protegido</h4>
          <p className="mt-1 text-xs text-white/70 leading-5">
            Solo la Dueña puede descargar los datos financieros y costos. El rol de Personal no tiene acceso a esta sección.
          </p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
          <ImageOff className="size-5 text-amber-800" />
          <h4 className="mt-3 font-display text-lg font-black">Alcance del respaldo</h4>
          <p className="mt-1 text-xs text-amber-950/80 leading-5">
            El archivo exporta los registros comerciales en Excel. No incluye los archivos de imágenes ni claves del sistema.
          </p>
        </div>
      </aside>
    </section>
  );
}

function UsersTab({
  onNotify
}: {
  onNotify?: (title: string, description?: string) => void;
}) {
  const queryClient = useQueryClient();
  const usersQuery = useBusinessQuery({ queryKey: ['store-users'], queryFn: (api) => api.listUsers() });
  const [draftRoles, setDraftRoles] = useState<Record<string, UserRole>>({});
  const [draftActive, setDraftActive] = useState<Record<string, boolean>>({});
  const [savedUserIds, setSavedUserIds] = useState<Record<string, boolean>>({});

  const update = useMutation({
    mutationFn: async ({ id, role, active }: { id: string; role: UserRole; active: boolean }) =>
      (await getBusinessApi()).updateUserAccess(id, role, active),
    onSuccess: async (updatedUser) => {
      await queryClient.invalidateQueries({ queryKey: ['store-users'] });
      setSavedUserIds((prev) => ({ ...prev, [updatedUser.id]: true }));
      setTimeout(() => {
        setSavedUserIds((prev) => ({ ...prev, [updatedUser.id]: false }));
      }, 3000);
      onNotify?.(
        'Permisos actualizados',
        `Los accesos para ${updatedUser.displayName} (${updatedUser.role === 'owner' ? 'Dueña' : 'Personal'}) se guardaron correctamente.`
      );
    }
  });

  return (
    <section className="space-y-6">
      {usersQuery.isPending ? <LoadingState label="Consultando usuarios…" /> : null}
      {usersQuery.isError ? <ErrorState error={usersQuery.error} onRetry={() => void usersQuery.refetch()} /> : null}
      {update.error ? <ErrorState error={update.error} /> : null}

      <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
        <div className="divide-y divide-ink-950/6">
          {usersQuery.data?.map((user) => {
            const role = draftRoles[user.id] ?? user.role;
            const active = draftActive[user.id] ?? user.active;
            const changed = role !== user.role || active !== user.active;
            const isSaved = savedUserIds[user.id];
            return (
              <article key={user.id} className="grid gap-4 p-5 sm:grid-cols-[auto_1fr_10rem_10rem_auto] sm:items-center sm:px-6">
                <span className={cn('grid size-11 place-items-center rounded-xl', user.role === 'owner' ? 'bg-brand-600 text-white' : 'bg-cream-100 text-ink-800')}>
                  {user.role === 'owner' ? <Crown className="size-5" /> : <UserCog className="size-5" />}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-black text-ink-950">{user.displayName}</h4>
                    <span className="text-xs text-ink-600">({user.role === 'owner' ? 'Dueña' : 'Personal'})</span>
                  </div>
                  <p className="text-xs text-ink-600">{user.email}</p>
                </div>
                <Select
                  aria-label={`Rol de ${user.displayName}`}
                  value={role}
                  onChange={(e) => setDraftRoles((cur) => ({ ...cur, [user.id]: e.target.value as UserRole }))}
                >
                  <option value="owner">Dueña (Total)</option>
                  <option value="staff">Personal (Operativo)</option>
                </Select>
                <Select
                  aria-label={`Acceso de ${user.displayName}`}
                  value={active ? 'active' : 'inactive'}
                  onChange={(e) => setDraftActive((cur) => ({ ...cur, [user.id]: e.target.value === 'active' }))}
                >
                  <option value="active">Habilitada</option>
                  <option value="inactive">Deshabilitada</option>
                </Select>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!changed && !isSaved}
                  loading={update.isPending && update.variables?.id === user.id}
                  className={cn(
                    'transition-all duration-300 min-w-[5.5rem]',
                    isSaved ? 'bg-emerald-600 hover:bg-emerald-600 text-white shadow-md border-emerald-600' : ''
                  )}
                  onClick={() => update.mutate({ id: user.id, role, active })}
                >
                  {isSaved ? (
                    <>
                      <Check className="size-4 animate-in zoom-in" /> Guardado
                    </>
                  ) : (
                    'Guardar'
                  )}
                </Button>
              </article>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-ink-950 p-5 text-white">
          <Crown className="size-5 text-brand-300" />
          <h4 className="mt-3 font-display text-lg font-black">Rol Dueña</h4>
          <p className="mt-1 text-xs text-white/70 leading-5">
            Acceso irrestricto a costos, márgenes, facturación, analíticas, exportaciones, IA y configuración de tienda.
          </p>
        </div>
        <div className="rounded-2xl border border-ink-950/8 bg-white p-5">
          <Shield className="size-5 text-brand-600" />
          <h4 className="mt-3 font-display text-lg font-black">Rol Personal</h4>
          <p className="mt-1 text-xs text-ink-600 leading-5">
            Operación de catálogo, stock, pedidos y compras. El sistema oculta automáticamente los costos y datos financieros.
          </p>
        </div>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<'store' | 'backups' | 'users'>('store');
  const queryClient = useQueryClient();
  const settingsQuery = useBusinessQuery({
    queryKey: queryKeys.settings,
    queryFn: (api) => api.getSettings()
  });

  const [draft, setDraft] = useState<DraftSettings | null>(null);
  const [justSavedSettings, setJustSavedSettings] = useState(false);
  const [toast, setToast] = useState<{
    open: boolean;
    title: string;
    description?: string | undefined;
    variant?: 'success' | 'error' | 'info' | undefined;
  }>({
    open: false,
    title: ''
  });

  const showToast = (
    title: string,
    description?: string | undefined,
    variant: 'success' | 'error' | 'info' = 'success'
  ) => {
    setToast({ open: true, title, description, variant });
  };

  const closeToast = () => {
    setToast((prev) => ({ ...prev, open: false }));
  };

  useEffect(() => {
    if (settingsQuery.data && !draft) {
      setDraft(toDraft(settingsQuery.data));
    }
  }, [settingsQuery.data, draft]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const standardShippingPesos =
        draft.standardShippingPesosStr === '' ? 0 : parseFloat(draft.standardShippingPesosStr) || 0;
      const expressShippingPesos =
        draft.expressShippingPesosStr === '' ? 0 : parseFloat(draft.expressShippingPesosStr) || 0;
      const taxRatePercent =
        draft.taxRatePercentStr === '' ? 0 : parseFloat(draft.taxRatePercentStr) || 0;

      return (await getBusinessApi()).updateSettings({
        storeName: draft.storeName.trim(),
        tagline: draft.tagline.trim(),
        whatsappPhone: draft.whatsappPhone.trim(),
        transferAlias: draft.transferAlias.trim(),
        transferAccount: draft.transferAccount.trim(),
        standardShippingCents: Math.round(standardShippingPesos * 100),
        expressShippingCents: Math.round(expressShippingPesos * 100),
        taxRateBasisPoints: Math.round(taxRatePercent * 100),
        currency: 'ARS'
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      setJustSavedSettings(true);
      setTimeout(() => setJustSavedSettings(false), 3500);
      showToast(
        'Configuración guardada',
        'Los datos de la tienda, transferencias y tarifas de envío se actualizaron correctamente.'
      );
    },
    onError: () => {
      showToast(
        'Error al guardar',
        'No pudimos guardar los cambios. Revisá los datos e intentá de nuevo.',
        'error'
      );
    }
  });

  return (
    <RoleGate capability="manage_pricing">
      <div className="page-enter">
        <PageHeader
          title="Configuración"
          description="Ajustá los datos de tu tienda, tarifas de envío, respaldos de datos en Excel y permisos de usuarios."
        />

        {/* Tabs Bar */}
        <nav className="mb-6 flex gap-2 border-b border-ink-950/8 pb-3" aria-label="Secciones de Configuración">
          <button
            type="button"
            onClick={() => setActiveTab('store')}
            className={cn(
              'rounded-xl px-4 py-2 text-sm font-black transition',
              activeTab === 'store' ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:bg-white hover:text-ink-950'
            )}
          >
            Tienda & Inflación
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('backups')}
            className={cn(
              'rounded-xl px-4 py-2 text-sm font-black transition',
              activeTab === 'backups' ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:bg-white hover:text-ink-950'
            )}
          >
            Datos y Respaldo
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('users')}
            className={cn(
              'rounded-xl px-4 py-2 text-sm font-black transition',
              activeTab === 'users' ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-600 hover:bg-white hover:text-ink-950'
            )}
          >
            Usuarios y Accesos
          </button>
        </nav>

        {activeTab === 'store' ? (
          <div>
            {settingsQuery.isPending ? <LoadingState label="Cargando configuración…" /> : null}
            {settingsQuery.isError ? <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} /> : null}

            {draft ? (
              <div className="space-y-6">
                <section className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
                      <Store className="size-5" />
                    </span>
                    <div>
                      <h3 className="font-display text-xl font-black text-ink-950">Identidad de la tienda</h3>
                      <p className="text-xs text-ink-600">Nombre público y contacto comercial.</p>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="Nombre comercial">
                      <Input value={draft.storeName} onChange={(e) => setDraft({ ...draft, storeName: e.target.value })} />
                    </Field>
                    <Field label="WhatsApp de atención" hint="Formato internacional sin + (ej: 54911...)">
                      <Input value={draft.whatsappPhone} onChange={(e) => setDraft({ ...draft, whatsappPhone: e.target.value })} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="Slogan / Mensaje de cabecera">
                        <Input value={draft.tagline} onChange={(e) => setDraft({ ...draft, tagline: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
                      <Banknote className="size-5" />
                    </span>
                    <div>
                      <h3 className="font-display text-xl font-black text-ink-950">Datos bancarios para transferencias</h3>
                      <p className="text-xs text-ink-600">Datos visibles para el cliente al elegir pagar por transferencia.</p>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <Field label="Alias de transferencia">
                      <Input value={draft.transferAlias} onChange={(e) => setDraft({ ...draft, transferAlias: e.target.value })} />
                    </Field>
                    <Field label="CBU / CVU / Titular">
                      <Input value={draft.transferAccount} onChange={(e) => setDraft({ ...draft, transferAccount: e.target.value })} />
                    </Field>
                  </div>
                </section>

                <section className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
                      <Truck className="size-5" />
                    </span>
                    <div>
                      <h3 className="font-display text-xl font-black text-ink-950">Tarifas de entrega e impuestos</h3>
                      <p className="text-xs text-ink-600">Costos aplicados en el checkout.</p>
                    </div>
                  </div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-3">
                    <Field label="Envío estándar ($)">
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="0"
                        value={draft.standardShippingPesosStr}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => {
                          const clean = sanitizeIntegerInput(e.target.value, draft.standardShippingPesosStr);
                          setDraft({ ...draft, standardShippingPesosStr: clean });
                        }}
                      />
                    </Field>
                    <Field label="Envío express ($)">
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="0"
                        value={draft.expressShippingPesosStr}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => {
                          const clean = sanitizeIntegerInput(e.target.value, draft.expressShippingPesosStr);
                          setDraft({ ...draft, expressShippingPesosStr: clean });
                        }}
                      />
                    </Field>
                    <Field label="Tasa impositiva (%)">
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0"
                        value={draft.taxRatePercentStr}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => {
                          const clean = sanitizeDecimalInput(e.target.value, draft.taxRatePercentStr);
                          setDraft({ ...draft, taxRatePercentStr: clean });
                        }}
                      />
                    </Field>
                  </div>
                </section>

                {saveSettings.error ? <ErrorState error={saveSettings.error} /> : null}

                <div className="flex items-center justify-end gap-3 pt-2">
                  {justSavedSettings ? (
                    <span className="flex items-center gap-1.5 text-sm font-bold text-emerald-700 animate-in fade-in duration-200">
                      <CheckCircle2 className="size-4 text-emerald-600" />
                      Guardado correctamente
                    </span>
                  ) : null}
                  <Button
                    size="lg"
                    loading={saveSettings.isPending}
                    className={cn(
                      'transition-all duration-300 min-w-[14.5rem]',
                      justSavedSettings
                        ? 'bg-emerald-600 hover:bg-emerald-600 text-white shadow-[0_8px_24px_rgba(5,150,105,0.28)] border-emerald-600'
                        : 'shadow-[0_8px_24px_rgba(37,99,235,0.25)]'
                    )}
                    onClick={() => saveSettings.mutate()}
                  >
                    {justSavedSettings ? (
                      <>
                        <Check className="size-5 animate-in zoom-in-75 duration-200" />
                        ¡Cambios guardados con éxito!
                      </>
                    ) : (
                      <>
                        <Save className="size-5" />
                        Guardar cambios de tienda
                      </>
                    )}
                  </Button>
                </div>

                <InflationTab onNotify={showToast} />
              </div>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'backups' ? <BackupsTab /> : null}

        {activeTab === 'users' ? <UsersTab onNotify={showToast} /> : null}

        {/* Notificación Toast flotante con auto-cierre y botón X */}
        <Toast
          open={toast.open}
          onClose={closeToast}
          title={toast.title}
          description={toast.description}
          variant={toast.variant}
        />
      </div>
    </RoleGate>
  );
}
