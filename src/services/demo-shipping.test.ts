import { beforeEach, describe, expect, it, vi } from 'vitest';
import { salesDateAt } from '@/domain/sales-date';
import type { BusinessApi } from './business-api';
import type { AdminProduct, Purchase } from '@/domain/types';
let api: BusinessApi, product: AdminProduct, first: Purchase, second: Purchase;
beforeEach(async () => {
  vi.resetModules();api=(await import('./demo-business-api')).demoBusinessApi;
  product=await api.saveProduct({sku:'SHIPPING_QA',slug:'shipping-qa',name:'Envíos QA',presentation:'1 unidad',description:'Fixture',category:'QA',priceCents:150000,currentCostCents:100000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Prueba',featured:false,published:true,active:true});
  await api.adjustStock(product.id,2,'QA',0);
  first=await api.createPurchase({supplierName:'Primero',expectedAt:'2030-01-01',items:[{productId:product.id,quantity:1,unitCostCents:107000}]});
  second=await api.createPurchase({supplierName:'Segundo',expectedAt:'2030-01-02',items:[{productId:product.id,quantity:1,unitCostCents:213001}]});
});
const create=(quantity=1,stockSource:'normal'|'incoming_only'='incoming_only')=>api.confirmImportedOrder({stockSource,customerName:'Cliente QA',paymentMethod:'cash',deliveryMethod:'pickup',shippingType:null,shippingFeeCents:0,quotedSubtotalCents:150000*quantity,quotedTotalCents:150000*quantity,protocolOrderId:crypto.randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:product.id,sku:product.sku,slug:product.slug,name:product.name,presentation:product.presentation,imageUrl:product.imageUrl,quantity,unitPriceCents:150000}]});
const current=async (id:string)=>(await api.listOrders(1,100,'','all')).items.find(o=>o.id===id)!;
describe('demo: reservas y contabilidad de envíos',()=>{
  it('cancelar un regalo manual sin entregar revierte su costo y reserva',async()=>{
    const pending=await create(1,'normal');await api.transitionOrder(pending.id,'cancel');
    const gifted=await api.confirmImportedOrder({stockSource:'normal',saleType:'gift',paymentMethod:'gift',customerName:'Regalo QA',deliveryMethod:'pickup',shippingType:null,shippingFeeCents:0,quotedSubtotalCents:0,quotedTotalCents:0,protocolOrderId:crypto.randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:product.id,sku:product.sku,slug:product.slug,name:product.name,presentation:product.presentation,imageUrl:product.imageUrl,quantity:1,unitPriceCents:150000}]});
    const before=await api.getDashboard();await api.transitionOrder(gifted.id,'cancel');
    expect((await current(gifted.id)).paymentState).toBe('refunded');
    expect((await api.listPaidOrders(1,100)).items.some(o=>o.id===gifted.id)).toBe(false);
    expect((await api.getDashboard()).estimatedMarginMonthCents).toBe(before.estimatedMarginMonthCents!+gifted.costTotalCents!);
    expect((await api.listAdminProducts()).find(p=>p.id===product.id)!.reserved).toBe(0);
  });
  it('reintegrar y cancelar un pedido cobrado concilia listado, dashboard y balance',async()=>{
    const order=await create(1,'normal');await api.transitionOrder(order.id,'mark_paid');
    const before=await api.getDashboard();expect(before.paidRevenueMonthCents).not.toBeNull();await api.transitionOrder(order.id,'mark_refunded');await api.transitionOrder(order.id,'cancel');
    expect((await current(order.id)).paymentState).toBe('refunded');
    expect((await api.listPaidOrders(1,100)).items.some(o=>o.id===order.id)).toBe(false);
    const after=await api.getDashboard();expect(after.paidRevenueMonthCents).toBe(before.paidRevenueMonthCents!-order.totalCents);
  });
  it('recibir la segunda compra no usa sus unidades para el cliente que reservó la primera',async()=>{
    const a=await create(),b=await create(3,'normal');
    expect(a.costTotalCents).toBe(107000);expect(b.costTotalCents).toBe(413001);
    await api.receivePurchase(second.id,[{purchaseItemId:second.items[0]!.id,receivedQuantity:1}],crypto.randomUUID(),0);
    expect((await current(a.id)).stockReadiness).toBe('waiting_incoming');
    expect((await current(b.id)).stockReadiness).toBe('ready');
    await api.receivePurchase(first.id,[{purchaseItemId:first.items[0]!.id,receivedQuantity:1}],crypto.randomUUID(),0);
    expect((await current(a.id)).stockReadiness).toBe('ready');
  });
  it('dos reintentos simultáneos de recepción conservan un único stock y gasto, igual que el balance',async()=>{
    const op=crypto.randomUUID(),items=[{purchaseItemId:first.items[0]!.id,receivedQuantity:1}];
    const [a,b]=await Promise.all([api.receivePurchase(first.id,items,op,1500000),api.receivePurchase(first.id,items,op,1500000)]);
    expect(a).toEqual(b);
    expect((await api.listAdminProducts()).find(p=>p.id===product.id)!.onHand).toBe(3);
    const exportData=await api.getExportDataset();expect(exportData.expenses?.filter(e=>e.purchaseReceiptOperationId===op)).toHaveLength(1);
    const date=salesDateAt(new Date()),analytics=await api.getAnalytics(date,date),dashboard=await api.getDashboard();
    expect(analytics.supplierShippingExpensesCents).toBe(1500000);expect(dashboard.miscExpensesMonthCents).toBe(1500000);
    expect(analytics.estimatedMarginCents).toBe(analytics.revenueCents-analytics.costCents-analytics.taxCents-analytics.miscExpensesCents);
  });
  it('cancelar libera la compra y reponer conserva la reserva en su nueva compra',async()=>{
    const cancelled=await create();await api.transitionOrder(cancelled.id,'cancel');
    const active=await create();
    const replacement=await api.replacePurchaseShortage({purchaseItemId:first.items[0]!.id,expectedPending:1,supplierName:'Reposición',expectedAt:'2030-01-03',operationId:crypto.randomUUID()});
    expect(replacement.transferredReservations).toBe(1);
    expect((await api.getPurchaseImpact(second.id))[0]!.reservedOrders).toHaveLength(0);
    await api.receivePurchase(replacement.newPurchase.id,undefined,crypto.randomUUID(),0);
    expect((await current(active.id)).stockReadiness).toBe('ready');
    expect((await current(cancelled.id)).orderState).toBe('cancelled');
  });
});
