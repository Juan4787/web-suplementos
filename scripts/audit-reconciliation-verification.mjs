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

  console.log('================================================================');
  console.log('AUDITORÍA RIGUROSA POST-MIGRACIÓN DE RECONCILIACIÓN DE STOCK');
  console.log('================================================================');

  const MAGNESIO_ID = '96129ad7-4bb1-56db-80d4-652d39c3ffeb';

  // 1. Balance de Magnesio
  const balRes = await client.query(`
    select p.name, sb.on_hand, sb.reserved, (sb.on_hand - sb.reserved) as available
    from stock_balances sb
    join products p on p.id = sb.product_id
    where sb.product_id = $1
  `, [MAGNESIO_ID]);
  console.log('\n1. BALANCE ACTUAL DE MAGNESIO DUAL ACTION:');
  console.table(balRes.rows);

  // 2. Reservas de Magnesio por pedido
  const resOrders = await client.query(`
    select o.order_number, o.customer_name_snapshot, sr.source_type, sr.quantity,
           sr.state, sr.purchase_item_id, sr.cost_snapshot_cents
    from stock_reservations sr
    join orders o on o.id = sr.order_id
    where sr.product_id = $1 and sr.state = 'active'
    order by o.created_at asc, o.order_number asc
  `, [MAGNESIO_ID]);
  console.log('\n2. RESERVAS ACTIVAS DE MAGNESIO POR PEDIDO:');
  console.table(resOrders.rows);

  // 3. Verificar que NO existen filas físicas duplicadas para un mismo order_item_id
  const dupRes = await client.query(`
    select order_item_id, count(*) as physical_rows_count, sum(quantity) as total_qty
    from stock_reservations
    where state = 'active' and source_type = 'physical'
    group by order_item_id
    having count(*) > 1
  `);
  console.log('\n3. VERIFICACIÓN DE FRAGMENTACIÓN DE FILAS FÍSICAS (Debe estar vacío):');
  if (dupRes.rows.length === 0) {
    console.log('✅ PERFECTO: Ningún order_item_id tiene filas físicas duplicadas o fragmentadas.');
  } else {
    console.error('❌ ALERTA: Filas físicas fragmentadas encontradas:', dupRes.rows);
  }

  // 4. Verificar integridad contable entre stock_movements y stock_balances
  const auditMoves = await client.query(`
    select sum(reserved_delta) as movement_sum_reserved
    from stock_movements
    where product_id = $1
  `, [MAGNESIO_ID]);
  console.log('\n4. INTEGRIDAD CONTABLE LIBRO MAYOR (stock_movements vs stock_balances):');
  console.log('Suma de reserved_delta en stock_movements:', auditMoves.rows[0].movement_sum_reserved);
  console.log('stock_balances.reserved actual:', balRes.rows[0].reserved);
  if (Number(auditMoves.rows[0].movement_sum_reserved) === Number(balRes.rows[0].reserved)) {
    console.log('✅ PERFECTO: La suma de movimientos en el Libro Mayor coincide exactamente con el saldo reservado.');
  } else {
    console.error('❌ ALERTA: Desfasaje entre stock_movements y stock_balances.');
  }

  // 5. Verificar que el pedido 2605 de Oscar Frutos quedó con 2 físicas
  const oscarRes = await client.query(`
    select sr.id, sr.source_type, sr.quantity, sr.state, oi.packed_quantity
    from stock_reservations sr
    join order_items oi on oi.id = sr.order_item_id
    join orders o on o.id = sr.order_id
    where o.order_number = '2605' and sr.product_id = $1 and sr.state = 'active'
  `, [MAGNESIO_ID]);
  console.log('\n5. ESTADO ESPECÍFICO DEL PEDIDO #2605 (Oscar Frutos):');
  console.table(oscarRes.rows);

  // 6. Verificar si quedan reservas incoming de Magnesio de compras futuras
  const incomingRes = await client.query(`
    select count(*) as incoming_count, sum(quantity) as incoming_qty
    from stock_reservations
    where product_id = $1 and state = 'active' and source_type = 'incoming'
  `, [MAGNESIO_ID]);
  console.log('\n6. RESERVAS INCOMING RESTANTES DE MAGNESIO (Para pedidos futuros si hubiera):');
  console.table(incomingRes.rows);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
