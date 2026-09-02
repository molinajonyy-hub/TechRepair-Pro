# Financial model — what TechRepair Pro actually implements

Everything here was read from current migrations, views and tests. Evidence paths are given so
you can re-verify rather than trust this file. When this file and the code disagree, the code
wins and this file is stale.

Currency and time:

- Amounts carry `amount`, `currency`, `exchange_rate` and `amount_ars`. Canonical reporting is in
  `amount_ars`.
- Business dates come from `ar_today()` (`supabase/migrations/20260702100000_finance_hardening_base.sql:37`).
- Accounting period dates are derived in `America/Argentina/Cordoba`, not UTC
  (`supabase/migrations/20260713270000_m7_6f4c_accrual_views.sql`, `v_finance_sales_ledger`).

## Two separate books, plus cash, plus the economic ledger

There is no single "ledger". There are four distinct stores, and conflating them is the most
common way to be wrong here.

### 1. `account_movements` — customer current account

The customer debt book. Base table: `supabase/migrations/20260628190324_remote_baseline.sql`.

- `type` has a closed CHECK: `venta | compra | gasto | pago | ajuste | apertura`.
- Direction carries the accounting meaning: **`debit` raises the customer's debt, `credit` lowers
  it**. A manually loaded debt and an adjustment are both `ajuste`, distinguished by direction,
  with `reference_type` holding the declared intent
  (`supabase/migrations/20260831120000_p0cc_d_manual_movements_and_reversal.sql`, header).
- `balance_after` is computed server-side by `trig_account_movement_balance` with `SELECT FOR UPDATE`.
- **Append-only for the client.** `authenticated` holds `SELECT` only: `INSERT`, `UPDATE` and
  `DELETE` are revoked and no write policy exists
  (`supabase/migrations/20260901120000_p0cc_e_revoke_direct_ledger_insert.sql`).

A manually loaded debt is deliberately **not** a `venta`: there is no comprobante, no items, and
it recognises no revenue. Calling it `venta` would contaminate the accrual. This is stated
explicitly in the CC-D header and must not be "simplified".

### 2. `supplier_account_movements` — supplier current account

A **different book** with its own RPCs, explicitly out of scope of the customer-ledger lockdown
(CC-E header). Balance is computed by `trig_supplier_account_movement_balance` using
`pg_advisory_xact_lock` (`CLAUDE.md`, "Cuentas corrientes (proveedores)").

Do not generalise a conclusion from one book to the other.

### 3. `financial_movements` (FM) — cash / treasury

`supabase/migrations/20260628190324_remote_baseline.sql:7056`.

Key columns: `type`, `movement_type` (default `income`), `sign`, `amount` (CHECK `> 0`),
`currency`, `exchange_rate`, `amount_ars`, `date`, `source` / `source_id`,
`reference_type` / `reference_id`, `comprobante_id`, `payment_transaction_id`, `metodo_pago`,
`caja_id`, `provider`, `channel`.

`amount` is always positive; direction lives in `sign` / `movement_type`. When a movement belongs
to an open cash session, `caja_id` may be passed as NULL and the trigger assigns the currently
open caja (CC-D header).

### 4. `business_finance_entries` (BFE) — economic classification

`supabase/migrations/20260628190324_remote_baseline.sql:6385`.

Carries `date`, `type`, `category`, `subcategory`, `amount`, `amount_ars`, `payment_method`,
`reference_comprobante_id`, `source`, `sale_type`, and the canonical `economic_class`.

## `economic_class` — the canonical taxonomy

Closed CHECK, 16 values
(`supabase/migrations/20260704100000_fix_cost_double_count.sql:33-39`):

```
sale_revenue            sales_return              cogs
operating_expense       employee_salary           payment_fee
inventory_purchase      supplier_liability_payment
owner_withdrawal        owner_contribution
transfer                cash_adjustment           manual_adjustment
legacy_unclassified     revenue_collection_mirror cogs_mirror
```

Classification is produced by the deterministic function `bfe_economic_class(type, category,
source, ref_comp)` (same migration, line 49).

**The single most important note in the whole model** is the column comment at line 43:

