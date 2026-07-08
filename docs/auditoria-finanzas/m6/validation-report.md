# M6 — Reporte de validación consolidado (Fase 11)

Estado: **todas las suites verdes**. Sin commit / sin push / producción intacta.
Runner: `npm run validate:m6` · Guía: `node scripts/finance/run-m6-validation.mjs --guide`

---

## 1. Resumen ejecutivo

M6 (“Ledger lockdown y flujos operativos atómicos”) llevó **toda operación económica
del cliente a una RPC atómica SECURITY DEFINER** (idempotente cuando se repite, ownership
check, reverso append-only) y **cerró la escritura directa al libro mayor** vía RLS + un
guard estático. Resultado: el frontend ya no escribe `financial_movements` /
`business_finance_entries` / `order_payments` / `cajas` / `supplier_*` directamente; sólo
quedan 3 excepciones acotadas y documentadas (E1/E2/E3). No se cambió el modelo contable
canónico, no se recalcularon históricos, no se tocó producción.

## 2. Migraciones M6 (`supabase/migrations/`)

| Fase | Archivo | Qué agrega |
|---|---|---|
| 3 | `20260706120000_m6_customer_account_payment.sql` | `record_customer_account_payment_atomic` + `account_payment_requests` (fix: el viejo `registrarPagoCC` insertaba `caja_id` en BFE → fallaba silencioso, nunca creaba FM) |
| 4 | `20260706130000_m6_cash_sessions.sql` | `open/close_cash_session_atomic` + `cash_session_requests`; `trigger_set_movement_caja` rechaza caja cerrada |
| 5 | `20260706140000_m6_reverse_operating_expense.sql` | `reverse_operating_expense_atomic` + `operating_expense_reversals` + `expenses.reversed_at/by` |
| 6 | `20260706150000_m6_order_payments.sql` | `create/reverse_order_payment_atomic` + requests/reversals; fix USD (`amount_ars=amount*rate`), link FM/BFE, DROP `order_payments_delete` |
| 7 | `20260706160000_m6_supplier_payment_lockdown.sql` | SELECT+INSERT policies acotadas en `supplier_payments`/`supplier_account_movements` (bloquea UPDATE/DELETE) |
| 8 | `20260706170000_m6_replace_comprobante_payment.sql` | `replace_comprobante_payment` (12 args) append-only + comisiones; `reversed_at` en FM/BFE |
| 9 | `20260706180000_m6_rls_lockdown.sql` | `create_manual_cash_movement_atomic`, `pay_supplier_free_atomic` + requests; lockdown de policies (ver §4) |

## 3. RPCs nuevas / modificadas

**Nuevas:** `record_customer_account_payment_atomic`, `open_cash_session_atomic`,
`close_cash_session_atomic`, `reverse_operating_expense_atomic`, `create_order_payment_atomic`,
`reverse_order_payment_atomic`, `create_manual_cash_movement_atomic`, `pay_supplier_free_atomic`.
**Modificada:** `replace_comprobante_payment` (9→12 args, append-only, idempotente).
Todas: `SECURITY DEFINER`, `SET search_path=public`, validan `auth.uid()` + pertenencia al
`business_id`, idempotencia por `request_hash` (replay vs `IDEMPOTENCY_CONFLICT`).
*(Verificado estructuralmente en la suite de integridad A2/A3.)*

## 4. RLS / policies modificadas (Fase 9)

**Dropeadas (INSERT ya migrado):** `fm_insert`, `financial_movements_business_insert`,
`bfe_insert`, `supplier_payments_insert`, `supplier_account_movements_insert`, `order_payments_insert`.
**Dropeadas (UPDATE/DELETE sin flujo vivo):** `bfe_update_manual`, `bfe_delete_manual`
(huecos del ex-`Finance.tsx`), `order_payments_update`, `expenses_update`, `expenses_delete`.
**Reemplazada:** `cajas_staff [ALL]` → `cajas_select [SELECT]`.
Resultado: **0 policies `ALL`** en las 9 tablas críticas (verificado A1/F9-24). Detalle y
matriz completa en [`rls-lockdown.md`](./rls-lockdown.md).

## 5. Frontend rewired

`CajaPage.handleAddMovement` → `create_manual_cash_movement_atomic`;
`suppliersService.createPayment` (pago libre) → `pay_supplier_free_atomic`;
`cuentasService.registrarPagoCC` → RPC; `CajaPage` open/close → RPC;
`Expenses` delete → `reverse_operating_expense_atomic`; `Comprobante`/`comprobanteService.actualizarPago`
→ `replace_comprobante_payment`; order payments (`PaymentCard`/`OrderCostManagement`/`ModalCobro`) → RPC.
**Código muerto removido:** `financeService.createEntry/updateEntry/deleteEntry`,
`expensesService.create/update`, `suppliersService._addAccountMovement/_recordPaymentInternal`.

## 6. Excepciones E1/E2/E3

| # | Archivo:línea | Tabla · op | Motivo | Destino |
|---|---|---|---|---|
| E1 | `comprobanteService.ts:911` | `comprobante_payments` insert | Cobro inicial (POS/checkout/ARCA); acotado por business; UPDATE/DELETE bloqueados | Migrar RPC posterior |
| E2 | `cuentasService.ts:150` | `account_movements` insert | CC manual; ledger aislado sin FM/BFE/caja; business+staff+feature | Migrar RPC posterior |
| E3 | `Expenses.tsx:421` | `expenses` insert | Factura documental legítima; UPDATE/DELETE bloqueados | Permitido por contrato |

## 7. Finance write guard (Fase 10)

