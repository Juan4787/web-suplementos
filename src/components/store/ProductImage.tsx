import { useState, type ImgHTMLAttributes } from 'react';

export const PRODUCT_PLACEHOLDER = '/product-placeholder.svg';

export function ProductImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const [failedSource, setFailedSource] = useState<string>();
  const source = src?.trim() || PRODUCT_PLACEHOLDER;
  return (
    <img
      {...props}
      src={source === failedSource ? PRODUCT_PLACEHOLDER : source}
      alt={alt || 'Imagen del producto'}
      onError={() => setFailedSource(source)}
    />
  );
}
