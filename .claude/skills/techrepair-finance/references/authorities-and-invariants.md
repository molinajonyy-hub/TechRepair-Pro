# Authorities and invariants

## The authority map

Three layers. Every financial number belongs to exactly one.

### Source of truth — base tables, written only by canonical RPCs or triggers

| Concept | Authority | Written by |
|---|---|---|
| Customer debt / current account | `account_movements` (+ `balance_after`) | canonical RPCs only; client has SELECT only |
| Supplier debt / current account | `supplier_account_movements` | supplier RPCs + `trig_supplier_account_movement_balance` |
| Caja / cash movements | `financial_movements` | canonical RPCs; `caja_id` assigned by trigger |
| Economic classification | `business_finance_entries.economic_class` | `bfe_economic_class()` |
| Sale amounts and cost | `comprobante_items` (incl. `costo_total`) | checkout RPC |
| Collection on a document | `comprobante_payments` | payment RPCs |
| Document totals collected | `comprobantes.total_cobrado`, `saldo_pendiente` | `trig_comprobante_payment_sync` |
| Reversal state | `account_payment_reversals` | reversal RPC; append-only |
| Period closure | period-lock tables + `close_period` / `reopen_period` | RPC only |

### Derived / read model — views and summary RPCs, never written to

`v_finance_pnl` · `v_finance_position` · `v_finance_cashflow` · `v_finance_sales_ledger` ·
`v_finance_effective_comprobantes` · `v_finance_product_margin` · `v_finance_receivables_aging` ·
`v_finance_payables_aging` · `v_finance_order_cogs_gaps` · `v_owner_flows` ·
`v_customer_open_documents` · `v_customer_unallocated_credit` · `v_order_financial_status` ·
`v_order_payment_state` · `v_payment_analytics` · `v_comprobantes_full` · `dashboard_daily_summary`

Answers by question:

- Profit / P&L → `v_finance_pnl`
- Accrued sales events → `v_finance_sales_ledger`
- Cash position → `v_finance_position`, `v_finance_cashflow`
- Product margin → `v_finance_product_margin`
- Customer debt ageing → `v_finance_receivables_aging`
- Supplier debt ageing → `v_finance_payables_aging`
- Owner capital flows → `v_owner_flows`
- Missing cost on orders → `v_finance_order_cogs_gaps`

### UI presentation — the client

The frontend formats, drafts and displays. It does not own a canonical number.

Verified consumers that go through the canonical path:
`src/hooks/useDashboardStats.ts` (via RPC `finance_dashboard_summary` → `v_finance_pnl`, and
`v_finance_product_margin` at :260), `src/components/finance/charts/ResultChart.tsx:16`
("React NO reconstruye el…"), `src/components/finance/charts/BillingVsCollectionsChart.tsx:17`,
`src/lib/orderBilling.ts:6`, `src/pages/Comprobante.tsx:133`.

`src/hooks/useFinancialDashboard.ts` reads base tables (`comprobante_payments` at :60,
`financial_movements` at :82) rather than a canonical view. No JS aggregation of canonical
balances was found in it, but treat it as the one place to re-verify before trusting or extending.

## Invariants

Each is backed by evidence. Do not add to this list without the same standard.

### Atomicity
Financial writes happen inside a single atomic RPC. Naming is explicit and consistent:
`create_comprobante_checkout_atomic`, `record_customer_account_payment_atomic`,
`reverse_customer_account_payment_atomic`, `annul_comprobante_atomic`,
`create_supplier_purchase_atomic`, `pay_supplier_purchase_atomic`,
`create_quick_inventory_purchase_atomic`, `open_cash_session_atomic`, `close_cash_session_atomic`,
`allocate_account_payment_atomic`, `reverse_payment_allocation_atomic`,
`reverse_operating_expense_atomic`, `reverse_order_payment_atomic`,
`create_manual_cash_movement_atomic`, `pay_comprobante_from_account_atomic`, `pay_supplier_free_atomic`.

### The customer ledger is append-only for the client
`REVOKE INSERT/UPDATE/DELETE` on `account_movements` for `authenticated`, `anon` and `PUBLIC`; the
INSERT policy was dropped; postconditions raise if any write privilege or write policy survives
(`supabase/migrations/20260901120000_p0cc_e_revoke_direct_ledger_insert.sql`). Tests:
`supabase/tests/etapa6_rls_lockdown_test.sql`, `etapa7_7e1_public_create_lockdown_test.sql`.

### Idempotency, and what actually guarantees it
Mutating RPCs take an idempotency key hashed over the caller's **intent** — operation, business,
target, reason — deliberately **without the date**, so a retry the next day is still a replay
(CC-D header). `compute_checkout_intent_hash` does the equivalent for checkout.

