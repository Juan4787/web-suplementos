import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';

function watch(page:Page) {
  const errors:string[]=[];
  page.on('dialog',dialog=>{errors.push('native-dialog:'+dialog.type());void dialog.dismiss();});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  return errors;
}
async function local(page:Page,path:string) {
  await page.goto(path);
  expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await expect(page.getByText('DEMO',{exact:true}).filter({visible:true}).first()).toBeVisible();
  await conservative(page);
}
async function conservative(page:Page) {
  await page.evaluate(async()=>{
    const path='/src/services/business-api.ts';
    await import(path);
    const api=await(window as any).__getBusinessApi();
    (window as any).__styledControlWrites=[];
    for(const name of Object.keys(api).filter(name=>/^(save|update|delete|archive|adjust|confirm|transition|create|receive|resolve|reassign|register|cancel|close|declare|replace|ask)/.test(name))) {
      api[name]=async()=>{(window as any).__styledControlWrites.push(name);throw new Error('Read-only UI test blocked a business write');};
    }
  });
}
async function styledDom(page:Page) {
  expect(await page.locator('select,datalist,input[type="date"],input[type="month"],input[type="time"],input[type="datetime-local"],[title]').count()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__styledControlWrites??[])).toEqual([]);
}

test('manual order choices and category list work with keyboard, search clearing and no stored changes',async({page},info)=>{
  const errors=watch(page);await local(page,'/app/pedidos/nuevo');
  const normal=page.getByRole('radio',{name:'Stock local primero',exact:true});
  const incoming=page.getByRole('radio',{name:'Solo compras al proveedor',exact:true});
  await expect(normal).toBeChecked();
  await normal.focus();await page.keyboard.press('ArrowRight');await expect(incoming).toBeChecked();
  await page.keyboard.press('ArrowLeft');await expect(normal).toBeChecked();
  const category=page.getByRole('button',{name:'Categoría de productos'});
  await category.focus();await page.keyboard.press('ArrowDown');
  const list=page.getByRole('listbox',{name:'Categoría de productos'});
  await expect(list).toBeVisible();
  await expect(list.getByRole('option').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const selected=await page.locator(':focus').textContent();
  await expect(category).toContainText('Todas las categorías');
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);await expect(category).toContainText(selected!.trim());
  await category.click();await list.getByRole('option',{name:'Todas las categorías',exact:true}).click();
  const search=page.getByRole('searchbox');await search.fill('Búsqueda sin coincidencias QA');
  await page.getByRole('button',{name:'Borrar búsqueda'}).click();await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await category.click();
  await page.screenshot({path:`/tmp/supplements-styled-manual-${info.project.name}.png`,fullPage:false});
  await page.keyboard.press('Escape');await expect(category).toBeFocused();
  await styledDom(page);expect(errors).toEqual([]);
});