`scripts/guards/no-direct-finance-writes.mjs` (+ `--self-test`). Detecta INSERT/UPDATE/DELETE/
UPSERT directo a las 9 tablas en `src/`; allowlist estricta por archivo+tabla+op (solo E1/E2/E3);
no permite UPDATE/DELETE en ninguna excepción. Scan real: **3 detectadas = 3 permitidas, 0 violaciones**.
Self-test **13/13**. Detalle en [`finance-write-guard.md`](./finance-write-guard.md).

## 8. Suites SQL ejecutadas (`npm run validate:m6`)

| Suite | PASS | Suite | PASS |
|---|--:|---|--:|
| Fase 3 · account payments | 17 | Etapa 0 · finance hardening | 21 |
| Fase 4 · cash sessions (C1) | 21 | Etapa 0 · checkout invariants | 32 |
| Fase 5 · expense reversal | 22 | Etapa 0 · anulación (ledger) | 64 |
| Fase 6 · order payments | 26 | Etapa 1 · modelo canónico | 40 |
| Fase 7 · supplier lockdown | 9 | Etapa 1 · gasto activo/compras | 48 |
| Fase 8 · replace comprobante | 24 | Etapa 1 · P&L exclusiones | 14 |
| Fase 9 · RLS lockdown | 39 | Etapa 1 · quick purchase | 46 |
| **Fase 11 · integridad transversal** | **33** | Checkout · pricing security | 29 |
| Checkout · idempotencia | 47 | Comprobantes · numeración | 34 |
| ARCA · claim atómico | 51 | | |

Guard self-test 13/13 · guard scan 0 violaciones. **Total: todo verde.**

## 9. Conciliaciones ejecutadas (transversal, `etapa6_m6_integrity_test.sql`)

1. **Cobro CC** — deuda baja, caja sube, `net_sales` sin cambio (B2/B11).
2. **Caja** — abre/cierra por RPC; caja cerrada inmutable; FM a caja cerrada rechazado (B0/D5); C1 (Fase 4) verde.
3. **Gasto operativo** — reverso append-only; auditoría presente; sin huérfanos (B6/B7/C6).
4. **Orden** — pago ARS + USD (TC correcto) + reverso; FM/BFE linkeados; P&L no contaminado (B3/B4/B5/C4/B11).
5. **Proveedor** — compra + pago libre por RPC; UPDATE/DELETE directo bloqueado (Fase 7); ledger presente (B8/B9/C5).
6. **Comprobante replace** — comisión previa neteada + nueva una sola vez = `payment_fee` neto 300; venta devengada intacta (B10/B10b/B11).
7. **RLS** — escritura directa bloqueada; RPC autorizada funciona; cross-tenant falla; 0 policies ALL (Fase 9 + A1).
8. **Guard** — 0 violaciones, E1/E2/E3 permitidas, self-test verde.
9. **Vistas canónicas** — `v_finance_pnl/cashflow/position` + `finance_dashboard_summary` responden post-operaciones (D1-D4).
10. **Idempotencia** — replay no duplica, payload distinto → conflict (cubierto en cada suite por fase + A4 constraints).

**Huérfanos: 0** — FM/BFE con comprobante inexistente, `payment_fee` sin comprobante,
`order_payments` sin FM/BFE link, `supplier_payments` sin ledger, expenses reversadas sin
auditoría, reversals sin original (C1-C7, todos = 0).

## 10. Antes / después relevantes

| Aspecto | Antes | Después |
|---|---|---|
| Cobro CC | `registrarPagoCC` insertaba `caja_id` en BFE (col inexistente) → fallo silencioso, **nunca creaba FM** | RPC crea FM+BFE atómico; caja sube |
| Pago de orden USD | `amount_ars` guardado 1:1 (sub-registro en ARS) | `amount_ars = amount × TC` |
| Replace comprobante | comisión previa quedaba **huérfana** (doble comisión) | previa neteada; nueva una sola vez |
| Pago libre proveedor | supplier_payment + FM en 2 pasos → **huérfano si el FM fallaba** | RPC atómico |
| Escrituras directas al mayor desde `src/` | ~5 (CajaPage manual, pago libre FM+BFE, financeService) | **0** (guard-enforced; solo E1/E2/E3 acotadas) |
| Policies en tablas críticas | `cajas [ALL]`, BFE manual UPDATE/DELETE abiertos | 0 ALL; BFE/FM/order_payments/supplier_* SELECT-only |

## 11. Riesgos residuales

- 🟡 **E1/E2 siguen con INSERT directo** (acotado por business, UPDATE/DELETE bloqueados, en allowlist + guard). Migrar a RPC en fase posterior.
- 🟡 **`pay_supplier_free_atomic` preserva el `metodo_pago` NULL** del FM de pago libre (comportamiento previo) → ese gasto no se refleja por método en el esperado de caja. **Gap pre-existente**, no introducido; revisar en fase futura.
- 🟡 **`replace_comprobante_payment` con comprobante ligado a una orden** (FM previo por otra vía) es caso borde no cubierto por tests unitarios (el común, sin orden, sí). Validar en smoke si se usa.
- 🟢 `reversed_at` sumado a FM/BFE (nullable, sin reescritura) → `db push` a prod rápido.

## 12. Checklist de deploy recomendado

1. **Merge/commit** único de M6 (ver recomendación de Fase 10) — sin `supabase/config.toml`.
2. `npx supabase db push` (7 migraciones M6, aditivas; columnas nullable → rápido).
3. Deploy frontend (Vercel) del build ya verificado.
4. **Smoke prod (Fase 12):** abrir/cerrar caja, cobro CC, pago de orden ARS+USD, reverso, gasto+reverso, pago proveedor, replace de cobro, y confirmar dashboard.
5. Post-deploy: correr `npm run validate:m6` contra staging si existe; monitorear `financial_movements`/`business_finance_entries` por 24h.
6. **No** correr backfills. **No** tocar históricos.
