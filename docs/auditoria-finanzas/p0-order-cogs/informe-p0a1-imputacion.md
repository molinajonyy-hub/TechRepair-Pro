# P0-A.1 (continuación) — Imputación explícita · informe local

**Fecha:** 2026-07-30 · Rama `fix/p0a1-order-completion-payment-status`
**No publicado, sin PR, sin deploy, sin backfills, sin datos productivos modificados.**

> ## ⚠️ Alcance
> **Entregado y validado:** imputación explícita completa (modelo, RPCs, reversa,
> crédito no imputado), recompute actualizado, guards (§18) y dry-run histórico (§15),
> más el inventario y la propuesta del Health Check (§14 del pedido).
>
> **NO entregado: la UI.** §9 (lista/detalle, badges, campos) y §10 (filtros combinables)
> siguen pendientes, junto con los tests 14-16 que dependen de ella. Es lo que quedó
> fuera del presupuesto de este turno. Las vistas que la alimentan ya existen.

---

## 1. Commits

| Commit | Contenido |
|---|---|
| `def017a` | núcleo: `completed_at`/`paid_at`, `v_order_financial_status`, `recompute_order_payment_status`, 3 triggers |
| `045efe6` | informe parcial anterior |
| `e8948db` | **nuevo**: imputación explícita, 3 RPCs, 2 vistas, guard con self-test |

## 2. Modelo de asignación

No existía **ninguna** tabla de imputaciones (`account_payment_requests` es sólo el registro de idempotencia de la RPC de cobro). Se creó `customer_account_payment_allocations`:

`id · business_id · customer_id · account_id · payment_movement_id · comprobante_id · amount · currency · status · idempotency_key · reason · reversed_at · reversal_of · created_at · created_by`

**`order_id` no se persiste**: es derivable de `comprobantes.order_id`. Duplicarlo abriría una segunda fuente que puede divergir — el mismo error que ya cometieron `orders.amount_paid` y `comprobantes.payment_status`. El trigger valida la coherencia.

Constraints y guards, todos verificados por test:

| Regla | Mecanismo |
|---|---|
| `amount > 0` | CHECK |
| coherencia de `status`/`reversed_at` | CHECK |
| idempotencia | UNIQUE `(business_id, idempotency_key)` |
| mismo negocio en pago, comprobante, cuenta y asignación | trigger → `ALLOCATION_CROSS_BUSINESS` |
| el comprobante es del cliente de la cuenta | trigger → `ALLOCATION_CROSS_CUSTOMER` |
| Σ asignaciones activas ≤ importe del pago | trigger → `ALLOCATION_EXCEEDS_PAYMENT` |
| Σ aplicado ≤ saldo imputable del documento | trigger → `ALLOCATION_EXCEEDS_BALANCE` |
| sólo se imputan cobros (`credit > 0`) | trigger → `ALLOCATION_NOT_A_PAYMENT` |
| no imputar sobre comprobante anulado | trigger → `ALLOCATION_ON_ANNULLED` |
| sin DELETE financiero | trigger append-only |
| importes y referencias inmutables | trigger (sólo se permite pasar a `reversed`) |

**El pago original no se duplica.** La asignación distribuye su efecto: el `account_movement` del cobro sigue siendo uno solo.

## 3. Atomicidad

- `allocate_account_payment_atomic(business, payment_movement, allocations[], reason, key)` — reparte entre 1..N comprobantes en **una** transacción, con `SELECT … FOR UPDATE` sobre el movimiento de pago para serializar imputaciones concurrentes sobre el mismo cobro. Idempotente por prefijo de clave (cada ítem guarda `<key>:<n>`).
- `pay_comprobante_from_account_atomic(...)` — contrato A: cobra e imputa en el mismo acto **componiendo** `record_customer_account_payment_atomic` + `allocate_account_payment_atomic`. No duplica una línea de lógica financiera. Si la imputación falla, `RAISE` revierte también el cobro.
- `reverse_payment_allocation_atomic(business, allocation, amount|NULL, reason, key)` — reversa total o parcial.

## 4. Estados y transiciones

`sin_facturar | pending | partial | paid`, tolerancia canónica 1,00 ARS. Sin cambios respecto del lote anterior, salvo que ahora **`total_cobrado` = pagos directos del documento + imputaciones activas** y el saldo las descuenta.

## 5. Cuenta corriente — los cuatro ejemplos del contrato

| # | Escenario | Resultado | Asserts |
|---|---|---|---|
| 1 | 100.000 = 40.000 efectivo + 60.000 CC | completed · **partial** · saldo 60.000 | `E1a`-`E1c` |
| 2 | cobro genérico de 60.000 **sin imputar** | la orden **sigue partial**, saldo 60.000, crédito no imputado 60.000 | `C3a`, `C3b`, `C2b` |
| 3 | imputar al comprobante | orden → **paid**, saldo 0, `paid_at` completado | `C4a`-`C4c` |
| 4 | revertir 10.000 de la imputación | orden → **partial**, saldo 10.000, `paid_at` limpio, remanente 30.000 registrado | `C8a`-`C8g` |