But the hash is not the guarantee. Uniqueness is enforced by a UNIQUE constraint: two calls with
*different* keys still compete for the same row and the second receives `ALREADY_REVERSED`
(CC-D header; postcondition at :452). Request tables are immutable by trigger:
`comprobante_checkout_requests`, `order_payment_requests`, `expense_requests`,
`manual_cash_requests`, `owner_flow_requests`, `supplier_payment_requests`,
`supplier_purchase_requests`, `account_payment_requests`, `comprobante_payment_replace_requests`.
Tests: `comprobante_checkout_idempotency_test.sql`, `etapa7_7e1b_mutator_idempotency_test.sql`,
`etapa7_6e2a_checkout_intent_hash_test.sql`, `tests/unit/orderPaymentMixedIdempotency.test.ts`,
`tests/unit/replacePaymentIdempotency.test.ts`.

### No double counting
`revenue_collection_mirror` and `cogs_mirror` net to zero and stay out of the P&L; real sale and
COGS come from `comprobante_items`
(`supabase/migrations/20260704100000_fix_cost_double_count.sql:43`). Tests:
`etapa1_pnl_exclusions_test.sql`, `etapa7_7e3_bfe_income_duplicated_test.sql`,
`tests/unit/orderCogsAbsorbed.test.ts`.

### Reversal compensates, never deletes
The reversal is dated **today** with `ar_today()`, never on the original date. It writes a
compensating FM `expense` with the **same** payment method — no reclassification — into the
currently open caja, and a compensating BFE `income` with a **negative** amount and
`economic_class='revenue_collection_mirror'`, so it nets to zero and stays out of the P&L. The
reversal recognises no revenue and generates no operating expense (CC-D header). Annulment
mirrors the sale with negative amounts at the annulment date rather than erasing it
(`v_finance_sales_ledger`). Tests: `etapa0_annulment_ledger_test.sql`,
`etapa6_expense_reversal_test.sql`, `etapa7_rpc_integration_order_payment_reversal_test.sql`,
`etapa7_rpc_integration_comprobante_annulment_test.sql`.

### Period locks exist and are enforced
`finance_period_bounds`, `finance_period_lock_key`, `is_period_closed`, `assert_period_open`,
`close_period`, `reopen_period`
(`supabase/migrations/20260713110000_m7_finance_period_locks.sql`), with guard triggers
`finance_period_guard_biu` (`.../20260713130000_m7_e1e2_period_guard.sql:19`) and
`finance_period_guard_cp_update` (`.../20260713240000_m7_6f3_payment_replacement_append_only.sql:99`).

Subtlety worth preserving: a reversal validates **today's** period only. Reversing today a
collection from a closed month is valid and does **not** reopen that month (CC-D header). Test:
`etapa7_period_locks_audit_test.sql`.

### Balance computation is server-side and locked
Customer: `trig_account_movement_balance` with `SELECT FOR UPDATE`. Supplier:
`trig_supplier_account_movement_balance` with `pg_advisory_xact_lock` (`CLAUDE.md`).

### Capability gating is fail-closed
Financial RPCs require `current_user_can('finance')`; current-account reads additionally require
`business_has_feature('currentAccounts')`
(`.../20260830120000_p0cc_c_capability_rbac_and_balance_lockdown.sql`, CC-E notes). CC-D
postconditions raise if an RPC does not demand the capability (:442) or if `anon` retains EXECUTE
(:447). `CLAUDE.md`: `requireFeature()` is fail-closed.

### Tenant isolation
Every financial table is RLS-scoped by `business_id` via `current_business_id()`; never query
without the business scope (`CLAUDE.md`, "Supabase — reglas críticas").

### SECURITY DEFINER hardening
Ledger RPCs are `SECURITY DEFINER` owned by `postgres` with hardened `search_path`; CC-E asserts
exactly five such RPCs still qualify and fails the migration otherwise (:2.4). Test:
`etapa7_7c1_security_definer_hardening_test.sql`.

### Traceability
Reversal, request and annulment tables are append-only, enforced by `*_immutable` triggers that
raise `0A000`. `reference_type` / `reference_id` and `source` / `source_id` carry provenance.

### Reconciliation
`reconcile_ledger_record`, `docs/auditoria-finanzas/conciliaciones.sql`, and
`supabase/tests/etapa1_conciliaciones.sql`. Here reconciliation means checking internal coherence
between the four stores — ledger, cash, economic entries and documents — not matching an external
bank feed.
