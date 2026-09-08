import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** Position portalled controls within the viewport, outside a modal's scroll clipping. */
export function usePopoverPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  { align = 'left', minWidth = 0, maxHeight = 320, centerOnMobile = false }:
    { align?: 'left' | 'right'; minWidth?: number; maxHeight?: number; centerOnMobile?: boolean } = {}
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchor.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const vw = viewport?.width ?? window.innerWidth;
      const vh = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const width = Math.min(Math.max(rect.width, minWidth), vw - 32);
      if (centerOnMobile && vw < 640) {
        setPosition({ position: 'fixed', width, left: (vw - width) / 2, top: offsetTop + vh / 2,
          transform: 'translateY(-50%)', maxHeight: vh - 32, zIndex: 70 });
        return;
      }
      const below = offsetTop + vh - rect.bottom - 16;
      const above = rect.top - offsetTop - 16;
      const flip = below < maxHeight && above > below;
      const left = Math.max(16, Math.min(align === 'right' ? rect.right - width : rect.left, vw - width - 16));
      setPosition({ position: 'fixed', width, left, zIndex: 70,
        maxHeight: Math.max(60, Math.min(maxHeight, (flip ? above : below) - 6)),
        ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open, anchor, align, minWidth, maxHeight, centerOnMobile]);
  return position;
}
