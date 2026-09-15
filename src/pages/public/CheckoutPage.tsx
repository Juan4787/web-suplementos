import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Building2,
  Check,
  CheckCircle2,
  Info,
  Mail,
  MapPin,
  MessageCircle,
  Store,
  Truck
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PublicShell } from '@/components/layout/PublicShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { formatMoney } from '@/domain/money';
import type { CheckoutData } from '@/domain/types';
import { calculateShippingFee, prepareCheckoutSubmission } from '@/domain/checkout';
import { whatsappCheckoutSchema, type CheckoutFormValues } from '@/domain/whatsapp';
import { useCart } from '@/features/cart/CartProvider';
import { cn } from '@/lib/cn';
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
  const queryClient = useQueryClient();
  const cart = useCart();
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

  const cartEtaKey =
    cart.lines.length > 0
      ? cart.lines.map((l) => `${l.productId}:${l.quantity}`).join(',')
      : 'empty';

  const cartEtaQuery = useBusinessQuery({
    queryKey: ['cart-eta', cartEtaKey],
    queryFn: (api) =>
      api.quoteCartEta(cart.lines.map((line) => ({ productId: line.productId, quantity: line.quantity }))),
    enabled: cart.lines.length > 0
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<CheckoutFormValues>({
    resolver: zodResolver(whatsappCheckoutSchema),
    defaultValues: {
      customerFirstName: cart.checkoutDraft?.customerFirstName ?? (
        cart.checkoutDraft?.customerName ? cart.checkoutDraft.customerName.split(' ')[0] ?? '' : ''
      ),
      customerLastName: cart.checkoutDraft?.customerLastName ?? (
        cart.checkoutDraft?.customerName ? cart.checkoutDraft.customerName.split(' ').slice(1).join(' ') : ''
      ),
      customerName: cart.checkoutDraft?.customerName ?? '',
      paymentMethod: cart.checkoutDraft?.paymentMethod ?? 'cash',
      deliveryMethod: cart.checkoutDraft?.deliveryMethod ?? 'pickup',
      shippingType: cart.checkoutDraft?.deliveryMethod === 'shipping' ? (cart.checkoutDraft.shippingType ?? 'standard') : null,
      isSantaFeOrNearby: cart.checkoutDraft?.deliveryMethod === 'shipping' ? (cart.checkoutDraft.isSantaFeOrNearby ?? null) : null,
      email: cart.checkoutDraft?.deliveryMethod === 'shipping' ? (cart.checkoutDraft.email ?? '') : '',
      address: cart.checkoutDraft?.address ?? null,
      addressNumber: cart.checkoutDraft?.addressNumber ?? null,
      phone: cart.checkoutDraft?.phone ?? null
    }
  });

  const paymentMethod = watch('paymentMethod');
  const deliveryMethod = watch('deliveryMethod');
  const shippingType = watch('shippingType');
  const isSantaFeOrNearby = watch('isSantaFeOrNearby');

  // Mantener el borrador sincronizado cuando cambian los campos
  useEffect(() => {
    const subscription = watch((formValues) => {
      const customerName = `${formValues.customerFirstName ?? ''} ${formValues.customerLastName ?? ''}`.trim();
      cart.updateCheckoutDraft({
        ...formValues,
        customerName: customerName || undefined
      } as Partial<CheckoutData>);
    });
    return () => subscription.unsubscribe();
  }, [watch, cart]);

  // Revalidación proactiva al cargar catálogo en vivo
  useEffect(() => {
    if (productsQuery.data && cart.lines.length > 0) {
      const reval = cart.syncWithLiveCatalog(productsQuery.data);
      if (reval.priceChanges.length > 0) {
        const changeSummary = reval.priceChanges
          .map((c) => `${c.name}: ${formatMoney(c.oldPriceCents)} → ${formatMoney(c.newPriceCents)}`)
          .join(', ');
        setPriceNotice(`Actualizamos el total por cambio de precio: ${changeSummary}.`);
      }
    }
  }, [productsQuery.data, cart.syncWithLiveCatalog, cart.lines.length]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const shippingFee = settingsQuery.data
    ? calculateShippingFee(deliveryMethod, shippingType, settingsQuery.data)
    : 0;

  const submit = handleSubmit(async (formValues) => {
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

      const liveProducts = await api.listStorefrontProducts();
      const liveSettings = await api.getSettings();
      queryClient.setQueryData(queryKeys.settings, liveSettings);

      const customerName = `${formValues.customerFirstName} ${formValues.customerLastName}`.trim();
      const values: CheckoutData = {
        ...formValues,
        customerName
      };

      const submission = await prepareCheckoutSubmission({
        values,
        lines: cart.lines,
        catalogProducts: liveProducts,
        settings: liveSettings,
        protocolDraft: cart.protocolDraft,
        validateAvailability: (lines) => api.validateAvailability(lines),
        syncWithLiveCatalog: (products) => cart.syncWithLiveCatalog(products)
      });

      if (submission.priceNotice || submission.shippingFeeCents !== shippingFee) {
        setPriceNotice(`${submission.priceNotice ?? 'Cambió la tarifa de envío y actualizamos el total.'} Revisá el nuevo importe y volvé a continuar por WhatsApp.`);
        desktopWindow?.close();
        return;
      }

      // Guardar el borrador del protocolo para reutilizar si no hay cambios
      cart.setProtocolDraft({
        orderId: submission.protocol.orderId,
        fingerprint: submission.fingerprint
      });

      // Tocar timestamp de actividad porque el usuario avanzó
      cart.touchActivity();

      if (desktopWindow) {
        desktopWindow.location.href = submission.whatsappUrl;
      } else {
        window.location.href = submission.whatsappUrl;
      }
    } catch (error) {
      desktopWindow?.close();
      setSubmitError(error);
    }
  });

  if (cart.lines.length === 0) {
    return (
      <PublicShell>
        <div className="mx-auto min-h-[60vh] max-w-3xl px-4 py-12">
          <h1 className="mb-6 font-display text-3xl font-black">Finalizar pedido</h1>
          <EmptyState
            title="Tu carrito está vacío"
            description="Sumá productos para continuar con tu pedido."
            action={<Link to="/" hash="productos" className={buttonStyles()}>Ver productos</Link>}
          />
        </div>
      </PublicShell>
    );
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

            {cartEtaQuery.data?.requiresIncoming ? (
              <div className="mt-5 flex items-start gap-3.5 rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-sm text-amber-950 shadow-sm">
                <Truck className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div>
                  <strong className="block font-black text-amber-900">
                    Tu pedido incluye productos en reposición
                  </strong>
                  <p className="mt-1 font-medium text-amber-800 leading-relaxed">
                    {cartEtaQuery.data.quotedEta
                      ? `Para optimizar tu envío y recibir todo junto, el pedido completo se despachará a partir del ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'long' }).format(new Date(cartEtaQuery.data.quotedEta))}.`
                      : 'Uno o más productos están ingresando desde el distribuidor y se entregarán apenas arriben al depósito.'}
                  </p>
                </div>
              </div>
            ) : null}

            <form className="mt-9 space-y-8" onSubmit={submit} noValidate>
              <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
                <h2 className="font-display text-xl font-black">1. Tus datos</h2>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Nombre *"
                    htmlFor="customerFirstName"
                    error={errors.customerFirstName?.message}
                  >
                    <Input
                      id="customerFirstName"
                      autoComplete="given-name"
                      placeholder="Ej. Juan"
                      {...register('customerFirstName')}
                    />
                  </Field>
                  <Field
                    label="Apellido *"
                    htmlFor="customerLastName"
                    error={errors.customerLastName?.message}
                  >
                    <Input
                      id="customerLastName"
                      autoComplete="family-name"
                      placeholder="Ej. Pérez"
                      {...register('customerLastName')}
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
                      setValue('isSantaFeOrNearby', null);
                      setValue('email', '');
                    }}
                  />
                  <RadioCard
                    selected={deliveryMethod === 'shipping'}
                    title="Envío a domicilio"
                    description="Coordinamos el flete según tu localidad."
                    icon={Truck}
                    onClick={() => {
                      setValue('deliveryMethod', 'shipping', { shouldValidate: true });
                      setValue('shippingType', 'standard', { shouldValidate: true });
                    }}
                  />
                </div>
                {deliveryMethod === 'shipping' ? (
                  <div className="mt-5 space-y-5 border-t border-ink-950/8 pt-5">
                    <div className="flex items-start gap-3 rounded-2xl border border-brand-200/70 bg-brand-50/60 p-4 text-xs text-brand-950">
                      <Info className="mt-0.5 size-4.5 shrink-0 text-brand-700" />
                      <div>
                        <strong className="block font-black text-[13px] text-brand-900">
                          Envíos a todo el país
                        </strong>
                        <p className="mt-1 leading-relaxed text-brand-950/80">
                          El costo del envío no está incluido en este total. Se cotiza y coordina directamente por WhatsApp según tu provincia y localidad.
                        </p>
                      </div>
                    </div>
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
                        error={errors.addressNumber?.message}
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

                    {/* Pregunta de Zona de Envío (Santa Fe Capital / Alrededores vs Resto del País) */}
                    <div className="pt-6 border-t border-ink-950/10 space-y-4">
                      <div className="flex items-start gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 border border-brand-200/50 shadow-xs">
                          <MapPin className="size-4.5" />
                        </span>
                        <div>
                          <p className="text-sm font-black text-ink-950 tracking-tight">
                            ¿Tu envío es dentro de la ciudad de Santa Fe Capital o alguna localidad cercana?
                          </p>
                          <p className="text-xs text-ink-600 mt-0.5 font-medium">
                            Elegí una opción para saber cómo gestionar el seguimiento de tu entrega.
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                        {/* Opción SÍ */}
                        <button
                          type="button"
                          onClick={() => {
                            setValue('isSantaFeOrNearby', true, { shouldValidate: true });
                            setValue('email', '', { shouldValidate: true });
                          }}
                          className={cn(
                            'group relative flex items-start gap-3.5 rounded-2xl border-2 p-4 text-left transition-all duration-200 cursor-pointer',
                            isSantaFeOrNearby === true
                              ? 'border-brand-600 bg-brand-50/80 ring-2 ring-brand-500/25 shadow-sm shadow-brand-500/10'
                              : 'border-ink-950/10 bg-white hover:border-brand-500/40 hover:bg-cream-50/80'
                          )}
                        >
                          <span
                            className={cn(
                              'grid size-11 shrink-0 place-items-center rounded-xl transition-colors',
                              isSantaFeOrNearby === true
                                ? 'bg-brand-600 text-white shadow-xs'
                                : 'bg-cream-100 text-ink-700 group-hover:bg-brand-100/60 group-hover:text-brand-700'
                            )}
                          >
                            <Building2 className="size-5" />
                          </span>
                          <div className="min-w-0 flex-1 pr-4">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-black tracking-wide uppercase',
                                  isSantaFeOrNearby === true
                                    ? 'bg-brand-600 text-white'
                                    : 'bg-ink-950/8 text-ink-700 group-hover:bg-brand-100 group-hover:text-brand-800'
                                )}
                              >
                                SÍ
                              </span>
                              <strong className="text-sm font-black text-ink-950">
                                Santa Fe y cercanías
                              </strong>
                            </div>
                            <p className="mt-1 text-xs text-ink-600 leading-relaxed font-medium">
                              Cadetería local directa. Sin necesidad de ingresar email.
                            </p>
                          </div>
                          <div
                            className={cn(
                              'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 transition',
                              isSantaFeOrNearby === true
                                ? 'border-brand-600 bg-brand-600 text-white'
                                : 'border-ink-950/20 bg-white'
                            )}
                          >
                            {isSantaFeOrNearby === true ? <Check className="size-3 stroke-[3]" /> : null}
                          </div>
                        </button>

                        {/* Opción NO */}
                        <button
                          type="button"
                          onClick={() => {
                            setValue('isSantaFeOrNearby', false, { shouldValidate: true });
                          }}
                          className={cn(
                            'group relative flex items-start gap-3.5 rounded-2xl border-2 p-4 text-left transition-all duration-200 cursor-pointer',
                            isSantaFeOrNearby === false
                              ? 'border-brand-600 bg-brand-50/80 ring-2 ring-brand-500/25 shadow-sm shadow-brand-500/10'
                              : 'border-ink-950/10 bg-white hover:border-brand-500/40 hover:bg-cream-50/80'
                          )}
                        >
                          <span
                            className={cn(
                              'grid size-11 shrink-0 place-items-center rounded-xl transition-colors',
                              isSantaFeOrNearby === false
                                ? 'bg-brand-600 text-white shadow-xs'
                                : 'bg-cream-100 text-ink-700 group-hover:bg-brand-100/60 group-hover:text-brand-700'
                            )}
                          >
                            <Truck className="size-5" />
                          </span>
                          <div className="min-w-0 flex-1 pr-4">
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-black tracking-wide uppercase',
                                  isSantaFeOrNearby === false
                                    ? 'bg-brand-600 text-white'
                                    : 'bg-ink-950/8 text-ink-700 group-hover:bg-brand-100 group-hover:text-brand-800'
                                )}
                              >
                                NO
                              </span>
                              <strong className="text-sm font-black text-ink-950">
                                Resto del país
                              </strong>
                            </div>
                            <p className="mt-1 text-xs text-ink-600 leading-relaxed font-medium">
                              Despacho postal o encomienda. Requiere link de seguimiento.
                            </p>
                          </div>
                          <div
                            className={cn(
                              'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 transition',
                              isSantaFeOrNearby === false
                                ? 'border-brand-600 bg-brand-600 text-white'
                                : 'border-ink-950/20 bg-white'
                            )}
                          >
                            {isSantaFeOrNearby === false ? <Check className="size-3 stroke-[3]" /> : null}
                          </div>
                        </button>
                      </div>

                      {errors.isSantaFeOrNearby ? (
                        <p role="alert" className="text-xs font-bold text-red-700">
                          {errors.isSantaFeOrNearby.message}
                        </p>
                      ) : null}

                      {/* Si responde SÍ: no se pide email y confirmación sutil */}
                      {isSantaFeOrNearby === true ? (
                        <div className="flex items-center gap-3 rounded-2xl bg-emerald-50/90 border border-emerald-200/80 p-3.5 text-xs text-emerald-950">
                          <span className="grid size-7 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-700">
                            <CheckCircle2 className="size-4" />
                          </span>
                          <div>
                            <strong className="block font-black text-emerald-900">
                              Coordinación de flete por WhatsApp
                            </strong>
                            <span className="text-emerald-800 font-medium leading-relaxed">
                              No necesitás ingresar correo electrónico; coordinamos el horario y la entrega directa en el chat.
                            </span>
                          </div>
                        </div>
                      ) : null}

                      {/* Si responde NO: se pide email obligatorio */}
                      {isSantaFeOrNearby === false ? (
                        <div className="rounded-2xl border border-brand-200/80 bg-gradient-to-br from-brand-50/80 to-cream-50 p-4 sm:p-5 space-y-3">
                          <div className="flex items-center gap-2.5">
                            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-brand-600 text-white shadow-xs">
                              <Mail className="size-4" />
                            </span>
                            <div>
                              <h4 className="text-xs font-black uppercase tracking-wider text-brand-900">
                                Seguimiento de envío nacional
                              </h4>
                              <p className="text-xs text-ink-600 font-medium">
                                Es para poder enviarte el link de seguimiento de tu pedido
                              </p>
                            </div>
                          </div>

                          <Field
                            label="Correo electrónico *"
                            htmlFor="email"
                            error={errors.email?.message}
                          >
                            <Input
                              id="email"
                              type="email"
                              autoComplete="email"
                              placeholder="tunombre@correo.com"
                              {...register('email')}
                            />
                          </Field>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </section>

              {settingsQuery.isPending || productsQuery.isPending ? <LoadingState label="Comprobando precios y datos de la tienda…" /> : null}
              {settingsQuery.isError ? <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} /> : null}
              {productsQuery.isError ? <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} /> : null}
              {submitError ? <ErrorState error={submitError} /> : null}
              <Button
                type="submit"
                size="lg"
                className="w-full sm:w-auto"
                loading={isSubmitting || isDebouncingClick}
                disabled={!settingsQuery.data || productsQuery.isPending || settingsQuery.isError || productsQuery.isError}
              >
                <MessageCircle className="size-5" /> Continuar por WhatsApp
              </Button>
              <p className="text-xs leading-5 text-ink-600">
                Antes de abrir WhatsApp volvemos a comprobar que las cantidades sigan disponibles. Esto todavía no reserva stock.
              </p>
              <p className="text-[11.5px] leading-4 text-ink-500">
                Tus datos personales están protegidos conforme a la Ley Nacional Nº 25.326.{' '}
                <Link
                  to="/privacidad"
                  target="_blank"
                  className="font-bold text-brand-600 hover:underline"
                >
                  Leé nuestra Política de Privacidad
                </Link>
                .
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
              {deliveryMethod === 'shipping' ? (
                <span className="font-bold text-brand-300">A coordinar</span>
              ) : (
                <span>{formatMoney(0)} (Retiro)</span>
              )}
            </div>
            <div className="mt-5 flex items-end justify-between">
              <div>
                <span className="font-black">Total productos</span>
                {deliveryMethod === 'shipping' ? (
                  <p className="text-[11px] font-normal text-white/50">+ flete a convenir</p>
                ) : null}
              </div>
              <strong className="font-display text-3xl">
                {formatMoney(cart.subtotalCents)}
              </strong>
            </div>

            {cartEtaQuery.data?.requiresIncoming ? (
              <div className="mt-4 rounded-xl bg-amber-400/10 border border-amber-400/20 p-3 text-xs text-amber-200 flex items-center gap-2">
                <Truck className="size-4 shrink-0 text-amber-300" />
                <span>
                  Entrega unificada:{' '}
                  {cartEtaQuery.data.quotedEta
                    ? `Desde el ${new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit' }).format(new Date(cartEtaQuery.data.quotedEta))}`
                    : 'Sujeta a arribo'}
                </span>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </PublicShell>
  );
}
