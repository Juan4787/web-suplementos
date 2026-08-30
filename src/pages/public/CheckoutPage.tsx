import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  Info,
  MapPin,
  MessageCircle,
  Store,
  Truck
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PublicShell } from '@/components/layout/PublicShell';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { AppError } from '@/domain/errors';
import { formatMoney } from '@/domain/money';
import type { CheckoutData } from '@/domain/types';
import {
  buildWhatsAppProtocol,
  createOrderFingerprint,
  whatsappCheckoutSchema
} from '@/domain/whatsapp';
import { useCart } from '@/features/cart/CartProvider';
import { cn } from '@/lib/cn';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';
import { getBusinessApi } from '@/services/business-api';

const RadioCard = ({
  selected,
  title,
  description,
  icon: Icon,
  onClick
}: {
  selected: boolean;
  title: string;
  description: string;
  icon: typeof Store;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={cn(
      'flex min-h-24 w-full items-start gap-4 rounded-[1.5rem] border p-4 text-left transition',
      selected
        ? 'border-brand-600 bg-brand-50/70 ring-2 ring-brand-500/20'
        : 'border-ink-950/12 bg-white hover:border-brand-500/30'
    )}
    onClick={onClick}
  >
    <span
      className={cn(
        'grid size-11 shrink-0 place-items-center rounded-2xl',
        selected ? 'bg-brand-600 text-white' : 'bg-cream-100 text-ink-800'
      )}
    >
      <Icon className="size-5" />
    </span>
    <span>
      <strong className="block font-black">{title}</strong>
      <span className="mt-1 block text-xs leading-5 text-ink-600">{description}</span>
    </span>
  </button>
);

export default function CheckoutPage() {
  const cart = useCart();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [priceNotice, setPriceNotice] = useState<string | null>(null);
  const [isDebouncingClick, setIsDebouncingClick] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsQuery = useBusinessQuery({
    queryKey: queryKeys.settings,
    queryFn: (api) => api.getSettings()
  });

  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.storefrontProducts,
    queryFn: (api) => api.listStorefrontProducts()
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<CheckoutData>({
    resolver: zodResolver(whatsappCheckoutSchema),
    defaultValues: {
      customerName: cart.checkoutDraft?.customerName ?? '',
      paymentMethod: cart.checkoutDraft?.paymentMethod ?? 'cash',
      deliveryMethod: cart.checkoutDraft?.deliveryMethod ?? 'pickup',
      shippingType: cart.checkoutDraft?.deliveryMethod === 'shipping' ? (cart.checkoutDraft.shippingType ?? 'standard') : null,
      address: cart.checkoutDraft?.address ?? null,
      addressNumber: cart.checkoutDraft?.addressNumber ?? null,
      phone: cart.checkoutDraft?.phone ?? null
    }
  });

  const paymentMethod = watch('paymentMethod');
  const deliveryMethod = watch('deliveryMethod');
  const shippingType = watch('shippingType');

  // Mantener el borrador sincronizado cuando cambian los campos
  useEffect(() => {
    const subscription = watch((values) => {
      cart.updateCheckoutDraft(values as Partial<CheckoutData>);
    });
    return () => subscription.unsubscribe();
  }, [watch, cart]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const shippingFee =
    deliveryMethod === 'shipping' && settingsQuery.data
      ? shippingType === 'express'
        ? settingsQuery.data.expressShippingCents
        : settingsQuery.data.standardShippingCents
      : 0;

  const submit = handleSubmit(async (values) => {
    if (isDebouncingClick || isSubmitting) return;
    setSubmitError(null);
    setPriceNotice(null);

    if (!settingsQuery.data) return;

    // Bloqueo de doble clic rápido
    setIsDebouncingClick(true);
    debounceTimerRef.current = setTimeout(() => {
      setIsDebouncingClick(false);
    }, 1200);

    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const desktopWindow = isMobile ? null : window.open('about:blank', '_blank');

    try {
      const api = await getBusinessApi();

      // 1. Revalidación en vivo de catálogo y precios
      if (productsQuery.data) {
        const reval = cart.syncWithLiveCatalog(productsQuery.data);
        if (reval.priceChanges.length > 0) {
          const changeSummary = reval.priceChanges
            .map((c) => `${c.name}: ${formatMoney(c.oldPriceCents)} → ${formatMoney(c.newPriceCents)}`)
            .join(', ');
          setPriceNotice(`Actualizamos el total por cambio de precio: ${changeSummary}.`);
        }
      }

      // 2. Validación en tiempo real de disponibilidad y stock en base de datos
      const availability = await api.validateAvailability(
        cart.lines.map((line) => ({ productId: line.productId, quantity: line.quantity }))
      );

      if (!availability.ok) {
        const issue = availability.issues[0];
        if (issue) {
          if (issue.available <= 0) {
            throw new AppError('business', `El producto “${issue.productName}” se quedó sin stock.`, {
              nextAction: 'Volvé al carrito y quitalo para poder continuar.'
            });
          }
          throw new AppError(
            'business',
            `Ahora quedan ${issue.available} unidades de “${issue.productName}” (pediste ${issue.requested}).`,
            {
              nextAction: 'Volvé al carrito y ajustá la cantidad antes de continuar.'
            }
          );
        }
        throw new AppError('business', 'Cambió la disponibilidad de uno o más productos.', {
          nextAction: 'Volvé al carrito y revisá las cantidades antes de continuar.'
        });
      }

      // 3. Sanitización de estado al construir el protocolo
      const sanitizedValues: CheckoutData = {
        ...values,
        shippingType: values.deliveryMethod === 'shipping' ? values.shippingType : null,
        address: values.deliveryMethod === 'shipping' ? values.address : null,
        addressNumber: values.deliveryMethod === 'shipping' ? values.addressNumber : null,
        phone: values.deliveryMethod === 'shipping' ? values.phone : null
      };

      // 4. Estabilidad de Protocol Order ID vs Invalidación si hubo cambios
      const currentFingerprint = createOrderFingerprint(
        sanitizedValues,
        cart.lines,
        shippingFee
      );

      const existingOrderId =
        cart.protocolDraft?.fingerprint === currentFingerprint
          ? cart.protocolDraft.orderId
          : undefined;

      const protocol = buildWhatsAppProtocol(
        sanitizedValues,
        cart.lines,
        settingsQuery.data,
        existingOrderId
      );

      // Guardar el borrador del protocolo para reutilizar si no hay cambios
      cart.setProtocolDraft({
        orderId: protocol.orderId,
        fingerprint: currentFingerprint
      });

      // Tocar timestamp de actividad porque el usuario avanzó
      cart.touchActivity();

      const url = buildWhatsAppUrl(settingsQuery.data.whatsappPhone, protocol.message);

      if (desktopWindow) {
        desktopWindow.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (error) {
      desktopWindow?.close();
      setSubmitError(error);
    }
  });

  if (cart.lines.length === 0) {
    void navigate({ to: '/carrito', replace: true });
    return null;
  }

  return (
    <PublicShell>
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
        <Link
          to="/carrito"
          className="inline-flex items-center gap-2 text-sm font-extrabold text-ink-600 hover:text-brand-600"
        >
          <ArrowLeft className="size-4" /> Volver al carrito
        </Link>
        <div className="mt-7 grid gap-10 lg:grid-cols-[1fr_23rem] lg:items-start">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-brand-600">Último paso</p>
            <h1 className="mt-2 font-display text-4xl font-black tracking-[-0.055em] sm:text-5xl">
              ¿Cómo coordinamos?
            </h1>
            <p className="mt-3 text-ink-600">Solo pedimos lo necesario para preparar el mensaje.</p>

            {priceNotice ? (
              <div className="mt-5 flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-bold text-blue-950">
                <Info className="mt-0.5 size-5 shrink-0 text-blue-600" />
                <p>{priceNotice}</p>
              </div>
            ) : null}

            <form className="mt-9 space-y-8" onSubmit={submit} noValidate>
              <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
                <h2 className="font-display text-xl font-black">1. Tus datos</h2>
                <div className="mt-5">
                  <Field
                    label="Nombre"
                    htmlFor="customerName"
                    error={errors.customerName?.message}
                  >
                    <Input
                      id="customerName"
                      autoComplete="name"
                      placeholder="Ej. Juan Pérez"
                      {...register('customerName')}
                    />
                  </Field>
                </div>
              </section>

              <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
                <h2 className="font-display text-xl font-black">2. Medio de pago</h2>
                <p className="mt-1 text-sm text-ink-600">Elegir pago no cambia cómo recibís el pedido.</p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <RadioCard
                    selected={paymentMethod === 'cash'}
                    title="Efectivo"
                    description="Coordinás el pago al confirmar."
                    icon={Banknote}
                    onClick={() => setValue('paymentMethod', 'cash', { shouldValidate: true })}
                  />
                  <RadioCard
                    selected={paymentMethod === 'transfer'}
                    title="Transferencia"
                    description="Te mostramos los datos antes de continuar."
                    icon={CheckCircle2}
                    onClick={() => setValue('paymentMethod', 'transfer', { shouldValidate: true })}
                  />
                </div>
                {paymentMethod === 'transfer' && settingsQuery.data ? (
                  <div className="mt-4 rounded-2xl border border-brand-200/60 bg-brand-50/80 p-4">
                    <h3 className="text-[14px] font-black text-brand-700">Datos para transferir</h3>
                    <p className="mt-2 font-black text-ink-950">Alias: {settingsQuery.data.transferAlias}</p>
                    <p className="mt-1 text-sm font-semibold text-ink-600">
                      {settingsQuery.data.transferAccount}
                    </p>
                    <p className="mt-3 text-xs text-ink-600">
                      No hace falta transferir antes de hablar por WhatsApp, salvo que la tienda te lo indique.
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
                <h2 className="font-display text-xl font-black">3. Entrega</h2>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <RadioCard
                    selected={deliveryMethod === 'pickup'}
                    title="Retiro"
                    description="Coordinás día y horario por WhatsApp."
                    icon={Store}
                    onClick={() => {
                      setValue('deliveryMethod', 'pickup', { shouldValidate: true });
                      setValue('shippingType', null);
                    }}
                  />
                  <RadioCard
                    selected={deliveryMethod === 'shipping'}
                    title="Envío a domicilio"
                    description="Elegí tradicional o express."
                    icon={Truck}
                    onClick={() => {
                      setValue('deliveryMethod', 'shipping', { shouldValidate: true });
                      setValue('shippingType', shippingType ?? 'standard', { shouldValidate: true });
                    }}
                  />
                </div>
                {deliveryMethod === 'shipping' ? (
                  <div className="mt-5 space-y-5 border-t border-ink-950/8 pt-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <RadioCard
                        selected={shippingType === 'standard'}
                        title={`Tradicional · ${formatMoney(settingsQuery.data?.standardShippingCents ?? 0)}`}
                        description="La opción más económica."
                        icon={Truck}
                        onClick={() => setValue('shippingType', 'standard', { shouldValidate: true })}
                      />
                      <RadioCard
                        selected={shippingType === 'express'}
                        title={`Express · ${formatMoney(settingsQuery.data?.expressShippingCents ?? 0)}`}
                        description="Para cuando lo necesitás antes."
                        icon={MapPin}
                        onClick={() => setValue('shippingType', 'express', { shouldValidate: true })}
                      />
                    </div>
                    {errors.shippingType?.message ? (
                      <p className="text-sm font-semibold text-red-700">
                        {errors.shippingType.message}
                      </p>
                    ) : null}
                    <div className="grid gap-5 sm:grid-cols-[1fr_9rem]">
                      <Field
                        label="Dirección"
                        htmlFor="address"
                        error={errors.address?.message}
                      >
                        <Input
                          id="address"
                          autoComplete="street-address"
                          placeholder="Calle o avenida"
                          {...register('address')}
                        />
                      </Field>
                      <Field
                        label="Altura"
                        htmlFor="addressNumber"
                        hint="Opcional"
                      >
                        <Input
                          id="addressNumber"
                          inputMode="numeric"
                          placeholder="742"
                          {...register('addressNumber')}
                        />
                      </Field>
                    </div>
                    <Field
                      label="Teléfono"
                      htmlFor="phone"
                      error={errors.phone?.message}
                    >
                      <Input
                        id="phone"
                        type="tel"
                        autoComplete="tel"
                        placeholder="11 5555 5555"
                        {...register('phone')}
                      />
                    </Field>
                  </div>
                ) : null}
              </section>

              {submitError ? <ErrorState error={submitError} /> : null}
              <Button
                type="submit"
                size="lg"
                className="w-full sm:w-auto"
                loading={isSubmitting || isDebouncingClick}
                disabled={!settingsQuery.data}
              >
                <MessageCircle className="size-5" /> Continuar por WhatsApp
              </Button>
              <p className="text-xs leading-5 text-ink-600">
                Antes de abrir WhatsApp volvemos a comprobar que las cantidades sigan disponibles. Esto todavía no reserva stock.
              </p>
            </form>
          </div>
          <aside className="sticky top-6 rounded-[2rem] bg-ink-950 p-6 text-white shadow-soft">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-300">Resumen</p>
            <div className="mt-5 space-y-4">
              {cart.lines.map((line) => (
                <div key={line.productId} className="flex justify-between gap-3 text-sm">
                  <span className="text-white/70">
                    {line.name} × {line.quantity}
                  </span>
                  <strong>{formatMoney(line.unitPriceCents * line.quantity)}</strong>
                </div>
              ))}
            </div>
            <div className="my-5 border-t border-white/10" />
            <div className="flex justify-between text-sm text-white/60">
              <span>Subtotal</span>
              <span>{formatMoney(cart.subtotalCents)}</span>
            </div>
            <div className="mt-2 flex justify-between text-sm text-white/60">
              <span>Envío</span>
              <span>{formatMoney(shippingFee)}</span>
            </div>
            <div className="mt-5 flex items-end justify-between">
              <span className="font-black">Total</span>
              <strong className="font-display text-3xl">
                {formatMoney(cart.subtotalCents + shippingFee)}
              </strong>
            </div>
          </aside>
        </div>
      </div>
    </PublicShell>
  );
}

