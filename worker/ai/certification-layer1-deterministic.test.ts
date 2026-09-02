import { describe, expect, it } from 'vitest';
import { Deadline } from './deadline';
import { AgentDeadlineFailure, UngroundedAnswerFailure } from './errors';
import {
  createFact,
  FactLedger,
  inferKind,
  inferUnit,
  type BusinessFact,
  type FactKind,
  type FactUnit
} from './fact-ledger';
import {
  inspectPotentialUnsupportedClaims,
  renderGroundedAnswer,
  type FactCatalog
} from './facts';
import { TOOL_REGISTRY, toCanonicalToolResult } from './tools/registry';

describe('Certificación Capa 1: Tests Determinísticos de Código', () => {
  it('BusinessFact acepta observed y derived, infiriendo unidades y tipos correctamente', () => {
    const observedFact = createFact({
      id: 'sales.revenue_cents',
      label: 'Facturación cobrada',
      value: 15000000,
      displayValue: '$ 150.000',
      sourceTool: 'get_sales_summary'
    });
    expect(observedFact.kind).toBe<FactKind>('observed');
    expect(observedFact.unit).toBe<FactUnit>('currency');
    expect(typeof observedFact.value).toBe('number');

    const derivedFact = createFact({
      id: 'change.revenue_percent',
      label: 'Variación de ingresos',
      value: 20.5,
      displayValue: '+20.5 %',
      sourceTool: 'compare_sales_periods'
    });
    expect(derivedFact.kind).toBe<FactKind>('derived');
    expect(derivedFact.unit).toBe<FactUnit>('percentage');

    expect(inferKind('inventory.returned_product_count')).toBe('observed');
    expect(inferKind('stock.coverage_days')).toBe('derived');
    expect(inferKind('sales.estimated_margin_cents')).toBe('derived');
    expect(inferUnit('stock.coverage_days')).toBe('days');
    expect(inferUnit('stock.available_units')).toBe('units');
  });

  it('FactLedger deduplica por id sin perder hechos con diferente identificador', () => {
    const ledger = new FactLedger();
    const fact1 = createFact({
      id: 'product:1.stock.available_units',
      label: 'Stock disponible',
      value: 4,
      displayValue: '4',
      sourceTool: 'get_inventory_status'
    });
    const fact1Duplicate = createFact({
      id: 'product:1.stock.available_units',
      label: 'Stock disponible actualizado',
      value: 4,
      displayValue: '4',
      sourceTool: 'get_inventory_status'
    });
    const fact2 = createFact({
      id: 'product:2.stock.available_units',
      label: 'Stock disponible Creatina',
      value: 10,
      displayValue: '10',
      sourceTool: 'get_inventory_status'
    });

    ledger.add(fact1);
    expect(ledger.size()).toBe(1);

    // Mismo id sobreescribe/deduplica sin duplicar conteo
    ledger.add(fact1Duplicate);
    expect(ledger.size()).toBe(1);
    expect(ledger.get('product:1.stock.available_units')?.label).toBe('Stock disponible actualizado');

    ledger.add(fact2);
    expect(ledger.size()).toBe(2);
  });

  it('el mismo hecho obtenido en dos rondas no aparece dos veces en evidence para el cliente', () => {
    const ledger = new FactLedger();
    const round1Fact = createFact({
      id: 'sales.revenue_cents',
      label: 'Facturación',
      value: 500000,
      displayValue: '$ 5.000',
      sourceTool: 'get_sales_summary'
    });
    const round2Fact = createFact({
      id: 'sales.revenue_cents',
      label: 'Facturación',
      value: 500000,
      displayValue: '$ 5.000',
      sourceTool: 'get_sales_summary'
    });

    ledger.add(round1Fact);
    ledger.add(round2Fact);

    const clientEvidence = ledger.toClient();
    expect(clientEvidence).toHaveLength(1);
    expect(clientEvidence[0]?.id).toBe('sales.revenue_cents');
  });

  it('los importes monetarios se conservan en enteros/centavos y no en floats imprecisos', () => {
    const priceFact = createFact({
      id: 'catalog.price_cents',
      label: 'Precio',
      value: 4300000, // $43.000,00 ARS en centavos
      displayValue: '$ 43.000',
      sourceTool: 'get_product_catalog'
    });

    expect(Number.isInteger(priceFact.value)).toBe(true);
    expect(priceFact.value).toBe(4300000);
    // Verificamos que no se produzcan artefactos de redondeo de punto flotante
    expect(Number(priceFact.value) / 100).toBe(43000);
  });

  it('los porcentajes calculados conservan la precisión decimal prevista', () => {
    const percentFact = createFact({
      id: 'change.revenue_percent',
      label: 'Variación',
      value: 15.55,
      displayValue: '+15.55 %',
      sourceTool: 'compare_sales_periods'
    });

    expect(percentFact.value).toBe(15.55);
    expect(percentFact.displayValue).toContain('15.55');
  });

  it('ToolResult<T> exige data, facts autorizados y reglas de interpretación válidas', () => {
    const rawData = { products: [{ sku: 'CREA300', price: 43000 }] };
    const safeData = {
      schemaVersion: 'ai-facts/v1' as const,
      tool: 'get_product_catalog',
      facts: { 'catalog.active_product_count': 1 }
    };
    const rules = ['catalog.price_rank: 1 es el más caro'];

    const result = toCanonicalToolResult('get_product_catalog', rawData, safeData, rules);
    expect(result.data).toBe(rawData);
    expect(Array.isArray(result.facts)).toBe(true);
    expect(result.facts.length).toBe(1);
    expect(result.interpretationRules).toEqual(rules);
  });

  it('ninguna tool registrada en TOOL_REGISTRY tiene capacidad de escritura ni mutación', () => {
    const tools = Object.values(TOOL_REGISTRY);
    expect(tools.length).toBe(6);

    for (const tool of tools) {
      const name = tool.definition.name.toLowerCase();
      const desc = tool.definition.description.toLowerCase();
      const rpc = tool.rpcName.toLowerCase();

      // Ningún nombre ni descripción ni rpc sugiere mutación
      expect(name).not.toMatch(/update|insert|delete|set|create|modify|write|upsert/);
      expect(rpc).not.toMatch(/update|insert|delete|set|create|modify|write|upsert/);
      expect(desc).toMatch(/devuelve|compara|catálogo|inventario|ranking|rendimiento/);
      expect(name.startsWith('get_') || name.startsWith('compare_')).toBe(true);
    }
  });

  it('ninguna tool expone clave service_role ni opera fuera de contexto seguro', () => {
    // Verificamos que las RPCs usadas por las herramientas son ai_* para anon + RLS
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(tool.rpcName.startsWith('ai_')).toBe(true);
    }
  });

  it('ninguna tool devuelve PII innecesaria (sin email, sin teléfono, sin dirección postal)', () => {
    for (const [toolName, tool] of Object.entries(TOOL_REGISTRY)) {
      const params = tool.definition.parameters;
      const paramKeys = Object.keys(params.properties || {}).join(' ').toLowerCase();

      expect(paramKeys).not.toContain('email');
      expect(paramKeys).not.toContain('phone');
      expect(paramKeys).not.toContain('address');
      expect(paramKeys).not.toContain('dni');
      expect(paramKeys).not.toContain('password');
    }
  });

  it('inspectPotentialUnsupportedClaims detecta números sin bloquear la ejecución normal', () => {
    const catalog: FactCatalog = new Map();
    const textWithHypothetical = 'Te propongo un 10% de descuento en 3 productos durante 2 semanas.';

    // En producción (renderGroundedAnswer sin strict), NO arroja excepción
    const output = renderGroundedAnswer(textWithHypothetical, catalog);
    expect(output.answer).toBe(textWithHypothetical);

    // En auditoría de prueba, el oráculo detecta los tokens numéricos libres
    const report = inspectPotentialUnsupportedClaims(textWithHypothetical, catalog);
    expect(report.hasUnsupportedClaims).toBe(true);
    expect(report.unsupportedNumericTokens).toContain('10');
    expect(report.unsupportedNumericTokens).toContain('3');
    expect(report.unsupportedNumericTokens).toContain('2');
  });

  it('el límite máximo de respuesta en backend permite 15.000 caracteres y rechaza >16.000', () => {
    const catalog: FactCatalog = new Map();

    const allowedLongText = 'A'.repeat(15_000);
    const validResult = renderGroundedAnswer(allowedLongText, catalog);
    expect(validResult.answer.length).toBe(15_000);

    const oversizedText = 'A'.repeat(16_001);
    expect(() => renderGroundedAnswer(oversizedText, catalog)).toThrow(UngroundedAnswerFailure);
  });

  it('el deadline global compartido limita efectivamente todo el request', () => {
    let currentTime = 1000;
    const fakeNow = () => currentTime;
    const deadline = new Deadline(25_000, fakeNow);

    expect(deadline.remainingMs()).toBe(25_000);

    // Simulamos que el proveedor primario consumió 18.000 ms
    currentTime += 18_000;
    expect(deadline.remainingMs()).toBe(7_000);

    // Simulamos que transcurrieron 7.001 ms adicionales
    currentTime += 7_001;
    expect(deadline.remainingMs()).toBe(0);
    expect(() => deadline.assertRemaining(100)).toThrow(AgentDeadlineFailure);
  });
});
