// Start before deployment, then send "verify\n" on stdin after served-build certification.
// Keep an unsaved receipt field in a real owner tab; every business write is blocked.
// Optional --replay-prior-html uses hash-verified prior HTML only in the browser,
// with current live assets/APIs. Its evidence is explicitly separate from a deployment.
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
const priorPath=process.argv[2]||'output/audit/shipping-principal-certified/shipping-served-build.json';
assert.match(priorPath,/^output\/audit\/shipping-(principal|dialog-intermediate)-certified\/shipping-served-build\.json$/);
const prior=JSON.parse(readFileSync(priorPath,'utf8'));
const replayPriorHtml=process.argv[3]==='--replay-prior-html';
assert.ok(process.argv[3]===undefined||replayPriorHtml,'Unsupported verification mode');
const environment=replayPriorHtml?'production-read-only-prior-html-replay':'production-read-only-open-tab';
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
  if(replayPriorHtml) {
    // Browser-only replay after publication. Never replace the deployed HTML.
    const html=readFileSync(priorPath.replace('shipping-served-build.json','index.html'));
    assert.equal(createHash('sha256').update(html).digest('hex'),prior.files.find(f=>f.path==='index.html').hash);
    await context.route(WORKER_ORIGIN+'/app/inventario',route=>{
      assert.ok(route.request().isNavigationRequest());
      return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
    });
  }
  const page=await context.newPage();
  page.on('pageerror',()=>errors.push('page-error'));
  page.on('console',message=>{if(message.type()==='error')errors.push('console-error');});
  page.on('dialog',dialog=>{errors.push('native-dialog');void dialog.dismiss();});
  page.on('response',response=>{
    if(response.url().includes('/rest/v1/')&&response.status()>=400)errors.push('failed-read');
    if(verifying&&response.url().startsWith(WORKER_ORIGIN+'/assets/'))lateRequests.push(new URL(response.url()).pathname.slice(1));
  });
  const root=await page.request.get(WORKER_ORIGIN+'/index.html');
  const deployed=JSON.parse(readFileSync('output/audit/shipping-served-build.json','utf8'));
  assert.equal(createHash('sha256').update(await root.body()).digest('hex'),
    (replayPriorHtml?deployed:prior).files.find(f=>f.path==='index.html').hash,
    'The served HTML must match the relevant certificate');
  await page.goto(WORKER_ORIGIN+'/app/inventario');
  await page.getByRole('button',{name:'Compras',exact:true}).click();
  await page.getByRole('button',{name:'Recibir mercadería'}).first().click();
  await page.getByText('Llegó TODO completo',{exact:true}).click();
  const field=page.getByRole('textbox',{name:'Costo de envío (opcional)'});
  await field.fill('12345');await expect(field).toHaveValue('12.345');
  console.log(JSON.stringify({environment,phase:'ready',unsavedField:true,blockedMutations:blocked.length}));
  if(!replayPriorHtml)await new Promise((resolve,reject)=>{
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
  // The manifest also contains retained pages of an earlier release. Identify
  // the prior page actually requested, rather than selecting the first filename.
  const sales=prior.files.find(file=>/^assets\/SalesPage-.*\.js$/.test(file.path)&&lateRequests.includes(file.path));
  assert.ok(sales&&lateRequests.includes(sales.path),'A prior lazy page must load after publication, without a reload');
  await page.getByRole('link',{name:'Pedidos',exact:true}).click();
  await page.getByRole('link',{name:'Cargar pedido manual',exact:true}).click();
  await page.getByRole('radio',{name:'Compra normal',exact:true}).waitFor();
  const retained=JSON.parse(readFileSync('output/audit/shipping-session-assets/restore.json','utf8'));
  assert.ok(prior.files.some(file=>/^assets\/(CreateOrderPage|OrdersPage)-.*\.js$/.test(file.path)&&
    retained.files.includes(file.path)&&lateRequests.includes(file.path)),
    'Also load a changed page whose prior file would be missing without retention');
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  const artifact=replayPriorHtml?'shipping-prior-html-replay-readonly.json':'shipping-open-tab-readonly.json';
  writeFileSync('output/audit/'+artifact,JSON.stringify({environment,
    priorBuildSha256:prior.buildSha256,currentBuildSha256:current.buildSha256,unsavedFieldPreserved:true,
    priorLazyPageLoaded:true,priorChangedPageLoaded:true,priorSalesResource:sales.path,
    replayPriorHtml,blockedMutations:0,errors:0},null,2),{mode:0o600});
  console.log(JSON.stringify({environment,phase:'verified',unsavedFieldPreserved:true,
    priorLazyPageLoaded:true,priorChangedPageLoaded:true,blockedMutations:0,errors:0}));
} finally {process.stdin.pause();await browser.close();await client.auth.signOut({scope:'local'});}
