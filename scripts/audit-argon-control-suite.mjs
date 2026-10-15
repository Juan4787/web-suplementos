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
  console.log('CONSULTA 1: AUDITORÍA GLOBAL DE INVARIANTES (TODO EL CATÁLOGO)');
  console.log('================================================================');
  const q1 = await client.query(`
    with active_phys_res as (
      select
        product_id,
        sum(quantity)::integer as sum_phys_res,
        count(*) filter (where purchase_item_id is not null) as dirty_purchase_links
      from public.stock_reservations
      where state = 'active' and source_type = 'physical'
      group by product_id
    ),
    active_wait_res as (
      select
        sr.product_id,
        sum(sr.quantity)::integer as sum_waiting_res
      from public.stock_reservations sr
      join public.orders o on o.id = sr.order_id
      where sr.state = 'active'
        and sr.source_type in ('incoming', 'uncovered')
        and o.order_state <> 'cancelled'
      group by sr.product_id
    ),
    dup_phys as (
      select
        product_id,
        count(*) as duplicate_item_groups
      from (
        select product_id, order_item_id, is_opening
        from public.stock_reservations
        where state = 'active' and source_type = 'physical'
        group by product_id, order_item_id, is_opening
        having count(*) > 1
      ) d
      group by product_id
    )
    select
      p.name as producto,
      sb.on_hand as en_mano,
      sb.reserved as reservado_balance,
      coalesce(apr.sum_phys_res, 0) as suma_res_fisicas,
      (sb.on_hand - sb.reserved) as disponible_actual,
      coalesce(awr.sum_waiting_res, 0) as esperando_en_camino,
      coalesce(apr.dirty_purchase_links, 0) as fisicas_con_compra_sucia,
      coalesce(dp.duplicate_item_groups, 0) as items_fisicos_duplicados,
      case
        when sb.reserved <> coalesce(apr.sum_phys_res, 0) then 'ERROR: Desfase balance vs reservas'
        when (sb.on_hand - sb.reserved) > 0 and coalesce(awr.sum_waiting_res, 0) > 0 then 'ERROR: Stock libre sin reconciliar'
        when coalesce(apr.dirty_purchase_links, 0) > 0 then 'ERROR: Reserva fisica con purchase_item_id'
        when coalesce(dp.duplicate_item_groups, 0) > 0 then 'ERROR: Filas fisicas duplicadas sin fusionar'
        else 'OK PERFECTO'
      end as veredicto
    from public.products p
    join public.stock_balances sb on sb.product_id = p.id
    left join active_phys_res apr on apr.product_id = p.id
    left join active_wait_res awr on awr.product_id = p.id
    left join dup_phys dp on dp.product_id = p.id
    where sb.on_hand > 0 or sb.reserved > 0 or coalesce(awr.sum_waiting_res, 0) > 0
    order by
      case when p.name ilike '%magnesio%' or p.name ilike '%complex%' then 0 else 1 end,
      p.name asc;
  `);

  console.log(`Total productos analizados con movimiento/stock: ${q1.rows.length}`);
  const errorsQ1 = q1.rows.filter(r => r.veredicto !== 'OK PERFECTO');
  if (errorsQ1.length > 0) {
    console.error('❌ ERRORES ENCONTRADOS:', errorsQ1);
  } else {
    console.log('✅ TODOS los productos dieron veredicto: OK PERFECTO');
  }
  console.log('\nPrimeras filas destacadas (Magnesio, Complex, etc.):');
  console.table(q1.rows.slice(0, 10));

  console.log('\n================================================================');
  console.log('CONSULTA 2: RADIOGRAFÍA DE LOS PEDIDOS #2605 AL #2624');
  console.log('================================================================');
  const q2 = await client.query(`
    select
      o.order_number as pedido,
      o.order_state as estado_pedido,
      p.name as producto,
      sr.source_type as tipo_reserva,
      sr.quantity as cantidad,
      sr.purchase_item_id as id_compra_vinculada,
      sr.cost_snapshot_cents as costo_cents,
      count(*) over (partition by sr.order_item_id, sr.source_type) as filas_por_item
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    join public.products p on p.id = sr.product_id
    where o.order_number::text in ('2605', '2611', '2613', '2616', '2617', '2620', '2621', '2624')
      and sr.state = 'active'
    order by o.order_number::integer asc, p.name asc;
  `);
  console.table(q2.rows);

  console.log('\n================================================================');
  console.log('CONSULTA 3.A: MOVIMIENTOS GENERADOS POR RECONCILIACIÓN');
  console.log('================================================================');
  const q3a = await client.query(`
    select
      sm.created_at,
      sm.product_name_snapshot as producto,
      sm.kind,
      sm.physical_delta,
      sm.reserved_delta,
      o.order_number as pedido,
      sm.reason,
      sm.created_by
    from public.stock_movements sm
    left join public.orders o on o.id = sm.order_id
    where sm.reason ilike '%reconciliación%'
    order by sm.created_at desc, o.order_number asc;
  `);
  console.table(q3a.rows);

  console.log('\n================================================================');
  console.log('CONSULTA 3.B: CUPO ENTRANTE LIBRE EN COMPRAS ABIERTAS (MAGNESIO)');
  console.log('================================================================');
  const q3b = await client.query(`
    select
      pu.id as purchase_id,
      pu.purchase_number,
      p.name as producto,
      pi.quantity as cant_comprada,
      pi.received_quantity as cant_recibida,
      coalesce(sum(sr.quantity), 0)::integer as reservado_en_camino,
      (pi.quantity - pi.received_quantity - coalesce(pi.shortage_quantity, 0) - coalesce(sum(sr.quantity), 0))::integer as cupo_entrante_libre
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    join public.products p on p.id = pi.product_id
    left join public.stock_reservations sr
      on sr.purchase_item_id = pi.id
      and sr.state = 'active'
      and sr.source_type = 'incoming'
    where pu.state = 'ordered'
      and p.name ilike '%magnesio%'
    group by pu.id, pu.purchase_number, p.name, pi.quantity, pi.received_quantity, pi.shortage_quantity;
  `);
  console.table(q3b.rows);

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
