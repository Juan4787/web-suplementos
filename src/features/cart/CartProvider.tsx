import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from 'react';
import type { CartLine, CheckoutData, StorefrontProduct } from '@/domain/types';

export const CART_STORAGE_KEY = 'impulso-cart-v2';
export const CART_SCHEMA_VERSION = 2;
export const CART_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas en milisegundos

export type CheckoutDraft = Partial<CheckoutData>;

export type ProtocolDraft = {
  orderId: string;
  fingerprint: string;
};

export type StoredCartV2 = {
  version: typeof CART_SCHEMA_VERSION;
  lastActivityAt: number;
  lines: CartLine[];
  checkoutDraft?: CheckoutDraft | undefined;
  protocolDraft?: ProtocolDraft | undefined;
};

export type CartRevalidationResult = {
  priceChanges: Array<{ name: string; oldPriceCents: number; newPriceCents: number }>;
  outOfStockProducts: string[];
  unavailableProducts: string[];
  partialStockProducts: Array<{ name: string; available: number; requested: number }>;
};

type CartContextValue = {
  lines: CartLine[];
  itemCount: number;
  subtotalCents: number;
  lastActivityAt: number;
  expiredNotice: string | null;
  dismissExpiredNotice: () => void;
  checkoutDraft: CheckoutDraft | null;
  updateCheckoutDraft: (draft: Partial<CheckoutDraft>) => void;
  protocolDraft: ProtocolDraft | null;
  setProtocolDraft: (draft: ProtocolDraft | null) => void;
  add: (product: StorefrontProduct, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  touchActivity: () => void;
  syncWithLiveCatalog: (products: StorefrontProduct[]) => CartRevalidationResult;
};

const CartContext = createContext<CartContextValue | null>(null);

const safeGetStorage = (): string | null => {
  try {
    return window.localStorage.getItem(CART_STORAGE_KEY);
  } catch {
    return null;
  }
};

const safeSetStorage = (value: string): void => {
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, value);
  } catch {
    // Si localStorage está bloqueado (navegación privada estricta), opera en memoria sin romper
  }
};

const safeRemoveStorage = (): void => {
  try {
    window.localStorage.removeItem(CART_STORAGE_KEY);
  } catch {
    // Silencioso
  }
};

const isExpired = (lastActivityAt: number, now = Date.now()): boolean => {
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return true;
  return now - lastActivityAt >= CART_TTL_MS;
};

const sanitizeQuantity = (quantity: number, max = 20): number => {
  if (!Number.isFinite(quantity)) return 1;
  return Math.max(1, Math.min(max, Math.floor(quantity)));
};

type InitialCartState = {
  lines: CartLine[];
  lastActivityAt: number;
  checkoutDraft: CheckoutDraft | null;
  protocolDraft: ProtocolDraft | null;
  wasExpired: boolean;
};

const readInitialCart = (): InitialCartState => {
  const now = Date.now();
  try {
    const raw = safeGetStorage();
    if (!raw) {
      return {
        lines: [],
        lastActivityAt: now,
        checkoutDraft: null,
        protocolDraft: null,
        wasExpired: false
      };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      safeRemoveStorage();
      return {
        lines: [],
        lastActivityAt: now,
        checkoutDraft: null,
        protocolDraft: null,
        wasExpired: false
      };
    }

    const data = parsed as Partial<StoredCartV2>;
    if (data.version !== CART_SCHEMA_VERSION || !Number.isFinite(data.lastActivityAt)) {
      safeRemoveStorage();
      return {
        lines: [],
        lastActivityAt: now,
        checkoutDraft: null,
        protocolDraft: null,
        wasExpired: false
      };
    }

    if (isExpired(data.lastActivityAt!, now)) {
      safeRemoveStorage();
      return {
        lines: [],
        lastActivityAt: now,
        checkoutDraft: null,
        protocolDraft: null,
        wasExpired: (data.lines?.length ?? 0) > 0
      };
    }

    const validLines: CartLine[] = Array.isArray(data.lines)
      ? data.lines.filter(
          (line): line is CartLine =>
            typeof line === 'object' &&
            line !== null &&
            typeof line.productId === 'string' &&
            typeof line.name === 'string' &&
            Number.isSafeInteger(line.unitPriceCents) &&
            line.unitPriceCents >= 0 &&
            Number.isSafeInteger(line.quantity) &&
            line.quantity > 0
        ).map((line) => ({
          ...line,
          quantity: sanitizeQuantity(line.quantity)
        }))
      : [];

    return {
      lines: validLines,
      lastActivityAt: data.lastActivityAt!,
      checkoutDraft: data.checkoutDraft ?? null,
      protocolDraft: data.protocolDraft ?? null,
      wasExpired: false
    };
  } catch {
    safeRemoveStorage();
    return {
      lines: [],
      lastActivityAt: now,
      checkoutDraft: null,
      protocolDraft: null,
      wasExpired: false
    };
  }
};

