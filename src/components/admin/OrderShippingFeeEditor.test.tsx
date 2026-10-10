import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoOrders } from '@/data/demo-data';
import type { Order } from '@/domain/types';
import { OrderShippingFeeEditor } from './OrderShippingFeeEditor';

const save = vi.hoisted(() => vi.fn());
vi.mock('@/services/business-api', () => ({getBusinessApi: async () => ({saveOrderShippingFee: save})}));
const order: Order = {...demoOrders[0]!, id:'shipping-test', number:42, orderState:'confirmed', paymentState:'pending',
  subtotalCents:1_500_000, totalCents:1_500_000, costTotalCents:1_070_000, shippingFeeCents:0, shippingFeeRevision:0};
const renderEditor = (input = order, canEdit = true) => {
  const onEditingChange = vi.fn();
  const client = new QueryClient({defaultOptions: {queries: {retry:false}, mutations: {retry:false}}});
  return {...render(<QueryClientProvider client={client}><OrderShippingFeeEditor order={input} canEdit={canEdit} disabled={false} onEditingChange={onEditingChange} /></QueryClientProvider>), onEditingChange, client};
};
beforeEach(() => save.mockReset().mockResolvedValue({...order,shippingFeeCents:53_500,shippingFeeRevision:1}));
afterEach(cleanup);
describe('envío en Qué sigue', () => {
  it('tracks changed values separately from opening and allows returning to the saved amount', () => {
    const {onEditingChange}=renderEditor({...order,shippingFeeCents:1_250_000});
    fireEvent.click(screen.getByRole('button',{name:'Editar'}));
    const input=screen.getByRole('textbox',{name:'Envío en pesos'});
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:false});
    fireEvent.change(input,{target:{value:'16000'}});
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:true});
    fireEvent.change(input,{target:{value:'12500'}});
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:false});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Porcentaje'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Porcentaje del costo'}),{target:{value:'5'}});
    fireEvent.click(screen.getByRole('button',{name:'Monto manual'}));
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:false});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
  });
  it('equivalent percentage formatting and blank zero do not create false changes', () => {
    const view=renderEditor({...order,shippingFeeCents:53_500,shippingFeeMethod:'percentage',shippingFeeBasisPoints:500,
      shippingFeeCostBaseCents:1_070_000});
    fireEvent.click(screen.getByRole('button',{name:'Editar'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Porcentaje del costo'}),{target:{value:'5,00'}});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
    expect(view.onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:false});
    view.unmount();
    renderEditor();
    fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Envío en pesos'}),{target:{value:'0'}});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
  });
  it('marks a submitted save as pending until its result, and preserves a failed draft', async () => {
    let reject!: (error:Error)=>void;
    save.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const {onEditingChange}=renderEditor();
    fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
    const input=screen.getByRole('textbox',{name:'Envío en pesos'});
    fireEvent.change(input,{target:{value:'12500'}});
    fireEvent.click(screen.getByRole('button',{name:'Guardar envío'}));
    await waitFor(()=>expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:true,dirty:true}));
    expect(input).toBeDisabled();
    expect(screen.getByRole('button',{name:'Cancelar'})).toBeDisabled();
    reject(new Error('Sin conexión'));
    await waitFor(()=>expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:true}));
    expect(input).toHaveValue('12.500');
    expect(input).toBeEnabled();
  });
  it('allows explicitly reviewing a saved percentage even when no input is changed', () => {
    renderEditor({...order,shippingFeeCents:53_500,shippingFeeMethod:'percentage',shippingFeeBasisPoints:500,
      shippingFeeCostBaseCents:1_000_000,shippingFeeNeedsReview:true});
    fireEvent.click(screen.getByRole('button',{name:'Editar'}));
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeEnabled();
    expect(screen.getByText('Envío').nextSibling).toHaveTextContent('535');
  });
  it('explica la revisión al personal sin revelar costos, incluso con cargo nominal cero', () => {
    renderEditor({...order,costTotalCents:null,shippingFeeMethod:null,shippingFeeBasisPoints:null,shippingFeeCostBaseCents:null,shippingFeeNeedsReview:true},false);
    expect(screen.getByRole('alert')).toHaveTextContent('La dueña debe revisar el envío antes de cobrar este pedido.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/10.700/)).not.toBeInTheDocument();
  });
  it('empieza discreto, sin campos visibles; el porcentaje muestra costo, monto y total', async () => {
    const {onEditingChange} = renderEditor();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:true,saving:false,dirty:false});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Porcentaje'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Porcentaje del costo'}),{target:{value:'5'}});
    expect(screen.getByText(/Costo de los productos/).textContent).toContain('10.700');
    expect(screen.getByText('Envío').nextSibling?.textContent).toContain('535');
    expect(screen.getByText('Total a cobrar').nextSibling?.textContent).toContain('15.535');
    fireEvent.click(screen.getByRole('button',{name:'Guardar envío'}));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]![0]).toMatchObject({orderId:'shipping-test',method:'percentage',basisPoints:500,expectedCostCents:1_070_000,expectedRevision:0});
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(onEditingChange).toHaveBeenLastCalledWith('shipping-test',{editing:false,saving:false,dirty:false});
  });
  it('cancelar no guarda ni cobra', () => {
    renderEditor(); fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Envío en pesos'}),{target:{value:'12500'}});
    fireEvent.click(screen.getByRole('button',{name:'Cancelar'}));
    expect(save).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('después del cobro muestra solo el importe y oculta la edición', () => {
    renderEditor({...order,paymentState:'paid',shippingFeeCents:1_250_000});
    expect(screen.getByText(/12.500/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Editar'})).not.toBeInTheDocument();
  });
  it('no muestra la base de costos a personal sin permiso', () => {
    renderEditor({...order,shippingFeeCents:53_500,shippingFeeMethod:'percentage',shippingFeeBasisPoints:500,shippingFeeCostBaseCents:1_070_000},false);
    expect(screen.queryByText(/10.700/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('porcentaje incompleto bloquea guardar', () => {
    renderEditor();fireEvent.click(screen.getByRole('button',{name:'Agregar'}));fireEvent.click(screen.getByRole('button',{name:'Porcentaje'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Porcentaje del costo'}),{target:{value:'5,'}});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
  });
  it('no recalcula silenciosamente si el costo cambia mientras se está editando', () => {
    const {rerender,client,onEditingChange}=renderEditor();
    fireEvent.click(screen.getByRole('button',{name:'Agregar'}));fireEvent.click(screen.getByRole('button',{name:'Porcentaje'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Porcentaje del costo'}),{target:{value:'5'}});
    rerender(<QueryClientProvider client={client}><OrderShippingFeeEditor order={{...order,costTotalCents:1_200_000}} canEdit disabled={false} onEditingChange={onEditingChange} /></QueryClientProvider>);
    expect(screen.getByText(/Costo de los productos/)).toHaveTextContent('10.700');
    expect(screen.getByRole('alert')).toHaveTextContent('Cambió el costo');
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });
  it('un porcentaje con signos no guarda el valor anterior por accidente', () => {
    renderEditor();fireEvent.click(screen.getByRole('button',{name:'Agregar'}));fireEvent.click(screen.getByRole('button',{name:'Porcentaje'}));
    const input=screen.getByRole('textbox',{name:'Porcentaje del costo'});
    fireEvent.change(input,{target:{value:'5'}});fireEvent.change(input,{target:{value:'5%'}});
    expect(screen.getByRole('alert')).toHaveTextContent('sin signos ni letras');
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
    fireEvent.change(input,{target:{value:'6'}});
    expect(screen.getByRole('button',{name:'Guardar envío'})).toBeEnabled();
  });
});
