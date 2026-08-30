---
name: vercel-react-best-practices
description: >-
  Optimize React and Next.js architecture. Use when structuring React/Next.js applications, managing Server Components (RSC) vs Client Components, data fetching, streaming with Suspense, caching, and Vercel performance.
---

# Vercel & React Best Practices

Architectural and performance standards for React and Next.js applications deployed on modern serverless/edge infrastructure.

## 1. Server Components (RSC) vs Client Components

- **Default to Server Components**: Keep data fetching, database queries, and heavy dependencies on the server to reduce JavaScript bundle size.
- **Push `'use client'` to the Leaves**: Only mark components with `'use client'` when they require:
  - React hooks (`useState`, `useEffect`, `useContext`, `useReducer`).
  - Browser APIs (`localStorage`, `window`, `navigator`, geolocation).
  - User event listeners (`onClick`, `onChange`, `onSubmit`).

```tsx
// ✅ Good: Server Component fetches data and passes to client leaf
// app/products/page.tsx (Server)
import { ProductList } from './ProductList';
import { FilterBar } from './FilterBar'; // Client component

export default async function Page() {
  const products = await db.products.findMany();
  return (
    <main>
      <FilterBar />
      <ProductList items={products} />
    </main>
  );
}
```

## 2. Streaming with Suspense & Instant Loading States

- Wrap dynamic server components in `<Suspense>` with skeleton fallbacks to avoid blocking page navigation.
- Implement parallel data fetching with `Promise.all` or independent Suspense boundaries:

```tsx
import { Suspense } from 'react';
import { ProductSkeleton } from '@/components/skeletons';

export default function Catalog() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <Suspense fallback={<ProductSkeleton count={6} />}>
        <AsyncProductGrid />
      </Suspense>
    </div>
  );
}
```

## 3. Data Fetching & Caching Strategy

- **Deduplication**: Native `fetch` requests with the same URL and options in the same render tree are automatically memoized.
- **Revalidation & Tags**: Use `next: { tags: ['products'], revalidate: 3600 }` and call `revalidateTag('products')` in Server Actions after mutations.
- **Optimistic UI**: Use `useOptimistic` hook for immediate UI feedback on actions before server confirmation.

## 4. Performance & Core Web Vitals Optimization

1. **Images**: Always use `@next/image` or responsive `<img loading="lazy" srcset="..." />` with explicit dimensions (`width`, `height`) to eliminate Cumulative Layout Shift (CLS).
2. **Fonts**: Use `next/font/google` or `next/font/local` to eliminate render-blocking external font requests.
3. **Dynamic Imports**: Code-split large dependencies (charts, heavy editors, canvas tools) using `dynamic(() => import('./HeavyChart'), { ssr: false })`.
4. **Avoid Waterfall Requests**: Never await asynchronous calls sequentially if they can run concurrently.