Un pago repartido entre dos comprobantes (20.000 + 30.000 de un cobro de 60.000) mueve las dos órdenes y deja 10.000 de crédito (`C6a`-`C7`).

## 6. Crédito no imputado

`v_customer_unallocated_credit` — por cada cobro de CC: importe, imputado y **no imputado**. Un pago genérico queda 100 % sin imputar y no toca ninguna orden. En el contrato A el excedente sobre el saldo del documento **no se fuerza**: queda como crédito.

**Hallazgo:** el tope real de un cobro no lo pone el documento sino la cuenta — `record_customer_account_payment_atomic` rechaza cobrar más que la deuda viva («El cobro supera la deuda pendiente»). Aparece en el test al intentar cobrar 50.000 con 10.000 de deuda.

## 7. UI — **pendiente**

No entregada. Las vistas que la alimentan ya están listas y con `security_invoker`:
`v_order_financial_status` (estado, totales, saldo, comprobante, timestamps),
`v_customer_open_documents` (documentos imputables por cliente) y
`v_customer_unallocated_credit` (crédito disponible). La pantalla de imputación tiene que leer las dos últimas y llamar a `allocate_account_payment_atomic`.

## 8. Filtros — **pendiente**

`v_order_financial_status` ya expone `estado_tecnico` y `payment_status` en la misma fila, así que las combinaciones pedidas (completada+pendiente, completada+parcial, completada+cobrada, sin facturar) son un `WHERE` sobre la vista, server-side.

## 9. Guards (§18)

`scripts/finance/guard-order-payment-status.mjs`, con **self-test de 10 fixtures** y cableado en `npm run guards`. Falla si:

- el frontend escribe `payment_status`, `paid_at`, `completed_at` o marca `status:'completed'` sobre `orders`;
- React deriva `payment_status`;
- aparece FIFO/proporcional/prorrateo en la imputación;
- falta cualquiera de las validaciones de sobreasignación, sobrepago, aislamiento de negocio/cliente o el guard append-only;
- `recompute_order_payment_status` se otorga a `authenticated`;
- se usa `orders.amount_paid` o `comprobantes.payment_status` **fuera del baseline registrado**.

Los `COMMENT ON` se excluyen del análisis: la prosa que explica que FIFO está prohibido no puede hacer fallar la regla que lo prohíbe.

**Hallazgo del guard:** `orders.amount_paid` no se lee en dos lugares sino en **cuatro** — `ModalCobro.tsx`, `useOrderSimple.ts`, **`useDashboardStats.ts`** y **`Customers.tsx`**. Los dos últimos muestran al usuario importes que en la práctica son siempre 0 (1 sola fila ≠ 0 en todo el histórico). Amplía el P1 #2; quedan en baseline explícito y el guard bloquea cualquier uso nuevo.

## 10. Dry-run histórico de estados (§15) — solo lectura

| Clasificación | Órdenes | Total comprobado | Saldo | Ya `completed` | Requieren cierre |
|---|---|---|---|---|---|
| `deterministica_cobrada` | **4** | 594.190,00 | 0,00 | 4 | 0 |
| `sin_facturar` | 84 | 0,00 | 0,00 | 48 | 36 |
| `orden_cancelada` | 5 | — | — | 0 | 0 |
| parciales · pendientes · comprobante anulado · **ambiguas** · cross-business | **0** | — | — | — | — |

**Auto-corregibles: sólo las 4 determinísticas cobradas** (setear `paid_at`; ya están en `completed`). Las 84 sin facturar **no** son auto-corregibles: sin comprobante vinculado no hay hecho económico que respalde ni el cierre ni el estado, y **no se infiere** por cliente, fecha ni importe. Las 36 que "requieren cierre" son órdenes abiertas legítimas.

**No ejecutado.** Es un backfill distinto del P0-B de COGS y no debe mezclarse en una misma escritura.

## 11. Tests

`p0a1_account_allocations_test.sql` — **47 asserts**. Cubre los casos **1-13** del contrato: imputación automática desde el documento · pago genérico no imputado · el no imputado no mueve órdenes · imputación que completa · parcial · repartida entre dos comprobantes · excedente como crédito · reversa parcial con remanente · aislamiento multi-tenant (RPC y RLS) · idempotencia · sobreasignación · sobrepago · comprobante anulado no queda cobrado · DELETE prohibido.

**Caso 11 (concurrencia)**: el `FOR UPDATE` sobre el movimiento de pago está implementado y es la serialización correcta, pero **no se probó con dos sesiones reales** — el harness de concurrencia (`scripts/finance/concurrency-harness.mjs`) es un lote aparte. Lo declaro pendiente en vez de darlo por probado.

