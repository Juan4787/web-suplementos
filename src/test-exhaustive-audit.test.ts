import { describe, it, expect } from 'vitest';
import { buildWhatsAppProtocol, parseWhatsAppProtocol } from './domain/whatsapp';
import { demoSettings, demoProducts } from './data/demo-data';
import { demoBusinessApi } from './services/demo-business-api';
import { Client } from 'pg';
import { loadEnv } from 'vite';
// @ts-expect-error project-targets.mjs has no ts declarations
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION, WORKER_ORIGIN } from '../scripts/project-targets.mjs';

describe('Auditoría Exhaustiva de Todos los Cambios Recientes', () => {

  describe('1. Protocolo de WhatsApp y Nuevo Encabezado', () => {
    const sampleCheckout = {
      customerName: 'Juan Pérez',
      phone: '3426987412',
      paymentMethod: 'cash' as const,
      deliveryMethod: 'shipping' as const,
      shippingType: 'standard' as const,
      address: 'Av santa fe',
      addressNumber: '3025',
      notes: null
    };

    const sampleLines = [
      {
        productId: demoProducts[0]!.id,
        sku: demoProducts[0]!.sku,
        slug: demoProducts[0]!.slug,
        name: demoProducts[0]!.name,
        presentation: demoProducts[0]!.presentation,
        quantity: 2,
        unitPriceCents: 3300000,
        imageUrl: demoProducts[0]!.imageUrl
      }
    ];

    it('genera el mensaje comenzando exactamente con PEDIDO DE TIENDA DE SUPLEMENTOS (sin negrita)', () => {
      const protocol = buildWhatsAppProtocol(sampleCheckout, sampleLines, demoSettings);
      expect(protocol.message.startsWith('PEDIDO DE TIENDA DE SUPLEMENTOS')).toBe(true);
      expect(protocol.message).not.toContain('*');
      expect(protocol.orderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(protocol.message.trim()).toMatch(/[0-9A-F]{8}$/);
    });

    it('el parser interpreta el nuevo mensaje generado de manera determinística', () => {
      const protocol = buildWhatsAppProtocol(sampleCheckout, sampleLines, demoSettings);
      const parsed = parseWhatsAppProtocol(protocol.message);
      expect(parsed.customerName).toBe('Juan Pérez');
      expect(parsed.protocolOrderId).toBe(protocol.orderId);
      expect(parsed.quotedTotalCents).toBe(6600000);
      expect(parsed.shippingFeeCents).toBe(0);
    });

    it('mantiene retrocompatibilidad con órdenes históricas (*PEDIDO IMPULSO*)', () => {
      const legacyOrder = `*PEDIDO IMPULSO*

*Código de pedido*
95abcf6b-0560-43a0-9862-e8318be10672

*Nombre*
Juan Pablo

*Productos*
* [CREATINA] CREATINA | 300 GRS | 1 x $ 30.000 = $ 30.000
* [OMEGA_3] OMEGA 3 | 120 CAPS | 1 x $ 102.000 = $ 102.000

*Subtotal*
$ 132.000

*Medio de pago*
Transferencia

*Entrega*
Retiro

*Envío*
$ 0

*Total*
$ 132.000

*Código de control*
DCE085E3`;

      const parsed = parseWhatsAppProtocol(legacyOrder);
      expect(parsed.customerName).toBe('Juan Pablo');
      expect(parsed.protocolOrderId).toBe('95abcf6b-0560-43a0-9862-e8318be10672');
      expect(parsed.quotedTotalCents).toBe(13200000);
    });

    it('bloquea intentos de manipulación de precios o productos mediante checksum FNV-1a', () => {
      const protocol = buildWhatsAppProtocol(sampleCheckout, sampleLines, demoSettings);
      const tampered = protocol.message.replace('2 x $', '5 x $');
      expect(() => parseWhatsAppProtocol(tampered)).toThrow('El mensaje fue modificado o está incompleto.');
    });
  });

  describe('2. Envíos Sin Costos Fijos ("A coordinar" a todo el país)', () => {
    const sampleCheckout = {
      customerName: 'Cliente Envíos',
      phone: '1198765432',
      paymentMethod: 'cash' as const,
      deliveryMethod: 'shipping' as const,
      shippingType: 'standard' as const,
      address: 'Calle Falsa',
      addressNumber: '123',
      notes: null
    };

    const sampleLines = [
      {
        productId: demoProducts[0]!.id,
        sku: demoProducts[0]!.sku,
        slug: demoProducts[0]!.slug,
        name: demoProducts[0]!.name,
        presentation: demoProducts[0]!.presentation,
        quantity: 1,
        unitPriceCents: 3300000,
        imageUrl: demoProducts[0]!.imageUrl
      }
    ];

    it('emite "Envío\\nA coordinar" en el mensaje cuando el costo es cero', () => {
      const protocol = buildWhatsAppProtocol(sampleCheckout, sampleLines, demoSettings);
      expect(protocol.message).toContain('Envío\nA coordinar');
    });

    it('el parser interpreta "A coordinar" con shippingFeeCents = 0 sin discrepancias', () => {
      const protocol = buildWhatsAppProtocol(sampleCheckout, sampleLines, demoSettings);
      const parsed = parseWhatsAppProtocol(protocol.message);
      expect(parsed.shippingFeeCents).toBe(0);
      expect(parsed.quotedSubtotalCents).toBe(3300000);
      expect(parsed.quotedTotalCents).toBe(3300000);
    });
  });

  describe('3. Edición de Pedidos de Compra a Proveedores', () => {
    it('permite crear, editar campos e ítems, y bloquea ediciones tras ser recibida', async () => {
      const created = await demoBusinessApi.createPurchase({
        supplierName: 'Distribuidora Alpha',
        expectedAt: '2026-09-20T12:00:00Z',
        notes: 'Nota 1',
        items: [{ productId: demoProducts[0]!.id, quantity: 10, unitCostCents: 100000 }]
      });

      expect(created.state).toBe('ordered');
      expect(created.totalCostCents).toBe(1000000);

      const edited = await demoBusinessApi.updatePurchase({
        id: created.id,
        supplierName: 'Distribuidora Alpha Modificada',
        expectedAt: '2026-09-25T12:00:00Z',
        notes: 'Nota modificada',
        items: [
          { productId: demoProducts[0]!.id, quantity: 15, unitCostCents: 110000 },
          { productId: demoProducts[1]!.id, quantity: 5, unitCostCents: 200000 }
        ]
      });

      expect(edited.supplierName).toBe('Distribuidora Alpha Modificada');
      expect(edited.notes).toBe('Nota modificada');
      expect(edited.items.length).toBe(2);
      expect(edited.totalCostCents).toBe(15 * 110000 + 5 * 200000);

      // Recibir la compra
      await demoBusinessApi.receivePurchase(created.id);

      // Intentar editar después de recibida debe ser bloqueado
      await expect(
        demoBusinessApi.updatePurchase({
          id: created.id,
          supplierName: 'Intento Post Recepcion',
          items: [{ productId: demoProducts[0]!.id, quantity: 5, unitCostCents: 100000 }]
        })
      ).rejects.toThrow('Solo se pueden editar pedidos pendientes de recepción.');
    });
  });

  describe('4. Auditoría de Base de Datos de Producción (Solo Lectura)', () => {
    it('verifica paridad de migraciones, RLS, $0 de envío y ausencia de anomalías', async () => {
      const env = loadEnv('production', process.cwd(), '');
      const db = new Client({
        host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
        port: 5432,
        database: 'postgres',
        user: `postgres.${SUPABASE_PROJECT_REF}`,
        password: env.SUPABASE_DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
        statement_timeout: 15000,
        options: '-c default_transaction_read_only=on'
      });

      try {
        await db.connect();
        await db.query('begin read only');

        // Migraciones (44 incluyendo corrección de columna generada, venta al costo y soporte de regalos)
        const migrationsRes = await db.query('select count(*) as count from supabase_migrations.schema_migrations');
        expect(Number(migrationsRes.rows[0].count)).toBe(44);

        // Columna sale_type en orders
        const saleTypeRes = await db.query(`
          select column_name from information_schema.columns 
          where table_schema = 'public' and table_name = 'orders' and column_name = 'sale_type'
        `);
        expect(saleTypeRes.rows.length).toBe(1);

        // Enums de regalo / cortesía presentes en base de datos
        const enumStateRes = await db.query(`
          select enumlabel from pg_enum 
          where enumtypid = 'public.payment_state'::regtype and enumlabel = 'gifted'
        `);
        expect(enumStateRes.rows.length).toBe(1);

        const enumMethodRes = await db.query(`
          select enumlabel from pg_enum 
          where enumtypid = 'public.payment_method'::regtype and enumlabel = 'gift'
        `);
        expect(enumMethodRes.rows.length).toBe(1);

        // RPC update_purchase presente
        const rpcRes = await db.query(`
          select routine_name from information_schema.routines 
          where routine_schema = 'public' and routine_name = 'update_purchase'
        `);
        expect(rpcRes.rows.length).toBeGreaterThan(0);

        // Configuración de envíos sin costos fijos
        const settingsRes = await db.query('select standard_shipping_cents, express_shipping_cents from store_settings limit 1');
        expect(Number(settingsRes.rows[0].standard_shipping_cents)).toBe(0);
        expect(Number(settingsRes.rows[0].express_shipping_cents)).toBe(0);

        // Integridad de stock (cero balances negativos, cero desfasajes con reservas)
        const stockAudit = (await db.query(`
          select 
            count(*) filter (where reserved < 0 or on_hand < reserved) as invalid_balances,
            count(*) filter (where reserved <> coalesce((
              select sum(quantity) from stock_reservations sr 
              where sr.product_id = sb.product_id and sr.state = 'active' and sr.source_type = 'physical'
            ), 0)) as reservation_mismatches
          from stock_balances sb
        `)).rows[0];
        expect(Number(stockAudit.invalid_balances)).toBe(0);
        expect(Number(stockAudit.reservation_mismatches)).toBe(0);

        // Tablas con RLS
        const rlsCheck = (await db.query(`
          select count(*) as missing_rls from pg_class c 
          join pg_namespace n on n.oid = c.relnamespace 
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
        `)).rows[0];
        expect(Number(rlsCheck.missing_rls)).toBe(0);

        await db.query('rollback');
      } finally {
        await db.end();
      }
    });
  });

  describe('5. Auditoría de Endpoints Vivos en Cloudflare Workers', () => {
    it('responde HTTP 200 OK en tienda, panel administrativo y healthcheck', async () => {
      for (const path of ['/', '/app/pedidos', '/api/health']) {
        const resp = await fetch(`${WORKER_ORIGIN}${path}`, { signal: AbortSignal.timeout(10000) });
        expect(resp.status).toBe(200);
      }
    });
  });

});
