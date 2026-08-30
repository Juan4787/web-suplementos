---
name: interface-design
description: >-
  Improve UI aesthetics and usability. Use when designing, styling, refining visual hierarchy, typography, color systems, responsive layouts, micro-interactions, and accessibility (a11y) in web applications.
---

# Interface Design & Aesthetics

Design systems, visual hierarchy, micro-interactions, and accessibility guidelines to create modern, responsive, and visually stunning user interfaces.

## 1. Visual Hierarchy & Design Tokens

### Color Palettes & Contrast
- **Backgrounds**: Deep dark tones (`#09090b`, `#121214`) or clean light tones (`#fafafa`, `#ffffff`).
- **Surfaces**: Distinct elevated surfaces with subtle borders (`rgba(255, 255, 255, 0.08)` or `border-zinc-800`).
- **Accents**: High-vibrancy accent colors (e.g. Electric Emerald `#10b981`, Indigo `#6366f1`, Amber `#f59e0b`).
- **Text Contrast**: Meet WCAG 2.1 AA ratio (minimum 4.5:1 for body text, 3:1 for large text).
  - Primary text: `text-zinc-100` / `#f4f4f5`
  - Muted/Secondary text: `text-zinc-400` / `#a1a1aa`

### Typography Hierarchy
- Use modern sans-serif fonts: `Inter`, `Outfit`, `Plus Jakarta Sans`, or `Geist`.
- Clear scale ratio:
  - Hero Title: `text-4xl md:text-5xl font-extrabold tracking-tight`
  - Section Header: `text-2xl md:text-3xl font-bold`
  - Card Title: `text-lg font-semibold`
  - Body: `text-sm md:text-base leading-relaxed`
  - Meta/Badge: `text-xs font-medium tracking-wide uppercase`

## 2. Spatial Rhythm & Layouts

- **8pt Grid System**: Consistent spacing using multiples of 4px/8px (`gap-2`, `gap-4`, `p-4`, `p-6`, `p-8`).
- **Glassmorphism & Elevation**:
  ```css
  .glass-card {
    background: rgba(24, 24, 27, 0.65);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
  }
  ```

## 3. Micro-Interactions & Transitions

- Smooth state changes: `transition-all duration-200 ease-out`
- Interactive buttons with active feedback:
  ```css
  .btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 20px -2px rgba(99, 102, 241, 0.4);
  }
  .btn-primary:active {
    transform: translateY(0);
    scale: 0.98;
  }
  ```
- Skeletons and shimmer loading states over plain spinners for perceived performance.

## 4. Accessibility (a11y) Best Practices

1. **Semantic HTML**: `<header>`, `<main>`, `<nav>`, `<section>`, `<article>`, `<footer>`.
2. **Keyboard Navigation**: Ensure all interactive elements have visible focus rings (`focus-visible:ring-2 focus-visible:ring-offset-2`).
3. **ARIA Labels**: `aria-label`, `aria-expanded`, `aria-describedby` on custom controls.
4. **Touch targets**: Minimum 44x44px clickable area on mobile screens.
