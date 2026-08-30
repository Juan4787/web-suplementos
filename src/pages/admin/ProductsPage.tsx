import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Edit3,
  Image as ImageIcon,
  Plus,
  Search,
  Sliders,
  Sparkles,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney, pesosToCents } from '@/domain/money';
import { can } from '@/domain/permissions';
import type { AdminProduct } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  deleteUploadedProductImage,
  storagePathFromProductImageUrl,
  uploadProductImage,
  validateProductImageFile
} from '@/features/products/product-image-upload';
import { getBusinessApi, type ProductUpdate } from '@/services/business-api';
import { cn } from '@/lib/cn';

const formSchema = z.object({
  sku: z.string().trim().min(2, 'Ingresá un SKU (mínimo 2 caracteres).').max(30),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Usá minúsculas, números y guiones (ej. creatina-300g).'),
  name: z.string().trim().min(2, 'Ingresá el nombre del producto.').max(100),
  presentation: z.string().trim().min(2, 'Ingresá la presentación (ej. 300 g · Sin sabor).').max(100),
  description: z.string().trim().min(10, 'Describí el producto en al menos 10 caracteres.').max(1000),
  category: z.string().trim().min(2, 'Ingresá una categoría.').max(60),
  pricePesos: z.number().nonnegative('El precio de venta no puede ser negativo.'),
  costPesos: z.number().nonnegative('El costo no puede ser negativo.'),
  reorderPoint: z.number().int().nonnegative('El punto de pedido debe ser 0 o mayor.'),
  safetyStock: z.number().int().nonnegative('El stock de seguridad debe ser 0 o mayor.'),
  leadTimeDays: z.number().int().min(0).max(365, 'El lead time debe estar entre 0 y 365 días.'),
  imageUrl: z.string().trim().min(1, 'Agregá o subí una imagen para el producto.'),
  imageAlt: z.string().trim().min(3, 'Describí la imagen para accesibilidad.'),
  published: z.boolean(),
  active: z.boolean(),
  featured: z.boolean()
});

type FormValues = z.infer<typeof formSchema>;

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

const skuFromText = (text: string): string =>
  text
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 8);

const defaults: FormValues = {
  sku: '',
  slug: '',
  name: '',
  presentation: '',
  description: '',
  category: 'General',
  pricePesos: 0,
  costPesos: 0,
  reorderPoint: 5,
  safetyStock: 2,
  leadTimeDays: 7,
  imageUrl: '',
  imageAlt: '',
  published: true,
  active: true,
  featured: false
};

