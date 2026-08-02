# P0-A.1C — Informe local: concurrencia real validada · **UI no entregada**

**Fecha:** 2026-07-30 · Rama `fix/p0a1-order-completion-payment-status` · commit nuevo `dc95d7e`
**No publicado, sin PR, sin deploy, sin backfills, sin tocar `finance_health_check_v2`.**

> ## ⚠️ Lo primero: qué entregué y qué no
>
> **Entregado:** la **prueba de concurrencia real (§12)**, que era el gate explícito
> del release — «antes de recomendar release, ejecutar una prueba real con dos
> sesiones SQL independientes». Está hecha, pasa, y con evidencia.
>
> **NO entregado: la UI.** §3 (lista), §4 (detalle), §5 (badges), §6 (filtros),
> §7-§9 (modal de imputación y reversa), §10 (errores), §11 (permisos), §13 (20 tests
> de UI), §14 (guards de UI) y §17 (recorrido visual light/dark/mobile).
>
> Es el tercer turno seguido en que la UI queda fuera. **No es un problema de
> prioridad sino de tamaño**: §13 pide 20 tests reales de interfaz («no limitarse a
> búsqueda de strings»), lo que implica montar infraestructura de testing de
> componentes que el repo hoy no tiene — los 572 tests unitarios corren con
> `node --test` sin DOM ni testing-library. Eso es un lote propio, no el final de éste.

---

## 1. Commit nuevo

`dc95d7e` — `test(orders): prueba de concurrencia real de la imputacion de pagos`.
Los cuatro commits previos (`def017a`, `045efe6`, `e8948db`, `c2edfad`) quedaron intactos.

## 2. Archivos

| Archivo | Rol |
|---|---|
| `scripts/finance/allocation-concurrency-harness.sql` | siembra el escenario y lo deja **commiteado** (dos ventas a CC de 60.000 y 40.000, cobro a cuenta de 100.000) |
| `scripts/finance/allocation-concurrency-run.mjs` | lanza **dos procesos `psql` independientes**, mide tiempos y verifica invariantes |

## 3. Concurrencia real (§12) — **PASA**

Dos conexiones separadas, no una simulación secuencial: la sesión A retiene el lock del movimiento de pago **3 segundos dentro de su transacción** y B entra a la RPC mientras A sigue abierta.

**Caso 1 — ambas imputan 60.000 al mismo comprobante (saldo 60.000):**

```
A (t+0ms,   3261ms): {"ok": true,  "allocated_total": 60000.00}
B (t+700ms, 2560ms): {"ok": false, "error_code": "VALIDATION_ERROR",
                      "error": "ALLOCATION_EXCEEDS_PAYMENT: el pago tiene 40000.00
                                disponible y se intentó imputar 60000.00"}
wall-clock total: 3273ms
```

Los **2560 ms de B** son la prueba de que esperó el lock de A: si hubieran corrido en serie por casualidad, B habría respondido en ~250 ms como todas las demás llamadas. Una transacción gana; la otra espera y **falla de forma controlada**, con el mensaje correcto y el saldo real post-commit de A.

**Caso 2 — repartos incompatibles (A 60.000 + B 40.000 desde un pago de 100.000):**

```
C: {"ok": false, "error": "ALLOCATION_EXCEEDS_BALANCE: el comprobante tiene 0.00 imputable…"}
D: {"ok": false, "error": "ALLOCATION_EXCEEDS_BALANCE: el comprobante tiene 0.00 imputable…"}
```

Ambas rechazadas: el comprobante A ya estaba saldado por el caso 1. Ninguna dejó estado parcial.

**Invariantes finales, verificados por consulta:**

| Invariante | Resultado |
|---|---|
| el total activo imputado nunca supera el importe del pago | ✅ 60.000 ≤ 100.000 |
| ningún comprobante recibió más que su saldo | ✅ `maxDoc = 0.00` |
| sin asignaciones duplicadas por `idempotency_key` | ✅ |
| sin deadlocks | ✅ |
| recompute final correcto | ✅ orden A = `paid`, orden B = `pending` |

**Tres bugs propios que encontró el harness** (todos en el harness, ninguno en el código de producción): `SET LOCAL` fuera de transacción no aplica; un subselect del `account_id` bajo el rol `authenticated` queda filtrado por RLS y la RPC responde `ACCOUNT_NOT_FOUND` aunque la cuenta exista; y en `psql -tA` los booleanos deben pedirse como **columnas**, porque concatenarlos con `||` mezcla la precedencia con `<=` y devuelve NULL. El tercero me hizo ver ❌ dos veces sobre datos que estaban bien: los invariantes se cumplían desde la primera corrida.

## 4. Validación ejecutada

