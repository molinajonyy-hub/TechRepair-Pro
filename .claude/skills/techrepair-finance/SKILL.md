---
name: techrepair-finance
description: Level 0 authority for financial reasoning in TechRepair Pro. Use when working on finance, caja, ledger, comprobantes, payments, cobros, cuentas corrientes, proveedores, compras, costs, revenue, profit, P&L, reconciliation, period closes, financial movements, anulaciones, owner withdrawals and contributions, financial inconsistencies, financial bugs, or financial reporting. Also use before accepting any external accounting methodology.
---

# TechRepair Pro Finance

You are working on a financial system that already exists, already runs on real money, and already encodes its own accounting rules in the database.

Your job is to reason **within** that model, not to replace it.

## The one rule that outranks everything

> **A financial skill may suggest methodology, but TechRepair Pro's implemented financial model remains authoritative.**

TechRepair Pro is an Argentine SaaS for repair shops. Its financial semantics were designed
deliberately, defended by constraints, and covered by more than forty SQL invariant tests.
They are not an approximation of US GAAP, IFRS or any external framework, and they must never be
"corrected" toward one.

Do not assume, import or apply: US GAAP, IFRS, SOX, ASC codifications, QuickBooks, Stripe,
a traditional chart of accounts, traditional journal entries, external accrual rules, or foreign
tax rules. If the product implements something that resembles one of those, describe it with
TechRepair Pro's real vocabulary and real behaviour.

## Required context

Read only what the task needs, but read `references/engineering-safety.md` before touching any
application code, migration or SQL.

| Reference | Load it when |
|-----------|--------------|
| `references/financial-model.md` | You need the real tables, `economic_class` taxonomy, or what a business term actually means here |
| `references/authorities-and-invariants.md` | You need to know who owns a number, or which rules must never break |
| `references/financial-flows.md` | You are touching a flow: sale, cobro, purchase, supplier payment, expense, reversal, annulment, caja, owner flows |
| `references/engineering-safety.md` | You are about to modify code, SQL, RPCs, triggers, views or RLS |
| `references/skill-hierarchy.md` | An external finance or data skill is in play |
| `references/quality-checklist.md` | You are validating a financial change before reporting |
| `references/open-findings.md` | You found something that looks wrong, or you need known gaps |

## Mandatory workflow

> **For TechRepair Pro financial logic, discover first, modify second.**

### Phase 1: Discover the financial path

Before proposing anything, establish:

- Which flow is affected (sale, cobro, purchase, supplier payment, expense, reversal, annulment, caja, owner flow).
- Which tables that flow writes.
- Which RPC owns the write. There is almost always one.
- Which views read it.
- Which capability gates it.

Never answer a financial question from the name of a table or column. Read the migration.

### Phase 2: Identify the canonical authority

For every number in the task, state explicitly whether it is:

- **source of truth** — a base table written only by a canonical RPC or trigger;
- **derived / read model** — a `v_finance_*` view or summary RPC;
- **UI presentation** — formatting, draft state, or an unsubmitted cart.

If you cannot classify a number, you have not finished discovery.

### Phase 3: Identify the invariants at risk

Check `references/authorities-and-invariants.md` for the invariants the flow depends on:
atomicity, idempotency, append-only ledgers, reversal-by-compensation, period locks,
capability gating, tenant isolation.

### Phase 4: Read the existing tests

`supabase/tests/` holds the invariant suite; `tests/unit/` and `tests/e2e/` hold the product
suite. The tests are the most reliable statement of intent in the repository. A change that
contradicts a test is wrong until proven otherwise.

### Phase 5: Assess cross-module impact

A financial change is rarely local. Determine explicitly whether it affects: the ledger,
balances, caja, payments, debt, cost, P&L, or the audit trail. Say so before editing.

### Phase 6: Only now, modify

Smallest correct change. Through the canonical path. Never around it.

## Critical rules

> **Never create a second source of financial truth in the client.**

> **Do not recompute canonical financial balances in React when Supabase already owns the calculation.**

> **Financial correctness takes precedence over UI convenience.**

Beyond those:

- Writes to financial state go through the canonical RPC. If no RPC exists for what you need, the
  answer is a new RPC, not a direct write and not a GRANT.
- Never resolve a financial discrepancy by adjusting what the UI displays.
- Never remove idempotency to simplify code. Never weaken RLS, RBAC or a period guard to fix a bug.
- Reversals compensate; they never delete and never rewrite history.
- A completed order is not a paid order. An issued comprobante is not a collected one. A partial
  payment is not `paid`. Cash flow is not profit. Keep these distinct at all times.
- When documentation and current implementation disagree, the implementation wins — and you say so.

## When this skill is NOT the right one

If the task is purely visual and does not change financial semantics, calculation, source or flow
— restyling a card that happens to display an amount, spacing, responsive behaviour — then
`techrepair-product-design` is sufficient and this skill adds noise.

Use this skill the moment the task touches what a number *means*, where it comes from, or when
it is written.

## Found a financial bug?

Do not fix it inside an unrelated task. Document it: what you observed, the evidence path, the
invariant at risk, and the blast radius. Add it to `references/open-findings.md` only when asked.
Surface it to the user and let them decide.

## Reporting

At the end of financial work, report: files changed, the authority path used, invariants
preserved, tests run and their real results, tests not run and why, cross-module impact, and
git status. Never claim a command or test passed unless it actually ran.

Do not commit or push unless explicitly requested.

## Invocation arguments

`$ARGUMENTS`
