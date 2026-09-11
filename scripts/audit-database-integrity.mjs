import { Client } from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const envPath = path.join(rootDir, '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let val = (match[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[match[1]] = val;
  }
}

const password = (process.env.SUPABASE_DB_PASSWORD || envVars.SUPABASE_DB_PASSWORD)?.trim();
const client = new Client({
  host: `aws-0-sa-east-1.pooler.supabase.com`,
  port: 5432,
  database: 'postgres',
  user: `postgres.mvtpidtuntvebyrxivue`,
  password,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  console.log('======================================================================');
  console.log('🔬 AUDITORÍA MASIVA DE BASE DE DATOS (SOLO LECTURA)');
  console.log('======================================================================\n');

  let totalChecks = 0;
  let passedChecks = 0;
  let warnings = 0;

  async function check(name, query, validator) {
    totalChecks++;
    process.stdout.write(`• [${totalChecks.toString().padStart(2, '0')}] ${name}... `);
    try {
      const res = await client.query(query);
      const result = validator(res.rows);
      if (result.ok) {
        passedChecks++;
        console.log(`✅ OK (${result.detail})`);
      } else {
        warnings++;
        console.log(`❌ FALLÓ: ${result.detail}`);
      }
    } catch (e) {
      warnings++;
      console.log(`❌ ERROR SQL: ${e.message}`);
    }
  }

  // 1. Columnas generadas en la base de datos
  await check(
    'Columnas generadas en el esquema público',
    `SELECT table_name, column_name, generation_expression 
     FROM information_schema.columns 
     WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`,
    (rows) => {
      const cols = rows.map(r => `${r.table_name}.${r.column_name}`);
      return { ok: true, detail: `${rows.length} columna(s) generadas detectadas: ${cols.join(', ')}` };
    }
  );

  // 2. Revisar si alguna función PL/pgSQL aún intenta escribir a line_subtotal_cents
  await check(
    'Búsqueda de escrituras ilegales a line_subtotal_cents en rutinas SQL',
    `SELECT routine_name 
     FROM information_schema.routines 
     WHERE specific_schema IN ('public', 'private') 
       AND routine_definition ILIKE '%line_subtotal_cents%'
       AND (routine_definition ILIKE '%insert into%line_subtotal_cents%' 
            OR routine_definition ILIKE '%set%line_subtotal_cents%=%')`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '0 funciones intentando escribir en columna generada' };
      return { ok: false, detail: `Funciones infractoras: ${rows.map(r => r.routine_name).join(', ')}` };
    }
  );

  // 3. Consistencia de órdenes vs subtotales de ítems
  await check(
    'Consistencia de subtotal en órdenes (orders.subtotal_cents = sum(order_items.line_subtotal_cents))',
    `SELECT o.id, o.order_number, o.subtotal_cents, coalesce(sum(oi.line_subtotal_cents), 0) as calc_subtotal
     FROM public.orders o
     LEFT JOIN public.order_items oi ON oi.order_id = o.id
     WHERE o.sale_type <> 'gift' AND o.sale_type <> 'cost'
     GROUP BY o.id, o.order_number, o.subtotal_cents
     HAVING o.subtotal_cents <> coalesce(sum(oi.line_subtotal_cents), 0)`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '100% de órdenes coinciden exactamente con la suma de sus ítems' };
      return { ok: false, detail: `${rows.length} órdenes con discrepancia de subtotal` };
    }
  );

  // 4. Consistencia de órdenes de regalo (total_cents = 0, subtotal_cents = 0, shipping = 0)
  await check(
    'Consistencia estricta de pedidos marcados como regalo (total = $0, subtotal = $0)',
    `SELECT id, order_number, total_cents, subtotal_cents, shipping_fee_cents, payment_method, payment_state
     FROM public.orders
     WHERE (sale_type = 'gift' OR payment_state = 'gifted' OR payment_method = 'gift')
       AND (total_cents <> 0 OR subtotal_cents <> 0 OR shipping_fee_cents <> 0 OR payment_method <> 'gift' OR payment_state <> 'gifted')`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '0 anomalías en pedidos de regalo/cortesía' };
      return { ok: false, detail: `${rows.length} pedidos de regalo con datos inconsistentes` };
    }
  );

  // 5. Consistencia de pedidos al costo (subtotal = cost_total_cents)
  await check(
    'Consistencia de pedidos al costo (subtotal = cost_total_cents y margen neutral)',
    `SELECT id, order_number, subtotal_cents, cost_total_cents, total_cents, shipping_fee_cents
     FROM public.orders
     WHERE sale_type = 'cost'
       AND (subtotal_cents <> cost_total_cents OR total_cents <> (cost_total_cents + shipping_fee_cents))`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '0 anomalías en pedidos al costo' };
      return { ok: false, detail: `${rows.length} pedidos al costo con cálculo erróneo` };
    }
  );

  // 6. Integridad de stock_balances (on_hand >= 0 y reserved >= 0)
  await check(
    'Integridad de balances de stock físico y comprometido (sin números negativos)',
    `SELECT product_id, on_hand, reserved 
     FROM public.stock_balances 
     WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '100% de balances en valores válidos (on_hand >= reserved >= 0)' };
      return { ok: false, detail: `${rows.length} productos con balances inconsistentes` };
    }
  );

  // 7. Reservas activas vs stock_balances.reserved
  await check(
    'Concordancia entre reservas físicas activas y balances reservados',
    `WITH active_res AS (
       SELECT product_id, sum(quantity) as total_reserved
       FROM public.stock_reservations
       WHERE state = 'active' AND source_type = 'physical'
       GROUP BY product_id
     )
     SELECT sb.product_id, sb.reserved, coalesce(ar.total_reserved, 0) as calc_reserved
     FROM public.stock_balances sb
     LEFT JOIN active_res ar ON ar.product_id = sb.product_id
     WHERE sb.reserved <> coalesce(ar.total_reserved, 0)`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: 'Suma de reservas activas coincide al 100% con balances reservados' };
      return { ok: false, detail: `${rows.length} productos con discrepancia en reservas activas` };
    }
  );

  // 8. Movimientos de stock con delta = 0 o nulo
  await check(
    'Integridad de movimientos de stock registrados (sin deltas huérfanos o nulos)',
    `SELECT id, product_id, kind, physical_delta, reserved_delta 
     FROM public.stock_movements 
     WHERE (physical_delta = 0 AND reserved_delta = 0) OR physical_delta IS NULL OR reserved_delta IS NULL`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '0 movimientos vacíos o sin delta' };
      return { ok: false, detail: `${rows.length} movimientos de stock con deltas vacíos` };
    }
  );

  // 9. Compras a proveedores: sin recepciones que excedan la cantidad pedida
  await check(
    'Consistencia de órdenes de compra a proveedores (recibido + faltante <= pedida)',
    `SELECT id, purchase_id, product_id, quantity, received_quantity, shortage_quantity
     FROM public.purchase_items
     WHERE (received_quantity + shortage_quantity) > quantity
        OR received_quantity < 0 OR shortage_quantity < 0`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: '100% de ítems de compras en rangos válidos' };
      return { ok: false, detail: `${rows.length} ítems de compras con cantidades inconsistentes` };
    }
  );

  // 10. Políticas RLS en tablas críticas
  await check(
    'Verificación de Row Level Security (RLS habilitado en todas las tablas)',
    `SELECT tablename, rowsecurity 
     FROM pg_tables 
     WHERE schemaname = 'public' AND rowsecurity = false`,
    (rows) => {
      if (rows.length === 0) return { ok: true, detail: 'RLS habilitado en el 100% de tablas públicas' };
      return { ok: false, detail: `Tablas sin RLS: ${rows.map(r => r.tablename).join(', ')}` };
    }
  );

  console.log('\n======================================================================');
  console.log(`RESULTADO FASE 1: ${passedChecks}/${totalChecks} verificaciones superadas con éxito.`);
  console.log('======================================================================\n');

  await client.end();
}

main().catch(console.error);
