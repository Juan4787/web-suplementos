import { Link } from '@tanstack/react-router';
import {
  ShieldCheck,
  Lock,
  FileText,
  Scale,
  UserCheck,
  Building2,
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
  Clock,
  Send
} from 'lucide-react';
import { PublicShell } from '@/components/layout/PublicShell';
import { buttonStyles } from '@/components/ui/Button';

export default function PrivacyPolicyPage() {
  return (
    <PublicShell>
      <div className="bg-gradient-to-b from-cream-100/70 via-cream-50 to-white pb-20 pt-8 sm:pt-12">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
          {/* Botón de retorno */}
          <div className="mb-6">
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-sm font-black text-ink-600 transition hover:text-brand-600"
            >
              <ArrowLeft className="size-4" /> Volver a la tienda
            </Link>
          </div>

          {/* Encabezado Principal / Hero */}
          <header className="rounded-3xl border border-ink-950/8 bg-white p-6 shadow-card sm:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3.5 py-1 text-xs font-black uppercase tracking-wider text-brand-700">
              <Scale className="size-3.5" /> Marco Legal · República Argentina
            </div>
            <h1 className="mt-4 font-display text-3xl font-black tracking-tight text-ink-950 sm:text-4xl">
              Política de Privacidad y Protección de Datos Personales
            </h1>
            <p className="mt-3 text-base leading-relaxed text-ink-700 sm:text-lg">
              Conforme a la <strong>Ley Nacional Nº 25.326</strong>, su Decreto Reglamentario Nº 1558/2001 y las
              disposiciones de la <strong>Agencia de Acceso a la Información Pública (AAIP)</strong>.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-4 text-xs font-semibold text-ink-500 border-t border-ink-950/8 pt-4">
              <span className="flex items-center gap-1.5">
                <Clock className="size-3.5 text-brand-600" /> Última actualización: Septiembre 2026
              </span>
              <span>·</span>
              <span>Aplicable a todas las compras y consultas en la plataforma</span>
            </div>
          </header>

          {/* Tarjetas de Resumen Ejecutivo */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <ShieldCheck className="size-5" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-ink-950">Finalidad Determinada</h2>
                  <p className="text-xs font-medium text-ink-600">Ley 25.326 · Art. 4</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-700">
                Tus datos solo se emplean para coordinar el pedido, facturar, despachar y dar soporte postventa. Jamás se comercializan ni ceden con fines publicitarios no solicitados.
              </p>
            </div>

            <div className="rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                  <UserCheck className="size-5" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-ink-950">Derechos ARCO Gratuitos</h2>
                  <p className="text-xs font-medium text-ink-600">Ley 25.326 · Arts. 14, 15 y 16</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-700">
                Tenés derecho de acceso, rectificación, actualización y supresión de tus datos en cualquier momento sin costo alguno a través de nuestros canales oficiales.
              </p>
            </div>

            <div className="rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-blue-50 text-blue-700">
                  <Lock className="size-5" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-ink-950">Seguridad y Confidencialidad</h2>
                  <p className="text-xs font-medium text-ink-600">Ley 25.326 · Arts. 9 y 10</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-700">
                Adoptamos medidas técnicas y organizativas para resguardar la confidencialidad de la información y prevenir cualquier acceso o tratamiento no autorizado.
              </p>
            </div>

            <div className="rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-xl bg-amber-50 text-amber-700">
                  <Building2 className="size-5" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-ink-950">Órgano de Control (AAIP)</h2>
                  <p className="text-xs font-medium text-ink-600">Disposición DNPDP 10/2008</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink-700">
                La Agencia de Acceso a la Información Pública es el órgano rector nacional facultado para atender denuncias y reclamos en materia de datos personales.
              </p>
            </div>
          </div>

          {/* Índice de Contenidos */}
          <nav
            aria-label="Índice de la Política de Privacidad"
            className="mt-8 rounded-2xl border border-ink-950/8 bg-cream-50/90 p-5"
          >
            <h2 className="text-xs font-black uppercase tracking-wider text-ink-700 mb-3 flex items-center gap-2">
              <FileText className="size-4 text-brand-600" /> Índice de Secciones
            </h2>
            <ol className="grid gap-2 text-sm font-bold text-ink-800 sm:grid-cols-2">
              <li>
                <a href="#seccion-1" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">1.</span> Responsable y marco legal
                </a>
              </li>
              <li>
                <a href="#seccion-2" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">2.</span> Datos que recolectamos
                </a>
              </li>
              <li>
                <a href="#seccion-3" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">3.</span> Finalidad del tratamiento
                </a>
              </li>
              <li>
                <a href="#seccion-4" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">4.</span> Consentimiento informado
                </a>
              </li>
              <li>
                <a href="#seccion-5" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">5.</span> Derechos del titular (ARCO)
                </a>
              </li>
              <li>
                <a href="#seccion-6" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">6.</span> Cómo ejercer tus derechos
                </a>
              </li>
              <li>
                <a href="#seccion-7" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">7.</span> Aviso legal de la AAIP
                </a>
              </li>
              <li>
                <a href="#seccion-8" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">8.</span> Seguridad y confidencialidad
                </a>
              </li>
              <li>
                <a href="#seccion-9" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">9.</span> Cesión a terceros limitada
                </a>
              </li>
              <li>
                <a href="#seccion-10" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">10.</span> Cookies y almacenamiento
                </a>
              </li>
              <li>
                <a href="#seccion-11" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">11.</span> Plazo de conservación
                </a>
              </li>
              <li>
                <a href="#seccion-12" className="hover:text-brand-600 transition flex items-center gap-1.5">
                  <span className="text-xs font-black text-brand-600">12.</span> Vigencia y contacto
                </a>
              </li>
            </ol>
          </nav>

          {/* Articulado Legal Detallado */}
          <div className="mt-10 space-y-10 text-ink-800 leading-relaxed text-[15px]">
            {/* Sección 1 */}
            <section id="seccion-1" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">1</span>
                Marco Normativo y Responsable
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">1. Responsable del Tratamiento y Base de Datos</h2>
              <p className="mt-3">
                El presente documento establece los términos en que <strong>Tienda de Suplementos</strong> (en adelante, “la Empresa” o “el Responsable”), con domicilio en la República Argentina, recopila, procesa, almacena y protege la información suministrada por los usuarios y clientes que visitan y operan a través del sitio web y los canales de mensajería integrados.
              </p>
              <p className="mt-3">
                El tratamiento de datos personales se rige estrictamente por los principios consagrados en la <strong>Ley Nacional Nº 25.326 de Protección de los Datos Personales</strong>, su Decreto Reglamentario Nº 1558/2001 y las normas complementarias dictadas por la <strong>Agencia de Acceso a la Información Pública (AAIP)</strong>. Los datos son incorporados a las bases de datos de la Empresa con las finalidades legítimas descriptas a continuación.
              </p>
            </section>

            {/* Sección 2 */}
            <section id="seccion-2" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">2</span>
                Principio de Calidad de los Datos
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">2. Datos Personales Recolectados</h2>
              <p className="mt-3">
                En estricto cumplimiento del <strong>artículo 4 de la Ley 25.326</strong> (Principio de Calidad de los Datos), la Empresa únicamente recolecta datos ciertos, adecuados, pertinentes y no excesivos en relación con el ámbito y la finalidad para la que se obtienen. Solicitamos exclusivamente:
              </p>
              <ul className="mt-3 space-y-2 text-sm font-semibold text-ink-800">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Nombre y Apellido:</strong> Para individualizar al comprador y formalizar el pedido comercial.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Teléfono de contacto / WhatsApp:</strong> Para coordinar en tiempo real la confirmación, medios de pago y entrega del pedido.</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="size-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Dirección y altura (calle y número):</strong> Requerido únicamente cuando el cliente selecciona la modalidad de entrega por envío a domicilio. En retiros en punto de entrega, estos campos no son exigidos.</span>
                </li>
              </ul>
              <p className="mt-3 text-xs text-ink-600 italic">
                Nota: La Empresa <strong>no</strong> recolecta datos sensibles (religión, origen étnico, filiación política, datos de salud íntimos) de conformidad con el artículo 7 de la Ley 25.326.
              </p>
            </section>

            {/* Sección 3 */}
            <section id="seccion-3" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">3</span>
                Finalidad Específica
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">3. Finalidad del Tratamiento</h2>
              <p className="mt-3">
                Los datos personales recolectados son tratados con los siguientes fines exclusivos:
              </p>
              <ol className="mt-3 list-decimal list-inside space-y-1.5 text-sm font-semibold text-ink-800">
                <li>Gestión, procesamiento y despacho de compras realizadas en la tienda.</li>
                <li>Generación del protocolo estructurado de pedido para su confirmación y seguimiento ágil a través de WhatsApp.</li>
                <li>Coordinación de pagos (efectivo al recibir o transferencia bancaria contra alias oficial de la tienda).</li>
                <li>Emisión de comprobantes comerciales, control contable y cumplimiento de obligaciones tributarias en la República Argentina.</li>
                <li>Atención de consultas, soporte postventa, cambios o devoluciones.</li>
              </ol>
            </section>

            {/* Sección 4 */}
            <section id="seccion-4" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">4</span>
                Consentimiento del Usuario
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">4. Consentimiento Libre, Expreso e Informado</h2>
              <p className="mt-3">
                De conformidad con el <strong>artículo 5 de la Ley 25.326</strong>, el tratamiento de los datos personales es lícito en tanto el titular ha prestado su consentimiento libre, expreso e informado.
              </p>
              <p className="mt-3">
                Al completar el formulario de checkout y accionar el botón <em>“Continuar por WhatsApp”</em>, el usuario presta su conformidad para que sus datos sean tratados exclusivamente conforme a los términos de esta Política de Privacidad.
              </p>
            </section>

            {/* Sección 5 */}
            <section id="seccion-5" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">5</span>
                Derechos ARCO
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">5. Derechos del Titular de los Datos (Acceso, Rectificación y Supresión)</h2>
              <p className="mt-3">
                Como titular de los datos, contás con los siguientes derechos garantizados por la legislación argentina:
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-ink-950/6 bg-cream-50 p-4">
                  <h3 className="text-sm font-black text-ink-950">Derecho de Acceso (Art. 14)</h3>
                  <p className="mt-1 text-xs text-ink-700">
                    Saber qué datos tuyos constan en nuestros registros, su procedencia y finalidad, en forma gratuita a intervalos no inferiores a 6 meses.
                  </p>
                </div>
                <div className="rounded-2xl border border-ink-950/6 bg-cream-50 p-4">
                  <h3 className="text-sm font-black text-ink-950">Derecho de Rectificación (Art. 16)</h3>
                  <p className="mt-1 text-xs text-ink-700">
                    Solicitar la corrección o actualización de datos erróneos, inexactos o desactualizados sin cargo alguno.
                  </p>
                </div>
                <div className="rounded-2xl border border-ink-950/6 bg-cream-50 p-4">
                  <h3 className="text-sm font-black text-ink-950">Derecho de Supresión (Art. 16)</h3>
                  <p className="mt-1 text-xs text-ink-700">
                    Solicitar la eliminación total de tus datos personales cuando haya cesado la relación comercial o no sean necesarios para obligaciones legales.
                  </p>
                </div>
                <div className="rounded-2xl border border-ink-950/6 bg-cream-50 p-4">
                  <h3 className="text-sm font-black text-ink-950">Derecho de Confidencialidad (Art. 10)</h3>
                  <p className="mt-1 text-xs text-ink-700">
                    Garantía de secreto profesional y estricta reserva de todos los colaboradores y prestadores involucrados.
                  </p>
                </div>
              </div>
            </section>

            {/* Sección 6 */}
            <section id="seccion-6" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">6</span>
                Ejercicio Práctico
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">6. Procedimiento para el Ejercicio de tus Derechos</h2>
              <p className="mt-3">
                Para ejercer cualquiera de los derechos de acceso, rectificación o supresión, podés comunicarte en forma directa y gratuita a través de:
              </p>
              <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50/70 p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <Send className="size-5 text-brand-700 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-black text-brand-950">Canal Directo de Atención</h3>
                    <p className="mt-1 text-xs text-brand-900 leading-relaxed">
                      Enviá un mensaje a través de nuestro <strong>WhatsApp oficial</strong> o solicitá la actualización indicando tu Nombre y Apellido y la acción requerida (acceso, actualización o baja). Responderemos a tu solicitud en los plazos previstos por la Ley 25.326 (10 días corridos para informes de acceso y 5 días hábiles para rectificación o supresión).
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Sección 7: AVISO OBLIGATORIO AAIP (Disposición 10/2008) */}
            <section id="seccion-7" className="rounded-3xl border-2 border-brand-600/30 bg-gradient-to-br from-brand-50/80 via-white to-cream-50 p-6 sm:p-8 shadow-card relative overflow-hidden">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-brand-800">
                <Scale className="size-4 text-brand-600" />
                Disposición DNPDP Nº 10/2008 · Cláusula Legal Obligatoria
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">
                7. Información al Titular de los Datos sobre el Órgano de Control
              </h2>
              <div className="mt-4 space-y-4 rounded-2xl border border-brand-200 bg-white/95 p-5 shadow-sm">
                <blockquote className="border-l-4 border-brand-600 pl-4 text-sm font-bold text-ink-900 leading-relaxed italic">
                  “El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses, salvo que se acredite un interés legítimo al efecto conforme lo establecido en el artículo 14, inciso 3 de la Ley Nº 25.326.”
                </blockquote>
                <blockquote className="border-l-4 border-brand-600 pl-4 text-sm font-bold text-ink-900 leading-relaxed italic">
                  “La AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley Nº 25.326, tiene la atribución de atender las denuncias y reclamos que se interpongan con relación al incumplimiento de las normas sobre protección de datos personales.”
                </blockquote>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs font-semibold text-ink-600">
                <span>Sede AAIP: Av. Pte. Gral. Julio A. Roca 710, Piso 3º, CABA</span>
                <a
                  href="https://www.argentina.gob.ar/aaip/datospersonales"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-black text-brand-700 hover:underline"
                >
                  Sitio Oficial de la AAIP <ExternalLink className="size-3" />
                </a>
              </div>
            </section>

            {/* Sección 8 */}
            <section id="seccion-8" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">8</span>
                Seguridad de la Información
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">8. Medidas de Seguridad y Confidencialidad Técnica</h2>
              <p className="mt-3">
                Conforme al <strong>artículo 9 de la Ley 25.326</strong>, la Empresa adopta medidas técnicas y organizativas rigurosas destinadas a garantizar la seguridad de los datos personales y evitar su adulteración, pérdida, consulta o tratamiento no autorizado.
              </p>
              <p className="mt-3">
                Toda la comunicación web se realiza mediante conexiones encriptadas bajo protocolo seguro <strong>HTTPS (TLS)</strong>. Asimismo, el acceso a la base de datos operativa está restringido por controles de identidad y roles de acceso administrativo autenticados.
              </p>
            </section>

            {/* Sección 9 */}
            <section id="seccion-9" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">9</span>
                Cesión Limitada
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">9. Destinatarios y Cesión a Terceros</h2>
              <p className="mt-3">
                La Empresa <strong>no vende, no alquila ni comercializa</strong> bases de datos personales bajo ninguna circunstancia.
              </p>
              <p className="mt-3">
                Los datos únicamente podrán ser comunicados a terceros cuando sea estrictamente indispensable para el cumplimiento del contrato de compraventa celebrado con el usuario (artículo 11, inciso 3 de la Ley 25.326):
              </p>
              <ul className="mt-3 space-y-1.5 text-sm font-semibold text-ink-800 list-disc list-inside">
                <li><strong>Servicios de logística y cadetería:</strong> Exclusivamente Nombre, Apellido, Dirección y Teléfono para efectuar la entrega física del paquete.</li>
                <li><strong>Entidades financieras / bancarias:</strong> Para validar pagos recibidos mediante transferencia bancaria.</li>
                <li><strong>Requerimiento judicial o de autoridad competente:</strong> Solo cuando exista una orden judicial fundada o mandamiento legal expreso.</li>
              </ul>
            </section>

            {/* Sección 10 */}
            <section id="seccion-10" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">10</span>
                Almacenamiento Local
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">10. Cookies y Almacenamiento Local Técnico</h2>
              <p className="mt-3">
                Este sitio web utiliza exclusivamente tecnologías de almacenamiento local del navegador (<code>localStorage</code>) con carácter estrictamente técnico y funcional:
              </p>
              <ul className="mt-3 space-y-1.5 text-sm font-semibold text-ink-800 list-disc list-inside">
                <li>Conservar los artículos seleccionados en tu carrito de compras mientras navegás el catálogo.</li>
                <li>Prevenir la pérdida de información del pedido en caso de recarga accidental de la página.</li>
              </ul>
              <p className="mt-3">
                No utilizamos cookies de seguimiento invasivo de terceros ni elaboramos perfiles de navegación para venta a redes de publicidad.
              </p>
            </section>

            {/* Sección 11 */}
            <section id="seccion-11" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">11</span>
                Conservación
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">11. Plazo de Conservación de los Datos</h2>
              <p className="mt-3">
                Los datos personales se conservarán mientras se mantenga la relación comercial o durante los plazos necesarios para dar cumplimiento a obligaciones impositivas, comerciales o legales exigibles por el Código Civil y Comercial de la Nación y la normativa tributaria argentina, transcurridos los cuales serán suprimidos de forma segura o anonimizados.
              </p>
            </section>

            {/* Sección 12 */}
            <section id="seccion-12" className="rounded-3xl border border-ink-950/8 bg-white p-6 sm:p-8 shadow-card">
              <div className="flex items-center gap-2.5 text-xs font-black uppercase tracking-wider text-brand-700">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-brand-700">12</span>
                Actualizaciones y Contacto
              </div>
              <h2 className="mt-2 text-xl font-black text-ink-950">12. Modificaciones a la Política de Privacidad</h2>
              <p className="mt-3">
                La Empresa se reserva el derecho de actualizar o modificar la presente Política de Privacidad para adecuarla a novedades normativas, resoluciones de la AAIP o mejoras en el funcionamiento de la plataforma. Cualquier modificación entrará en vigor desde su publicación en esta misma página con la fecha de última actualización visible.
              </p>
            </section>
          </div>

          {/* Tarjeta Final de Contacto / CTA */}
          <div className="mt-12 rounded-3xl border border-brand-200 bg-brand-50/90 p-8 text-center shadow-card">
            <h2 className="font-display text-2xl font-black text-brand-950">
              ¿Tenés dudas sobre cómo protegemos tus datos?
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-brand-900">
              Estamos a tu disposición para aclarar cualquier inquietud sobre la privacidad de tu información o ayudarte a ejercer tus derechos de acceso, rectificación o eliminación.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-4">
              <Link to="/" className={buttonStyles({ size: 'lg', className: 'font-black' })}>
                Volver a la tienda
              </Link>
            </div>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
