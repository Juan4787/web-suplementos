# Registro de Estado Actual: Pedidos, Ventas y Stock en Producción
**Fecha de Captura:** 2026-09-11T02:15:21.865Z (10 de Septiembre de 2026)
**Entorno:** Producción (Supabase DB Pooler sa-east-1 + Cloudflare Worker)
**Modo de Extracción:** Transacción de Solo Lectura (`SET default_transaction_read_only = 'on'`)
**Archivo Fuente Raw:** `production_state_snapshot.json`

---

## 1. Resumen Ejecutivo de Ventas (Septiembre 2026)

| Métrica | Valor Registrado | Observación |
| :--- | :--- | :--- |
| **Pedidos Pagados** | 6 pedidos | Ventas concretadas y cobradas |
| **Pedidos de Regalo (Gift)** | 0 pedidos | Sin órdenes de regalo emitidas aún |
| **Facturación Bruta (Ingresos)** | **$ 675.500** | Total cobrado a clientes |
| **Costo de Mercadería Vendida (CMV)** | **$ 434.026** | Costo base de reposición de los productos vendidos |
| **Margen Bruto Comercial** | **$ 241.474** | Rentabilidad bruta (35.7%) |
| **Costo Total por Regalos** | $ 0 | No hubo costo de obsequios |
| **Impuestos Registrados** | $ 0 | $ 0 |

---

## 2. Detalle Exhaustivo de Pedidos (8 Órdenes)

| N° Pedido | Cliente | Teléfono | Estado Pago | Estado Envío | Total Venta | Costo Total | Ítems | Fecha Creación |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **#2406** | MARIA ROSA PANIZZA | 3492220877 | `paid` | `delivered` | **$ 216.000** | $ 132.200 | 5 un. | 2026-09-10 12:23:36 |
| **#2407** | gigliotti keila | - | `paid` | `delivered` | **$ 95.000** | $ 57.530 | 3 un. | 2026-09-10 12:44:53 |
| **#2408** | Borgonovo Elena | - | `paid` | `delivered` | **$ 45.000** | $ 30.100 | 1 un. | 2026-09-10 13:00:06 |
| **#2409** | Sandra galarza | - | `paid` | `delivered` | **$ 91.500** | $ 55.710 | 3 un. | 2026-09-10 13:05:12 |
| **#2410** | Pauli | - | `paid` | `pending` | **$ 71.000** | $ 57.816 | 1 un. | 2026-09-10 13:14:10 |
| **#2411** | Laura Calcagno | - | `paid` | `delivered` | **$ 157.000** | $ 100.670 | 4 un. | 2026-09-10 13:15:45 |
| **#2412** | Compra de prueba | - | `refunded` | `cancelled` | **$ 33.000** | $ 12.000 | 1 un. | 2026-09-10 14:26:22 |
| **#2413** | Compra de prueba | 3426987412 | `pending` | `cancelled` | **$ 58.000** | $ 24.000 | 2 un. | 2026-09-10 23:55:23 |

### Desglose Ítem por Ítem de Cada Pedido

#### Pedido #2406 — MARIA ROSA PANIZZA
- **ID de Orden:** `0641c262-72dd-4240-9482-9e91591a465e`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `delivered` (Método: shipping)
- **Financiero:** Subtotal: $ 209.000 | Envío: $ 7.000 | Total: $ 216.000 | Costo Mercadería: $ 132.200
- **Fechas:** Creado: `2026-09-10T12:23:36.204Z` | Pagado: `2026-09-10T23:30:28.790Z` | Entregado: `2026-09-10T23:30:30.448Z`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `B_COMPLEX_ACTIVE` | B COMPLEX ACTIVE | 30 CAPS | 1 | $ 25.000 | $ 12.000 | $ 25.000 | $ 12.000 |
| `VITALITY_SUPPORT` | VITALITY SUPPORT | 30 CAPS | 1 | $ 32.000 | $ 20.400 | $ 32.000 | $ 20.400 |
| `MAGNESIO_DUAL_ACTION` | MAGNESIO DUAL ACTION | 30 CAPS | 1 | $ 26.000 | $ 12.600 | $ 26.000 | $ 12.600 |
| `OMEGA_3` | OMEGA 3 | 120 CAPS | 1 | $ 102.000 | $ 75.000 | $ 102.000 | $ 75.000 |
| `SLEEP_SUPPORT` | SLEEP SUPPORT | 30 CAPS | 1 | $ 24.000 | $ 12.200 | $ 24.000 | $ 12.200 |

