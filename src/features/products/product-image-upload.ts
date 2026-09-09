import { appEnv } from '@/app/env';
import { AppError } from '@/domain/errors';
import { getSupabaseClient } from '@/lib/supabase';

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 80_000_000;
const MAX_EDGE_PIXELS = 1_600;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export const validateProductImageFile = (file: Pick<File, 'size' | 'type'>): void => {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new AppError('validation', 'Ese formato de imagen no es compatible.', {
      nextAction: 'Elegí una imagen JPG, PNG, WebP o AVIF.'
    });
  }
  if (file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
    throw new AppError('validation', 'La imagen es demasiado pesada.', {
      nextAction: 'Elegí un archivo de hasta 12 MB.'
    });
  }
};

const canvasBlob = async (
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number
): Promise<Blob> => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new AppError('unexpected', 'No pudimos preparar la imagen.');
  context.fillStyle = '#f8f4e9';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') throw new AppError('validation', 'Este navegador no pudo preparar la imagen.', { nextAction: 'Actualizá el navegador o probá cargarla desde otro dispositivo.' });
  return blob;
};

export const optimizeProductImage = async (file: File): Promise<Blob> => {
  validateProductImageFile(file);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new AppError('validation', 'No pudimos abrir esa imagen.', {
      cause,
      nextAction: 'Comprobá que el archivo no esté dañado.'
    });
  }
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
      throw new AppError('validation', 'La imagen tiene dimensiones demasiado grandes.', {
        nextAction: 'Reducila antes de volver a cargarla.'
      });
    }
    const scale = Math.min(1, MAX_EDGE_PIXELS / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    let quality = 0.84;
    let output = await canvasBlob(bitmap, width, height, quality);
    for (let attempt = 0; output.size > MAX_OUTPUT_BYTES && attempt < 3; attempt += 1) {
      quality -= 0.12;
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
      output = await canvasBlob(bitmap, width, height, quality);
    }
    if (output.size > MAX_OUTPUT_BYTES) {
      throw new AppError('validation', 'No pudimos reducir la imagen lo suficiente.', {
        nextAction: 'Elegí una imagen con menos detalle o menor tamaño.'
      });
    }
    return output;
  } finally {
    bitmap.close();
  }
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AppError('unexpected', 'No pudimos preparar la vista previa.'));
    reader.readAsDataURL(blob);
  });

export type UploadedProductImage = { url: string; storagePath: string | null };

export const productImageUploadError = (error: unknown): AppError => {
  const detail = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const status = Number(detail.statusCode ?? detail.status);
  const code = String(detail.code ?? '');
  // Inspect internal metadata only for classification; never display it.
  const message = String(detail.message ?? '');
  if (status === 401 || /InvalidJWT|JWTExpired/i.test(code) || /jwt.*(?:expired|invalid)/i.test(message)) {
    return new AppError('auth', 'Tu sesión venció y no pudimos subir la imagen.', { cause: error, nextAction: 'Volvé a iniciar sesión y cargá la imagen nuevamente.' });
  }
  if (status === 403 || /AccessDenied|Unauthorized/i.test(code) || /row.level security|permission denied/i.test(message)) {
    return new AppError('permission', 'Tu cuenta no tiene permiso para subir esta imagen.', { cause: error, nextAction: 'Pedile a la dueña que revise tu acceso antes de volver a intentarlo.' });
  }
  if (status === 413 || /EntityTooLarge/i.test(code)) {
    return new AppError('validation', 'La imagen supera el tamaño permitido.', { cause: error, nextAction: 'Elegí una imagen más pequeña y volvé a cargarla.' });
  }
  if (status === 415 || /InvalidMimeType/i.test(code)) {
    return new AppError('validation', 'No pudimos guardar el formato de esta imagen.', { cause: error, nextAction: 'Probá con otra imagen JPG, PNG, WebP o AVIF.' });
  }
  return new AppError('temporary', 'No pudimos subir la imagen en este momento.', { cause: error, retryable: true, nextAction: 'Revisá tu conexión e intentá de nuevo. Si continúa, probá más tarde.' });
};

export const uploadProductImage = async (file: File): Promise<UploadedProductImage> => {
  const optimized = await optimizeProductImage(file);
  if (appEnv.mode === 'demo') {
    return { url: await blobToDataUrl(optimized), storagePath: null };
  }
  if (appEnv.mode !== 'supabase') {
    throw new AppError('configuration', 'La aplicación todavía no está conectada a la tienda.');
  }
  const storagePath = `catalog/${crypto.randomUUID()}.webp`;
  const bucket = getSupabaseClient().storage.from('product-images');
  const { error } = await bucket.upload(storagePath, optimized, {
    cacheControl: '31536000',
    contentType: 'image/webp',
    upsert: false
  }).catch(error => { throw productImageUploadError(error); });
  if (error) {
    throw productImageUploadError(error);
  }
  const { data } = bucket.getPublicUrl(storagePath);
  return { url: data.publicUrl, storagePath };
};

export const storagePathFromProductImageUrl = (url: string): string | null => {
  const marker = '/storage/v1/object/public/product-images/';
  const markerIndex = url.indexOf(marker);
  if (markerIndex < 0) return null;
  const path = decodeURIComponent(url.slice(markerIndex + marker.length));
  return /^catalog\/[0-9a-f-]{36}\.webp$/u.test(path) ? path : null;
};

export const deleteUploadedProductImage = async (storagePath: string | null): Promise<void> => {
  if (!storagePath || appEnv.mode !== 'supabase') return;
  await getSupabaseClient().storage.from('product-images').remove([storagePath]);
};
