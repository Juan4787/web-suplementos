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
  port: 6543,
  database: 'postgres',
  user: `postgres.mvtpidtuntvebyrxivue`,
  password,
  ssl: { rejectUnauthorized: false }
});

async function runAdversarialAudit() {
  await client.connect();
  console.log('======================================================================');
  console.log('🛡️  AUDITORÍA ADVERSARIAL DE BASE DE DATOS (ESTRICTO READ-ONLY)');
  console.log('======================================================================\n');

  let checks = 0;
  let failures = 0;

  async function testInvariant(desc, query, conditionFn) {
    checks++;
    process.stdout.write(`[${checks.toString().padStart(2, '0')}] ${desc}... `);
    try {
      await client.query('savepoint sp_audit');
      const res = await client.query(query);
      const passed = conditionFn(res.rows);
      if (passed.ok) {
        console.log(`✅ OK (${passed.detail})`);
      } else {
        failures++;
        console.log(`❌ VIOLACIÓN: ${passed.detail}`);
      }
      await client.query('release savepoint sp_audit');
    } catch (e) {
      failures++;
      console.log(`❌ ERROR SQL: ${e.message}`);
      await client.query('rollback to savepoint sp_audit');
    }
  }

  try {
    await client.query('begin read only');

    // 1. Huérfanos en stock_reservations hacia órdenes inexistentes
    await testInvariant(
      'Reservas activas con pedido huérfano',
      `select count(*) as cnt from stock_reservations sr
       left join orders o on o.id = sr.order_id
       where sr.order_id is not null and o.id is null and sr.state = 'active'`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} reservas huérfanas` })
    );

    // 2. Huérfanos en stock_reservations hacia purchase_items inexistentes
    await testInvariant(
      'Reservas incoming con ítem de compra huérfano',
      `select count(*) as cnt from stock_reservations sr
       left join purchase_items pi on pi.id = sr.purchase_item_id
       where sr.source_type = 'incoming' and sr.state = 'active' and (sr.purchase_item_id is null or pi.id is null)`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} reservas incoming huérfanas` })
    );

    // 3. Cantidades negativas en purchases y purchase_items
    await testInvariant(
      'Ausencia de cantidades negativas en purchase_items',
      `select count(*) as cnt from purchase_items
       where quantity <= 0 or received_quantity < 0 or shortage_quantity < 0`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} ítems con cantidades ilegales` })
    );

    // 4. Desbordes: received_quantity + shortage_quantity > quantity
    await testInvariant(
      'Invariante de completitud en purchase_items (recibido + faltante <= pedido)',
      `select count(*) as cnt from purchase_items
       where (received_quantity + shortage_quantity) > quantity`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} ítems sobre-recibidos` })
    );

    // 5. Consistencia de estado de compra 'received'
    await testInvariant(
      'Compras cerradas (state = received) con 100% de ítems liquidados',
      `select p.id, p.purchase_number, count(*) as unliquidated_items
       from purchases p
       join purchase_items pi on pi.purchase_id = p.id
       where p.state = 'received' and (pi.received_quantity + pi.shortage_quantity) < pi.quantity
       group by p.id, p.purchase_number`,
      (rows) => ({ ok: rows.length === 0, detail: `${rows.length} compras 'received' con remanente abierto` })
    );

    // 6. Consistencia de compras 'ordered'
    await testInvariant(
      'Compras abiertas (state = ordered) tienen al menos un ítem con remanente',
      `select p.id, p.purchase_number
       from purchases p
       where p.state = 'ordered'
         and not exists (
           select 1 from purchase_items pi
           where pi.purchase_id = p.id and (pi.received_quantity + pi.shortage_quantity) < pi.quantity
         )`,
      (rows) => ({ ok: rows.length === 0, detail: `${rows.length} compras 'ordered' ya completadas sin cerrar` })
    );

    // 7. Reservas incoming apuntan exclusivamente a compras abiertas (state = ordered)
    await testInvariant(
      'Reservas incoming apuntan exclusivamente a compras ordered',
      `select count(*) as cnt
       from stock_reservations sr
       join purchase_items pi on pi.id = sr.purchase_item_id
       join purchases p on p.id = pi.purchase_id
       where sr.state = 'active' and sr.source_type = 'incoming' and p.state <> 'ordered'`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} reservas incoming en compras cerradas` })
    );

    // 8. Órdenes canceladas no poseen reservas activas
    await testInvariant(
      'Órdenes canceladas no poseen reservas activas en stock',
      `select count(*) as cnt
       from stock_reservations sr
       join orders o on o.id = sr.order_id
       where sr.state = 'active' and o.order_state = 'cancelled'`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} reservas activas en pedidos cancelados` })
    );

    // 9. Cantidades de reservas válidas (> 0)
    await testInvariant(
      'Ausencia de reservas con cantidad menor o igual a cero',
      `select count(*) as cnt from stock_reservations where quantity <= 0 and state = 'active'`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} reservas con cantidad <= 0` })
    );

    // 10. Balances físicos no negativos y coherencia on_hand >= reserved
    await testInvariant(
      'Balances de stock sin números negativos y coherencia on_hand >= reserved',
      `select count(*) as cnt from stock_balances
       where on_hand < 0 or reserved < 0 or on_hand < reserved`,
      (rows) => ({ ok: Number(rows[0].cnt) === 0, detail: `${rows[0].cnt} balances inconsistentes` })
    );

    // 11. Suma de reservas físicas activas coincide con balances reservados
    await testInvariant(
      'Paridad exacta entre suma de reservas físicas activas y stock_balances.reserved',
      `select sb.product_id, sb.reserved as balance_reserved, coalesce(sum(sr.quantity), 0) as active_res
       from stock_balances sb
       left join stock_reservations sr on sr.product_id = sb.product_id and sr.state = 'active' and sr.source_type = 'physical'
       group by sb.product_id, sb.reserved
       having sb.reserved <> coalesce(sum(sr.quantity), 0)`,
      (rows) => ({ ok: rows.length === 0, detail: `${rows.length} discrepancias encontradas` })
    );

    // 12. Verificación de la compra activa #2042 de Sophos
    await testInvariant(
      'Compra #2042 de Sophos en estado ordered con ítems íntegros',
      `select p.purchase_number, p.supplier_name, p.state,
              sum(pi.quantity) as total_qty,
              sum(pi.received_quantity) as rec_qty,
              sum(pi.shortage_quantity) as short_qty
       from purchases p
       join purchase_items pi on pi.purchase_id = p.id
       where p.purchase_number = 2042
       group by p.purchase_number, p.supplier_name, p.state`,
      (rows) => {
        if (rows.length === 0) return { ok: false, detail: 'Compra #2042 no encontrada' };
        const row = rows[0];
        const ok = row.state === 'ordered' && Number(row.rec_qty) >= 0;
        return { ok, detail: `Compra #${row.purchase_number} (${row.supplier_name}): ${row.state}, ${row.total_qty} u. pedidas, ${row.rec_qty} recibidas, ${row.short_qty} faltantes` };
      }
    );

    await client.query('rollback');
    console.log('\n======================================================================');
    console.log(`📊 RESULTADO AUDITORÍA: ${checks - failures}/${checks} invariantes validadas.`);
    console.log('======================================================================');
  } finally {
    await client.end();
  }
}

runAdversarialAudit().catch(err => {
  console.error('Error fatal en auditoría:', err);
  process.exit(1);
});