#### Pedido #2407 — gigliotti keila
- **ID de Orden:** `c68469dc-8b28-4b6b-9466-1093db678a82`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `delivered` (Método: pickup)
- **Financiero:** Subtotal: $ 95.000 | Envío: $ 0 | Total: $ 95.000 | Costo Mercadería: $ 57.530
- **Fechas:** Creado: `2026-09-10T12:44:53.909Z` | Pagado: `2026-09-10T23:30:16.251Z` | Entregado: `2026-09-10T23:30:17.743Z`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `SLEEP_SUPPORT` | SLEEP SUPPORT | 30 CAPS | 1 | $ 24.000 | $ 12.200 | $ 24.000 | $ 12.200 |
| `FEMME_BALANCE` | FEMME BALANCE | 30 CAPS | 1 | $ 41.000 | $ 24.500 | $ 41.000 | $ 24.500 |
| `GLUTAMINA` | GLUTAMINA | 300 GRS | 1 | $ 30.000 | $ 20.830 | $ 30.000 | $ 20.830 |

#### Pedido #2408 — Borgonovo Elena
- **ID de Orden:** `447f6eff-f8c7-4d80-afcd-880e075ded5e`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `delivered` (Método: pickup)
- **Financiero:** Subtotal: $ 45.000 | Envío: $ 0 | Total: $ 45.000 | Costo Mercadería: $ 30.100
- **Fechas:** Creado: `2026-09-10T13:00:06.208Z` | Pagado: `2026-09-10T23:29:53.939Z` | Entregado: `2026-09-10T23:29:55.509Z`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `GASTRO_SUPPORT` | GASTRO SUPPORT | 60 CAPS | 1 | $ 45.000 | $ 30.100 | $ 45.000 | $ 30.100 |

#### Pedido #2409 — Sandra galarza
- **ID de Orden:** `44f07acf-384b-48bc-bf35-93780827657d`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `delivered` (Método: pickup)
- **Financiero:** Subtotal: $ 91.500 | Envío: $ 0 | Total: $ 91.500 | Costo Mercadería: $ 55.710
- **Fechas:** Creado: `2026-09-10T13:05:12.707Z` | Pagado: `2026-09-10T23:29:41.513Z` | Entregado: `2026-09-10T23:29:44.063Z`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `VITALITY_SUPPORT` | VITALITY SUPPORT | 30 CAPS | 1 | $ 32.000 | $ 20.400 | $ 32.000 | $ 20.400 |
| `COLAGENO_HIDROLIZADO` | COLAGENO HIDROLIZADO | 300 GRS | 1 | $ 34.500 | $ 21.650 | $ 34.500 | $ 21.650 |
| `MSM` | MSM | 100 GRS | 1 | $ 25.000 | $ 13.660 | $ 25.000 | $ 13.660 |

#### Pedido #2410 — Pauli
- **ID de Orden:** `200cbcd3-6e10-4eea-8693-fd5379969b3a`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `pending` (Método: pickup)
- **Financiero:** Subtotal: $ 71.000 | Envío: $ 0 | Total: $ 71.000 | Costo Mercadería: $ 57.816
- **Fechas:** Creado: `2026-09-10T13:14:10.532Z` | Pagado: `2026-09-10T23:28:26.363Z` | Entregado: `-`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `PROBIOVANCE_I5` | PROBIOVANCE I5 | 60 CAPS | 1 | $ 71.000 | $ 57.816 | $ 71.000 | $ 57.816 |

