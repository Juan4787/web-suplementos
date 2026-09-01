import { CheckCircle2, DatabaseBackup, FileSpreadsheet, HardDriveDownload, ImageOff, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { getBusinessApi } from '@/services/business-api';

type Phase = 'idle' | 'fetching' | 'transforming' | 'writing' | 'done';

export default function ExportPage() {
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
    idle: 'Preparar respaldo', fetching: 'Reuniendo datos autorizados…', transforming: 'Ordenando hojas y relaciones…', writing: 'Creando el archivo Excel…', done: 'Descargar otro respaldo'
  };
  return (
    <RoleGate capability="export_data">
      <div className="page-enter">
        <PageHeader title="Exportar todos mis datos" description="Una planilla de Excel completa con todos tus datos de productos, stock, ventas, compras y clientes." />
        <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
          <section className="rounded-[2rem] bg-white p-6 shadow-card sm:p-8">
            <span className="grid size-14 place-items-center rounded-[1.25rem] bg-brand-100 text-brand-700"><FileSpreadsheet className="size-7" /></span>
            <h2 className="mt-6 font-display text-3xl font-black">Un archivo. Trece hojas.</h2>
            <p className="mt-3 max-w-2xl leading-7 text-ink-600">La planilla organiza cada área en su propia hoja con valores históricos y formato limpio para que puedas abrirla en Excel sin errores.</p>
            <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{['Resumen', 'Productos', 'Stock', 'Pedidos', 'Detalle pedidos', 'Ventas', 'Compras', 'Detalle compras', 'Movimientos', 'Reservas', 'Clientes', 'Inflación oficial', 'Usuarios'].map((sheet) => <div key={sheet} className="flex items-center gap-2 rounded-2xl bg-cream-100 px-4 py-3 text-sm font-bold"><CheckCircle2 className="size-4 text-brand-600" /> {sheet}</div>)}</div>
            {error ? <div className="mt-6"><ErrorState error={error} /></div> : null}
            {phase === 'done' ? <div className="mt-6 rounded-2xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">El respaldo se creó correctamente{lastSize ? ` (${new Intl.NumberFormat('es-AR').format(Math.ceil(lastSize / 1024))} KB)` : ''}. Guardalo en un lugar seguro.</div> : null}
            <Button className="mt-7" size="lg" loading={busy} onClick={() => void exportData()}><HardDriveDownload className="size-5" /> {phaseLabel[phase]}</Button>
            <p className="mt-3 text-xs leading-5 text-ink-600">Exportar es una operación de lectura: no borra ni modifica datos.</p>
          </section>
          <aside className="space-y-5">
            <section className="rounded-[1.75rem] bg-ink-950 p-5 text-white"><ShieldCheck className="size-6 text-brand-300" /><h2 className="mt-4 font-display text-xl font-black">Acceso protegido</h2><p className="mt-2 text-sm leading-6 text-white/60">Solo la dueña tiene acceso para descargar los costos y datos financieros de la tienda.</p></section>
            <section className="rounded-[1.75rem] border border-amber-200 bg-amber-50 p-5"><ImageOff className="size-6 text-amber-800" /><h2 className="mt-4 font-display text-xl font-black">Qué no incluye</h2><p className="mt-2 text-sm leading-6 text-amber-950/70">Descarga los registros comerciales en Excel. No incluye los archivos pesados de fotos ni claves internas del sistema.</p></section>
          </aside>
        </div>
      </div>
    </RoleGate>
  );
}