test('expense date and month controls preserve exact leap dates and nested focus without saving',async({page},info)=>{
  const errors=watch(page);await local(page,'/app/configuracion');
  const yearLabel=page.getByRole('button',{name:'Mes a revisar: año'}).locator('span').first();
  expect(await yearLabel.evaluate(label=>{
    const range=document.createRange();range.selectNodeContents(label);
    return range.getClientRects().length;
  })).toBe(1);
  const current=await page.locator('#misc-expenses-month').inputValue();
  await page.getByRole('button',{name:'Mes a revisar: mes'}).click();
  await page.getByRole('listbox').getByRole('option',{name:'Septiembre',exact:true}).click();
  expect(await page.getByRole('button',{name:'Mes a revisar: mes'}).evaluate(button=>{
    const range=document.createRange();range.selectNodeContents(button.querySelector('span')!);
    return range.getBoundingClientRect().right<=button.querySelector('svg')!.getBoundingClientRect().left;
  })).toBe(true);
  await page.getByRole('button',{name:'Mes a revisar: mes'}).click();
  await page.getByRole('listbox').getByRole('option',{name:'Febrero',exact:true}).click();
  await expect(page.locator('#misc-expenses-month')).toHaveValue(current.slice(0,4)+'-02');
  await page.getByRole('button',{name:'Agregar gasto'}).first().click();
  const editor=page.getByRole('dialog',{name:'Agregar gasto'});
  await editor.getByLabel('Título del gasto').fill('Borrador local QA');
  await editor.getByRole('button',{name:'Fecha del gasto',exact:true}).click();
  const calendar=page.getByRole('dialog',{name:'Elegir fecha'});
  await calendar.getByRole('button',{name:'Año del calendario'}).click();
  await page.keyboard.press('Escape');
  await expect(calendar).toBeVisible();await expect(editor).toBeVisible();
  await expect(calendar.getByRole('button',{name:'Año del calendario'})).toBeFocused();
  await calendar.getByRole('button',{name:'Año del calendario'}).click();
  await page.getByRole('textbox',{name:'Buscar opciones'}).fill('2028');
  await page.getByRole('listbox').getByRole('option',{name:'2028',exact:true}).click();
  await calendar.getByRole('button',{name:'Mes del calendario'}).click();
  await page.getByRole('listbox').getByRole('option',{name:'febrero',exact:true}).click();
  const currentColor=await calendar.getByRole('button',{name:/28 febrero 2028/}).evaluate(button=>getComputedStyle(button).color);
  const nextColor=await calendar.getByRole('button',{name:/1 marzo 2028/}).evaluate(button=>getComputedStyle(button).color);
  expect(nextColor).not.toBe(currentColor);
  await calendar.getByRole('button',{name:/28 febrero 2028/}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(calendar.getByRole('button',{name:/29 febrero 2028/})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(calendar).toHaveCount(0);
  await expect(editor.getByRole('button',{name:'Fecha del gasto',exact:true})).toContainText('29/02/2028');
  await editor.getByRole('button',{name:'Mensual',exact:true}).click();
  await editor.getByRole('button',{name:'Sí',exact:true}).click();
  await editor.getByRole('button',{name:'Fecha de finalización',exact:true}).click();
  await expect(calendar.getByRole('button',{name:/28 febrero 2028/})).toBeDisabled();
  await expect(calendar.getByRole('button',{name:/29 febrero 2028/})).toBeEnabled();
  await page.screenshot({path:`/tmp/supplements-styled-calendar-${info.project.name}.png`,fullPage:false});
  await page.keyboard.press('Escape');await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Título del gasto')).toHaveValue('Borrador local QA');
  await editor.getByRole('button',{name:'Cancelar',exact:true}).click();
  await styledDom(page);expect(errors).toEqual([]);
});

test('a product selector inside a purchase preserves the form with Tab and Escape and blocks duplicate options',async({page},info)=>{
  const errors=watch(page);await local(page,'/app/inventario');
  await page.getByRole('button',{name:'Compras',exact:true}).click();
  await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'Nuevo pedido al proveedor'});
  await expect(editor).toBeVisible();
  const trigger=editor.locator('button[aria-haspopup="listbox"]').first();
  await trigger.click();
  const list=page.getByRole('listbox');
  await expect(list).toBeVisible();
  await page.screenshot({path:`/tmp/supplements-styled-product-select-${info.project.name}.png`,fullPage:false});
  const options=list.getByRole('option');
  await options.nth(1).click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button',{name:/Agregar producto/}).click();
  const second=editor.locator('button[aria-haspopup="listbox"]').nth(1);
  await second.click();
  const disabled=page.getByRole('listbox').getByRole('option').filter({hasText:'ya agregado'});
  await expect(disabled).toHaveCount(1);await expect(disabled).toBeDisabled();
  await page.keyboard.press('Escape');await expect(editor).toBeVisible();await expect(second).toBeFocused();
  await second.click();await page.keyboard.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);await expect(editor).toBeVisible();
  await expect(editor.getByRole('button',{name:'Guardar pedido'})).not.toBeFocused();
  await styledDom(page);expect(errors).toEqual([]);
});

test('all public and owner routes render without browser widgets, errors or business writes',async({page})=>{
  const errors=watch(page);
  for(const path of ['/','/carrito','/checkout','/privacidad','/ingresar','/app','/app/pedidos','/app/pedidos/nuevo','/app/pedidos/importar','/app/productos','/app/inventario','/app/clientes','/app/compras','/app/ventas','/app/analiticas','/app/ia','/app/exportar','/app/configuracion','/app/usuarios']) {
    await page.goto(path);expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    await expect(page.locator('main').first()).toBeVisible();
    await conservative(page);
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await styledDom(page);
  }
  expect(errors).toEqual([]);
});

test('product flags keep checkbox semantics and the styled image control works with keyboard without upload',async({page})=>{
  const errors=watch(page);
  // Enable interception before loading the screen. Registering immediately
  // before the key can race the browser's asynchronous interception command.
  const chooserPromise=page.waitForEvent('filechooser');
  await local(page,'/app/productos');
  await page.getByRole('button',{name:'Nuevo producto',exact:true}).click();
  const editor=page.getByRole('dialog');
  const image=editor.getByRole('button',{name:'Elegir imagen del producto'});
  await image.focus();
  await page.keyboard.press('Enter');
  const chooser=await chooserPromise;
  await chooser.setFiles({name:'imagen-qa.png',mimeType:'image/png',buffer:readFileSync('public/favicon-32x32.png')});
  await expect(editor.getByText('imagen-qa.png',{exact:true})).toBeVisible();
  await editor.getByRole('button',{name:'Código de producto y alertas de reposición',exact:true}).click();
  const published=editor.getByRole('checkbox',{name:/Publicado/});
  await published.focus();await page.keyboard.press('Space');
  await expect(published).not.toBeChecked();
  expect(await published.evaluate(input=>getComputedStyle(input).appearance)).toBe('none');
  await expect(editor.locator('input[type="file"]')).toBeHidden();
  await styledDom(page);expect(errors).toEqual([]);
});
