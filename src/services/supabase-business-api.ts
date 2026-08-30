import { appEnv } from '@/app/env';
import { AppError } from '@/domain/errors';
import type {
  AdminProduct,
  AnalyticsSummary,
  AvailabilityCheck,
  DashboardSummary,
  ExportDataset,
  Order,
  Purchase,
  StorefrontProduct,
  StoreSettings
} from '@/domain/types';
import { getSupabaseClient } from '@/lib/supabase';
import type { BusinessApi, Page } from './business-api';

type RpcArgs = Record<string, unknown>;

const configurationError = (): AppError =>
  new AppError('configuration', 'La aplicación todavía no está conectada a la tienda.', {
    nextAction: 'Configurá el proyecto de Supabase antes de publicar este entorno.'
  });

const translateDatabaseError = (error: { message?: string; code?: string }): AppError => {
  const diagnostic = `${error.code ?? ''} ${error.message ?? ''}`;
  if (/JWT|session|auth/i.test(diagnostic)) {
    return new AppError('auth', 'Tu sesión venció.', {
      nextAction: 'Volvé a ingresar para continuar.'
    });
  }
  if (/FORBIDDEN|PERMISSION|42501/i.test(diagnostic)) {
    return new AppError('permission', 'No tenés permiso para hacer esta acción.', {
      nextAction: 'Pedile a la dueña que revise tu acceso.'
    });
  }
  if (/INSUFFICIENT_STOCK/i.test(diagnostic)) {
    return new AppError('business', 'El stock cambió y ya no alcanza para ese pedido.', {
      nextAction: 'Revisá las cantidades disponibles antes de confirmarlo.'
    });
  }
  if (/ORDER_PRICE_CHANGED/i.test(diagnostic)) {
    return new AppError('business', 'Cambió un precio o el costo de envío desde que se armó el mensaje.', {
      nextAction: 'Volvé a generar el pedido o revisá los importes antes de confirmarlo.'
    });
  }
  if (/INVALID_TRANSITION/i.test(diagnostic)) {
    return new AppError('business', 'Ese paso ya no está disponible.', {
      nextAction: 'Actualizá la vista para ver el estado actual.'
    });
  }
  if (/ORDER_ALREADY_IMPORTED/i.test(diagnostic)) {
    return new AppError('business', 'Este pedido ya fue importado.', {
      nextAction: 'Buscalo en Pedidos antes de volver a cargarlo.'
    });
  }
  if (/PRODUCT_DUPLICATE/i.test(diagnostic)) {
    return new AppError('business', 'Ya existe un producto con ese SKU o enlace.', {
      nextAction: 'Usá valores distintos o editá el producto existente.'
    });
  }
  if (/PRODUCT_NOT_FOUND/i.test(diagnostic)) {
    return new AppError('business', 'Uno de los productos ya no está disponible.', {
      nextAction: 'Actualizá la pantalla y revisá la selección.'
    });
  }
  if (/INVALID_PURCHASE_TRANSITION/i.test(diagnostic)) {
    return new AppError('business', 'Esta compra ya no está esperando recepción.', {
      nextAction: 'Actualizá la lista para ver su estado actual.'
    });
  }
  if (/INVALID_PURCHASE|PURCHASE_NOT_FOUND/i.test(diagnostic)) {
    return new AppError('validation', 'No pudimos guardar esa compra.', {
      nextAction: 'Revisá proveedor, productos, cantidades y costos.'
    });
  }
  if (/CANNOT_CHANGE_OWN_ACCESS/i.test(diagnostic)) {
    return new AppError('business', 'No podés cambiar tu propio acceso.', {
      nextAction: 'Pedile a otra dueña activa que realice ese cambio.'
    });
  }
  if (/LAST_OWNER_REQUIRED/i.test(diagnostic)) {
    return new AppError('business', 'La tienda debe conservar al menos una dueña habilitada.', {
      nextAction: 'Habilitá primero a otra dueña.'
    });
  }
  if (/USER_NOT_FOUND|INVALID_USER_ACCESS/i.test(diagnostic)) {
    return new AppError('business', 'No encontramos ese acceso o cambió recientemente.', {
      nextAction: 'Actualizá la lista de usuarios.'
    });
  }
  if (/INVALID_INFLATION_INDEX/i.test(diagnostic)) {
    return new AppError('validation', 'El dato de IPC está incompleto o no es válido.', {
      nextAction: 'Revisá período, nivel del índice, fecha y enlace oficial HTTPS.'
    });
  }
  if (/INVALID_PERIOD/i.test(diagnostic)) {
    return new AppError('validation', 'El período elegido no es válido.', {
      nextAction: 'Elegí una fecha inicial anterior o igual a la final.'
    });
  }
  if (/INVALID_SETTINGS/i.test(diagnostic)) {
    return new AppError('validation', 'Hay datos de configuración que necesitan una revisión.', {
      nextAction: 'Comprobá teléfono, importes, impuesto y campos obligatorios.'
    });
  }
  if (/EXPORT_CHANGED/i.test(diagnostic)) {
    return new AppError('temporary', 'Los datos cambiaron mientras preparábamos el respaldo.', {
      retryable: true,
      nextAction: 'Volvé a exportar para obtener un corte completo.'
    });
  }
  return new AppError('temporary', 'No pudimos comunicarnos con la tienda.', {
    cause: error,
    retryable: true,
    nextAction: 'Revisá tu conexión y volvé a intentarlo.'
  });
};

