# Quality checklist for financial changes

Work through this before reporting. Skipping a line is fine; pretending you checked it is not.

## Discovery completed

- [ ] The affected flow is named, and its canonical RPC identified.
- [ ] Every number in the change is classified: source of truth, derived read model, or UI.
- [ ] The relevant migration was actually read — not inferred from a table or column name.
- [ ] Where definitions were repeated across migrations, the latest one was used.
- [ ] Existing tests covering this flow were located and read.

## Invariants preserved

- [ ] Writes go through the canonical RPC; no direct write to a protected table.
- [ ] Atomicity intact — the whole flow still commits or rolls back together.
- [ ] Idempotency intact — key hashed over intent, uniqueness still enforced by a constraint.
- [ ] No double counting; mirror classes still net to zero and stay out of the P&L.
- [ ] Reversals still compensate rather than delete or rewrite.
- [ ] Period guards intact; nothing is dated backwards into a closed period.
- [ ] Capability checks intact and still fail-closed.
- [ ] `business_id` scoping and RLS intact.
- [ ] Append-only tables still append-only; immutability triggers untouched.
- [ ] Audit trail preserved: `reference_type`/`reference_id`, `source`/`source_id`, `created_by`.

## Semantics preserved

- [ ] Revenue still comes from `comprobante_items` via `v_finance_sales_ledger`, not from BFE.
- [ ] Cash and profit remain distinct.
- [ ] Completed vs paid, issued vs collected, partial vs paid remain distinct.
- [ ] Owner withdrawals and contributions stay out of the P&L.
- [ ] Customer and supplier books remain separate; no conclusion crossed between them.
- [ ] No external accounting concept was introduced without explicit instruction.

## Verification actually run

- [ ] `npx tsc --noEmit` — 0 errors.
- [ ] `npm run lint:errors` — 0 errors.
- [ ] Relevant unit tests run: `tests/unit/` finance suite.
- [ ] Relevant SQL invariant tests identified in `supabase/tests/`, and run if the environment
      allows. If not run, say which and why.
- [ ] Relevant e2e specs identified: `tests/e2e/caja-*.spec.ts`,
      `tests/e2e/cuenta-corriente-cliente.spec.ts`, `tests/e2e/finance-*.spec.ts`,
      `tests/e2e/supplier-detail.spec.ts`.
- [ ] `git status` reviewed; no unrelated files touched.

## Optional cross-check

For a numeric result or dataset produced during the work, `data:validate-data` can be used to
check aggregation logic, denominators, period completeness and timezone alignment. It validates
arithmetic; it does not define what the numbers mean here. See `skill-hierarchy.md`.

## Reporting

- [ ] Files changed, with a per-file summary.
- [ ] The authority path used, stated explicitly.
- [ ] Invariants preserved, named.
- [ ] Cross-module impact: ledger, balances, caja, payments, debt, cost, P&L, audit.
- [ ] Tests run and their real results.
- [ ] Tests not run and why.
- [ ] Manual verification still required.
- [ ] `git status`.
- [ ] Risks and follow-up work.
- [ ] No commit and no push unless explicitly requested.
