import { expect, test, type Page } from '@playwright/test';

async function navigate(page:Page,name:string) {
  const menu=page.getByRole('button',{name:'Abrir navegación'});
  if(await menu.isVisible())await menu.click();
  await page.getByRole('link',{name,exact:true}).filter({visible:true}).click();
}
async function fixture(page:Page) {
  await page.goto('/app/pedidos');
  expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await expect(page.getByText('DEMO',{exact:true}).filter({visible:true}).first()).toBeVisible();
  await page.evaluate(async()=>{
    const api=await(window as any).__getBusinessApi();
    const unique=Date.now().toString();
    const product=await api.saveProduct({sku:'CONFIRM-'+unique,slug:'confirm-'+unique,name:'Producto confirmación QA',
      presentation:'1 unidad',description:'Fixture local',category:'QA',priceCents:100000,currentCostCents:50000,
      reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/demo/creatina.svg',imageAlt:'Prueba',published:true,active:true});
    await api.adjustStock(product.id,4,'Fixture local',0);
    const modulePath='/src/domain/whatsapp.ts';
    const {buildWhatsAppProtocol}=await import(modulePath);
    const settings=await api.getSettings();
    const lines=[{productId:product.id,sku:product.sku,slug:product.slug,name:product.name,presentation:product.presentation,
      imageUrl:product.imageUrl,unitPriceCents:product.priceCents,quantity:1}];
    for(const firstName of ['Primera','Segunda']) {
      const checkout={customerFirstName:firstName,customerLastName:'Confirmación QA',customerName:firstName+' Confirmación QA',
        paymentMethod:'cash',deliveryMethod:'pickup',shippingType:null};
      const protocol=buildWhatsAppProtocol(checkout,lines,settings);
      await api.confirmImportedOrder({...checkout,lines,shippingFeeCents:0,quotedSubtotalCents:100000,quotedTotalCents:100000,
        protocolOrderId:protocol.orderId,protocolChecksum:protocol.checksum,saleType:'retail',stockSource:'normal'});
    }
    // Fixtures bypass the real mutation callbacks, so invalidate their cached reads explicitly.
    const queryModule='/src/app/query-client.ts';
    const {queryClient}=await import(queryModule);
    await queryClient.invalidateQueries();
  });
  await navigate(page,'Inventario');
  await navigate(page,'Pedidos');
}
function article(page:Page,firstName:string) {
  return page.locator('article').filter({has:page.getByRole('heading',{name:firstName+' Confirmación QA',exact:true})});
}
function watch(page:Page) {
  const errors:string[]=[];
  page.on('dialog',dialog=>{errors.push('native-dialog:'+dialog.type());void dialog.dismiss();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  return errors;
}

test('cambiar de pedido preserva la edición con Escape, Enter y Seguir editando; solo Descartar la elimina',async({page},info)=>{
  const errors=watch(page);
  await fixture(page);
  const first=article(page,'Primera'),second=article(page,'Segunda');
  const header=(card:ReturnType<typeof article>)=>card.locator('button[aria-expanded]').first();
  await header(first).click();
  await first.getByRole('button',{name:'Agregar',exact:true}).click();
  await expect(first.getByRole('button',{name:'Guardar envío'})).toBeDisabled();
  await header(second).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await header(first).click();
  await first.getByRole('button',{name:'Agregar',exact:true}).click();
  const amount=first.getByRole('textbox',{name:'Envío en pesos'});
  await amount.fill('12500');
  await header(second).click();
  const decision=page.getByRole('dialog',{name:'¿Descartar la edición de envío?'});
  await expect(decision).toBeVisible();
  await expect(decision.getByRole('button',{name:'Seguir editando'})).toBeFocused();
  await expect(decision.getByRole('button',{name:'Aceptar'})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/supplements-custom-confirmation-${info.project.name}.png`,fullPage:true});
  await page.keyboard.press('Escape');
  await expect(amount).toHaveValue('12.500');
  await header(second).click();
  await expect(decision.getByRole('button',{name:'Seguir editando'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(decision).toHaveCount(0);
  await expect(amount).toHaveValue('12.500');
  await header(second).click();
  await decision.getByRole('button',{name:'Seguir editando'}).click();
  await expect(amount).toHaveValue('12.500');
  await header(second).click();
  await decision.getByRole('button',{name:'Descartar',exact:true}).click();
  await expect(second.getByRole('button',{name:'Agregar',exact:true})).toBeVisible();
  await header(first).click();
  await first.getByRole('button',{name:'Agregar',exact:true}).click();
  await expect(amount).toHaveValue('');
  expect(await page.evaluate(async()=>{
    const api=await(window as any).__getBusinessApi();
    return (await api.listOrders(1,100,'Confirmación QA','all')).items.map((order:any)=>order.shippingFeeCents);
  })).toEqual([0,0]);
  expect(errors).toEqual([]);
});

test('la navegación interna y Atrás conservan el monto hasta una decisión explícita',async({page})=>{
  const errors=watch(page);await fixture(page);
  const first=article(page,'Primera');
  await first.locator('button[aria-expanded]').first().click();
  await first.getByRole('button',{name:'Agregar',exact:true}).click();
  const amount=first.getByRole('textbox',{name:'Envío en pesos'});
  await amount.fill('15000');
  await navigate(page,'Inventario');
  let decision=page.getByRole('dialog',{name:'¿Descartar los cambios?'});
  await expect(decision).toContainText('edición de envío');
  await decision.getByRole('button',{name:'Seguir editando'}).click();
  await expect(page).toHaveURL(/\/app\/pedidos$/);await expect(amount).toHaveValue('15.000');
  await page.evaluate(()=>history.back());
  await expect(decision).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/app\/pedidos$/);await expect(amount).toHaveValue('15.000');
  await page.evaluate(()=>history.back());
  await decision.getByRole('button',{name:'Descartar',exact:true}).click();
  await expect(page).toHaveURL(/\/app\/inventario$/);
  await navigate(page,'Pedidos');
  await first.locator('button[aria-expanded]').first().click();
  await first.getByRole('button',{name:'Agregar',exact:true}).click();
  await expect(amount).toHaveValue('');
  expect(errors).toEqual([]);
});

test('una confirmación anidada conserva la compra y el foco sin cerrar la ventana inferior',async({page},info)=>{
  const errors=watch(page);await fixture(page);await navigate(page,'Inventario');
  await page.getByRole('button',{name:'Compras',exact:true}).click();
  await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();
  const supplier=page.getByRole('textbox',{name:'Proveedor · opcional'});
  await supplier.fill('Compra pendiente QA');await supplier.press('Escape');
  const decision=page.getByRole('dialog',{name:'¿Descartar la compra sin guardar?'});
  await expect(decision).toBeVisible();
  await expect(decision.getByRole('button',{name:'Seguir editando'})).toBeFocused();
  await page.screenshot({path:`/tmp/supplements-nested-confirmation-${info.project.name}.png`,fullPage:true});
  await page.keyboard.press('Escape');
  await expect(decision).toHaveCount(0);await expect(supplier).toHaveValue('Compra pendiente QA');
  await expect(supplier).toBeFocused();
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  await decision.getByRole('button',{name:'Seguir editando'}).click();
  await expect(supplier).toHaveValue('Compra pendiente QA');
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  await decision.getByRole('button',{name:'Descartar',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
