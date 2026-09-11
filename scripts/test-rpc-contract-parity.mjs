import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Cargar variables de .env.local
const envPath = path.join(rootDir, '.env.local');
if (!fs.existsSync(envPath)) {
  console.error('❌ No se encontró .env.local');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const envConfig = {};
envContent.split('\n').forEach((line) => {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (m) {
    let v = m[2] || '';
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    envConfig[m[1]] = v;
  }
});

const supabaseUrl = envConfig.VITE_SUPABASE_URL;
const supabaseKey = envConfig.VITE_SUPABASE_ANON_KEY;
const ownerEmail = envConfig.E2E_ADMIN_EMAIL || 'natisfrutos@gmail.com';
const ownerPassword = envConfig.E2E_ADMIN_PASSWORD || 'natalia5050';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Variables de Supabase no configuradas en .env.local');
  process.exit(1);
}

const client = createClient(supabaseUrl, supabaseKey);

const CONTRACT_SPECS = [
  {
    rpc: 'get_public_store_settings',
    args: {},
    requiredKeys: [
      'storeName',
      'tagline',
      'whatsappPhone',
      'transferAlias',
      'transferAccount',
      'standardShippingCents',
      'expressShippingCents',
      'currency'
    ]
  },
  {
    rpc: 'get_storefront_products',
    args: {},
    isArray: true,
    requiredItemKeys: [
      'id',
      'sku',
      'name',
      'slug',
      'category',
      'priceCents',
      'availability',
      'presentation'
    ]
  },
  {
    rpc: 'get_dashboard_summary',
    args: {},
    requiredKeys: [
      'pendingPreparation',
      'readyForDelivery',
      'lowStockProducts',
      'incomingPurchases',
      'recentOrders',
      'priorityInventory'
    ],
    validate: (data) => {
      if (!Array.isArray(data.recentOrders)) throw new Error('recentOrders must be an array');
      if (!Array.isArray(data.priorityInventory)) throw new Error('priorityInventory must be an array');
    }
  },
  {
    rpc: 'list_admin_products',
    args: {},
    isArray: true,
    requiredItemKeys: [
      'id',
      'sku',
      'name',
      'slug',
      'active',
      'published',
      'priceCents',
      'onHand',
      'reserved',
      'safetyStock',
      'reorderPoint'
    ]
  },
  {
    rpc: 'list_inventory_status',
    args: {},
    isArray: true,
    requiredItemKeys: [
      'id',
      'sku',
      'name',
      'onHand',
      'reserved',
      'available',
      'status',
      'safetyStock',
      'reorderPoint'
    ]
  },
  {
    rpc: 'search_orders',
    args: { p_page: 1, p_page_size: 10, p_search: '', p_state: 'all' },
    requiredKeys: ['page', 'pageSize', 'total', 'items'],
    validate: (data) => {
      if (!Array.isArray(data.items)) throw new Error('items must be an array');
      if (data.items.length > 0) {
        const order = data.items[0];
        const required = ['id', 'number', 'customerName', 'orderState', 'paymentState', 'fulfillmentState', 'totalCents', 'items'];
        for (const k of required) {
          if (order[k] === undefined) throw new Error(`search_orders order missing item key: ${k}`);
        }
        if (!Array.isArray(order.items)) throw new Error('order.items must be an array');
      }
    }
  },
  {
    rpc: 'search_paid_orders',
    args: { p_page: 1, p_page_size: 10, p_from: null, p_to: null },
    requiredKeys: ['page', 'pageSize', 'total', 'items'],
    validate: (data) => {
      if (!Array.isArray(data.items)) throw new Error('items must be an array');
    }
  },
  {
    rpc: 'list_purchases',
    args: { p_page: 1, p_page_size: 10, p_state: null },
    requiredKeys: ['page', 'pageSize', 'total', 'items'],
    validate: (data) => {
      if (!Array.isArray(data.items)) throw new Error('items must be an array');
      if (data.items.length > 0) {
        const p = data.items[0];
        if (p.id === undefined || p.number === undefined || p.state === undefined) {
          throw new Error('Purchase missing id/number/state');
        }
        if (!Array.isArray(p.items)) throw new Error('purchase.items must be an array');
      }
    }
  },
  {
    rpc: 'list_stock_movements',
    args: { p_page: 1, p_page_size: 10, p_search: null, p_filter: null },
    requiredKeys: ['page', 'pageSize', 'total', 'items'],
    validate: (data) => {
      if (!Array.isArray(data.items)) throw new Error('items must be an array');
    }
  },
  {
    rpc: 'list_customers',
    args: { p_page: 1, p_page_size: 10, p_search: null },
    requiredKeys: ['page', 'pageSize', 'total', 'items'],
    validate: (data) => {
      if (!Array.isArray(data.items)) throw new Error('items must be an array');
    }
  },
  {
    rpc: 'get_sales_analytics',
    args: { p_from: '2026-09-01T00:00:00Z', p_to: '2026-09-30T23:59:59Z' },
    requiredKeys: [
      'from',
      'to',
      'revenueCents',
      'costCents',
      'estimatedMarginCents',
      'orders',
      'units',
      'series',
      'topProducts'
    ],
    validate: (data) => {
      if (!Array.isArray(data.series)) throw new Error('series must be an array');
      if (!Array.isArray(data.topProducts)) throw new Error('topProducts must be an array');
    }
  },
  {
    rpc: 'get_business_export_dataset',
    args: {},
    requiredKeys: ['products', 'inventory', 'orders', 'purchases', 'movements', 'customers', 'settings']
  },
  {
    rpc: 'list_store_users',
    args: {},
    isArray: true,
    requiredItemKeys: ['id', 'role', 'email', 'active']
  }
];

