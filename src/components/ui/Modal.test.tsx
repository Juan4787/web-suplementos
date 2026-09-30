import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal, Drawer } from './Modal';
import { Select } from './Select';
import { DatePicker } from './DatePicker';

afterEach(cleanup);

it('contains focus, blocks background activation and does not refocus when the close callback changes', () => {
  const outside = vi.fn();
  const view = render(<><button onClick={outside}>Fondo</button><Modal onClose={() => {}} ariaLabelledBy="title">
    <h2 id="title">Prueba</h2><input aria-label="Cantidad" /><button>Último</button>
  </Modal></>);
  const panel = screen.getByRole('dialog');
  expect(panel).toHaveFocus();
  fireEvent.keyDown(panel, { key: 'Tab' });
  const input = screen.getByRole('textbox', { name: 'Cantidad' });
  expect(input).toHaveFocus();
  view.rerender(<><button onClick={outside}>Fondo</button><Modal onClose={() => {}} ariaLabelledBy="title">
    <h2 id="title">Prueba</h2><input aria-label="Cantidad" /><button>Último</button>
  </Modal></>);
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
  expect(screen.getByRole('button', { name: 'Último' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(input).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Fondo' }));
  expect(outside).not.toHaveBeenCalled();
});

it('closes only the upper dialog and preserves the scroll lock and focus of the underlying drawer', () => {
  function Nested() {
    const [drawer, setDrawer] = useState(false);
    const [modal, setModal] = useState(false);
    return <><button onClick={() => setDrawer(true)}>Abrir</button>{drawer ? <Drawer onClose={() => setDrawer(false)}>
      <button onClick={() => setModal(true)}>Detalle</button>{modal ? <Modal onClose={() => setModal(false)}><button>Interior</button></Modal> : null}
    </Drawer> : null}</>;
  }
  render(<Nested />);
  const opener = screen.getByRole('button', { name: 'Abrir' });
  opener.focus(); fireEvent.click(opener);
  const detail = screen.getByRole('button', { name: 'Detalle' });
  detail.focus(); fireEvent.click(detail);
  expect(screen.getAllByRole('dialog')).toHaveLength(2);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(detail).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(detail, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(opener.closest('[inert]')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
});

it('allows a select portal and uses Escape to dismiss the popover before the dialog', () => {
  const close = vi.fn();
  const select = vi.fn();
  render(<Modal onClose={close}><Select aria-label="Producto" onValueChange={select} options={[{ value: 'a', label: 'Uno' }]} /></Modal>);
  fireEvent.click(screen.getByRole('button', { name: 'Producto' }));
  const option = screen.getByRole('option', { name: 'Uno' });
  expect(option.closest('[data-modal-popover]')).toHaveAttribute('data-dialog-owner');
  fireEvent.keyDown(option, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});

it('dismisses a calendar before its modal', () => {
  const close = vi.fn();
  render(<Modal onClose={close}><DatePicker /></Modal>);
  fireEvent.click(screen.getByRole('button', { name: /dd\/mm\/aaaa/ }));
  expect(document.querySelector('[data-modal-popover="date"]')).toBeInTheDocument();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[data-modal-popover="date"]')).not.toBeInTheDocument();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps an initially mounted nested modal above its parent and focuses only the child', () => {
  const parentClose = vi.fn();
  const childClose = vi.fn();
  render(<Modal onClose={parentClose} ariaLabelledBy="parent-title">
    <h2 id="parent-title">Padre</h2><button>Exterior</button>
    <Modal onClose={childClose} ariaLabelledBy="child-title"><h2 id="child-title">Hijo</h2><input aria-label="Interior" /></Modal>
  </Modal>);
  const parent = screen.getByRole('dialog', { name: 'Padre' });
  const child = screen.getByRole('dialog', { name: 'Hijo' });
  expect(child).toHaveFocus();
  expect(parent.closest('[inert]')).not.toBeNull();
  expect(child.closest('[inert]')).toBeNull();
  expect(Number(child.parentElement!.style.zIndex)).toBeGreaterThan(Number(parent.parentElement!.style.zIndex));
  fireEvent.keyDown(child, { key: 'Escape' });
  expect(childClose).toHaveBeenCalledTimes(1);
  expect(parentClose).not.toHaveBeenCalled();
});
