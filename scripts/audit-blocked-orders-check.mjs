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

  console.log('=== PEDIDOS PENDIENTES CON RESERVAS NO FÍSICAS ===');
  const res = await client.query(`
    select
      o.order_number as pedido,
      o.customer_name_snapshot as cliente,
      p.sku,
      p.name as producto_bloqueante,
      sr.source_type,
      sr.quantity as cantidad_en_espera,
      sb.on_hand as fisico_en_mano,
      sb.reserved as reservado_fisico,
      (sb.on_hand - sb.reserved) as disponible_en_local,
      pu.purchase_number as compra_esperada,
      pu.supplier_name as proveedor,
      pu.expected_at as fecha_esperada_compra
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    join public.products p on p.id = sr.product_id
    join public.stock_balances sb on sb.product_id = p.id
    left join public.purchase_items pi on pi.id = sr.purchase_item_id
    left join public.purchases pu on pu.id = pi.purchase_id
    where sr.state = 'active'
      and sr.source_type in ('incoming', 'uncovered')
      and o.order_state <> 'cancelled'
    order by o.order_number asc, p.name asc;
  `);

  console.table(res.rows);

  const availableGtZero = res.rows.filter(r => Number(r.disponible_en_local) > 0);
  if (availableGtZero.length === 0) {
    console.log('✅ CERTIFICADO: El 100% de los productos bloqueantes tienen disponible_en_local = 0.');
  } else {
    console.error('❌ ALERTA: Hay pedidos bloqueados con stock disponible:', availableGtZero);
    process.exit(1);
  }

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
