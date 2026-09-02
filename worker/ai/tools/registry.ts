import { z } from 'zod';
import { InvalidToolCallFailure } from '../errors';
import type { CanonicalTool, CanonicalToolCall } from '../types';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Fecha inválida');

const boundedPeriod = (from: string, to: string): boolean => {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  const days = (toMs - fromMs) / 86_400_000;
  return days >= 0 && days <= 366;
};

const salesSummarySchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine(({ from, to }) => boundedPeriod(from, to));

const compareSalesSchema = z
  .object({
    firstFrom: isoDate,
    firstTo: isoDate,
    secondFrom: isoDate,
    secondTo: isoDate
  })
  .strict()
  .refine(
    ({ firstFrom, firstTo, secondFrom, secondTo }) =>
      boundedPeriod(firstFrom, firstTo) && boundedPeriod(secondFrom, secondTo)
  );

const productCatalogSchema = z.object({}).strict();

const inventorySchema = z
  .object({
    query: z.string().trim().min(1).max(80).optional(),
    onlyAttention: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(12)
  })
  .strict();

const productPerformanceSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    query: z.string().trim().min(1).max(80),
    limit: z.number().int().min(1).max(10).default(10)
  })
  .strict()
  .refine(({ from, to }) => boundedPeriod(from, to));

const topSellingProductsSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    limit: z.number().int().min(1).max(10).default(10)
  })
  .strict()
  .refine(({ from, to }) => boundedPeriod(from, to));

import type { BusinessFact } from '../fact-ledger';
import { collectFactsFromToolResult } from '../fact-ledger';
import { formatFact, humanizeFactId, type SafeToolResult } from '../facts';

export interface ToolResult<T = unknown> {
  data: T;
  facts: BusinessFact[];
  interpretationRules?: string[];
}

export type ToolSpec<Input = Record<string, unknown>, Output = unknown> = {
  definition: CanonicalTool;
  schema: z.ZodType<Input>;
  rpcName: string;
  toRpcArgs: (args: Input) => Record<string, unknown>;
  interpretationRules?: string[];
};

export const toCanonicalToolResult = <T = unknown>(
  toolName: string,
  rawResult: unknown,
  safeResult: SafeToolResult,
  interpretationRules?: string[]
): ToolResult<T> => ({
  data: rawResult as T,
  facts: collectFactsFromToolResult(toolName, safeResult, {
    humanizeFactId,
    formatFact
  }),
  ...(interpretationRules && interpretationRules.length > 0 ? { interpretationRules } : {})
});

