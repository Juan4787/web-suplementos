// Start before deployment, then send "verify\n" on stdin after served-build certification.
// Keep an unsaved receipt field in a real owner tab; every business write is blocked.
import { chromium, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, WORKER_ORIGIN } from './project-targets.mjs';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';

assertSupabaseTarget();
const env=loadEnv('production',PROJECT_ROOT,'');
const client=createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_ANON_KEY||env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {auth:{persistSession:false,autoRefreshToken:false}});
const {data,error}=await client.auth.signInWithPassword({email:env.E2E_ADMIN_EMAIL||env.E2E_EMAIL,password:env.E2E_ADMIN_PASSWORD||env.E2E_PASSWORD});
assert.ok(!error&&data.session,'Owner authentication failed');
const prior=JSON.parse(readFileSync('output/audit/shipping-principal-certified/shipping-served-build.json','utf8'));
const snapshot=JSON.parse(readFileSync('output/audit/shipping-release-after.json','utf8'));
assert.deepEqual(snapshot.failures,[]);
const allowed=new Set(snapshot.functions.filter(f=>f.schema==='public'&&['s','i'].includes(f.provolatile)).map(f=>f.name));
const blocked=[],errors=[],lateRequests=[];
let verifying=false;
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),
    {key:`sb-${SUPABASE_PROJECT_REF}-auth-token`,session:data.session});
  await context.route('**/rest/v1/**',route=>{
    const request=route.request(),name=new URL(request.url()).pathname.split('/rpc/')[1];
    if(['GET','OPTIONS'].includes(request.method())||(request.method()==='POST'&&allowed.has(name)))return route.continue();
    blocked.push(name||'table-write');return route.abort();
  });
  await context.route(WORKER_ORIGIN+'/api/**',route=>{blocked.push('worker-api');return route.abort();});
  const page=await context.newPage();
  page.on('pageerror',()=>errors.push('page-error'));
  page.on('console',message=>{if(message.type()==='error')errors.push('console-error');});
  page.on('dialog',dialog=>{errors.push('native-dialog');void dialog.dismiss();});
  page.on('response',response=>{
    if(response.url().includes('/rest/v1/')&&response.status()>=400)errors.push('failed-read');
    if(verifying&&response.url().startsWith(WORKER_ORIGIN+'/assets/'))lateRequests.push(new URL(response.url()).pathname.slice(1));
  });
  const root=await page.request.get(WORKER_ORIGIN+'/index.html');
  assert.equal(createHash('sha256').update(await root.body()).digest('hex'),prior.files.find(f=>f.path==='index.html').hash,
    'The tab must start on the certified previous version');
  await page.goto(WORKER_ORIGIN+'/app/inventario');
  await page.getByRole('button',{name:'Compras',exact:true}).click();
  await page.getByRole('button',{name:'Recibir mercadería'}).first().click();
  await page.getByText('Llegó TODO completo',{exact:true}).click();
  const field=page.getByRole('textbox',{name:'Costo de envío (opcional)'});
  await field.fill('12345');await expect(field).toHaveValue('12.345');
  console.log(JSON.stringify({environment:'production-read-only-open-tab',phase:'ready',unsavedField:true,blockedMutations:blocked.length}));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Deployment verification signal timed out')),10*60_000);
    process.stdin.setEncoding('utf8');process.stdin.resume();
    process.stdin.once('data',message=>{clearTimeout(timer);process.stdin.pause();
      message.trim()==='verify'?resolve():reject(new Error('Unexpected verification signal'));});
  });
  const current=JSON.parse(readFileSync('output/audit/shipping-served-build.json','utf8'));
  assert.notEqual(current.buildSha256,prior.buildSha256);
  const currentFiles=new Map(current.files.map(file=>[file.path,file.hash]));
  for(const file of prior.files.filter(file=>/^assets\/.*\.(js|css)$/.test(file.path)))assert.equal(currentFiles.get(file.path),file.hash);
  await expect(field).toHaveValue('12.345');
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  verifying=true;
  await page.getByRole('link',{name:'Ventas',exact:true}).click();
  await page.getByText('Cómo se calcula la ganancia neta',{exact:true}).waitFor();
  const sales=prior.files.find(file=>/^assets\/SalesPage-.*\.js$/.test(file.path));
  assert.ok(sales&&lateRequests.includes(sales.path),'A prior lazy page must load after publication, without a reload');
  await page.getByRole('link',{name:'Pedidos',exact:true}).click();
  await page.getByRole('link',{name:'Cargar pedido manual',exact:true}).click();
  await page.getByRole('radio',{name:'Compra normal',exact:true}).waitFor();
  const manual=prior.files.find(file=>/^assets\/CreateOrderPage-.*\.js$/.test(file.path));
  const retained=JSON.parse(readFileSync('output/audit/shipping-session-assets/restore.json','utf8'));
  assert.ok(manual&&retained.files.includes(manual.path)&&lateRequests.includes(manual.path),
    'Also load a changed page whose prior file would be missing without retention');
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  writeFileSync('output/audit/shipping-open-tab-readonly.json',JSON.stringify({environment:'production-read-only-open-tab',
    priorBuildSha256:prior.buildSha256,currentBuildSha256:current.buildSha256,unsavedFieldPreserved:true,
    priorLazyPageLoaded:true,priorChangedPageLoaded:true,blockedMutations:0,errors:0},null,2),{mode:0o600});
  console.log(JSON.stringify({environment:'production-read-only-open-tab',phase:'verified',unsavedFieldPreserved:true,
    priorLazyPageLoaded:true,priorChangedPageLoaded:true,blockedMutations:0,errors:0}));
} finally {process.stdin.pause();await browser.close();await client.auth.signOut({scope:'local'});}
