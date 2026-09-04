import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  Edit2,
  Minus,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { AppError } from '@/domain/errors';
import { formatMoney } from '@/domain/money';
import type { CartLine, ImportOrderInput, Order } from '@/domain/types';
import { parseWhatsAppProtocol, type ParsedWhatsAppOrder } from '@/domain/whatsapp';
import { getBusinessApi } from '@/services/business-api';

type Review = {
  source: ParsedWhatsAppOrder;
  lines: CartLine[];
  customerName: string;
};

export default function ImportOrderPage() {
  const [message, setMessage] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [showEditFields, setShowEditFields] = useState(false);
  const [parseError, setParseError] = useState<unknown>(null);
  const [created, setCreated] = useState<Order | null>(null);
  const queryClient = useQueryClient();

  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.products,
    queryFn: (api) => api.listAdminProducts()
  });

  const totals = useMemo(() => {
    const subtotal =
      review?.lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0) ?? 0;
    const shipping = review?.source.shippingFeeCents ?? 0;
    return { subtotal, shipping, total: subtotal + shipping };
  }, [review]);

  const confirm = useMutation({
    mutationFn: async (input: ImportOrderInput) =>
      (await getBusinessApi()).confirmImportedOrder(input),
    onSuccess: async (order) => {
      setCreated(order);
      setReview(null);
      setShowEditFields(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
    }
  });

  const analyze = () => {
    setParseError(null);
    setCreated(null);
    setShowEditFields(false);
    try {
      const parsed = parseWhatsAppProtocol(message);
      const products = productsQuery.data ?? [];
      const lines = parsed.lines.map((line) => {
        const product = products.find((candidate) => candidate.sku === line.sku);
        if (!product || !product.active) {
          throw new AppError('business', `El producto “${line.name}” (código: ${line.sku}) no está disponible en catálogo.`, {
            nextAction: 'Revisá el mensaje de WhatsApp o cargá el producto si es nuevo.'
          });
        }
        return {
          productId: product.id,
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          presentation: product.presentation,
          imageUrl: product.imageUrl,
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity
        } satisfies CartLine;
      });
      setReview({ source: parsed, lines, customerName: parsed.customerName });
    } catch (error) {
      setReview(null);
      setParseError(
        error instanceof AppError
          ? error
          : new AppError(
              'validation',
              'No pudimos interpretar este texto como un pedido válido de la tienda.',
              {
                cause: error,
                nextAction:
                  'Copiá el mensaje completo desde WhatsApp, desde "*PEDIDO IMPULSO*" hasta el final.'
              }
            )
      );
    }
  };

  const setLineQuantity = (productId: string, quantity: number) => {
    setReview((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((line) =>
              line.productId === productId
                ? { ...line, quantity: Math.max(1, Math.min(20, quantity)) }
                : line
            )
          }
        : null
    );
  };

  const createdUnits = useMemo(() => {
    return created?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  }, [created]);

  return (
    <div className="page-enter">
      <PageHeader
        title={created ? 'Pedido cargado' : 'Importar pedido'}
        description={
          created
            ? 'El pedido quedó registrado correctamente.'
            : 'Pegá el mensaje generado por la tienda.'
        }
      />

      {/* Éxito: Estado posterior a la confirmación */}
      {created ? (
        <div className="mx-auto mt-4 max-w-2xl sm:mt-6">
          <section className="rounded-[2rem] border border-ink-950/8 bg-white p-7 shadow-card sm:p-9">
            {/* Indicador de éxito con badge verde suave */}
            <div className="flex items-center gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                <CheckCircle2 className="size-6" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-display text-2xl font-black text-ink-950 sm:text-[26px]">
                  Pedido cargado
                </h2>
                <p className="mt-0.5 text-[15px] font-semibold text-emerald-800">
                  El pedido quedó registrado y el stock fue reservado.
                </p>
              </div>
            </div>

            {/* Tarjeta de Resumen explícito del pedido confirmado */}
            <div className="mt-6 rounded-2xl border border-ink-950/8 bg-cream-50/80 p-5 sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-950/8 pb-3">
                <span className="font-display text-lg font-black text-ink-950 sm:text-xl">
                  Pedido #{created.number} · {created.customerName}
                </span>
                <span className="text-[14.5px] font-bold text-ink-600">
                  {created.items.length} {created.items.length === 1 ? 'producto' : 'productos'} · {createdUnits} {createdUnits === 1 ? 'unidad' : 'unidades'}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-wider text-ink-500">
                    Total del pedido
                  </p>
                  <p className="mt-0.5 font-display text-3xl font-black tracking-tight text-ink-950 sm:text-4xl">
                    {formatMoney(created.totalCents)}
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-950/10 bg-white px-3.5 py-1.5 text-[14px] font-bold text-ink-800 shadow-sm">
                    {created.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'} · {created.deliveryMethod === 'pickup' ? 'Retiro' : `Envío ${created.shippingType === 'express' ? 'express' : 'a domicilio'}`}
                  </span>
                </div>
              </div>
            </div>

            {/* Mensaje natural sobre el stock */}
            <p className="mt-5 text-[15px] font-semibold text-ink-700">
              El pedido quedó cargado y las unidades fueron reservadas.
            </p>

            {/* Botones de acción jerárquicos: Azul zafiro principal y Blanco secundario */}
            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                to="/app/pedidos"
                search={{ search: created.number.toString() } as any}
                className={buttonStyles({
                  variant: 'primary',
                  size: 'lg',
                  className: 'flex-1 shadow-[0_8px_24px_rgba(37,99,235,0.28)]'
                })}
              >
                Ver pedido #{created.number}
              </Link>
              <Button
                variant="secondary"
                size="lg"
                className="flex-1 border-ink-950/15"
                onClick={() => {
                  setCreated(null);
                  setMessage('');
                  setReview(null);
                  setParseError(null);
                }}
              >
                <RotateCcw className="size-4" /> Importar otro pedido
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {/* Paso 1: Área de Pegado */}
      {!created && !review ? (
        <div className="max-w-3xl">
          <section className="rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
            <Field
              label="Mensaje de WhatsApp"
              htmlFor="order-message"
              hint="Pegá el texto completo que envió el cliente desde el carrito."
            >
              <Textarea
                id="order-message"
                className="min-h-[18rem] font-mono text-sm leading-6"
                placeholder="*PEDIDO IMPULSO*&#10;&#10;*Código de pedido*&#10;...&#10;*Nombre*&#10;Juan Pérez&#10;..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>

            {parseError ? (
              <div className="mt-4">
                <ErrorState error={parseError} />
              </div>
            ) : null}

            <Button
              className="mt-5"
              size="lg"
              onClick={analyze}
              disabled={!message.trim() || productsQuery.isPending}
            >
              <ClipboardPaste className="size-5" /> Analizar pedido
            </Button>
          </section>
        </div>
      ) : null}

      {/* Paso 2: Pantalla de Verificación y Control Visual */}
      {!created && review ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_21rem]">
          <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
            <div className="flex items-center justify-between gap-4 border-b border-ink-950/8 pb-4">
              <div>
                <h2 className="font-display text-2xl font-black text-ink-950">Revisá el pedido</h2>
                <p className="mt-1 text-[15px] font-semibold text-ink-600">
                  Comprobá productos, cantidades y precios antes de confirmarlo.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setReview(null)}>
                Volver
              </Button>
            </div>

            {/* Metadatos compactos: Cliente, Pago y Entrega en jerarquía secundaria */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-cream-50/90 px-4 py-3 border border-ink-950/6 text-[14.5px]">
              <div className="flex items-center gap-2">
                <span className="font-black text-ink-950">{review.customerName}</span>
                {review.source.phone ? (
                  <span className="text-ink-600 font-semibold">· {review.source.phone}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-ink-700 font-semibold">
                <span>{review.source.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'}</span>
                <span className="text-ink-400">·</span>
                <span>
                  {review.source.deliveryMethod === 'pickup'
                    ? 'Retiro'
                    : `Envío ${review.source.shippingType === 'express' ? 'express' : 'tradicional'}`}
                </span>
                {review.source.address ? (
                  <span className="text-ink-600">({review.source.address} {review.source.addressNumber ?? ''})</span>
                ) : null}
              </div>
            </div>

            {/* Filas de Verificación de Productos */}
            <div className="mt-5 space-y-3">
              {/* Encabezado conceptual de columnas para validación en 3 segundos */}
              <div className="hidden sm:grid sm:grid-cols-[1fr_7rem_8rem_7.5rem] items-center gap-4 px-5 text-[13px] font-black uppercase tracking-wider text-ink-500">
                <span>Producto</span>
                <span className="text-right">Cantidad</span>
                <span className="text-right">Precio u.</span>
                <span className="text-right">Subtotal</span>
              </div>

              {/* Cada producto como fila de verificación explícita */}
              {review.lines.map((line) => {
                const lineSubtotal = line.unitPriceCents * line.quantity;
                return (
                  <article
                    key={line.productId}
                    className="flex flex-col sm:grid sm:grid-cols-[1fr_7rem_8rem_7.5rem] items-start sm:items-center gap-4 rounded-2xl border border-ink-950/8 bg-white p-4 sm:px-5 sm:py-4 shadow-sm hover:border-ink-950/20 transition"
                  >
                    {/* Izquierda: Imagen ampliada + Nombre + Presentación */}
                    <div className="flex items-center gap-3.5 min-w-0">
                      <img
                        src={line.imageUrl}
                        alt={line.name}
                        className="size-14 shrink-0 rounded-xl bg-cream-100 object-cover border border-ink-950/6"
                      />
                      <div className="min-w-0">
                        <h3 className="text-[17.5px] font-black text-ink-950 leading-tight">
                          {line.name}
                        </h3>
                        <p className="mt-0.5 text-[14.5px] font-medium text-ink-600 truncate">
                          {line.presentation}
                        </p>
                      </div>
                    </div>

                    {/* Zona cuantitativa y económica destacada */}
                    <div className="flex w-full sm:w-auto items-center justify-between sm:contents border-t sm:border-t-0 border-ink-950/6 pt-2.5 sm:pt-0">
                      {/* Cantidad */}
                      <div className="sm:text-right">
                        <span className="sm:hidden text-xs font-bold text-ink-500 block">Cantidad:</span>
                        <span className="text-[16.5px] font-black text-ink-950">
                          {line.quantity} {line.quantity === 1 ? 'unidad' : 'unidades'}
                        </span>
                      </div>

                      {/* Precio unitario */}
                      <div className="sm:text-right">
                        <span className="sm:hidden text-xs font-bold text-ink-500 block">Precio unitario:</span>
                        <span className="text-[16px] font-semibold text-ink-700">
                          {formatMoney(line.unitPriceCents)} c/u
                        </span>
                      </div>

                      {/* Subtotal de línea */}
                      <div className="sm:text-right">
                        <span className="sm:hidden text-xs font-bold text-ink-500 block">Subtotal:</span>
                        <span className="text-[17.5px] font-black text-ink-950">
                          {formatMoney(lineSubtotal)}
                        </span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            {/* Corregir datos del pedido (Edición Progresiva) */}
            <div className="mt-6 border-t border-ink-950/8 pt-4">
              <button
                type="button"
                className="flex items-center gap-2 text-[14.5px] font-black text-brand-600 hover:text-brand-700 transition"
                onClick={() => setShowEditFields((prev) => !prev)}
              >
                <Edit2 className="size-4" />
                <span>
                  {showEditFields
                    ? 'Ocultar corrección de datos'
                    : 'Corregir datos del pedido ▾'}
                </span>
              </button>

              {showEditFields ? (
                <div className="mt-4 space-y-5 rounded-2xl bg-cream-50 p-5 border border-ink-950/6">
                  {/* 1. Cliente */}
                  <div>
                    <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-700 mb-2.5">
                      Cliente
                    </h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Nombre del cliente" htmlFor="review-name">
                        <Input
                          id="review-name"
                          value={review.customerName}
                          onChange={(e) => setReview({ ...review, customerName: e.target.value })}
                        />
                      </Field>
                      <Field label="Teléfono" htmlFor="review-phone">
                        <Input
                          id="review-phone"
                          value={review.source.phone ?? ''}
                          onChange={(e) =>
                            setReview({
                              ...review,
                              source: { ...review.source, phone: e.target.value }
                            })
                          }
                        />
                      </Field>
                    </div>
                  </div>

                  {/* 2. Productos y Cantidades */}
                  <div>
                    <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-700 mb-2.5">
                      Productos (ajuste de cantidades)
                    </h4>
                    <div className="space-y-2">
                      {review.lines.map((line) => (
                        <div
                          key={line.productId}
                          className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 border border-ink-950/6"
                        >
                          <div>
                            <span className="text-sm font-black text-ink-950">{line.name}</span>
                            <span className="text-xs text-ink-600 font-semibold ml-2">
                              · {formatMoney(line.unitPriceCents)} c/u
                            </span>
                          </div>
                          <div className="inline-flex items-center rounded-full bg-cream-100 p-1">
                            <button
                              type="button"
                              className="grid size-7 place-items-center rounded-full hover:bg-white text-ink-700 hover:text-ink-950 transition"
                              onClick={() => setLineQuantity(line.productId, line.quantity - 1)}
                              aria-label={`Restar unidad de ${line.name}`}
                            >
                              <Minus className="size-3.5" />
                            </button>
                            <span className="min-w-8 text-center text-sm font-black text-ink-950">
                              {line.quantity}
                            </span>
                            <button
                              type="button"
                              className="grid size-7 place-items-center rounded-full hover:bg-white text-ink-700 hover:text-ink-950 transition"
                              onClick={() => setLineQuantity(line.productId, line.quantity + 1)}
                              aria-label={`Sumar unidad de ${line.name}`}
                            >
                              <Plus className="size-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 3. Entrega */}
                  <div>
                    <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-700 mb-2.5">
                      Entrega
                    </h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Dirección" htmlFor="review-address">
                        <Input
                          id="review-address"
                          value={review.source.address ?? ''}
                          onChange={(e) =>
                            setReview({
                              ...review,
                              source: { ...review.source, address: e.target.value }
                            })
                          }
                        />
                      </Field>
                      <Field label="Número / Depto" htmlFor="review-address-num">
                        <Input
                          id="review-address-num"
                          value={review.source.addressNumber ?? ''}
                          onChange={(e) =>
                            setReview({
                              ...review,
                              source: { ...review.source, addressNumber: e.target.value }
                            })
                          }
                        />
                      </Field>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {confirm.error ? (
              <div className="mt-5">
                <ErrorState error={confirm.error} />
              </div>
            ) : null}
          </section>

          {/* Panel Lateral de Resumen Equilibrado y Limpio */}
          <aside className="sticky top-6 rounded-[2rem] bg-white p-6 shadow-card border border-ink-950/8 h-fit">
            <h3 className="font-display text-xl font-black text-ink-950">
              Resumen
            </h3>

            <div className="mt-5 space-y-3 text-[15px]">
              <div className="flex justify-between font-semibold text-ink-700">
                <span>
                  Productos ({review.lines.reduce((s, l) => s + l.quantity, 0)}{' '}
                  {review.lines.reduce((s, l) => s + l.quantity, 0) === 1 ? 'unidad' : 'unidades'})
                </span>
                <span className="font-black text-ink-950">{formatMoney(totals.subtotal)}</span>
              </div>
              <div className="flex justify-between font-semibold text-ink-700">
                <span>Envío</span>
                <span className="font-black text-ink-950">{formatMoney(totals.shipping)}</span>
              </div>
            </div>

            <div className="my-5 border-t border-ink-950/8" />

            <div className="flex items-baseline justify-between mb-6">
              <span className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">Total</span>
              <span className="font-display text-3xl font-black text-ink-950">
                {formatMoney(totals.total)}
              </span>
            </div>

            <Button
              className="w-full text-[15.5px] font-black"
              size="lg"
              loading={confirm.isPending}
              disabled={review.customerName.trim().length < 2}
              onClick={() =>
                confirm.mutate({
                  customerName: review.customerName.trim(),
                  paymentMethod: review.source.paymentMethod,
                  deliveryMethod: review.source.deliveryMethod,
                  shippingType: review.source.shippingType,
                  address: review.source.address,
                  addressNumber: review.source.addressNumber,
                  phone: review.source.phone,
                  lines: review.lines,
                  shippingFeeCents: totals.shipping,
                  quotedSubtotalCents: totals.subtotal,
                  quotedTotalCents: totals.total,
                  protocolOrderId: review.source.protocolOrderId,
                  protocolChecksum: review.source.protocolChecksum
                })
              }
            >
              Confirmar pedido
            </Button>
            <p className="mt-3 text-center text-xs font-semibold text-ink-600">
              Al confirmar, estas unidades quedan reservadas.
            </p>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
