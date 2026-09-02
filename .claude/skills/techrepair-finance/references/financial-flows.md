# Financial flows and their canonical entry points

Every flow below has exactly one supported way in. If a task seems to need another way, that is a
signal to stop and ask, not to open a direct write.

RPC names were inventoried from `supabase/migrations/`; the customer-ledger set is enumerated and
asserted in `20260901120000_p0cc_e_revoke_direct_ledger_insert.sql`.

## Sale / POS checkout

`create_comprobante_checkout_atomic` — the single sale path, including a sale on cuenta corriente.

Writes the comprobante, its items (with `costo_total`, the accrual and COGS source), payments when
the sale is collected, the FM cash movement, the BFE economic entry, and the `account_movements`
`venta` row when the sale is on credit.

Intent hashing: `compute_checkout_intent_hash`; requests are immutable
(`comprobante_checkout_requests_immutable`). Frontend entry point is `comprobanteService.crear()`
and the single sale modal `ComprobanteProModal` — `CLAUDE.md` forbids parallel mini-POS flows.

Do not set `total_cobrado` on the insert; `trig_comprobante_payment_sync` owns it.

## Collection against a customer account

- `record_customer_account_payment_atomic` — a cobro.
- `allocate_account_payment_atomic` / `reverse_payment_allocation_atomic` — imputation of a
  payment against open documents.
- `pay_comprobante_from_account_atomic` — settle a document from account credit.
- Read models: `v_customer_open_documents`, `v_customer_unallocated_credit`.

A cobro produces cash and lowers debt. It does **not** produce revenue — the revenue was
recognised at the sale.

## Manual debt and adjustments

`record_customer_account_adjustment_atomic(p_business_id, p_account_id, p_amount, p_direction,
p_reason, p_idempotency_key)` where `p_direction` is `'debit'` (raises debt) or `'credit'`
(lowers it). Both land as `type='ajuste'`; the intent is preserved in `reference_type`.

This RPC exists precisely because `registerDebt` and `addAdjustment` used to INSERT directly —
without server-side capability, idempotency, period guard or explicit audit (CC-D header). Never
reintroduce that shape.

## Reversing a collection

`reverse_customer_account_payment_atomic(p_business_id, p_movement_id, p_reason,
p_idempotency_key)`.

Dated today. Compensating FM `expense` with the same method into the open caja; compensating BFE
`income` with a negative amount and `economic_class='revenue_collection_mirror'`. One reversal per
original, enforced by UNIQUE on `original_movement_id`; a second attempt gets `ALREADY_REVERSED`.

Related reversals elsewhere in the system, same philosophy:
`reverse_order_payment_atomic`, `reverse_operating_expense_atomic`, `reverse_manual_cash_movement`.

## Annulment

`annul_comprobante_atomic`, with `comprobante_annulment_transition_guard`,
`comprobante_annulments_immutable`, `comprobante_payments_annulled_guard`,
`comprobante_state_is_annulled` / `is_comprobante_annulled`.

The sale event survives in `v_finance_sales_ledger`; the annulment adds a negative mirror at the
annulment date. History is compensated, not rewritten.

## Replacing payments on a document

`replace_comprobante_payment`, append-only by design
(`.../20260713240000_m7_6f3_payment_replacement_append_only.sql`), guarded by
`comprobante_payments_replacement_guard` and `finance_period_guard_cp_update`. Tests:
`etapa6_replace_comprobante_payment_test.sql`, `tests/unit/replacePaymentIdempotency.test.ts`.

## Purchases and suppliers

- `create_supplier_purchase_atomic` — a purchase from a supplier.
- `create_quick_inventory_purchase_atomic` — quick inventory purchase.
- `pay_supplier_purchase_atomic` — pay a specific purchase.
- `pay_supplier_free_atomic` — free-form supplier payment.
- `delete_supplier_purchase_safe` — the only supported removal path.
- `normalize_supplier_payment_method` — method normalisation.
- Frontend: `suppliersService`, including `_addAccountMovement()` (`CLAUDE.md`).
- Read model: `v_finance_payables_aging`.

An inventory purchase is `economic_class='inventory_purchase'`; paying down supplier debt is
`supplier_liability_payment`. They are different economic events even when money moves both times.
Tests: `etapa6_supplier_payment_lockdown_test.sql`,
`etapa7_6d2a_supplier_payment_cashflow_test.sql`,
`etapa7_6d2b_supplier_method_consistency_test.sql`, `etapa7_6e1a_quick_purchase_integrity_test.sql`.

## Expenses

`create_expense_with_finance`, reversed by `reverse_operating_expense_atomic`; requests immutable
via `expense_requests_immutable`. Classes: `operating_expense`, `employee_salary`, `payment_fee`.
Tests: `etapa1_active_expense_flow_test.sql`, `etapa7_rpc_integration_expense_cash_test.sql`.

## Caja / cash sessions

`open_cash_session_atomic` and `close_cash_session_atomic`; manual movements via
`create_manual_cash_movement_atomic` and `reverse_manual_cash_movement`, requests immutable via
`manual_cash_requests_immutable`.

A `cierre de caja` here is a **cash session close** — it is not an accounting period close. Those
are different mechanisms and must not be conflated: period closure is `close_period` /
`reopen_period` with `assert_period_open` guards. Tests: `etapa6_cash_sessions_test.sql`,
`tests/e2e/caja-comprobante.spec.ts`, `tests/e2e/caja-health.spec.ts`.

## Owner capital flows

`create_owner_withdrawal` and `create_owner_contribution`, requests immutable via
`owner_flow_requests_immutable`; classes `owner_withdrawal` / `owner_contribution`; read model
`v_owner_flows` (`supabase/migrations/20260704110000_owner_capital_flows.sql`).

These are **capital flows, not P&L items**. A withdrawal is not an operating expense and a
contribution is not revenue. Never fold them into profit.

## Orders with financial impact

`create_order_payment_atomic`, `register_order_payment`, `reverse_order_payment_atomic`,
`order_status_on_payment_change`; read models `v_order_financial_status`, `v_order_payment_state`,
`v_finance_order_cogs_gaps`. Order amounts contract:
`.../20260828120000_order_amounts_canonical_profile_identity.sql`. Order-level triggers
`adjust_stock_on_order_item` and `recalculate_order_total` are listed as do-not-touch in `CLAUDE.md`.

Order completion and order payment are independent states.

## Period closing

`close_period` / `reopen_period`, with `is_period_closed` and `assert_period_open` called by the
mutating RPCs, plus the `finance_period_guard_*` triggers. Never bypass a guard; never write into
a closed period by dating a movement backwards.

## Fiscal / ARCA

Fiscal emission is a **separate concern** from financial recording, with its own canonical
contract: `.../20260814150000_fiscal_sales_point_canonical_contract.sql` and
`.../20260818210000_arca_comprobante_identity_snapshot.sql`; docs under `docs/auditoria-fiscal/`;
test `arca_atomic_claim_test.sql`.

Never change fiscal or ARCA behaviour on the advice of a generic finance skill. Argentine fiscal
compliance is out of scope for any external methodology and is governed by this contract and the
user's explicit instruction.