export function CartProvider({ children }: PropsWithChildren) {
  const [initial] = useState(readInitialCart);
  const [lines, setLines] = useState<CartLine[]>(initial.lines);
  const [lastActivityAt, setLastActivityAt] = useState<number>(initial.lastActivityAt);
  const [checkoutDraft, setCheckoutDraft] = useState<CheckoutDraft | null>(initial.checkoutDraft);
  const [protocolDraft, setProtocolDraftState] = useState<ProtocolDraft | null>(initial.protocolDraft);
  const [expiredNotice, setExpiredNotice] = useState<string | null>(
    initial.wasExpired ? 'Tu carrito anterior venció después de 24 horas sin actividad.' : null
  );

  // Persistir en localStorage únicamente cuando hay estado activo
  useEffect(() => {
    if (lines.length === 0 && !checkoutDraft && !protocolDraft) {
      safeRemoveStorage();
      return;
    }
    const payload: StoredCartV2 = {
      version: CART_SCHEMA_VERSION,
      lastActivityAt,
      lines,
      checkoutDraft: checkoutDraft ?? undefined,
      protocolDraft: protocolDraft ?? undefined
    };
    safeSetStorage(JSON.stringify(payload));
  }, [lines, lastActivityAt, checkoutDraft, protocolDraft]);

  // Expiración por inactividad
  const checkExpiration = useCallback((explicitNow = Date.now()): boolean => {
    if (lines.length === 0) return false;
    if (isExpired(lastActivityAt, explicitNow)) {
      setLines([]);
      setCheckoutDraft(null);
      setProtocolDraftState(null);
      setLastActivityAt(explicitNow);
      safeRemoveStorage();
      setExpiredNotice('Tu carrito anterior venció después de 24 horas sin actividad.');
      return true;
    }
    return false;
  }, [lastActivityAt, lines.length]);

  // Comprobar expiración al volver de segundo plano / cambiar de pestaña / recuperar foco
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkExpiration();
      }
    };
    const handleFocus = () => {
      checkExpiration();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== CART_STORAGE_KEY) return;
      if (!event.newValue) {
        setLines([]);
        setCheckoutDraft(null);
        setProtocolDraftState(null);
        return;
      }
      try {
        const updated = JSON.parse(event.newValue) as StoredCartV2;
        if (updated.version === CART_SCHEMA_VERSION) {
          if (isExpired(updated.lastActivityAt)) {
            setLines([]);
            setCheckoutDraft(null);
            setProtocolDraftState(null);
            safeRemoveStorage();
            setExpiredNotice('Tu carrito anterior venció después de 24 horas sin actividad.');
          } else {
            setLines(updated.lines ?? []);
            setLastActivityAt(updated.lastActivityAt);
            setCheckoutDraft(updated.checkoutDraft ?? null);
            setProtocolDraftState(updated.protocolDraft ?? null);
          }
        }
      } catch {
        // Ignorar eventos corruptos
      }
    };

    window.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('storage', handleStorage);
    };
  }, [checkExpiration]);

  const touchActivity = useCallback(() => {
    setLastActivityAt(Date.now());
  }, []);

  const updateCheckoutDraft = useCallback((draft: Partial<CheckoutDraft>) => {
    const now = Date.now();
    setLastActivityAt(now);
    setCheckoutDraft((current) => {
      const isChanged = Object.entries(draft).some(
        ([key, val]) => (current as Record<string, unknown> | null)?.[key] !== val
      );
      if (isChanged) {
        setProtocolDraftState(null);
      }
      return {
        ...(current ?? {}),
        ...draft
      };
    });
  }, []);

  const setProtocolDraft = useCallback((draft: ProtocolDraft | null) => {
    setProtocolDraftState(draft);
    try {
      const raw = safeGetStorage();
      if (raw) {
        const parsed = JSON.parse(raw) as StoredCartV2;
        parsed.protocolDraft = draft ?? undefined;
        safeSetStorage(JSON.stringify(parsed));
      }
    } catch {
      // Ignorar errores de almacenamiento
    }
  }, []);

  const add = useCallback((product: StorefrontProduct, quantity = 1) => {
    if (product.maxOrderQuantity <= 0) return;
    const now = Date.now();
    setLastActivityAt(now);
    setProtocolDraftState(null); // Modificar carrito invalida el protocolo generado anterior
    setLines((current) => {
      const existing = current.find((line) => line.productId === product.id);
      const nextQuantity = Math.min(
        product.maxOrderQuantity,
        Math.max(1, (existing?.quantity ?? 0) + sanitizeQuantity(quantity))
      );
      const next: CartLine = {
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents: product.priceCents,
        quantity: nextQuantity
      };
      return existing
        ? current.map((line) => (line.productId === product.id ? next : line))
        : [...current, next];
    });
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    const now = Date.now();
    setLastActivityAt(now);
    setProtocolDraftState(null); // Modificar cantidad invalida el protocolo anterior
    if (quantity <= 0) {
      setLines((current) => {
        const next = current.filter((line) => line.productId !== productId);
        if (next.length === 0) {
          setProtocolDraftState(null);
        }
        return next;
      });
      return;
    }
    setLines((current) =>
      current.map((line) =>
        line.productId === productId
          ? { ...line, quantity: sanitizeQuantity(quantity) }
          : line
      )
    );
  }, []);

  const remove = useCallback((productId: string) => {
    const now = Date.now();
    setLastActivityAt(now);
    setProtocolDraftState(null);
    setLines((current) => {
      const next = current.filter((line) => line.productId !== productId);
      if (next.length === 0) {
        setProtocolDraftState(null);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    const now = Date.now();
    setLastActivityAt(now);
    setLines([]);
    setCheckoutDraft(null);
    setProtocolDraftState(null);
    safeRemoveStorage();
  }, []);

  const dismissExpiredNotice = useCallback(() => {
    setExpiredNotice(null);
  }, []);

  // Revalidación visual en vivo contra el catálogo de la base de datos
  const syncWithLiveCatalog = useCallback(
    (catalogProducts: StorefrontProduct[]): CartRevalidationResult => {
      const result: CartRevalidationResult = {
        priceChanges: [],
        outOfStockProducts: [],
        unavailableProducts: [],
        partialStockProducts: []
      };

      if (lines.length === 0 || catalogProducts.length === 0) return result;

      let hasLinePriceChange = false;
      const updated = lines.map((line) => {
        const current = catalogProducts.find((p) => p.id === line.productId);
        if (!current) {
          result.unavailableProducts.push(line.name);
          return line;
        }

        if (current.availability === 'out_of_stock' || current.maxOrderQuantity <= 0) {
          result.outOfStockProducts.push(line.name);
        } else if (line.quantity > current.maxOrderQuantity) {
          result.partialStockProducts.push({
            name: line.name,
            available: current.maxOrderQuantity,
            requested: line.quantity
          });
        }

        if (current.priceCents !== line.unitPriceCents) {
          result.priceChanges.push({
            name: line.name,
            oldPriceCents: line.unitPriceCents,
            newPriceCents: current.priceCents
          });
          hasLinePriceChange = true;
          return {
            ...line,
            unitPriceCents: current.priceCents
          };
        }

        return line;
      });

      if (hasLinePriceChange) {
        setLines(updated);
        setProtocolDraftState(null);
      }

      return result;
    },
    [lines]
  );

  const value = useMemo<CartContextValue>(
    () => ({
      lines,
      itemCount: lines.reduce((total, line) => total + line.quantity, 0),
      subtotalCents: lines.reduce(
        (total, line) => total + line.quantity * line.unitPriceCents,
        0
      ),
      lastActivityAt,
      expiredNotice,
      dismissExpiredNotice,
      checkoutDraft,
      updateCheckoutDraft,
      protocolDraft,
      setProtocolDraft,
      add,
      setQuantity,
      remove,
      clear,
      touchActivity,
      syncWithLiveCatalog
    }),
    [
      lines,
      lastActivityAt,
      expiredNotice,
      dismissExpiredNotice,
      checkoutDraft,
      updateCheckoutDraft,
      protocolDraft,
      setProtocolDraft,
      add,
      setQuantity,
      remove,
      clear,
      touchActivity,
      syncWithLiveCatalog
    ]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = (): CartContextValue => {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart debe usarse dentro de CartProvider.');
  return context;
};


