import { loadEnv } from 'vite';
import { chromium } from '@playwright/test';
import { PROJECT_ROOT, SUPABASE_API_HOST, SUPABASE_PROJECT_REF } from './project-targets.mjs';

const PRODUCTION_ORIGIN = 'https://impulso.suplementos.workers.dev';
const supabaseUrl = `https://${SUPABASE_API_HOST}`;
const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY || '').trim();
const email = (process.env.E2E_EMAIL || fileEnv.E2E_EMAIL || '').trim();
const password = (process.env.E2E_PASSWORD || fileEnv.E2E_PASSWORD || '').trim();

if (new URL(PRODUCTION_ORIGIN).hostname !== 'impulso.suplementos.workers.dev') {
  throw new Error('production smoke target guard failed');
}
if (!anonKey || !email || !password) throw new Error('production smoke credentials are missing');

const json = async (response, phase) => {
  try {
    return await response.json();
  } catch {
    throw new Error(`${phase}: non-json response`);
  }
};

const authenticate = async () => {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const body = await json(response, 'auth');
  if (!response.ok || typeof body.access_token !== 'string' || body.access_token.length < 20) {
    throw new Error('auth: owner sign-in failed');
  }
  return body.access_token;
};

const ask = async (token, message, history) => {
  const response = await fetch(`${PRODUCTION_ORIGIN}/api/ai`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: PRODUCTION_ORIGIN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ message, history, modelPreference: 'auto' })
  });
  const body = await json(response, message);
  return { status: response.status, body };
};

