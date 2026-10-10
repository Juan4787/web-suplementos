import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.goto('/app/pedidos');
  await expect(page.getByText('DEMO',{exact:true}).filter({visible:true}).first()).toBeVisible();
  return page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi();
    const unique = Date.now().toString();
    const product = await api.saveProduct({sku:`UI-SHIP-${unique}`,slug:`ui-ship-${unique}`,name:'Prueba de envíos QA',presentation:'1 unidad',description:'Fixture de navegador aislado',category:'QA',priceCents:1_500_000,currentCostCents:1_070_000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/demo/creatina.svg',imageAlt:'Prueba',published:true,active:true});
    await api.adjustStock(product.id,2,'Fixture de navegador',0);
    const purchase = await api.createPurchase({supplierName:'Proveedor envíos QA',items:[{productId:product.id,quantity:4,unitCostCents:1_070_000}]});
    return {productId:product.id,purchaseId:purchase.id,purchaseNumber:purchase.number};
  });
}
async function navigate(page: Page, name: string) {
  const menu=page.getByRole('button',{name:'Abrir navegación'});
  if(await menu.isVisible()) await menu.click();
  await page.getByRole('link',{name,exact:true}).filter({visible:true}).click();
}
test('en camino reserva solo lo entrante; porcentaje se revisa y queda bloqueado al cobrar',async ({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const data=await fixture(page);
  await page.locator('a[href="/app/pedidos/nuevo"]').first().click();
  await expect(page.getByRole('radio',{name:'Compra normal',exact:true})).toBeChecked();
  await page.getByRole('radio',{name:'Comprar productos en camino',exact:true}).check();
  await page.getByPlaceholder('Buscar creatina, proteína, colágeno, SKU…').fill('Prueba de envíos QA');
  await expect(page.getByText('4 libres en camino',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Agregar',exact:true}).click();
  await page.locator('#customerFirstName').fill('Cliente');await page.locator('#customerLastName').fill('Envíos QA');
  await page.getByRole('button',{name:'Confirmar pedido manual'}).click();
  await page.getByRole('link',{name:/Ver pedido #\d+ en la lista/}).click();
  const article=page.locator('article').filter({has:page.getByRole('heading',{name:'Cliente Envíos QA',exact:true})});
  await expect(article.getByText('Mercadería en camino',{exact:true})).toBeVisible();
  expect(await page.evaluate(async id=>{const api=await(window as any).__getBusinessApi();const p=(await api.listAdminProducts()).find((p:any)=>p.id===id);return {onHand:p.onHand,reserved:p.reserved,incoming:p.incomingAvailable};},data.productId)).toEqual({onHand:2,reserved:0,incoming:3});
  await article.getByRole('button',{name:'Agregar',exact:true}).click();
  await expect(article.getByRole('button',{name:'Marcar como cobrado'})).toBeDisabled();
  await expect(article.getByRole('button',{name:'Monto manual',exact:true})).toBeEnabled();
  await expect(article.getByRole('button',{name:'Porcentaje',exact:true})).toBeEnabled();
  await article.getByRole('button',{name:'Porcentaje',exact:true}).click();
  await article.getByRole('textbox',{name:'Porcentaje del costo'}).fill('5');
  await expect(article.getByText('Envío',{exact:true}).locator('..')).toContainText('535');
  await expect(article.getByText('Total a cobrar',{exact:true}).locator('..')).toContainText('15.535');
  // Capture the settled selected state, after the shared color transition.
  await expect(article.getByRole('button',{name:'Porcentaje',exact:true})).toHaveCSS('color','rgb(255, 255, 255)');
  await expect(article.getByRole('button',{name:'Porcentaje',exact:true})).toHaveCSS('opacity','1');
  await expect(article.getByRole('button',{name:'Monto manual',exact:true})).toHaveCSS('color','rgb(11, 19, 36)');
  await page.screenshot({path:`/tmp/shipping-editor-${info.project.name}.png`,fullPage:true});
  await article.getByRole('button',{name:'Guardar envío'}).click();
  await expect(article.getByRole('button',{name:'Editar',exact:true})).toBeVisible();
  await article.getByRole('button',{name:'Marcar como cobrado'}).click();
  const confirmation=page.getByRole('dialog');
  await expect(confirmation).toContainText('15.535');
  await expect(confirmation).toContainText('Después del cobro no se podrá editar');
  await confirmation.getByRole('button',{name:'Sí, registrar cobro'}).click();
  await expect(confirmation).not.toBeVisible();
  await expect(article.getByRole('button',{name:'Editar',exact:true})).toHaveCount(0);
  await expect(article.getByText('Costo de envío',{exact:true}).locator('..')).toContainText('535');
  expect(errors).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/shipping-paid-${info.project.name}.png`,fullPage:true});
});

test('recepción registra un único gasto de proveedor y ventas muestra su impacto neto',async ({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const data=await fixture(page);
  await navigate(page,'Inventario');
  await page.getByRole('button',{name:'Compras',exact:true}).click();
  const purchase=page.locator('article').filter({hasText:`Pedido #${data.purchaseNumber}`});
  await purchase.getByRole('button',{name:'Recibir mercadería'}).click();
  await page.getByText('Llegó TODO completo',{exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'Costo de envío (opcional)'}).fill('15000');
  await expect(dialog).toContainText('15.000');
  await page.screenshot({path:`/tmp/shipping-receipt-${info.project.name}.png`,fullPage:true});
  await dialog.getByRole('button',{name:/Confirmar ingreso completo/}).click();
  await expect(dialog).not.toBeVisible();
  const expense=await page.evaluate(async()=>{const api=await(window as any).__getBusinessApi();const dataset=await api.getExportDataset();return dataset.expenses.filter((e:any)=>e.purchaseReceiptOperationId).map((e:any)=>({amount:e.amountCents,frequency:e.frequency,purchase:e.purchaseId}));});
  expect(expense).toEqual([{amount:1_500_000,frequency:'once',purchase:data.purchaseId}]);
  await navigate(page,'Ventas');
  await page.getByText('Cómo se calcula la ganancia neta',{exact:true}).click();
  await expect(page.getByText('Envíos pagados al proveedor',{exact:true}).locator('..')).toContainText('15.000');
  expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/shipping-stats-${info.project.name}.png`,fullPage:true});
});

test('cambiar a en camino conserva el borrador y exige corregir la cantidad antes de confirmar',async ({page},info)=>{
  await fixture(page);
  if(info.project.name==='mobile-chrome')await page.setViewportSize({width:320,height:740});
  await page.locator('a[href="/app/pedidos/nuevo"]').first().click();
  await page.getByPlaceholder('Buscar creatina, proteína, colágeno, SKU…').fill('Prueba de envíos QA');
  await page.getByRole('button',{name:'Agregar',exact:true}).click();
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'Aumentar cantidad'}).click();
  await page.locator('#customerFirstName').fill('Cliente');await page.locator('#customerLastName').fill('Cantidad QA');
  await page.getByRole('radio',{name:'Comprar productos en camino',exact:true}).check();
  await expect(page.getByRole('alert').filter({hasText:'Los productos se conservaron'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirmar pedido manual'})).toBeDisabled();
  await page.getByRole('button',{name:'Disminuir cantidad'}).click();
  await expect(page.getByRole('button',{name:'Confirmar pedido manual'})).toBeDisabled();
  await page.getByRole('button',{name:'Disminuir cantidad'}).click();
  await expect(page.getByRole('button',{name:'Confirmar pedido manual'})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/shipping-source-${info.project.name}.png`,fullPage:true});
});

test('el importe rechaza pegados negativos y centavos sin convertirlos en otro cargo',async ({page})=>{
  await fixture(page);await navigate(page,'Inventario');await page.getByRole('button',{name:'Compras',exact:true}).click();
  await page.locator('article').filter({hasText:'Proveedor envíos QA'}).getByRole('button',{name:'Recibir mercadería'}).click();
  await page.getByText('Llegó TODO completo',{exact:true}).click();
  const input=page.getByRole('textbox',{name:'Costo de envío (opcional)'});
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await input.fill('12000');
  for(const value of ['-15.000','15.000,50','abc','15.50']) {
    await page.evaluate(value=>navigator.clipboard.writeText(value),value);
    await input.press('Control+V');
    await expect(input).toHaveValue('12.000');
    await expect(page.getByText(/Usá pesos enteros, sin letras, signos ni centavos/)).toBeVisible();
  }
  await input.press('Control+A');
  await page.evaluate(()=>navigator.clipboard.writeText('15.000'));
  await input.press('Control+V');
  await expect(input).toHaveValue('15.000');
});