const rpc = async <T>(name: string, args?: RpcArgs): Promise<T> => {
  if (appEnv.mode !== 'supabase') throw configurationError();
  const client = getSupabaseClient();
  const result = args ? await client.rpc(name, args) : await client.rpc(name);
  if (result.error) throw translateDatabaseError(result.error);
  return result.data as T;
};

const invokeAi = async (
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<{ answer: string; model: string; usedTools: string[] }> => {
  if (appEnv.mode !== 'supabase') throw configurationError();
  if (!appEnv.aiEnabled) {
    throw new AppError('configuration', 'El asistente todavía no está habilitado.', {
      nextAction: 'Primero hay que elegir y auditar el proveedor y el modelo.'
    });
  }
  const { data, error } = await getSupabaseClient().functions.invoke('business-ai', {
    body: { message, history }
  });
  if (error) {
    let payload: unknown;
    try {
      const context = (error as { context?: { json?: () => Promise<unknown> } }).context;
      payload = context?.json ? await context.json() : undefined;
    } catch {
      payload = undefined;
    }
    const code =
      typeof payload === 'object' && payload !== null && 'code' in payload
        ? String((payload as { code: unknown }).code)
        : '';
    if (code === 'AI_QUOTA_REACHED' || code === 'AI_UNAVAILABLE') {
      throw new AppError(
        'temporary',
        code === 'AI_QUOTA_REACHED'
          ? 'El asistente alcanzó temporalmente el límite gratuito.'
          : 'El asistente no está disponible en este momento.',
        { retryable: true, nextAction: 'Volvé a intentarlo más tarde. El resto de la aplicación sigue disponible.' }
      );
    }
    if (code === 'FORBIDDEN') {
      throw new AppError('permission', 'El asistente está disponible únicamente para la dueña.');
    }
    throw new AppError('temporary', 'No pudimos obtener una respuesta del asistente.', {
      cause: error,
      retryable: true,
      nextAction: 'Volvé a intentarlo. Tus datos no fueron modificados.'
    });
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { answer?: unknown }).answer !== 'string'
  ) {
    throw new AppError('unexpected', 'El asistente devolvió una respuesta incompleta.', {
      nextAction: 'Volvé a intentarlo.'
    });
  }
  return {
    answer: (data as { answer: string }).answer,
    model: String((data as { model?: unknown }).model ?? 'Proveedor no informado'),
    usedTools: Array.isArray((data as { usedTools?: unknown }).usedTools)
      ? ((data as { usedTools: unknown[] }).usedTools.map(String))
      : []
  };
};

export const supabaseBusinessApi: BusinessApi = {
  getSettings: () => rpc<StoreSettings>('get_public_store_settings'),
  updateSettings: (settings) => rpc<StoreSettings>('update_store_settings', { p_settings: settings }),
  listStorefrontProducts: () => rpc<StorefrontProduct[]>('get_storefront_products'),
  getStorefrontProduct: (slug) =>
    rpc<StorefrontProduct | null>('get_storefront_product', { p_slug: slug }),
  validateAvailability: (lines) =>
    rpc<AvailabilityCheck>('check_cart_availability', { p_lines: lines }),
  getDashboard: () => rpc<DashboardSummary>('get_dashboard_summary'),
  listAdminProducts: () => rpc<AdminProduct[]>('list_admin_products'),
  saveProduct: (input) => rpc<AdminProduct>('save_product', { p_product: input }),
  listInventory: () => rpc('list_inventory_status'),
  adjustStock: async (productId, delta, reason) => {
    await rpc('adjust_product_stock', {
      p_product_id: productId,
      p_delta: delta,
      p_reason: reason
    });
  },
  listOrders: (page = 1, pageSize = 20) =>
    rpc<Page<Order>>('list_orders', { p_page: page, p_page_size: pageSize }),
  listPaidOrders: (page = 1, pageSize = 20) =>
    rpc<Page<Order>>('list_paid_orders', { p_page: page, p_page_size: pageSize }),
  confirmImportedOrder: (input) =>
    rpc<Order>('confirm_imported_order', { p_order: input }),
  transitionOrder: (orderId, action) =>
    rpc<Order>('transition_order', { p_order_id: orderId, p_action: action }),
  listPurchases: (page = 1, pageSize = 20) =>
    rpc<Page<Purchase>>('list_purchases', { p_page: page, p_page_size: pageSize }),
  createPurchase: (input) => rpc<Purchase>('create_purchase', { p_purchase: input }),
  receivePurchase: (purchaseId) =>
    rpc<Purchase>('receive_purchase', { p_purchase_id: purchaseId }),
  listMovements: (page = 1, pageSize = 30) =>
    rpc('list_stock_movements', { p_page: page, p_page_size: pageSize }),
  listCustomers: (page = 1, pageSize = 30) =>
    rpc('list_customers', { p_page: page, p_page_size: pageSize }),
  getAnalytics: (from, to) =>
    rpc<AnalyticsSummary>('get_sales_analytics', { p_from: from, p_to: to }),
  listInflationIndices: () => rpc('list_inflation_indices'),
  saveInflationIndex: (input) => rpc('save_inflation_index', { p_index: input }),
  getExportDataset: () => rpc<ExportDataset>('get_business_export_dataset'),
  listUsers: () => rpc('list_store_users'),
  updateUserAccess: (userId, role, active) =>
    rpc('update_store_user_access', { p_user_id: userId, p_role: role, p_active: active }),
  askBusinessAi: invokeAi
};
