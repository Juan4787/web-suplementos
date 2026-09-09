import { describe, expect, it } from 'vitest';
import { AppError } from '@/domain/errors';
import { productImageUploadError, storagePathFromProductImageUrl, validateProductImageFile } from './product-image-upload';

describe('product image upload guard', () => {
  it.each([
    [{ statusCode: '403', message: 'new row violates row-level security policy' }, 'permission', /permisos de tu cuenta/],
    [{ statusCode: '401', message: 'JWT expired' }, 'auth', /iniciar sesión/],
    [{ statusCode: '413' }, 'validation', /más pequeña/],
    [{ code: 'InvalidMimeType' }, 'validation', /otra imagen/],
    [new Error('Failed to fetch'), 'temporary', /conexión/]
  ])('indica la acción correcta para %j', (error, kind, action) => {
    const result = productImageUploadError(error);
    expect(result.kind).toBe(kind);
    expect(result.nextAction).toMatch(action as RegExp);
    expect(result.message).not.toMatch(/JWT|policy|403|fetch/);
  });
  it('accepts supported browser image formats within the source limit', () => {
    expect(() => validateProductImageFile({ type: 'image/jpeg', size: 2_000_000 })).not.toThrow();
    expect(() => validateProductImageFile({ type: 'image/avif', size: 500_000 })).not.toThrow();
  });

  it('rejects unsupported or oversized files with a human error', () => {
    expect(() => validateProductImageFile({ type: 'image/svg+xml', size: 10_000 })).toThrow(AppError);
    expect(() => validateProductImageFile({ type: 'image/png', size: 13 * 1024 * 1024 })).toThrow('pesada');
  });

  it('only recognizes paths inside the product image bucket', () => {
    expect(storagePathFromProductImageUrl('https://example.supabase.co/storage/v1/object/public/product-images/catalog/123e4567-e89b-42d3-a456-426614174000.webp')).toBe('catalog/123e4567-e89b-42d3-a456-426614174000.webp');
    expect(storagePathFromProductImageUrl('https://example.test/unrelated.webp')).toBeNull();
  });
});