const assertSuccess = (result, phase) => {
  if (result.status !== 200 || typeof result.body.answer !== 'string' || result.body.answer.length < 1) {
    throw new Error(`${phase}: production request failed (${result.status}/${result.body.error?.kind ?? 'unknown'})`);
  }
  if (result.body.error) throw new Error(`${phase}: production returned an error`);
  if (/\{\{fact:|\b(?:RPC|Groq|Cloudflare|provider|tool_call)\b/i.test(result.body.answer)) {
    throw new Error(`${phase}: response leaked an internal implementation detail`);
  }
};

const appendHistory = (history, user, result) => [
  ...history,
  { role: 'user', content: user },
  { role: 'assistant', content: result.body.answer }
].slice(-6);

const waitForNextQuotaMinute = async () => {
  let remaining = 60_100 - (Date.now() % 60_000);
  while (remaining > 0) {
    const chunk = Math.min(30_000, remaining);
    await new Promise((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
};

const runApiSmoke = async () => {
  const token = await authenticate();
  const rpcResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/ai_get_product_catalog`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: '{}'
  });
  const rpcBody = await json(rpcResponse, 'catalog rpc');
  if (!rpcResponse.ok || rpcBody?.tool !== 'get_product_catalog' || !Array.isArray(rpcBody?.products)) {
    throw new Error(`catalog rpc: remote function failed (${rpcResponse.status})`);
  }
  console.log('PASS production catalog rpc');
  let history = [];

  const generalQuestions = [
    '¿De qué podemos hablar?',
    'Técnicas para vender más',
    'Interesante',
    'Hola'
  ];
  let strategyAnswer = '';
  for (const [index, generalQuestion] of generalQuestions.entries()) {
    const general = await ask(token, generalQuestion, history);
    assertSuccess(general, `general advice ${index + 1}`);
    if (general.body.usedTools?.length !== 0 || general.body.evidence?.length !== 0) {
      throw new Error(`general advice ${index + 1}: unexpectedly queried commercial data`);
    }
    if (generalQuestion === 'Técnicas para vender más') strategyAnswer = general.body.answer;
    history = appendHistory(history, generalQuestion, general);
  }
  if (!/venta|cliente|beneficio|promoc|combo|objetivo/i.test(strategyAnswer)) {
    throw new Error('general advice: strategy answer was not substantive');
  }
  console.log('PASS production general conversation with long-history follow-ups');

  const catalogQuestion = '¿Qué productos tengo?';
  const catalog = await ask(token, catalogQuestion, history);
  assertSuccess(catalog, 'catalog');
  if (!catalog.body.usedTools?.includes('get_product_catalog') || catalog.body.evidence?.length < 2) {
    throw new Error('catalog: exact tool/evidence contract failed');
  }
  history = appendHistory(history, catalogQuestion, catalog);
  console.log('PASS production catalog');

  const specificPriceQuestion = '¿Qué precio tiene la creatina?';
  const specificPrice = await ask(token, specificPriceQuestion, history);
  assertSuccess(specificPrice, 'specific price');
  if (!specificPrice.body.usedTools?.includes('get_product_catalog') || specificPrice.body.evidence?.length < 1) {
    throw new Error('specific price: exact tool/evidence contract failed');
  }
  if (!/\$|pesos|ars/i.test(specificPrice.body.answer)) {
    throw new Error('specific price: formatted price missing');
  }
  history = appendHistory(history, specificPriceQuestion, specificPrice);
  console.log('PASS production specific price');

  const marketPriceQuestion = '¿El precio de la creatina te parece barato para Argentina?';
  const marketPrice = await ask(token, marketPriceQuestion, history);
  assertSuccess(marketPrice, 'market price context');
  if (!marketPrice.body.usedTools?.includes('get_product_catalog') || marketPrice.body.evidence?.length < 1) {
    throw new Error('market price context: exact tool/evidence contract failed');
  }
  if (!/argentina|mercado|extern|referencia|compar/i.test(marketPrice.body.answer)) {
    throw new Error('market price context: missing honest market limitation or comparison');
  }
  history = appendHistory(history, marketPriceQuestion, marketPrice);
  console.log('PASS production market-price limitation and store context');

  const priceQuestion = '¿Cuál es el producto más caro?';
  const price = await ask(token, priceQuestion, history);
  assertSuccess(price, 'highest price');
  if (!price.body.usedTools?.includes('get_product_catalog') || price.body.evidence?.length < 2) {
    throw new Error('highest price: exact tool/evidence contract failed');
  }
  history = appendHistory(history, priceQuestion, price);
  console.log('PASS production highest price');

  const colloquialPriceQuestion = '¿Cuál te parece que está caro?';
  const colloquialPrice = await ask(token, colloquialPriceQuestion, history);
  assertSuccess(colloquialPrice, 'colloquial highest price');
  if (!colloquialPrice.body.usedTools?.includes('get_product_catalog') || colloquialPrice.body.evidence?.length < 2) {
    throw new Error('colloquial highest price: exact tool/evidence contract failed');
  }
  if (!/\$|pesos|ars/i.test(colloquialPrice.body.answer)) {
    throw new Error('colloquial highest price: formatted price missing');
  }
  history = appendHistory(history, colloquialPriceQuestion, colloquialPrice);
  console.log('PASS production colloquial highest price');

  const comparisonQuestion = 'Compará las ventas cobradas de agosto con julio.';
  const comparison = await ask(token, comparisonQuestion, history);
  assertSuccess(comparison, 'sales comparison');
  if (!comparison.body.usedTools?.includes('compare_sales_periods') || comparison.body.evidence?.length < 1) {
    throw new Error('sales comparison: exact tool/evidence contract failed');
  }
  if (!/facturaci[oó]n|margen|pedidos|unidades/i.test(comparison.body.answer)) {
    throw new Error('sales comparison: analytical summary missing');
  }
  history = appendHistory(history, comparisonQuestion, comparison);
  console.log('PASS production sales comparison');

  const topQuestion = '¿Cuál se vendió más?';
  const top = await ask(token, topQuestion, history);
  assertSuccess(top, 'empty sales ranking');
  if (!top.body.usedTools?.includes('get_top_selling_products') || top.body.evidence?.length < 1) {
    throw new Error('empty sales ranking: exact tool/evidence contract failed');
  }
  if (!/no hay productos con ventas cobradas/i.test(top.body.answer)) {
    throw new Error('empty sales ranking: deterministic empty response missing');
  }
  history = appendHistory(history, topQuestion, top);
  console.log('PASS production empty sales ranking');

  const inventoryQuestion = '¿Qué productos debería comprar esta semana?';
  const inventory = await ask(token, inventoryQuestion, history);
  assertSuccess(inventory, 'inventory priority');
  if (!inventory.body.usedTools?.includes('get_inventory_status') || inventory.body.evidence?.length < 1) {
    throw new Error('inventory priority: exact tool/evidence contract failed');
  }
  if (!/compr|repon|stock|atenci[oó]n|producto/i.test(inventory.body.answer)) {
    throw new Error('inventory priority: no actionable inventory explanation');
  }
  history = appendHistory(history, inventoryQuestion, inventory);

  const performanceQuestion = '¿Cómo rindió la creatina durante agosto?';
  const performance = await ask(token, performanceQuestion, history);
  assertSuccess(performance, 'product performance');
  if (!performance.body.usedTools?.includes('get_product_performance') || performance.body.evidence?.length < 1) {
    throw new Error('product performance: exact tool/evidence contract failed');
  }
  if (!/unidades|facturaci[oó]n|margen|pedidos/i.test(performance.body.answer)) {
    throw new Error('product performance: analytical answer missing');
  }
  console.log('PASS production mixed business conversation');
};

const runBrowserSmoke = async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${PRODUCTION_ORIGIN}/ingresar`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Correo').fill(email);
    await page.getByLabel('Contraseña').fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await page.waitForURL('**/app', { timeout: 30_000 });
    await page.goto(`${PRODUCTION_ORIGIN}/app/ia`, { waitUntil: 'networkidle' });
    const input = page.locator('textarea').first();
    if (!(await input.isVisible())) throw new Error('browser: assistant input is not visible');

    const questions = [
      { text: '¿De qué podemos hablar?', kind: 'general' },
      { text: 'Técnicas para vender más', kind: 'strategy' },
      { text: 'Interesante', kind: 'general' },
      { text: 'Hola', kind: 'general' },
      { text: '¿Qué productos tengo?', kind: 'business' },
      { text: '¿Qué precio tiene la creatina?', kind: 'business' },
      { text: '¿El precio de la creatina te parece barato para Argentina?', kind: 'business' },
      { text: '¿Cuál es el producto más caro?', kind: 'business' },
      { text: '¿Cuál te parece que está caro?', kind: 'business' },
      { text: 'Compará las ventas cobradas de agosto con julio.', kind: 'business' },
      { text: '¿Cuál se vendió más?', kind: 'business' },
      { text: '¿Qué productos debería comprar esta semana?', kind: 'business' },
      { text: '¿Cómo rindió la creatina durante agosto?', kind: 'business' }
    ];
    for (const [index, question] of questions.entries()) {
      const before = await page.locator('article').count();
      await input.fill(question.text);
      await input.press('Enter');
      try {
        await page.waitForFunction(
          ({ beforeCount }) => document.querySelectorAll('article').length >= beforeCount + 2,
          { beforeCount: before },
          { timeout: 45_000 }
        );
      } catch (error) {
        const articleCount = await page.locator('article').count();
        const errorVisible = await page
          .getByText(/No pudimos interpretar|El asistente no está disponible|alcanzó el límite/, { exact: false })
          .count();
        const pending = await page.locator('textarea').first().isDisabled().catch(() => false);
        throw new Error(`browser: question ${index + 1} timed out (articles=${articleCount}, error=${errorVisible > 0}, pending=${pending})`);
      }
      const articles = page.locator('article');
      const assistant = articles.nth((await articles.count()) - 1);
      const assistantText = await assistant.innerText();
      if (assistantText.match(/No pudimos interpretar|El asistente no está disponible|alcanzó el límite/)) {
        throw new Error(`browser: question ${index + 1} returned temporary error`);
      }
      if (question.kind === 'strategy' && !/venta|cliente|beneficio|promoc|combo|objetivo/i.test(assistantText)) {
        throw new Error(`browser: question ${index + 1} strategy answer was not substantive`);
      }
      if (question.text.startsWith('¿Qué precio') && !/\$|pesos|ars/i.test(assistantText)) {
        throw new Error(`browser: question ${index + 1} formatted price missing`);
      }
      if (question.text.includes('Argentina') && !/argentina|mercado|extern|referencia|compar/i.test(assistantText)) {
        throw new Error(`browser: question ${index + 1} market limitation or comparison missing`);
      }
      if (question.text.startsWith('Compará') && !/facturaci[oó]n|margen|pedidos|unidades/i.test(assistantText)) {
        throw new Error(`browser: question ${index + 1} analytical summary missing`);
      }
      if (question.text.startsWith('¿Cómo rindió') && !/unidades|facturaci[oó]n|margen|pedidos/i.test(assistantText)) {
        throw new Error(`browser: question ${index + 1} product analysis missing`);
      }
    }
    console.log('PASS browser mixed conversation');
  } finally {
    await browser.close();
  }
};

await runApiSmoke();
console.log('WAIT production quota window before browser smoke');
await waitForNextQuotaMinute();
await runBrowserSmoke();
console.log(`Production smoke complete for ${SUPABASE_PROJECT_REF}`);