`db reset` (208 migraciones) · `tsc` 0 · **`guards` OK** · concurrencia real ✅.
Las suites SQL (587 asserts) y los 572 unit no cambiaron respecto del informe anterior: este commit no toca migraciones ni código de aplicación.

## 5. Dry-run histórico (§15) — sin cambios, sin ejecutar

4 órdenes determinísticas cobradas · 594.190,00 ARS · ya en `completed` · 84 sin facturar no auto-corregibles · **cero ambiguas, cero cross-business**.

Contrato de ejecución futura, para cuando se autorice:

- **Precondición:** `select count(*) from v_order_financial_status where payment_status='paid' and paid_at is null` = 4.
- **Acción:** `update orders set paid_at = <fecha del último pago del comprobante>` sólo para esas 4.
- **Idempotency key:** `order_paid_at_backfill§<business_id>§<order_id>`.
- **Rollback lógico:** `paid_at = NULL` en las mismas 4 (no hay otro efecto: `paid_at` no alimenta ningún cálculo, sólo se muestra).
- **Auditoría:** `finance_log_audit` con `order_payment_status_changed`, igual que el recompute.

**No ejecutado.**

## 6. Propuesta exacta de P0-A.1H (§16)

Reemplazar `service_with_cogs` (líneas 643-649 de `20260713280000`) por **cuatro** checks. La condición `AND c.order_id IS NULL` es parte de uno solo, no la protección completa:

1. **`folded_cogs_without_order`** — línea de servicio con COGS cuyo comprobante no tiene `order_id`. `warn`.
   ```sql
   FROM v_finance_sales_ledger l JOIN comprobantes c ON c.id = l.comprobante_id
   WHERE l.tipo_linea='servicio' AND COALESCE(l.cogs_amount_ars,0) <> 0 AND c.order_id IS NULL
   ```
2. **`folded_cogs_mismatch`** — el COGS plegado **no coincide** con la suma de snapshots de los repuestos absorbidos de esa orden. `warn` hasta 1 ARS de diferencia, `fail` por encima. Es el check que realmente protege: detecta un plegado inventado aunque haya `order_id`.
   ```sql
   WHERE abs(cogs_del_comprobante - costo_atribuible_de_la_orden) > 1.00
   ```
3. **`order_part_missing_cogs`** — repuesto consumido en una orden facturada cuyo costo no llegó a ningún `comprobante_items`. `warn`. Deriva de `v_finance_order_cogs_gaps.gap_type='cogs_incompleto'`, ya en producción.
4. **`order_double_stock_risk`** — línea con `inventory_id` sobre un producto ya consumido por la orden. `fail`. Deriva de `gap_type='riesgo_doble_stock'`.

**No eliminar el warning actual sin los cuatro sustitutos.** Fixtures: (a) servicio con COGS y `order_id` coincidente → pass en los cuatro; (b) sin `order_id` → dispara 1; (c) con `order_id` pero importe distinto → dispara 2; (d) repuesto consumido sin COGS → dispara 3; (e) línea con `inventory_id` duplicando stock → dispara 4.

**Impacto esperado:** de los 12 warnings actuales, los que provengan de comprobantes sin `order_id` se mantienen (sólo 3 de 277 lo tienen), así que el número baja poco hasta que corra el backfill de trazabilidad. Correcto: sin vínculo no hay forma de saber si el plegado es legítimo.

## 7. Riesgos

- **El principal: la UI sigue sin existir.** Todo el modelo —estado financiero, imputación, crédito no imputado, reversa— sólo se puede operar por RPC. Para el usuario final, hoy no cambió nada.
- **Bajo** en lo entregado: este commit agrega dos scripts de prueba; no toca migraciones ni aplicación.
- El harness deja datos **commiteados** en la base local mientras corre. Se limpia con `db reset` (hecho) y no debe ejecutarse contra producción — usa `session_replication_role='replica'` para limpiar tablas append-only.

## 8. Recomendación

**BLOQUEADO para release**, por una única razón: **falta la UI completa**.

El backend está terminado y ahora también probado bajo concurrencia real. Lo que falta es exclusivamente la capa de interfaz, y con ella su testing.

Orden sugerido:

1. **P0-A.1U — UI**, como lote propio y con presupuesto propio. Incluye montar el entorno de testing de componentes (hoy no existe), sin el cual los 20 tests de §13 no se pueden escribir de verdad. Las vistas ya están listas: `v_order_financial_status`, `v_customer_open_documents`, `v_customer_unallocated_credit`.
2. **P0-A.1H** — Health Check, con la propuesta de §6.
3. **Backfill de estados** — las 4 órdenes, con el contrato de §5.
4. **P0-B** — COGS histórico. **Sigue bloqueado y sin cambios.**
5. Los dos **P1** (`amount_paid` con 4 consumidores; `orders.total_cost` como monto cobrable en `ModalCobro`).
