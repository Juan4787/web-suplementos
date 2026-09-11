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
  QuoteCartEtaResult,
  ReceivePurchaseResult,
  StockMovement,
  StorefrontProduct,
  StoreSettings
} from '@/domain/types';
import { getSupabaseClient } from '@/lib/supabase';
import type { AIAnswer, BusinessApi, Page, OrdersPage, PurchasesPage } from './business-api';
import { requestBusinessAI } from './business-ai-client';

type RpcArgs = Record<string, unknown>;

const configurationError = (): AppError =>
  new AppError('configuration', 'La aplicación todavía no está conectada a la tienda.', {
    nextAction: 'Por favor contactá al administrador de la tienda.'
  });

export const translateDatabaseError = (error: { message?: string; code?: string }): AppError => {
  const diagnostic = `${error.code ?? ''} ${error.message ?? ''}`;
  const businessMessages: Record<string, [string, string]> = {
    OPENING_RESERVATION_NOT_RECEIVED: ['No hay suficientes unidades recibidas de esta reserva.', 'Registrá primero la recepción de la compra o revisá si otra persona ya anotó la entrega.'],
    OPENING_RESERVATION_CHANGED: ['Esta reserva cambió o ya fue resuelta.', 'Actualizá Inventario y revisá las unidades pendientes antes de continuar.'],
    INVALID_OPENING_RESERVATION_ACTION: ['La cantidad de la reserva no es válida.', 'Ingresá unidades enteras, entre una y la cantidad pendiente.'],
    STALE_STOCK_COUNT: ['El stock cambió mientras hacías el conteo.', 'Cerrá esta corrección y volvé a abrirla para revisar el stock actualizado antes de guardar.'],
    CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK: ['Todavía falta mercadería para entregar este pedido.', 'Registrá la recepción de la compra pendiente en Inventario antes de continuar.'],
    IDEMPOTENCY_KEY_REUSE_MISMATCH: ['Los datos cambiaron respecto del intento anterior.', 'Revisá si la operación ya aparece en Pedidos o Compras antes de iniciar otra.'],
    OVER_RECEIVING_NOT_ALLOWED: ['La cantidad recibida supera lo que falta de esta compra.', 'Actualizá la compra y anotá solamente las unidades que siguen pendientes.'],
    INVALID_RECEIVED_QUANTITY: ['La cantidad recibida no es válida.', 'Ingresá unidades enteras, entre cero y la cantidad pendiente.'],
    RECEIVED_EXCEEDS_ORDERED_QUANTITY: ['La cantidad recibida supera la cantidad pedida.', 'Revisá las unidades pendientes de cada producto.'],
    CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS: ['Esta compra tiene unidades comprometidas en pedidos de clientes.', 'Revisá esos pedidos antes de cancelar la compra.'],
    CANNOT_CHANGE_PRODUCT_WITH_ACTIVE_RESERVATIONS: ['Este producto tiene unidades reservadas en pedidos.', 'Completá o cancelá esos pedidos antes de cambiar el producto de la compra.'],
    QUANTITY_BELOW_RESERVED_AND_FULFILLED_CAPACITY: ['La cantidad no puede ser menor que las unidades ya recibidas o reservadas.', 'Revisá los pedidos vinculados y las recepciones de esta compra.'],
    INVALID_QUANTITY: ['La cantidad del producto no es válida.', 'Ingresá una cantidad entera mayor que cero.'],
    INVALID_ADJUSTMENT: ['La corrección de stock está incompleta.', 'Ingresá la cantidad real y un motivo que explique la diferencia.'],
    ORDER_NOT_FOUND: ['No encontramos ese pedido.', 'Actualizá la lista de Pedidos y volvé a buscarlo.'],
    PURCHASE_ITEM_NOT_FOUND: ['Uno de los productos ya no pertenece a esta compra.', 'Cerrá la recepción y abrí de nuevo la compra actualizada.'],
    INVALID_ORDER: ['El pedido tiene datos incompletos.', 'Revisá nombre del cliente, productos, cantidades y datos de entrega.'],
    INVALID_PRODUCT: ['El producto tiene datos incompletos o inválidos.', 'Revisá nombre, presentación, precio y campos marcados en el formulario.'],
    INVALID_PRODUCT_IMAGE: ['La imagen del producto no es válida.', 'Elegí nuevamente una imagen y esperá a que termine de cargarse.']
  };
  const specific = businessMessages[error.message ?? ''];
  if (specific) return new AppError('business', specific[0], { nextAction: specific[1] });
  if (/JWT|session|auth/i.test(diagnostic)) {
    return new AppError('auth', 'Tu sesión venció.', {
      nextAction: 'Volvé a ingresar para continuar.'
    });
  }
  if (/FORBIDDEN|PERMISSION|42501/i.test(diagnostic)) {
    return new AppError('permission', 'No tenés permiso para hacer esta acción.', {
      nextAction: 'Solicitá que revisen los permisos de tu cuenta.'
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
    return new AppError('business', 'Ya existe un producto con ese código o enlace.', {
      nextAction: 'Usá valores distintos o editá el producto existente.'
    });
  }
  if (/PRODUCT_HAS_ORDERS/i.test(diagnostic)) {
    return new AppError(
      'business',
      'No se puede eliminar un producto que tiene pedidos asociados.',
      {
        nextAction: 'Podés archivarlo o desactivarlo desde la edición para que no aparezca en la tienda.'
      }
    );
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
    return new AppError('validation', 'El dato de inflación está incompleto o no es válido.', {
      nextAction: 'Revisá período, nivel del índice, fecha y enlace oficial.'
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
  if (/23514|check constraint/i.test(diagnostic)) {
    return new AppError('business', 'Los datos o importes del pedido no son consistentes.', {
      cause: error,
      nextAction: 'Revisá los importes, método de entrega y productos antes de confirmarlo.'
    });
  }
  if (/Failed to fetch|NetworkError|Network request failed|net::ERR/i.test(diagnostic)) {
    return new AppError('temporary', 'No pudimos comunicarnos con la tienda.', {
      cause: error,
      retryable: true,
      nextAction: 'Revisá tu conexión y volvé a intentarlo.'
    });
  }
  return new AppError('temporary', 'Ocurrió un error al procesar la operación en la tienda.', {
    cause: error,
    retryable: true,
    nextAction: 'Revisá los datos o volvé a intentarlo en unos instantes.'
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
): Promise<AIAnswer> => {
  if (appEnv.mode !== 'supabase') throw configurationError();
  if (!appEnv.aiEnabled) {
    throw new AppError('configuration', 'El asistente todavía no está habilitado.', {
      nextAction: 'Falta confirmar que el proveedor principal no conserve las consultas.'
    });
  }
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new AppError('auth', 'Tu sesión venció.', {
      cause: error,
      nextAction: 'Volvé a ingresar para continuar.'
    });
  }
  return requestBusinessAI({ message, history, accessToken: data.session.access_token });
};

export const supabaseBusinessApi: BusinessApi = {
  getSettings: () => rpc<StoreSettings>('get_public_store_settings'),
  listCustomerOrders: (customerId, page = 1, pageSize = 20) =>
    rpc<Page<Order>>('list_customer_orders', { p_customer_id: customerId, p_page: page, p_page_size: pageSize }),
  updateSettings: (settings) => rpc<StoreSettings>('update_store_settings', { p_settings: settings }),
  listStorefrontProducts: () => rpc<StorefrontProduct[]>('get_storefront_products'),
  getStorefrontProduct: (slug) =>
    rpc<StorefrontProduct | null>('get_storefront_product', { p_slug: slug }),
  validateAvailability: (lines) =>
    rpc<AvailabilityCheck>('check_cart_availability', { p_lines: lines }),
  quoteCartEta: (lines) =>
    rpc<QuoteCartEtaResult>('quote_cart_eta', { p_lines: lines }),
  getDashboard: async () => {
    const data = await rpc<DashboardSummary & { priorities?: DashboardSummary['priorityInventory'] }>('get_dashboard_summary');
    return {
      ...data,
      priorityInventory: data.priorityInventory ?? data.priorities ?? [],
      recentOrders: data.recentOrders ?? []
    };
  },
  listAdminProducts: () => rpc<AdminProduct[]>('list_admin_products'),
  saveProduct: (input) => rpc<AdminProduct>('save_product', { p_product: input }),
  deleteProduct: async (productId) => {
    await rpc('delete_product', { p_product_id: productId });
  },
  archiveProduct: async (productId, archived) => {
    await rpc('archive_product', { p_product_id: productId, p_archived: archived });
    const updated = await rpc<AdminProduct[]>('list_admin_products');
    const match = updated.find((p) => p.id === productId);
    if (!match) throw new AppError('business', 'No se pudo verificar la actualización del producto.');
    return match;
  },
  listInventory: () => rpc('list_inventory_status'),
  adjustStock: async (productId, delta, reason, expectedOnHand) => {
    await rpc(expectedOnHand === undefined ? 'adjust_product_stock' : 'adjust_product_stock_checked', {
      p_product_id: productId,
      p_delta: delta,
      p_reason: reason,
      ...(expectedOnHand === undefined ? {} : { p_expected_on_hand: expectedOnHand })
    });
  },
  updateStockThresholds: async ({ productId, reorderPoint, safetyStock, leadTimeDays }) => {
    await rpc('update_stock_thresholds', {
      p_product_id: productId, p_reorder_point: reorderPoint,
      p_safety_stock: safetyStock, p_lead_time_days: leadTimeDays ?? null
    });
  },
  listOrders: (page = 1, pageSize = 20, search = '', state = 'all') =>
    rpc<OrdersPage>('search_orders', { p_page: page, p_page_size: pageSize, p_search: search, p_state: state }),
  listPaidOrders: (page = 1, pageSize = 20, from, to) =>
    rpc<Page<Order>>('search_paid_orders', { p_page: page, p_page_size: pageSize, p_from: from || null, p_to: to || null }),
  confirmImportedOrder: (input) =>
    rpc<Order>('confirm_imported_order', { p_order: input }),
  transitionOrder: (orderId, action) =>
    rpc<Order>('transition_order', { p_order_id: orderId, p_action: action }),
  listPurchases: (page = 1, pageSize = 20, state = 'all') =>
    rpc<PurchasesPage>('list_purchases', {
      p_page: page,
      p_page_size: pageSize,
      p_state: state === 'all' ? null : state
    }),
  createPurchase: (input) => rpc<Purchase>('create_purchase', { p_purchase: input }),
  updatePurchase: (input) => rpc<Purchase>('update_purchase', { p_purchase: input }),
  listOpeningReservations: () => rpc('list_opening_reservations'),
  resolveOpeningReservation: (purchaseItemId, quantity, action, operationId) => rpc('resolve_opening_reservation', {
    p_purchase_item_id: purchaseItemId, p_quantity: quantity, p_action: action, p_operation_id: operationId
  }),
  receivePurchase: async (purchaseId, items, operationId) => {
    let itemsPayload = items;
    if (!itemsPayload || itemsPayload.length === 0) {
      const purchasePage = await rpc<PurchasesPage>('list_purchases', { p_page: 1, p_page_size: 100 });
      const current = purchasePage.items.find((p) => p.id === purchaseId);
      if (current) {
        itemsPayload = current.items.map((pi) => ({
          purchaseItemId: pi.id,
          receivedQuantity: Math.max(0, pi.quantity - (pi.receivedQuantity ?? 0) - (pi.shortageQuantity ?? 0))
        }));
      } else {
        itemsPayload = [];
      }
    }
    return rpc<ReceivePurchaseResult>('receive_purchase', {
      p_purchase_id: purchaseId,
      p_items: itemsPayload,
      p_operation_id: operationId ?? crypto.randomUUID()
    });
  },
  closePurchaseWithShortage: (purchaseId, notes) =>
    rpc<ReceivePurchaseResult>('close_purchase_with_shortage', {
      p_purchase_id: purchaseId,
      p_notes: notes ?? 'Cerrado con faltante definitivo de distribuidor'
    }),
  listMovements: (page = 1, pageSize = 30, search = '', filter = 'all') =>
    rpc<Page<StockMovement>>('list_stock_movements', {
      p_page: page,
      p_page_size: pageSize,
      p_search: search || null,
      p_filter: filter === 'all' ? null : filter
    }),
  listCustomers: (page = 1, pageSize = 30, search?: string) =>
    rpc('list_customers', { p_page: page, p_page_size: pageSize, p_search: search || null }),
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