export const TOOL_REGISTRY: Record<string, ToolSpec<any, any>> = {
  get_sales_summary: {
    definition: {
      name: 'get_sales_summary',
      description: 'Devuelve ventas cobradas, costos, impuestos, margen, pedidos y unidades para un período de hasta 366 días.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date', description: 'Fecha inicial YYYY-MM-DD.' },
          to: { type: 'string', format: 'date', description: 'Fecha final YYYY-MM-DD.' }
        },
        required: ['from', 'to'],
        additionalProperties: false
      }
    },
    schema: salesSummarySchema,
    rpcName: 'ai_get_sales_summary',
    toRpcArgs: (args) => ({ p_from: args.from, p_to: args.to }),
    interpretationRules: [
      'Ventas, margen y costos corresponden únicamente a pedidos cobrados.',
      'El margen estimado ya deduce los costos unitarios registrados.'
    ]
  },
  compare_sales_periods: {
    definition: {
      name: 'compare_sales_periods',
      description: 'Compara dos períodos de ventas cobradas. Usá normalmente el período anterior como primero y el posterior como segundo. Todas las facts change.* son segundo menos primero y ya vienen con signo y formato calculados por PostgreSQL.',
      parameters: {
        type: 'object',
        properties: {
          firstFrom: { type: 'string', format: 'date', description: 'Inicio del período base o anterior.' },
          firstTo: { type: 'string', format: 'date', description: 'Fin del período base o anterior.' },
          secondFrom: { type: 'string', format: 'date', description: 'Inicio del período comparado o posterior.' },
          secondTo: { type: 'string', format: 'date', description: 'Fin del período comparado o posterior.' }
        },
        required: ['firstFrom', 'firstTo', 'secondFrom', 'secondTo'],
        additionalProperties: false
      }
    },
    schema: compareSalesSchema,
    rpcName: 'ai_compare_sales_periods',
    toRpcArgs: (args) => ({
      p_first_from: args.firstFrom,
      p_first_to: args.firstTo,
      p_second_from: args.secondFrom,
      p_second_to: args.secondTo
    }),
    interpretationRules: [
      'Las facts change.* representan el segundo período menos el primero.',
      'Los importes y porcentajes de variación ya vienen calculados con signo exacto.'
    ]
  },
  get_product_catalog: {
    definition: {
      name: 'get_product_catalog',
      description: 'Devuelve el catálogo completo de productos activos con nombre, presentación, precio exacto de venta y posición de precio calculada por PostgreSQL. Usá esta herramienta cuando pregunten qué productos existen, pidan una lista, consulten precios o quieran saber cuál es el más caro.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    schema: productCatalogSchema,
    rpcName: 'ai_get_product_catalog',
    toRpcArgs: () => ({}),
    interpretationRules: [
      'catalog.price_rank: la posición 1 corresponde al producto de mayor precio.',
      'catalog.price_cents es el precio de lista exacto en centavos de ARS.'
    ]
  },
  get_inventory_status: {
    definition: {
      name: 'get_inventory_status',
      description: 'Devuelve stock disponible, físico, reservado, en camino y compra sugerida. Si la persona pregunta por un producto específico (ej: creatina, omega, glutamina), pasá ese término en query para obtener su stock exacto. Para preguntas generales sobre qué comprar, qué falta o alertas, dejá query vacío.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 80, description: 'Opcional. Nombre, presentación o SKU del producto para consultar su stock específico (ej: "creatina", "omega 3", "glutamina"). Devuelve todas las presentaciones coincidentes.' },
          onlyAttention: { type: 'boolean', description: 'false incluye stock normal y con alertas; true devuelve solo productos que requieren atención.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        },
        additionalProperties: false
      }
    },
    schema: inventorySchema,
    rpcName: 'ai_get_inventory_status',
    toRpcArgs: (args) => ({
      p_only_attention: args.onlyAttention ?? (args.query ? false : true),
      p_limit: args.limit ?? 50,
      p_query: args.query ?? null
    }),
    interpretationRules: [
      'disponible = on_hand - reserved.',
      'compra sugerida considera stock de seguridad y punto de pedido.'
    ]
  },
  get_product_performance: {
    definition: {
      name: 'get_product_performance',
      description: 'Devuelve el rendimiento cobrado de un producto específico para un período. query es obligatorio y debe contener el SKU, nombre o presentación mencionados por la persona. Para rankings generales usá get_top_selling_products.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          query: { type: 'string', minLength: 1, maxLength: 80, description: 'SKU, nombre o presentación del producto mencionado.' },
          limit: { type: 'integer', minimum: 1, maximum: 10 }
        },
        required: ['from', 'to', 'query'],
        additionalProperties: false
      }
    },
    schema: productPerformanceSchema,
    rpcName: 'ai_get_product_performance',
    toRpcArgs: (args) => ({
      p_from: args.from,
      p_to: args.to,
      p_query: args.query ?? null,
      p_limit: args.limit
    }),
    interpretationRules: [
      'Devuelve rendimiento únicamente para pedidos cobrados en el período.',
      'Si un producto no tuvo ventas en ese lapso, units y revenue serán 0.'
    ]
  },
  get_top_selling_products: {
    definition: {
      name: 'get_top_selling_products',
      description: 'Devuelve el ranking de productos con ventas cobradas para un período. Usá esta herramienta para saber cuál se vendió más, cuáles fueron los más vendidos o comparar desempeño general. Si no indican período, usá desde el inicio del año actual hasta la fecha actual.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          limit: { type: 'integer', minimum: 1, maximum: 10 }
        },
        required: ['from', 'to'],
        additionalProperties: false
      }
    },
    schema: topSellingProductsSchema,
    rpcName: 'ai_get_top_selling_products',
    toRpcArgs: (args) => ({
      p_from: args.from,
      p_to: args.to,
      p_limit: args.limit
    }),
    interpretationRules: [
      'El ranking ordena de mayor a menor según unidades cobradas.',
      'Si ningún producto tuvo ventas en el rango, la lista estará vacía.'
    ]
  }
};

export const TOOL_DEFINITIONS = Object.values(TOOL_REGISTRY).map(({ definition }) => definition);

export type ValidatedToolCall = {
  call: CanonicalToolCall;
  spec: ToolSpec;
  args: Record<string, unknown>;
};

export const validateToolCall = (call: CanonicalToolCall): ValidatedToolCall => {
  const spec = TOOL_REGISTRY[call.name];
  if (!spec) throw new InvalidToolCallFailure();

  let rawArguments: unknown;
  try {
    rawArguments = JSON.parse(call.argumentsJson);
  } catch (error) {
    throw new InvalidToolCallFailure(error);
  }

  const parsed = spec.schema.safeParse(rawArguments);
  if (!parsed.success) throw new InvalidToolCallFailure(parsed.error);
  return { call, spec, args: parsed.data };
};