**Casos 14-16 (UI)**: pendientes con la UI.

## 12. Health Check (§ pedido) — inventario y propuesta, sin tocar nada

**Inventario exacto.** `finance_health_check_v2` (migración `20260713280000`, 917 líneas). El check vive en las **líneas 643-649**, dentro del bloque `pnl_ledger`:

```sql
-- Servicios: no deben inventar COGS.
SELECT count(*) INTO n FROM v_finance_sales_ledger l
 WHERE l.business_id=v_biz AND l.tipo_linea='servicio' AND COALESCE(l.cogs_amount_ars,0) <> 0;
v_c := v_c || finance_hc_mk('service_with_cogs','pnl_ledger','Servicios con COGS',
  CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0, …);
```

**No hay forma de parametrizarlo desde fuera**: el predicado está embebido en el cuerpo. Cambiarlo exige `CREATE OR REPLACE` de las 917 líneas. Por eso **no se tocó**, según la instrucción.

**Propuesta de reemplazo** — mismo `id`, semántica corregida: no es anomalía una línea de servicio con COGS cuyo comprobante tiene `order_id` y cuyo costo plegado coincide con los repuestos absorbidos de esa orden.

```sql
SELECT count(*) INTO n FROM v_finance_sales_ledger l
 JOIN comprobantes c ON c.id = l.comprobante_id
 WHERE l.business_id = v_biz AND l.tipo_linea = 'servicio'
   AND COALESCE(l.cogs_amount_ars,0) <> 0
   AND c.order_id IS NULL;          -- ← sólo sin orden es sospechoso
```

Y tres checks nuevos derivables de `v_finance_order_cogs_gaps`, que ya está en producción: `folded_cogs_without_order`, `order_part_missing_cogs` y `order_double_stock_risk`.

**Impacto histórico esperado:** hoy `service_with_cogs` marca **12** líneas. Con el predicado corregido, las que provengan de órdenes con `order_id` dejan de contar; como sólo 3 de 277 comprobantes históricos tienen el vínculo, **la mayoría de los 12 seguirá apareciendo hasta que el backfill de trazabilidad corra**. Eso es correcto: sin `order_id` no hay forma de saber si el costo plegado es legítimo. Fixtures propuestas: (a) servicio con COGS y `order_id` → pass; (b) servicio con COGS sin `order_id` → warn; (c) servicio sin COGS → pass; (d) producto con COGS → pass.

**El cambio real es P0-A.1H, en su propio lote.**

## 13. Migraciones

| Migración | Contenido |
|---|---|
| `20260731120000` (207) | núcleo: columnas, vista, helper, 3 triggers |
| `20260731130000` (208) | **nueva**: tabla de asignaciones + guard de integridad + 3 RPCs + 2 vistas + `v_order_financial_status` recreada |

Ambas con rollback documentado. `v_order_financial_status` se recrea con `DROP + CREATE` porque `CREATE OR REPLACE VIEW` no admite agregar columnas intermedias.

## 14. Validación

`db reset` ×2 (**208** migraciones, ambos limpios) · `tsc` 0 · `lint:errors` 0 · **572/572** unit ·
`build` OK · **`guards` OK** (incluye el nuevo con su self-test) ·
**587 asserts SQL en 12 suites, 0 fallas, 0 regresiones** (checkout, anulación, reemplazo de pagos, cobros de cuenta, modelo canónico, P&L, dashboard, M6, health check v2, P0-A, y las dos suites de P0-A.1).

## 15. Riesgos

- **Bajo — tabla y RPCs nuevas**: no modifican ningún camino existente. Las 10 suites preexistentes pasan sin cambios.
- **Bajo — `v_order_financial_status` recreada**: ningún consumidor productivo la usa todavía.
- **Medio — sin UI, la funcionalidad es invisible**: la imputación sólo puede ejercerse por RPC. No es riesgo de datos, pero sí de utilidad.
- **No probado — concurrencia real** sobre el mismo cobro (ver §11).
- **Documentado — `service_with_cogs`** sigue emitiendo warnings sin significado hasta P0-A.1H.

## 16. Recomendación de release

**No liberar todavía**, por la misma razón que en el lote anterior: sin §9-§10 el estado financiero y la imputación existen pero no se ven ni se pueden operar. Sugerencia de orden:

1. **UI** (§9-§10) + tests 14-16 → con eso P0-A.1 queda completo y liberable.
2. **P0-A.1H** — Health Check semántico, con la propuesta de §12.
3. **Backfill de estados** — sólo las 4 órdenes determinísticas.
4. **P0-B** — COGS histórico, **sigue bloqueado y sin cambios**: 730.162,50 ARS, 14 determinísticas (433.212,50), 6 cerradas ambiguas (210.390), 70.560 en órdenes vivas, 16.000 en una cancelada.
5. Los dos **P1** (ampliado: `amount_paid` tiene 4 consumidores, no 2).