function ProductForm({ product, onClose }: { product: AdminProduct | null; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const pricing = can(user, 'manage_pricing');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<unknown>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors }
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults
  });

  const isCreating = !product;

  useEffect(() => {
    setImageFile(null);
    setImagePreviewUrl(null);
    setImageError(null);
    reset(
      product
        ? {
            sku: product.sku,
            slug: product.slug,
            name: product.name,
            presentation: product.presentation,
            description: product.description,
            category: product.category,
            pricePesos: product.priceCents / 100,
            costPesos: (product.currentCostCents ?? 0) / 100,
            reorderPoint: product.reorderPoint,
            safetyStock: product.safetyStock,
            leadTimeDays: product.leadTimeDays,
            imageUrl: product.imageUrl,
            imageAlt: product.imageAlt,
            published: product.published,
            active: product.active,
            featured: product.featured
          }
        : defaults
    );
  }, [product, reset]);

  useEffect(
    () => () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    },
    [imagePreviewUrl]
  );

  const currentImageUrl = watch('imageUrl');
  const watchedName = watch('name');

  // Autogenerar slug y SKU SOLO al crear nuevo producto (no modifica al editar para preservar URLs)
  const handleNameBlur = () => {
    if (isCreating && watchedName.trim()) {
      const currentSlug = watch('slug');
      const currentSku = watch('sku');
      if (!currentSlug) {
        setValue('slug', slugify(watchedName), { shouldValidate: true });
      }
      if (!currentSku) {
        setValue('sku', skuFromText(watchedName) || 'PROD', { shouldValidate: true });
      }
      if (!watch('imageAlt')) {
        setValue('imageAlt', `Pote de ${watchedName.trim()}`, { shouldValidate: true });
      }
    }
  };

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const previousStoragePath = product
        ? storagePathFromProductImageUrl(product.imageUrl)
        : null;
      let uploadedStoragePath: string | null = null;
      let imageUrl = values.imageUrl;

      if (imageFile) {
        const uploaded = await uploadProductImage(imageFile);
        imageUrl = uploaded.url;
        uploadedStoragePath = uploaded.storagePath;
      }

      const input: ProductUpdate = {
        ...(product ? { id: product.id } : {}),
        sku: values.sku.toUpperCase().trim(),
        slug: values.slug.trim(),
        name: values.name.trim(),
        presentation: values.presentation.trim(),
        description: values.description.trim(),
        category: values.category.trim(),
        priceCents: pricing ? pesosToCents(values.pricePesos) : product?.priceCents ?? 0,
        currentCostCents: pricing ? pesosToCents(values.costPesos) : product?.currentCostCents ?? null,
        reorderPoint: values.reorderPoint,
        safetyStock: values.safetyStock,
        leadTimeDays: values.leadTimeDays,
        imageUrl,
        imageAlt: values.imageAlt.trim(),
        published: values.published,
        active: values.active,
        featured: values.featured
      };

      try {
        const saved = await (await getBusinessApi()).saveProduct(input);
        return { saved, previousStoragePath, uploadedStoragePath };
      } catch (error) {
        await deleteUploadedProductImage(uploadedStoragePath);
        throw error;
      }
    },
    onSuccess: async ({ saved, previousStoragePath }) => {
      const savedStoragePath = storagePathFromProductImageUrl(saved.imageUrl);
      if (previousStoragePath && previousStoragePath !== savedStoragePath) {
        await deleteUploadedProductImage(previousStoragePath);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storefrontProducts }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory })
      ]);
      onClose();
    }
  });

  return (
    <Modal isOpen={true} onClose={onClose} ariaLabelledBy="product-form-title" maxWidth="2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="product-form-title" className="font-display text-3xl font-black text-ink-950">
            {product ? 'Editar producto' : 'Nuevo producto'}
          </h2>
          <p className="mt-1 text-[14.5px] font-medium text-ink-700">
            Completá los datos visibles en la tienda y la información de reposición.
          </p>
        </div>
        <button
          type="button"
          className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition"
          onClick={onClose}
          aria-label="Cerrar"
        >
          <X className="size-5" />
        </button>
      </div>

      <form
        className="mt-6 space-y-6"
        onSubmit={handleSubmit((values) => save.mutate(values))}
        noValidate
      >
          {/* SECCIÓN 1: DATOS BÁSICOS (Siempre visible) */}
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nombre del suplemento" error={errors.name?.message}>
                <Input
                  placeholder="Ej. Creatina Monohidratada"
                  {...register('name')}
                  onBlur={handleNameBlur}
                />
              </Field>
              <Field
                label="Presentación"
                error={errors.presentation?.message}
                hint="Envase o sabor"
              >
                <Input placeholder="Ej. 300 g · Sin sabor" {...register('presentation')} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Categoría" error={errors.category?.message}>
                <Input placeholder="Ej. Rendimiento, Proteínas…" {...register('category')} />
              </Field>

              {pricing ? (
                <Field
                  label="Precio de venta al público (ARS)"
                  error={errors.pricePesos?.message}
                >
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="25000"
                    {...register('pricePesos', { valueAsNumber: true })}
                  />
                </Field>
              ) : null}
            </div>

            <Field label="Descripción comercial" error={errors.description?.message}>
              <Textarea
                className="min-h-[6.5rem]"
                placeholder="Breve descripción del producto para la tienda pública…"
                {...register('description')}
              />
            </Field>

            {/* Imagen del producto */}
            <div className="rounded-2xl border border-ink-950/8 bg-cream-50 p-4">
              <p className="text-xs font-black uppercase tracking-wider text-ink-600 mb-3">
                Imagen del producto
              </p>
              <div className="grid gap-4 sm:grid-cols-[6rem_1fr] sm:items-center">
                <div className="aspect-square size-24 overflow-hidden rounded-2xl bg-cream-100 border border-ink-950/10">
                  {currentImageUrl ? (
                    <img src={currentImageUrl} alt="Vista previa" className="size-full object-cover" />
                  ) : (
                    <div className="grid size-full place-items-center text-ink-400">
                      <ImageIcon className="size-6 text-ink-600/40" />
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/avif"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setImageError(null);
                      if (!file) return;
                      try {
                        validateProductImageFile(file);
                        if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
                        const preview = URL.createObjectURL(file);
                        setImagePreviewUrl(preview);
                        setImageFile(file);
                        setValue('imageUrl', preview, { shouldValidate: true });
                      } catch (error) {
                        setImageError(error);
                        event.target.value = '';
                      }
                    }}
                  />
                  <p className="text-[13px] font-medium text-ink-600">
                    JPG, PNG, WebP o AVIF (hasta 12 MB). El navegador la optimiza automáticamente.
                  </p>
                </div>
              </div>
              {imageError ? <div className="mt-3"><ErrorState error={imageError} /></div> : null}
            </div>
          </div>

          {/* SECCIÓN 2: FINANZAS (Solo Dueña) */}
          {pricing ? (
            <div className="rounded-2xl border border-brand-200/60 bg-brand-50 p-4">
              <span className="block text-[14.5px] font-bold text-ink-950 mb-2">
                Costo y finanzas (solo dueña)
              </span>
              <Field
                label="Costo unitario de adquisición actual (ARS)"
                error={errors.costPesos?.message}
                hint="Se usará como costo base para compras y márgenes estimados."
              >
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="15000"
                  {...register('costPesos', { valueAsNumber: true })}
                />
              </Field>
            </div>
          ) : (
            <div className="rounded-2xl bg-cream-100 p-3.5 text-sm font-medium text-ink-700">
              Podés editar la información del catálogo. Los costos y márgenes financieros están reservados para la dueña.
            </div>
          )}

          {/* SECCIÓN 3: CONFIGURACIÓN AVANZADA Y REPOSICIÓN (Colapsable / Bajo Demanda) */}
          <div className="border-t border-ink-950/8 pt-4">
            <button
              type="button"
              className="flex w-full items-center justify-between py-2 text-left font-display text-sm font-black text-ink-800 hover:text-ink-950"
              onClick={() => setShowAdvanced((prev) => !prev)}
              aria-expanded={showAdvanced}
            >
              <span className="flex items-center gap-2">
                <Sliders className="size-4 text-brand-600" />
                Configuración avanzada de reposición y SKU
              </span>
              <ChevronDown
                className={`size-4 text-ink-600 transition-transform ${
                  showAdvanced ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showAdvanced ? (
              <div className="mt-4 space-y-4 rounded-2xl bg-cream-50 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="SKU / Código identificador"
                    error={errors.sku?.message}
                    hint="Identificador único del producto."
                  >
                    <Input className="uppercase" {...register('sku')} />
                  </Field>
                  <Field
                    label="Enlace web (slug)"
                    error={errors.slug?.message}
                    hint="Ruta pública (ej. creatina-300g)."
                  >
                    <Input {...register('slug')} />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Punto de pedido"
                    hint="Alerta de stock bajo"
                    error={errors.reorderPoint?.message}
                  >
                    <Input
                      type="number"
                      min="0"
                      {...register('reorderPoint', { valueAsNumber: true })}
                    />
                  </Field>
                  <Field
                    label="Stock seguridad"
                    hint="Reserva mínima"
                    error={errors.safetyStock?.message}
                  >
                    <Input
                      type="number"
                      min="0"
                      {...register('safetyStock', { valueAsNumber: true })}
                    />
                  </Field>
                  <Field
                    label="Lead time (días)"
                    hint="Días demora proveedor"
                    error={errors.leadTimeDays?.message}
                  >
                    <Input
                      type="number"
                      min="0"
                      {...register('leadTimeDays', { valueAsNumber: true })}
                    />
                  </Field>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-3 pt-2">
                  {[
                    ['published', 'Publicado', 'Visible en la tienda pública'],
                    ['featured', 'Destacado', 'Prioridad en portada'],
                    ['active', 'Activo', 'Habilitado para operar']
                  ].map(([name, title, description]) => (
                    <label
                      key={name}
                      className="flex items-start gap-2.5 rounded-xl border border-ink-950/10 bg-white p-3 cursor-pointer hover:border-ink-950/20"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-brand-600"
                        {...register(name as 'published' | 'featured' | 'active')}
                      />
                      <div>
                        <strong className="block text-xs font-black">{title}</strong>
                        <span className="text-[10px] text-ink-600 leading-tight block">
                          {description}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {save.error ? <ErrorState error={save.error} /> : null}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" variant="dark" loading={save.isPending}>
              Guardar producto
            </Button>
          </div>
        </form>
    </Modal>
  );
}

export default function ProductsPage() {
  const { user } = useAuth();
  const [editing, setEditing] = useState<AdminProduct | null | undefined>(undefined);
  const [search, setSearch] = useState('');
  const productsQuery = useBusinessQuery({
    queryKey: queryKeys.products,
    queryFn: (api) => api.listAdminProducts()
  });

  const filteredProducts = useMemo(() => {
    const list = productsQuery.data ?? [];
    if (!search.trim()) return list;
    const term = search.toLowerCase();
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        p.sku.toLowerCase().includes(term) ||
        p.category.toLowerCase().includes(term)
    );
  }, [productsQuery.data, search]);

  return (
    <div className="page-enter">
      <PageHeader
        title="Productos"
        description="Administrá los precios, presentaciones e imágenes de los productos de la tienda."
        action={
          can(user, 'manage_pricing') ? (
            <Button onClick={() => setEditing(null)}>
              <Plus className="size-4" /> Nuevo producto
            </Button>
          ) : undefined
        }
      />

      {/* Buscador de catálogo rápido */}
      <div className="mb-6 max-w-sm">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar producto o categoría…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-4 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {productsQuery.isPending ? <LoadingState label="Cargando productos…" /> : null}
      {productsQuery.isError ? (
        <ErrorState error={productsQuery.error} onRetry={() => void productsQuery.refetch()} />
      ) : null}

      {productsQuery.data ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredProducts.map((product) => {
            const available = product.onHand - product.reserved;
            const isOutOfStock = available <= 0;
            const isCritical = available > 0 && available <= product.safetyStock;
            const isLow = available > product.safetyStock && available <= product.reorderPoint;

            return (
              <article
                key={product.id}
                className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm transition hover:border-ink-950/20"
              >
                <div className="grid grid-cols-[5.5rem_1fr] gap-4 p-5">
                  <img
                    src={product.imageUrl}
                    alt={product.imageAlt}
                    className="aspect-square rounded-xl bg-cream-100 object-cover"
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-1.5">
                      {!product.active ? (
                        <StatusChip label="Archivado" tone="neutral" />
                      ) : null}
                      {!product.published ? (
                        <StatusChip label="Oculto" tone="warning" />
                      ) : null}
                    </div>
                    <h2 className="mt-1.5 truncate text-[17px] font-black text-ink-950">{product.name}</h2>
                    <p className="mt-0.5 text-[14.5px] font-semibold text-ink-700">{product.presentation}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 border-y border-ink-950/8 bg-cream-50/70 px-5 py-3.5">
                  <div>
                    <p className="text-[13px] font-black uppercase tracking-wider text-ink-700">
                      Precio
                    </p>
                    <p className="mt-0.5 font-display text-xl font-black text-ink-950">
                      {formatMoney(product.priceCents)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[13px] font-black uppercase tracking-wider text-ink-700">
                      Disponible
                    </p>
                    <p
                      className={cn(
                        'mt-0.5 font-display text-xl font-black',
                        isOutOfStock
                          ? 'text-red-700'
                          : isCritical
                          ? 'text-red-700'
                          : isLow
                          ? 'text-amber-700'
                          : 'text-ink-950'
                      )}
                    >
                      {available} {available === 0 ? '· Sin stock' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-end p-3 sm:px-5">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(product)}>
                    <Edit3 className="size-4" /> Editar
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      ) : null}

      {editing !== undefined ? (
        <ProductForm product={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </div>
  );
}
