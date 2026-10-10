import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConfirmationProvider, useAppConfirmation } from './AppConfirmation';
import { Modal } from './Modal';

afterEach(cleanup);
const options = { title: '¿Descartar la edición?', description: 'Los cambios sin guardar se perderán.' };
function Editor({ onDecision }: { onDecision: (accepted: boolean) => void }) {
  const ask = useAppConfirmation();
  return <button onClick={async () => onDecision(await ask(options))}>Cambiar pedido</button>;
}

it('uses explicit decisions, describes the consequence, focuses preserving and restores the trigger', async () => {
  const decision = vi.fn();
  render(<StrictMode><AppConfirmationProvider><Editor onDecision={decision} /></AppConfirmationProvider></StrictMode>);
  const trigger = screen.getByRole('button', { name: 'Cambiar pedido' });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: options.title })).toHaveAccessibleDescription(options.description);
  expect(screen.getByRole('button', { name: 'Seguir editando' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Aceptar' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
  await waitFor(() => expect(decision).toHaveBeenCalledExactlyOnceWith(false));
  expect(trigger).toHaveFocus();
  expect(trigger.closest('[inert]')).toBeNull();
});

it('Escape and backdrop preserve, while only the explicit discard action accepts', async () => {
  const decision = vi.fn();
  render(<AppConfirmationProvider><Editor onDecision={decision} /></AppConfirmationProvider>);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Cambiar pedido' }));
  open(); fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(decision).toHaveBeenLastCalledWith(false));
  open(); fireEvent.click(screen.getByRole('dialog').previousElementSibling!);
  await waitFor(() => expect(decision).toHaveBeenCalledTimes(2));
  expect(decision).toHaveBeenLastCalledWith(false);
  open(); fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
  await waitFor(() => expect(decision).toHaveBeenCalledTimes(3));
  expect(decision).toHaveBeenLastCalledWith(true);
});

it('keeps the underlying form inert, closes only the top surface and preserves entered data', async () => {
  const close = vi.fn(), decision = vi.fn();
  render(<AppConfirmationProvider><Modal onClose={close} ariaLabelledBy="purchase-title">
    <h2 id="purchase-title">Compra</h2><input aria-label="Proveedor" defaultValue="Mi proveedor" />
    <Editor onDecision={decision} />
  </Modal></AppConfirmationProvider>);
  const underlying = screen.getByRole('dialog', { name: 'Compra' });
  const trigger = screen.getByRole('button', { name: 'Cambiar pedido' });
  trigger.focus(); fireEvent.click(trigger);
  expect(underlying.closest('[inert]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Seguir editando' })).toHaveFocus();
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(decision).toHaveBeenCalledExactlyOnceWith(false));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Proveedor' })).toHaveValue('Mi proveedor');
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});

it('traps keyboard focus within the two decisions and blocks background actions', () => {
  const background = vi.fn();
  render(<AppConfirmationProvider><button onClick={background}>Fondo</button><Editor onDecision={vi.fn()} /></AppConfirmationProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cambiar pedido' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Descartar' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Seguir editando' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Fondo' }));
  expect(background).not.toHaveBeenCalled();
});

it('cancels a pending decision when its editor disappears, without discarding afterwards', async () => {
  const decision = vi.fn();
  const view = render(<AppConfirmationProvider><Editor onDecision={decision} /></AppConfirmationProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cambiar pedido' }));
  view.rerender(<AppConfirmationProvider><span>Ya no está el pedido</span></AppConfirmationProvider>);
  await waitFor(() => expect(decision).toHaveBeenCalledExactlyOnceWith(false));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.overflow).not.toBe('hidden');
});

it('never replaces a pending decision with a second request and resolves both exactly once', async () => {
  const first = vi.fn(), second = vi.fn();
  function Concurrent() {
    const ask = useAppConfirmation();
    return <button onClick={() => { void ask(options).then(first); void ask({ ...options, title: 'Otra decisión' }).then(second); }}>Dos solicitudes</button>;
  }
  render(<AppConfirmationProvider><Concurrent /></AppConfirmationProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Dos solicitudes' }));
  await waitFor(() => expect(second).toHaveBeenCalledExactlyOnceWith(false));
  expect(screen.getByRole('dialog', { name: options.title })).toBeInTheDocument();
  expect(first).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
  await waitFor(() => expect(first).toHaveBeenCalledExactlyOnceWith(true));
});

it('resolves as preserved if the entire application provider unmounts', async () => {
  const decision = vi.fn();
  const view = render(<AppConfirmationProvider><Editor onDecision={decision} /></AppConfirmationProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cambiar pedido' }));
  await act(async () => view.unmount());
  expect(decision).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.body.style.overflow).not.toBe('hidden');
});
