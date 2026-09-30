import { createContext, useContext, useId, useLayoutEffect, useRef } from 'react';

export const DialogDepth = createContext(0);

type Surface = { depth: number; id: string; root: HTMLElement; panel: HTMLElement; close: () => void };
const surfaces: Surface[] = [];
const originalInert = new Map<HTMLElement, string | null>();
let originalOverflow = '';

const popovers = (surface: Surface) => [...document.querySelectorAll<HTMLElement>('[data-modal-popover]')]
  .filter(element => element.dataset.dialogOwner === surface.id);
const contains = (surface: Surface, target: Node) => surface.panel.contains(target) ||
  popovers(surface).some(popover => popover.contains(target));

const refreshInert = () => {
  const top = surfaces.at(-1);
  if (!top) return;
  surfaces.forEach((surface, index) => { surface.root.style.zIndex = String(52 + index * 2); });
  for (const node of document.body.children) {
    if (!(node instanceof HTMLElement)) continue;
    if (!originalInert.has(node)) originalInert.set(node, node.getAttribute('inert'));
    const allowed = node === top?.root || (node.hasAttribute('data-modal-popover') && node.dataset.dialogOwner === top?.id);
    if (allowed) node.removeAttribute('inert'); else node.setAttribute('inert', '');
  }
};

const tabbables = (surface: Surface): HTMLElement[] => [surface.panel, ...popovers(surface)].flatMap(root =>
  [...root.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')].filter(element => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[inert],[hidden]')) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  })
);

/** One focus owner and one scroll lock across modal/drawer nesting. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const id = useId();
  const depth = useContext(DialogDepth) + 1;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!open || !root.current || !panel.current) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface: Surface = { depth, id, root: root.current, panel: panel.current, close: () => close.current() };
    if (surfaces.length === 0) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    surfaces.push(surface);
    surfaces.sort((a, b) => a.depth - b.depth);
    surface.root.style.zIndex = String(50 + surfaces.length * 2);
    refreshInert();
    surface.panel.focus();
    const observer = new MutationObserver(refreshInert);
    observer.observe(document.body, { childList: true });
    const focus = (event: FocusEvent) => {
      if (surfaces.at(-1) === surface && event.target instanceof Node && !contains(surface, event.target)) surface.panel.focus();
    };
    const click = (event: MouseEvent) => {
      if (surfaces.at(-1) === surface && event.target instanceof Node && !surface.root.contains(event.target) && !contains(surface, event.target)) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (surfaces.at(-1) !== surface) return;
      if (event.key === 'Escape') {
        if (popovers(surface).length) return;
        event.preventDefault(); event.stopPropagation(); surface.close();
      } else if (event.key === 'Tab') {
        const elements = tabbables(surface);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (!elements.length) { event.preventDefault(); surface.panel.focus(); }
        else if (index < 0 || (event.shiftKey ? index === 0 : index === elements.length - 1)) {
          event.preventDefault(); (event.shiftKey ? elements.at(-1)! : elements[0]!).focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('click', click, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('click', click, true);
      surfaces.splice(surfaces.indexOf(surface), 1);
      if (surfaces.length) refreshInert(); else {
        document.body.style.overflow = originalOverflow;
        for (const [node, value] of originalInert) {
          if (value === null) node.removeAttribute('inert'); else node.setAttribute('inert', value);
        }
        originalInert.clear();
      }
      const top = surfaces.at(-1);
      if (previous?.isConnected && (!top || contains(top, previous))) previous.focus(); else top?.panel.focus();
    };
  }, [open, id, depth]);
  return { root, panel, id, depth, closeTop: () => { if (surfaces.at(-1)?.id === id) close.current(); } };
}