#### Pedido #2411 — Laura Calcagno
- **ID de Orden:** `abf03fe0-7e77-47f6-876f-aae7301b1fba`
- **Estado de Pago:** `paid` (Método: transfer)
- **Estado de Entrega:** `delivered` (Método: pickup)
- **Financiero:** Subtotal: $ 157.000 | Envío: $ 0 | Total: $ 157.000 | Costo Mercadería: $ 100.670
- **Fechas:** Creado: `2026-09-10T13:15:45.415Z` | Pagado: `2026-09-10T14:19:09.142Z` | Entregado: `2026-09-10T23:28:33.048Z`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `INOSITOL_CARE` | INOSITOL CARE | 100 G | 1 | $ 25.000 | $ 13.210 | $ 25.000 | $ 13.210 |
| `OMEGA_PURE_NUTRITION_ULTRA` | OMEGA PURE NUTRITION ULTRA | 60 CAPS | 1 | $ 72.000 | $ 48.000 | $ 72.000 | $ 48.000 |
| `GLUTAMINA` | GLUTAMINA | 300 GRS | 1 | $ 30.000 | $ 20.830 | $ 30.000 | $ 20.830 |
| `CREATINA` | CREATINA | 300 GRS | 1 | $ 30.000 | $ 18.630 | $ 30.000 | $ 18.630 |

#### Pedido #2412 — Compra de prueba
- **ID de Orden:** `d3f8e210-ba59-406e-90c0-408f9d2fb2d9`
- **Estado de Pago:** `refunded` (Método: cash)
- **Estado de Entrega:** `cancelled` (Método: pickup)
- **Financiero:** Subtotal: $ 33.000 | Envío: $ 0 | Total: $ 33.000 | Costo Mercadería: $ 12.000
- **Fechas:** Creado: `2026-09-10T14:26:22.279Z` | Pagado: `2026-09-10T14:26:35.547Z` | Entregado: `-`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `ANDRO_SUPPORT` | ANDRO SUPPORT | 30 CAPS | 1 | $ 33.000 | $ 12.000 | $ 33.000 | $ 12.000 |

#### Pedido #2413 — Compra de prueba
- **ID de Orden:** `e4f4be9e-83be-45c8-8c31-207fba571a44`
- **Estado de Pago:** `pending` (Método: cash)
- **Estado de Entrega:** `cancelled` (Método: shipping)
- **Financiero:** Subtotal: $ 58.000 | Envío: $ 0 | Total: $ 58.000 | Costo Mercadería: $ 24.000
- **Fechas:** Creado: `2026-09-10T23:55:23.719Z` | Pagado: `-` | Entregado: `-`

| SKU | Producto | Presentación | Cantidad | Precio Unitario | Costo Unitario | Subtotal Venta | Costo Total |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `ANDRO_SUPPORT` | ANDRO SUPPORT | 30 CAPS | 1 | $ 33.000 | $ 12.000 | $ 33.000 | $ 12.000 |
| `B_COMPLEX_ACTIVE` | B COMPLEX ACTIVE | 30 CAPS | 1 | $ 25.000 | $ 12.000 | $ 25.000 | $ 12.000 |

---

## 3. Estado de Inventario y Stock (26 Productos del Catálogo)

