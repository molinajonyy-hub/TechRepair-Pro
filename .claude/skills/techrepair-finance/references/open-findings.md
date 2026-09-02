# Open findings

Observations from the discovery that built this skill (2026-09-02). Nothing here was fixed —
discovery only. Each item states what was seen and what remains unverified, so that a future task
can confirm before acting.

## Verify before extending: `useFinancialDashboard`

`src/hooks/useFinancialDashboard.ts` reads base tables directly — `comprobante_payments` (:60) and
`financial_movements` (:82) — rather than a canonical `v_finance_*` view. No JavaScript
aggregation of a canonical balance was found in it, and the neighbouring
`src/hooks/useDashboardStats.ts` does go through `finance_dashboard_summary` → `v_finance_pnl`.

Not a confirmed defect. It is the one place where the read path diverges from the documented
pattern, so verify it before extending it or trusting its figures for anything canonical.

## Closed historically, worth remembering

The CC-E migration documents the defect that motivated the whole P0-CC series: the `/cuentas`
screen lowered a customer's debt with a direct `INSERT` into `account_movements`, creating neither
the cash movement nor the financial entry. The debt looked right and the caja was wrong.

That path is now impossible — `INSERT` is revoked and the write policy dropped. The pattern is
worth remembering because it is exactly what a well-meaning "just update the balance" change
recreates.

A second documented case: a manual adjustment in the opposite direction fixed the balance but did
**not** reverse the `financial_movement`, leaving a phantom income in the caja. This is why
`reverse_customer_account_payment_atomic` exists and why compensating by hand is prohibited.

## Not verified in this pass

Discovery was interrupted partway and resumed, so the following were not examined and should not
be assumed either way:

- The full body of `trig_account_movement_balance` and `trig_supplier_account_movement_balance`
  (their locking is documented in `CLAUDE.md` but the function bodies were not read here).
- The sign convention of `supplier_account_movements` — whether a positive balance means the
  business owes the supplier or the reverse. **Read this before writing anything about supplier
  debt.**
- Where product cost is captured and by what method (last cost, average cost, cost at sale). The
  cost column `comprobante_items.costo_total` is canonical for the P&L, but the upstream costing
  policy was not established. `docs/auditoria-finanzas/p0-order-cogs/` and
  `v_finance_order_cogs_gaps` are the places to look.
- `docs/auditoria-finanzas/` was not read in full. Its formulas (`02-formulas.md`), currency
  handling (`04-monedas.md`) and edge cases (`03-casos-extremos.md`) were not cross-checked
  against current implementation, so **no claim is made here about whether those documents are
  current**. Treat them as unverified until compared, and remember the standing rule: current
  code and schema outrank older documentation.
- The dollar-quote contract (`.../20260902120000_p0_dollar_quote_source_canonical.sql`,
  `docs/p0-dollar-quote-fix.md`) was not read. Multi-currency behaviour beyond the
  `amount`/`exchange_rate`/`amount_ars` column shape is undocumented here.
- The `m8` work under `docs/auditoria-finanzas/m8/` was not reviewed.
