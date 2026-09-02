import { describe, expect, it } from 'vitest';
import {
  calculateAvailableStock,
  calculatePercentageChange,
  simulateDiscount
} from './simulation';
import { sanitizeToolResult } from './facts';
import { collectFactsFromToolResult, FactLedger } from './fact-ledger';

describe('Certificación Capa 2: Tests de Herramientas contra Datos Controlados', () => {
  // Fixture estricto especificado por el usuario
  const controlledCreatinaFixture = {
    ref: 'product:CREA300',
    label: 'Creatina Monohidrato 300g',
    priceCents: 4300000, // $ 43.000
    costCents: 2800000, // $ 28.000
    stockRealOnHand: 7,
    reserved: 3,
    expectedAvailable: 4,
    incoming: 10,
    soldLast30Days: 17
  };

  it('get_inventory_status calcula exactamente disponible = on_hand - reserved y nunca confunde con vendidas o incoming', () => {
    const calculatedAvailable = calculateAvailableStock(
      controlledCreatinaFixture.stockRealOnHand,
      controlledCreatinaFixture.reserved
    );

    // Debe ser exactamente 4 (7 - 3)
    expect(calculatedAvailable).toBe(4);

    // NUNCA debe confundirse con las vendidas en 30 días (17)
    expect(calculatedAvailable).not.toBe(controlledCreatinaFixture.soldLast30Days);

    // NUNCA debe sumar stock en camino a la disponibilidad inmediata (7 + 10 = 17)
    expect(calculatedAvailable).not.toBe(
      controlledCreatinaFixture.stockRealOnHand + controlledCreatinaFixture.incoming
    );

    // Sanitización e integración en SafeToolResult
    const safeResult = sanitizeToolResult(
      {
        schemaVersion: 'ai-facts/v1',
        tool: 'get_inventory_status',
        facts: { 'inventory.returned_product_count': 1 },
        products: [
          {
            ref: controlledCreatinaFixture.ref,
            label: controlledCreatinaFixture.label,
            facts: {
              'stock.available_units': calculatedAvailable,
              'stock.on_hand_units': controlledCreatinaFixture.stockRealOnHand,
              'stock.reserved_units': controlledCreatinaFixture.reserved,
              'stock.incoming_units': controlledCreatinaFixture.incoming
            }
          }
        ]
      },
      'get_inventory_status'
    );

    const facts = collectFactsFromToolResult('get_inventory_status', safeResult);
    const ledger = new FactLedger();
    ledger.addAll(facts);

    const availableFact = ledger.get(`${controlledCreatinaFixture.ref}.stock.available_units`);
    expect(availableFact?.value).toBe(4);
    expect(availableFact?.displayValue).toBe('4');
  });

  it('get_product_performance preserva exactamente unidades, facturación y márgenes del período', () => {
    const rawRpcOutput = {
      schemaVersion: 'ai-facts/v1',
      tool: 'get_product_performance',
      facts: {
        'performance.revenue_cents': controlledCreatinaFixture.soldLast30Days * controlledCreatinaFixture.priceCents,
        'performance.units': controlledCreatinaFixture.soldLast30Days,
        'performance.cost_cents': controlledCreatinaFixture.soldLast30Days * controlledCreatinaFixture.costCents
      },
      products: [
        {
          ref: controlledCreatinaFixture.ref,
          label: controlledCreatinaFixture.label,
          facts: {
            'product.revenue_cents': controlledCreatinaFixture.soldLast30Days * controlledCreatinaFixture.priceCents,
            'product.units': controlledCreatinaFixture.soldLast30Days
          }
        }
      ]
    };

    const safe = sanitizeToolResult(rawRpcOutput, 'get_product_performance');
    expect(safe.facts?.['performance.units']).toBe(17);
    expect(safe.facts?.['performance.revenue_cents']).toBe(73100000); // 17 * $43.000 = $731.000 en centavos
    expect(safe.facts?.['performance.cost_cents']).toBe(47600000); // 17 * $28.000 = $476.000 en centavos
  });

  it('compare_sales_periods calcula variaciones exactas y gestiona todos los edge cases sin NaN ni Infinity', () => {
    // 100 -> 120 = +20%
    expect(calculatePercentageChange(100, 120)).toBe(20);

    // 100 -> 80 = -20%
    expect(calculatePercentageChange(100, 80)).toBe(-20);

    // 10 -> 0 = -100%
    expect(calculatePercentageChange(10, 0)).toBe(-100);

    // 0 -> 0 = 0%
    expect(calculatePercentageChange(0, 0)).toBe(0);

    // 0 -> 10 = null ("Sin dato", base cero previene división por cero / Infinity)
    const zeroBaseChange = calculatePercentageChange(0, 10);
    expect(zeroBaseChange).toBeNull();
    expect(Number.isNaN(zeroBaseChange as unknown as number)).toBe(false);
    expect(zeroBaseChange).not.toBe(Infinity);
  });

  it('las simulaciones comerciales determinísticas calculan precio, margen y descuento desde código sin el LLM', () => {
    // Escenario de prueba solicitado:
    // precio = 43.000 ($4.300.000 centavos), costo = 28.000 ($2.800.000 centavos), descuento = 15%
    const simulation = simulateDiscount({
      priceCents: 4300000,
      costCents: 2800000,
      discountPercent: 15,
      expectedUnits: 10
    });

    // Descuento = 15% de $43.000 = $6.450 (645.000 centavos)
    expect(simulation.discountAmountCents).toBe(645000);

    // Precio resultante = $43.000 - $6.450 = $36.550 (3.655.000 centavos)
    expect(simulation.discountedPriceCents).toBe(3655000);

    // Margen unitario = $36.550 - $28.000 = $8.550 (855.000 centavos)
    expect(simulation.unitMarginCents).toBe(855000);

    // Margen porcentual = (8.550 / 36.550) * 100 = 23.39%
    expect(simulation.marginPercent).toBe(23.39);

    // Totales calculados para 10 unidades
    expect(simulation.totalRevenueCents).toBe(36550000); // $ 365.500
    expect(simulation.totalMarginCents).toBe(8550000); // $ 85.500
  });

  it('la simulación comercial gestiona casos límite (descuento 0%, 50%, precio igual a costo)', () => {
    // Descuento 0%
    const zeroDiscount = simulateDiscount({
      priceCents: 4300000,
      costCents: 2800000,
      discountPercent: 0
    });
    expect(zeroDiscount.discountedPriceCents).toBe(4300000);
    expect(zeroDiscount.unitMarginCents).toBe(1500000); // $ 15.000

    // Precio exactamente igual al costo
    const breakEven = simulateDiscount({
      priceCents: 2800000,
      costCents: 2800000,
      discountPercent: 0
    });
    expect(breakEven.unitMarginCents).toBe(0);
    expect(breakEven.marginPercent).toBe(0);

    // Descuento donde el precio cae por debajo del costo (margen negativo)
    const lossSale = simulateDiscount({
      priceCents: 3000000,
      costCents: 2800000,
      discountPercent: 20 // $30.000 - $6.000 = $24.000
    });
    expect(lossSale.discountedPriceCents).toBe(2400000);
    expect(lossSale.unitMarginCents).toBe(-400000); // - $ 4.000
    expect(lossSale.marginPercent).toBeLessThan(0);
  });
});
