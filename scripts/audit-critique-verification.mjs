import { Client } from 'pg';
import { loadEnv } from 'vite';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const env = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();
const client = new Client({
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
  port: 6543,
  database: 'postgres',
  user: `postgres.${SUPABASE_PROJECT_REF}`,
  password,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();

  console.log('=== 1. VERIFICAR LA FUNCIÓN confirm_imported_order EN LA BD ===');
  const procRes = await client.query(`
    select prosrc from pg_proc where proname = 'confirm_imported_order'
  `);
  const prosrc = procRes.rows[0]?.prosrc || '';
  // Buscar cómo ordena las compras entrantes
  const orderMatch = prosrc.match(/order by pu\.[^;\n]+/i);
  console.log('Cláusula ORDER BY de compras en confirm_imported_order:', orderMatch ? orderMatch[0] : 'NO ENCONTRADA');

  console.log('\n=== 2. VERIFICAR POR QUÉ LA COMPRA 2053 NO FUE TOMADA POR EL PEDIDO 2605 ===');
  // Simular la subquery de incoming_avail sobre los items de magnesio de 2053 y 2054
  const simRes = await client.query(`
    select pu.id as purchase_id, pu.purchase_number, pu.state, pu.expected_at, pu.ordered_at,
           pi.id as purchase_item_id, pi.quantity, pi.received_quantity, pi.shortage_quantity,
           coalesce((
             select sum(sr.quantity)
             from public.stock_reservations sr
             where sr.purchase_item_id = pi.id and sr.state = 'active' and sr.source_type = 'incoming'
           ), 0) as incoming_reserved,
           (pi.quantity - pi.received_quantity - coalesce(pi.shortage_quantity, 0) - coalesce((
             select sum(sr.quantity)
             from public.stock_reservations sr
             where sr.purchase_item_id = pi.id and sr.state = 'active' and sr.source_type = 'incoming'
           ), 0)) as incoming_avail
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    where pi.product_id = '96129ad7-4bb1-56db-80d4-652d39c3ffeb'
      and pu.purchase_number in (2053, 2054)
    order by pu.expected_at asc nulls last, pu.ordered_at asc, pu.id asc, pi.id asc
  `);
  console.log(simRes.rows);

  console.log('\n=== 3. VERIFICAR EL CASO DE LORENA CARREL (#2624) Y LA CANCELACIÓN ===');
  // Buscar la orden 12b36579-14b6-4871-997c-b075f7456114
  const cancelRes = await client.query(`
    select o.id, o.order_number, o.customer_name_snapshot, o.order_state, o.created_at, o.cancelled_at
    from public.orders o
    where o.id = '12b36579-14b6-4871-997c-b075f7456114'
  `);
  console.log('Orden cancelada:', cancelRes.rows[0]);

  // Ver los movimientos de stock del 14 y 15 de octubre hasta que entró 2624
  const moveRes = await client.query(`
    select sm.id, sm.kind, sm.physical_delta, sm.reserved_delta, sm.reason, sm.order_id, o.order_number, sm.created_at
    from public.stock_movements sm
    left join public.orders o on o.id = sm.order_id
    where sm.product_id = '96129ad7-4bb1-56db-80d4-652d39c3ffeb'
      and sm.created_at >= '2026-10-14T18:00:00Z'
      and sm.created_at <= '2026-10-15T13:00:00Z'
    order by sm.created_at asc
  `);
  console.log('Movimientos alrededor de la cancelación y pedido 2624:');
  console.log(moveRes.rows);

  console.log('\n=== 4. VERIFICAR PEDIDOS 2601 (Antonela) y 2604 (Sandra) RESPECTO A MAGNESIO ===');
  const ordersMag = await client.query(`
    select o.order_number, o.customer_name_snapshot, sr.source_type, sr.purchase_item_id, p.purchase_number,
           sr.quantity, sr.state, sr.created_at
    from stock_reservations sr
    join orders o on o.id = sr.order_id
    left join purchase_items pi on pi.id = sr.purchase_item_id
    left join purchases p on p.id = pi.purchase_id
    where o.order_number in ('2601', '2604')
      and sr.product_id = '96129ad7-4bb1-56db-80d4-652d39c3ffeb'
  `);
  console.log('Reservas de Magnesio de 2601 y 2604:', ordersMag.rows);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
