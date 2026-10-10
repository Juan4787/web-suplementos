import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';
import { DialogDepth, getTopDialogDepth } from './use-dialog-focus';

export type ConfirmationOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
type Request = ConfirmationOptions & { owner: string; depth: number; resolve: (accepted: boolean) => void };
type ConfirmationApi = {
  ask: (owner: string, options: ConfirmationOptions) => Promise<boolean>;
  cancel: (owner: string) => void;
};
const ConfirmationContext = createContext<ConfirmationApi | null>(null);

function ConfirmationDialog({ request, finish }: { request: Request; finish: (accepted: boolean) => void }) {
  const titleId = useId();
  const safeAction = useRef<HTMLButtonElement>(null);
  useEffect(() => { safeAction.current?.focus(); }, []);
  return <DialogDepth.Provider value={request.depth}>
    <Modal maxWidth="md" ariaLabelledBy={titleId} ariaDescribedBy={titleId + '-description'} onClose={() => finish(false)}>
      <h2 id={titleId} className="font-display text-2xl font-black text-ink-950">{request.title}</h2>
      <p id={titleId + '-description'} className="mt-3 text-sm leading-relaxed text-ink-700">{request.description}</p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => finish(true)}>{request.confirmLabel ?? 'Descartar'}</Button>
        <Button ref={safeAction} variant="dark" onClick={() => finish(false)}>{request.cancelLabel ?? 'Seguir editando'}</Button>
      </div>
    </Modal>
  </DialogDepth.Provider>;
}

/** One explicit decision at a time. Closing, unmounting or Escape never discard. */
export function AppConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const active = useRef<Request | null>(null);
  const finish = useCallback((accepted: boolean) => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    setRequest(null);
    current.resolve(accepted);
  }, []);
  const ask = useCallback((owner: string, options: ConfirmationOptions) => {
    if (active.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const next = { ...options, owner, depth: getTopDialogDepth(), resolve };
      active.current = next;
      setRequest(next);
    });
  }, []);
  const cancel = useCallback((owner: string) => {
    if (active.current?.owner === owner) finish(false);
  }, [finish]);
  const api = useMemo(() => ({ ask, cancel }), [ask, cancel]);
  useEffect(() => () => {
    active.current?.resolve(false);
    active.current = null;
  }, []);
  return <ConfirmationContext.Provider value={api}>
    {children}
    {request ? <ConfirmationDialog request={request} finish={finish} /> : null}
  </ConfirmationContext.Provider>;
}

export function useAppConfirmation() {
  const api = useContext(ConfirmationContext);
  const owner = useId();
  if (!api) throw new Error('AppConfirmationProvider is required');
  const { ask, cancel } = api;
  useEffect(() => () => cancel(owner), [cancel, owner]);
  return useCallback((options: ConfirmationOptions) => ask(owner, options), [ask, owner]);
}
