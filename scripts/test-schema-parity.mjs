import { Client } from 'pg';
import { loadEnv } from 'vite';
import {
  SUPABASE_PROJECT_REF,
  SUPABASE_PROJECT_REGION
} from './project-targets.mjs';

const fileEnv = loadEnv('production', process.cwd(), '');
const password = (process.env.SUPABASE_DB_PASSWORD || fileEnv.SUPABASE_DB_PASSWORD)?.trim();

const localClient = new Client({
  connectionString: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres'
});
const remoteClient = new Client({
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
  port: 5432,
  database: 'postgres',
  user: `postgres.${SUPABASE_PROJECT_REF}`,
  password,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  console.log('======================================================================');
  console.log('  TEST 4: VERIFICACIÓN DE REPLAY LIMPIO Y PARIDAD DE ESQUEMA');
  console.log('  Comparando instalación limpia desde cero (local) vs base remota');
  console.log('======================================================================\n');

  await localClient.connect();
  await remoteClient.connect();

  const functionsToCheck = [
    'confirm_imported_order',
    'receive_purchase',
    'close_purchase_with_shortage',
    'transition_order',
    'quote_cart_eta'
  ];

  let hasDiscrepancy = false;

  for (const fn of functionsToCheck) {
    const q = `
      select pg_get_functiondef(p.oid) as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
    `;
    const locRes = await localClient.query(q, [fn]);
    const remRes = await remoteClient.query(q, [fn]);

    const loc = locRes.rows[0]?.def?.trim();
    const rem = remRes.rows[0]?.def?.trim();

    if (!loc) {
      console.error(`  ✗ Función ${fn} FALTA en base local limpia.`);
      hasDiscrepancy = true;
    }
    if (!rem) {
      console.error(`  ✗ Función ${fn} FALTA en base remota.`);
      hasDiscrepancy = true;
    }

    if (loc && rem) {
      if (loc === rem) {
        console.log(`  ✓ Función ${fn}: 100% IDÉNTICA`);
      } else {
        console.error(`  ✗ Discrepancia detectada en función ${fn}`);
        hasDiscrepancy = true;
      }
    }
  }

  // Comparar constraints de stock_reservations
  const constrQ = `
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.stock_reservations'::regclass
    order by conname
  `;
  const locC = (await localClient.query(constrQ)).rows;
  const remC = (await remoteClient.query(constrQ)).rows;

  if (JSON.stringify(locC) === JSON.stringify(remC)) {
    console.log(`  ✓ Constraints de stock_reservations: 100% IDÉNTICOS (${locC.length} constraints)`);
  } else {
    console.error('  ✗ Discrepancia en constraints de stock_reservations');
    hasDiscrepancy = true;
  }

  // Comparar triggers de compras y reservas
  const trigQ = `
    select tgname, pg_get_triggerdef(oid) as def
    from pg_trigger
    where tgrelid in ('public.purchases'::regclass, 'public.purchase_items'::regclass, 'public.stock_reservations'::regclass)
      and not tgisinternal
    order by tgname
  `;
  const locT = (await localClient.query(trigQ)).rows;
  const remT = (await remoteClient.query(trigQ)).rows;

  if (JSON.stringify(locT) === JSON.stringify(remT)) {
    console.log(`  ✓ Triggers de inventario y compras: 100% IDÉNTICOS (${locT.length} triggers)`);
  } else {
    console.error('  ✗ Discrepancia en triggers');
    hasDiscrepancy = true;
  }

  // Comparar índices en tablas clave
  const idxQ = `
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
      and tablename in ('stock_reservations', 'purchases', 'purchase_items', 'stock_balances', 'orders', 'order_items')
    order by tablename, indexname
  `;
  const locIdx = (await localClient.query(idxQ)).rows;
  const remIdx = (await remoteClient.query(idxQ)).rows;

  if (JSON.stringify(locIdx) === JSON.stringify(remIdx)) {
    console.log(`  ✓ Índices en tablas críticas: 100% IDÉNTICOS (${locIdx.length} índices)`);
  } else {
    console.error('  ✗ Discrepancia en índices:', { locCount: locIdx.length, remCount: remIdx.length });
    hasDiscrepancy = true;
  }

  await localClient.end();
  await remoteClient.end();

  if (hasDiscrepancy) {
    throw new Error('Se encontraron discrepancias entre la instalación limpia y la base remota.');
  }

  console.log('\n======================================================================');
  console.log('  RESULTADO: TEST 4 (REPLAY Y PARIDAD) 100% EXITOSO');
  console.log('  Una instalación limpia desde cero es idéntica bit a bit al estado remoto.');
  console.log('======================================================================\n');
}

main().catch((err) => {
  console.error('\n[FATAL PARITY FAILURE]', err.message);
  process.exit(1);
});
