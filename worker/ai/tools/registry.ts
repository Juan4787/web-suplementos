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
    onlyAttention: z.boolean().default(false),
    limit: z.number().int().min(1).max(20).default(12)
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

type ToolSpec = {
  definition: CanonicalTool;
  schema: z.ZodType<Record<string, unknown>>;
  rpcName: string;
  toRpcArgs: (args: Record<string, unknown>) => Record<string, unknown>;
};

export const TOOL_REGISTRY: Record<string, ToolSpec> = {
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
    toRpcArgs: (args) => ({ p_from: args.from, p_to: args.to })
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
    })
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
    toRpcArgs: () => ({})
  },
  get_inventory_status: {
    definition: {
      name: 'get_inventory_status',
      description: 'Devuelve inventario agregado y una lista acotada de productos, incluyendo disponible, reservado, en camino y compra sugerida. Usá esta herramienta para stock, reposición, faltantes, alertas o preguntas sobre qué comprar/priorizar; para listar el catálogo usá get_product_catalog.',
      parameters: {
        type: 'object',
        properties: {
          onlyAttention: { type: 'boolean', description: 'false incluye stock sin alertas; true devuelve solo productos que requieren atención.' },
          limit: { type: 'integer', minimum: 1, maximum: 20 }
        },
        additionalProperties: false
      }
    },
    schema: inventorySchema,
    rpcName: 'ai_get_inventory_status',
    toRpcArgs: (args) => ({ p_only_attention: args.onlyAttention, p_limit: args.limit })
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
    })
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
    })
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