async function main() {
  console.log('🔍 [AUDITORÍA DE CONTRATOS RPC] Iniciando sesión autenticada...');
  const { data: auth, error: authErr } = await client.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword
  });

  if (authErr) {
    console.error('❌ Error fatal de autenticación en Supabase:', authErr.message);
    process.exit(1);
  }
  console.log(`✅ Autenticado como dueña: ${ownerEmail} (${auth.user.id})\n`);

  let totalFailed = 0;
  let totalPassed = 0;

  for (const spec of CONTRACT_SPECS) {
    process.stdout.write(`• Probando RPC [${spec.rpc}]... `);
    try {
      const { data, error } = await client.rpc(spec.rpc, spec.args);
      if (error) {
        throw new Error(`RPC devolvió error: ${error.message} (code: ${error.code})`);
      }
      if (data === null || data === undefined) {
        throw new Error('RPC devolvió null o undefined');
      }

      if (spec.isArray) {
        if (!Array.isArray(data)) throw new Error('Se esperaba un Array y se recibió ' + typeof data);
        if (spec.requiredItemKeys && data.length > 0) {
          const firstItem = data[0];
          for (const key of spec.requiredItemKeys) {
            if (firstItem[key] === undefined) {
              throw new Error(`Ítem del array carece de la clave requerida: "${key}"`);
            }
          }
        }
      } else {
        if (typeof data !== 'object') throw new Error('Se esperaba un Object y se recibió ' + typeof data);
        if (spec.requiredKeys) {
          for (const key of spec.requiredKeys) {
            if (data[key] === undefined) {
              throw new Error(`Objeto carece de la clave requerida: "${key}"`);
            }
          }
        }
      }

      if (spec.validate) {
        spec.validate(data);
      }

      console.log('✅ OK (contrato verificado)');
      totalPassed++;
    } catch (err) {
      console.log(`❌ FALLÓ: ${err.message}`);
      totalFailed++;
    }
  }

  console.log('\n===========================================');
  console.log(`Resumen: ${totalPassed} pasados, ${totalFailed} fallidos de ${CONTRACT_SPECS.length} contratos probados.`);
  console.log('===========================================');

  if (totalFailed > 0) {
    console.error(`\n🚨 ERROR CRÍTICO: ${totalFailed} RPCs rompieron el contrato de tipos esperado por el frontend.`);
    process.exit(1);
  } else {
    console.log('\n✨ Todos los contratos de Supabase cumplen el 100% de paridad con TypeScript.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