| SKU | Nombre Producto | Físico (On-Hand) | Reservado | Disponible | En Tránsito | Costo Reposición | Precio Venta |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `ACID_SUPPORT` | ACID SUPPORT | **4** | 0 | **4** | 0 | $ 11.500 | $ 19.000 |
| `ANDRO_SUPPORT` | ANDRO SUPPORT | **2** | 0 | **2** | 0 | $ 12.000 | $ 33.000 |
| `B_COMPLEX_ACTIVE` | B COMPLEX ACTIVE | **21** | 0 | **21** | 0 | $ 12.000 | $ 25.000 |
| `CLIMATERIC_SUPPORT` | CLIMATERIC SUPPORT | **0** | 0 | **0** | 0 | $ 14.100 | $ 26.200 |
| `COLAGENO_HIDROLIZADO` | COLAGENO HIDROLIZADO | **1** | 0 | **1** | 0 | $ 21.650 | $ 34.500 |
| `CREATINA` | CREATINA | **2** | 0 | **2** | 0 | $ 18.630 | $ 30.000 |
| `D_40_SUPPORT` | D +40 SUPPORT | **0** | 0 | **0** | 0 | $ 8.800 | $ 20.000 |
| `FEMME_BALANCE` | FEMME BALANCE | **2** | 0 | **2** | 0 | $ 24.500 | $ 41.000 |
| `GASTRO_SUPPORT` | GASTRO SUPPORT | **5** | 0 | **5** | 0 | $ 30.100 | $ 45.000 |
| `GLICINA` | GLICINA | **0** | 0 | **0** | 0 | $ 15.000 | $ 30.000 |
| `GLUTAMINA` | GLUTAMINA | **0** | 0 | **0** | 0 | $ 20.830 | $ 30.000 |
| `HEPATO_SUPPORT` | HEPATO SUPPORT | **3** | 0 | **3** | 0 | $ 17.400 | $ 31.000 |
| `HIERROQU` | Hierro quelado | **0** | 0 | **0** | 0 | $ 10.200 | $ 21.000 |
| `INOSITOL_CARE` | INOSITOL CARE | **2** | 0 | **2** | 0 | $ 13.210 | $ 25.000 |
| `MAGNESIO_DUAL_ACTION` | MAGNESIO DUAL ACTION | **12** | 0 | **12** | 0 | $ 12.600 | $ 26.000 |
| `METABOGLYC` | METABOGLYC | **2** | 0 | **2** | 0 | $ 25.800 | $ 40.000 |
| `MSM` | MSM | **3** | 0 | **3** | 0 | $ 13.660 | $ 25.000 |
| `OMEGA_3` | OMEGA 3 | **4** | 0 | **4** | 0 | $ 75.000 | $ 102.000 |
| `OMEGA_PURE_NUTRITION_ULTRA` | OMEGA PURE NUTRITION ULTRA | **3** | 0 | **3** | 0 | $ 48.000 | $ 72.000 |
| `ORMUX_AR` | ORMUX AR | **0** | 0 | **0** | 0 | $ 42.330 | $ 60.000 |
| `PROBIOVANCE_I5` | PROBIOVANCE I5 | **2** | 1 | **1** | 0 | $ 57.816 | $ 71.000 |
| `SLEEP_SUPPORT` | SLEEP SUPPORT | **6** | 4 | **2** | 0 | $ 12.200 | $ 24.000 |
| `THYROID_SUPPORT` | THYROID SUPPORT | **10** | 3 | **7** | 0 | $ 16.000 | $ 33.000 |
| `VITALITY_SUPPORT` | VITALITY SUPPORT | **6** | 1 | **5** | 0 | $ 20.400 | $ 32.000 |
| `VITAMINA_C` | VITAMINA C | **5** | 0 | **5** | 0 | $ 13.310 | $ 25.000 |
| `WHEYPROT` | whey proteion | **0** | 0 | **0** | 0 | $ 11.500 | $ 25.000 |

### Productos con Reservas Activas

| SKU | Producto | Físico | Reservado | Disponible |
| :--- | :--- | :---: | :---: | :---: |
| `PROBIOVANCE_I5` | PROBIOVANCE I5 | 2 | 1 | 1 |
| `SLEEP_SUPPORT` | SLEEP SUPPORT | 6 | 4 | 2 |
| `THYROID_SUPPORT` | THYROID SUPPORT | 10 | 3 | 7 |
| `VITALITY_SUPPORT` | VITALITY SUPPORT | 6 | 1 | 5 |

---

## 4. Órdenes de Compra a Proveedores

| N° Compra | Proveedor | Estado | Costo Total | Fecha Pedido | Fecha Recepción |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **#2034** | Proveedor no informado | `received` | $ 883.340 | 2026-09-09 | 2026-09-10 |
| **#2035** | Proveedor no informado | `ordered` | $ 1.254.080 | 2026-09-09 | Pendiente |
| **#2036** | sophos | `ordered` | $ 40.800 | 2026-09-10 | Pendiente |

---

## 5. Resumen de Movimientos de Stock Históricos

| Tipo de Movimiento (`kind`) | Cantidad de Eventos | Delta Físico Total | Delta Reservado Total |
| :--- | :---: | :---: | :---: |
| `sale` | 16 | -16 un. | -16 un. |
| `purchase_received` | 7 | +62 un. | 0 un. |
| `adjustment` | 16 | +49 un. | 0 un. |
| `reservation` | 23 | 0 un. | +28 un. |