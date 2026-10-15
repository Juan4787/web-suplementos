# Auditoría Forense: Reconciliación Automática de Stock Libre y Desbloqueo de Bolsitas

**Fecha:** 15 de Octubre de 2026  
**Entorno:** Producción (Supabase `jualrtbwyadijovhhjfs`)  
**Migración:** `supabase/migrations/20261015180000_automatic_stock_reconciliation.sql`  
**Scripts de verificación:** `scripts/audit-critique-verification.mjs`, `scripts/audit-reconciliation-verification.mjs`

---

## 1. Contexto y Diagnóstico del Problema

### El Incidente
La operadora del local reportó que al intentar armar las bolsitas para pedidos pendientes con **Magnesio Dual Action** (ej. Pedido #2620 de Eva Bonin), el sistema no le permitía guardar las unidades en la bolsita (error `PACKING_EXCEEDS_PHYSICAL_RESERVATION` en el backend, o input de bolsita oculto/deshabilitado en el frontend), a pesar de que el stock disponible en pantalla figuraba en 10 unidades libres.

### Diagnóstico de Causa Raíz
1. **Línea de tiempo desfasada:**  
   - El 14 de octubre, cuando ingresaron los pedidos #2605, #2611, #2613, #2616, #2617 y #2620, el stock físico libre en local era 0 (las unidades físicas estaban reservadas para pedidos anteriores #2595, #2601 y #2604).
   - El sistema vinculó las reservas de estos pedidos a la orden de compra entrante más próxima: la Compra #2054 (esperada para el 20 de octubre).
2. **Recepción no cruzada:**  
   - El 15 de octubre a las 12:52 hs ingresó la Compra #2053 con 10 unidades físicas de Magnesio.
   - Como los pedidos estaban atados en `purchase_item_id` a la Compra #2054 y no a la #2053, la función `receive_purchase` ingresó las 10 unidades a `on_hand`, pero no promovió las reservas de la Compra #2054.
   - Esto dejó a los pedidos con `source_type = 'incoming'`, lo que bloqueaba la posibilidad de empaquetar en bolsitas (`physicalReservedQuantity = 0`).
3. **Cancelaciones previas:**  
   - Además, la cancelación del pedido #2528 liberó 1 unidad física que fue absorbida por el pedido #2624 (Lorena Carrel) que entró el 15 a las 09:37 hs, antes de que los pedidos más viejos pudieran reclamarla por falta de un reconciliador automático en cancelaciones.

---

## 2. Evaluación Rigurosa de la Propuesta de Argon

Se confrontó exhaustivamente la crítica técnica de Argon contra el código PL/pgSQL y el modelo relacional:

1. **Error 1 (Omisión en `stock_movements`):**  
   - *Confirmado.* La versión preliminar promovía las reservas sin asentar el movimiento contable en `stock_movements` (`kind = 'reservation'`, `reserved_delta = +v_take`). Esto hubiera provocado un desfasaje silencioso en el libro mayor frente a `stock_balances.reserved`.
2. **Error 2 (Fragmentación de reservas en pedidos mixtos):**  
   - *Confirmado.* En pedidos con asignación mixta previa (como Oscar Frutos #2605, que tenía 1 unidad física y 1 entrante), una inserción directa sin búsqueda previa hubiera dejado dos filas físicas activas para el mismo `order_item_id`. Se implementó la búsqueda y fusión atómica en la fila física preexistente.
3. **Error 3 (Integridad de `cost_snapshot_cents`):**  
   - *Confirmado.* Se garantizó el fallback a `product_financials.current_cost_cents` en caso de que `cost_snapshot_cents` fuera nulo o cero, previniendo violaciones de constraints o distorsión de márgenes comerciales.
4. **Error 4 (Ordenamiento con fechas nulas en compras):**  
   - *Confirmado.* Se corrigió la cláusula de ordenamiento en `confirm_imported_order` utilizando `coalesce(pu.expected_at, pu.ordered_at + interval '7 days') asc, pu.ordered_at asc` para asegurar que compras sin fecha estimada explícita no salten arbitrariamente por delante ni queden relegadas al final frente a órdenes posteriores.

---

## 3. Arquitectura de la Solución Desplegada

Se creó y aplicó la migración `20261015180000_automatic_stock_reconciliation.sql`, la cual incorpora:

1. **Motor Centralizado `private.reconcile_product_stock(p_product_id)`:**
   - Adquiere bloqueo canónico Nivel 1 (`for update of p, sb`) ordenado por ID para prevenir condiciones de carrera y deadlocks.
   - Determina el stock disponible real: `v_avail := greatest(0, v_on_hand - v_reserved)`.
   - Itera por antigüedad estricta (FIFO) sobre reservas `incoming` o `uncovered` activas de pedidos no cancelados.
   - Si el pedido ya tiene una reserva física para ese ítem, fusiona sumando la cantidad (`quantity = quantity + v_take`), eliminando la fila entrante si se absorbe por completo.
   - Asienta el movimiento en `public.stock_movements` con `kind = 'reservation'` y `reserved_delta = +v_take`.
   - Incrementa `stock_balances.reserved` de forma balanceada.
2. **Puntos de Contacto Automáticos:**
   - `receive_purchase`: Tras recibir mercadería, cualquier excedente físico libre dispara `reconcile_product_stock`.
   - `adjust_product_stock`: Todo ajuste manual de inventario positivo (`p_delta > 0`) reconcilia pedidos en espera.
   - `transition_order`: Al cancelar un pedido (`p_action = 'cancel'`), las unidades físicas liberadas se ofrecen inmediatamente a los pedidos siguientes en cola por FIFO.
   - `confirm_imported_order`: Corrige el algoritmo de imputación de compras con ponderación temporal equitativa.
3. **Bloque de Reconciliación Inmediata:**
   - La migración ejecutó un bloque anónimo que barrió todos los productos con reservas en espera y stock libre en producción.

---

## 4. Resultados de la Auditoría Forense Post-Migración

### A. Estado de los Pedidos de Magnesio
| Pedido | Cliente | Cantidad | Empacado | Reserva Física | Reserva Entrante | Estado Bolsita |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **#2605** | oscar y mirian frutos | 2 | 1 | **2** | 0 | **Desbloqueado** (Fila física unificada) |
| **#2611** | Lucio Lopez | 1 | 0 | **1** | 0 | **Desbloqueado** |
| **#2613** | Florencia Gómez Cochia | 1 | 0 | **1** | 0 | **Desbloqueado** |
| **#2616** | Alfonsina Diaz | 1 | 0 | **1** | 0 | **Desbloqueado** |
| **#2617** | Melina Renk | 1 | 0 | **1** | 0 | **Desbloqueado** |
| **#2620** | Eva Bonin | 1 | 0 | **1** | 0 | **Desbloqueado** |
| **#2624** | Lorena Carrel | 1 | 0 | **1** | 0 | **Desbloqueado** |

### B. Balance de Inventario de Magnesio Dual Action
- **Físico en local (`on_hand`):** 12 unidades (2 remanentes de lote anterior + 10 ingresadas por Compra #2053).
- **Reservado físico (`reserved`):** 8 unidades (repartidas exactamente entre los 7 pedidos pendientes).
- **Disponible físico (`available`):** 4 unidades libres en góndola.
- **Cuadratura matemática:** $12 - 8 = 4$. Exactitud del 100%.

### C. Auditoría Global del Catálogo Completo (200+ Productos)
- **Productos con stock libre y reservas en espera pendientes:** **0** (ninguno).
- **Reservas activas en pedidos cancelados:** **0**.
- **Reservas activas en pedidos despachados/entregados:** **0**.
- **Reservas huérfanas sin orden:** **0**.
- **Reservas entrantes con `purchase_item_id` nulo:** **0**.
- **Desajustes entre `stock_balances.reserved` y sumatoria de reservas físicas activas:** **0**.

### D. Suite de Pruebas y Certificación de Software
- `pnpm test`: 71 suites de test, **621 pruebas unitarias aprobadas**.
- `pnpm test:contract`: **14 de 14 contratos RPC verificados** con 100% de paridad cliente/servidor.
- `pnpm check` (`tsc -b`): **0 errores** de tipos TypeScript.
- `pnpm build`: Bundle de producción compilado exitosamente.

---

## 5. Ejecución de la Suite de Control de 3 Consultas

Se ejecutó la suite formal [audit-argon-control-suite.mjs](file:///home/usuario/CascadeProjects/APP%20DE%20SUPLEMENTOS/scripts/audit-argon-control-suite.mjs) contra la base de datos de producción con la migración de saneamiento `20261015190000_clean_physical_purchase_links.sql`:

1. **Consulta 1 (Invariantes Globales del Catálogo):**
   - 27 productos con stock o movimiento evaluados.
   - **0 productos con error**. 100% veredicto `'OK PERFECTO'`.
   - Magnesio: `en_mano = 12, reservado = 8, disponible = 4, esperando_en_camino = 0, veredicto = 'OK PERFECTO'`.
   - B Complex: `en_mano = 12, reservado = 9, disponible = 3, esperando_en_camino = 0, veredicto = 'OK PERFECTO'`.
2. **Consulta 2 (Radiografía de Pedidos #2605 al #2624):**
   - Todos los ítems en estado `confirmed` con `tipo_reserva = 'physical'` y `id_compra_vinculada = null`.
   - Pedido #2605: 1 sola fila física de Magnesio de 2 unidades (`filas_por_item = 1`).
   - Costos positivos registrados en todas las reservas.
3. **Consulta 3.A y 3.B (Libro Mayor y Cupo de Compra #2054):**
   - 12 asientos de reconciliación en `stock_movements` con `reserved_delta` positivo y `created_by` intacto.
   - Compra #2054: `cant_comprada = 15, reservado_en_camino = 0, cupo_entrante_libre = 15`. Exactitud contable absoluta.

