---
name: shadcn
description: >-
  Manages shadcn components and projects — adding, searching, fixing, debugging, styling, and integrating shadcn/ui, shadcn-svelte, and Tailwind CSS components.
---

# shadcn/ui Component Management

Guidelines and patterns for initializing, adding, customizing, and debugging shadcn/ui and Radix UI components with Tailwind CSS.

## 1. Installation & Setup

### CLI Commands
```bash
# Initialize shadcn/ui in a React / Vite / Next.js project
npx shadcn@latest init

# Add components
npx shadcn@latest add button card dialog dropdown-menu input table toast avatar badge
```

### Configuration (`components.json`)
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.js",
    "css": "src/index.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

## 2. The `cn` Utility Pattern

Always use `clsx` and `tailwind-merge` to combine conditional and overridden classes:

```typescript
// src/lib/utils.ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

## 3. Class Variance Authority (CVA) for Variants

```typescript
import { cva, type VariantProps } from "class-variance-authority"

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none ring-offset-background",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "underline-offset-4 hover:underline text-primary",
      },
      size: {
        default: "h-10 py-2 px-4",
        sm: "h-9 px-3 rounded-md",
        lg: "h-11 px-8 rounded-md",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
```

## 4. Debugging & Customization Best Practices

- **Component Override**: shadcn copies source code directly into your repository (`src/components/ui`). Edit them directly rather than fighting abstractions.
- **Radix UI Portal Z-Index**: Ensure modal dialogs and dropdown menus have higher z-indexes than fixed headers (`z-50`).
- **Form Integration**: Pair with React Hook Form and Zod using shadcn's `<Form />` primitives for declarative validation.