> the `v_finance_*` views decide which classes enter the P&L. `revenue_collection_mirror` /
> `cogs_mirror` are *technical mirrors*: the real sale and COGS live in `comprobante_items` and
> are **not** summed here.

So: **revenue and COGS are not read from BFE.** Summing BFE by class to obtain revenue is a
double-count. This is exactly the defect that
`supabase/migrations/20260704100000_fix_cost_double_count.sql` exists to close.

## Documents and their collection

- `comprobantes` — the document. `total_cobrado` and `saldo_pendiente` are computed server-side
  by `trig_comprobante_payment_sync` when `comprobante_payments` rows are inserted. Never set
  `total_cobrado` manually on insert (`CLAUDE.md`, "Comprobantes / POS").
- `comprobante_items` — where real sale amounts and `costo_total` live. This is the accrual source.
- `comprobante_payments` — the collection events.
- `account_payment_reversals` — reversal state, append-only, enforced by
  `account_payment_reversals_immutable` and a UNIQUE on `original_movement_id`
  (`.../20260831120000_p0cc_d_manual_movements_and_reversal.sql:108`, postconditions at :452).

Reversal state deliberately lives in its own table: no `reversed_at` column was added to
`account_movements`, so the ledger stays genuinely append-only.

## Business semantics — distinctions that must never collapse

These are different states. A generic accounting model would merge some of them. Do not.

| Concept | What it means here | Where it lives |
|---|---|---|
| Trabajo completado | Order work finished | order status |
| Comprobante generado | Document issued | `comprobantes.status/estado` in `issued`/`emitido` |
| Dinero cobrado | Cash actually collected | `comprobante_payments`, FM |
| Pago parcial | Collected < total; **not** `paid` | `total_cobrado` < total, `saldo_pendiente` > 0 |
| Pendiente | Outstanding balance on the document | `saldo_pendiente` |
| Crédito / cuenta corriente | Sale on credit; debt rises, no cash | `account_movements` type `venta`, direction debit |
| Revenue (devengado) | Accrued sale | `v_finance_sales_ledger` from `comprobante_items` |
| Cash | Treasury movement | `financial_movements` |
| Cost / COGS | Line cost | `comprobante_items.costo_total` |
| Profit | Accrual result | `v_finance_pnl` |
| Debt (customer) | Customer owes the business | `account_movements.balance_after` |
| Debt (supplier) | Business owes the supplier | `supplier_account_movements` |
| Owner withdrawal / contribution | Capital flow, **not** expense or revenue | `economic_class` `owner_withdrawal` / `owner_contribution`, `v_owner_flows` |

Selling on credit produces revenue and debt but **no cash**. Collecting later produces cash but
**no new revenue** — that is what `revenue_collection_mirror` nets to zero. Keeping these apart is
the entire point of the model.

## The accrual ledger

`v_finance_sales_ledger` is the canonical source of accrued events
(`supabase/migrations/20260713270000_m7_6f4c_accrual_views.sql`). One row per (item, event):

- `event_type='sale'` — original date, positive amounts.
- `event_type='annulment'` — annulment date, negative amounts (mirror).

> The comprobante still emits its sale event even if it was later annulled: accounting history is
> not rewritten, it is compensated.

## The P&L formula, as implemented

From `v_finance_pnl` (same migration, line 119). This is the real definition, not a paraphrase:

- `gross_sales`, `discounts`, `net_line_sales`, `cogs` — from `v_finance_sales_ledger` where
  `is_credit_note = false`.
- `sales_returns` — from `v_finance_effective_comprobantes` where `is_credit_note = true`.
- `net_sales = net_line_sales − sales_returns`
- `gross_profit = net_line_sales − sales_returns − cogs`
- `payment_fees`, `operating_expenses`, `employee_salaries`, `unclassified_amount` — from
  `business_finance_entries` filtered by `economic_class`.
- `missing_cost_items` counts lines flagged `missing_cost`.

Note what is absent: no depreciation, no tax provision, no deferred tax, no lease accounting, no
goodwill. Their absence is a product decision, not an omission to be corrected.
