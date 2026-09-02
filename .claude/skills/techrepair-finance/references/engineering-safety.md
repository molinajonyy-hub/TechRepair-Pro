# Engineering safety for financial work

This file complements `techrepair-product-design/references/engineering-safety.md`. That one
protects the interface; this one protects the money.

## Architectural rule

The database owns financial truth. The client reads it and presents it.

All financial logic lives in triggers, RPCs, constraints and views. The client does not compute
definitive balances (`CLAUDE.md`, "Finanzas — reglas absolutas").

## Prohibited

Never do any of these, regardless of how convenient it is or which external skill suggests it:

- Insert directly into a protected financial table when a canonical RPC exists.
- Recompute a canonical balance in the frontend.
- Build a second ledger, a shadow table, or a parallel financial store.
- Create ad-hoc compensating movements without first understanding the official reversal for that
  flow. Every flow has one; find it in `financial-flows.md`.
- Change `economic_class` assignment, or the classification function, without discovery.
- Infer revenue, cost or profit from a table's name. Summing `business_finance_entries` to obtain
  revenue is a double-count — read `financial-model.md`.
- Conflate cash flow with profit.
- Treat a completed order as a paid order.
- Treat an issued comprobante as a collected one.
- Treat a partial payment as `paid`.
- Remove or weaken idempotency to simplify code.
- Bypass a period lock, or date a movement backwards to land in a closed period.
- Weaken RLS, RBAC or a capability check to fix a bug. Fail-closed stays closed.
- Write to a derived view.
- Hide a financial discrepancy in the frontend instead of resolving its cause.
- Apply an external accounting formula without verifying it matches the implemented model.
- Apply US GAAP, SOX, IFRS or any foreign regulation automatically.
- Change fiscal or ARCA behaviour on the basis of a generic finance skill.

## Protected surfaces

Do not modify without explicit approval for that specific task:

Supabase schema · migrations · RLS policies · RPC functions · database triggers · financial views ·
period-lock functions and guards · capability and permission functions · financial calculations ·
cash calculations · customer and supplier account balances · ARCA and fiscal contracts ·
comprobante payment synchronisation · stock synchronisation tied to sales · idempotency hashing ·
immutability triggers.

A visual task does not authorise a business-logic change. A bug fix in one module does not
authorise loosening a guard in another.

## If no canonical path exists

If the task genuinely needs a write that no RPC supports:

1. Say so explicitly rather than working around it.
2. Propose a new RPC that preserves atomicity, idempotency, capability gating, period guards and
   the audit trail.
3. Wait for approval.

The rollback note in `20260901120000_p0cc_e_revoke_direct_ledger_insert.sql` states the principle
in the project's own words: reopening the client's INSERT would restore the ability to lower a
debt without touching the cash box, and *"si hace falta un camino de escritura nuevo, la respuesta
es una RPC, no este GRANT."*

## Changing SQL

- The latest migration wins. Never edit an applied migration; add a new one.
- Preserve postconditions. Several migrations end in a `DO $post$` block that raises if an
  invariant broke. Follow that pattern.
- Keep RPCs `SECURITY DEFINER` owned by `postgres` with a hardened `search_path`, and keep `anon`
  without `EXECUTE`.
- Amount columns are positive with direction carried separately (`sign`, `movement_type`,
  `direction`). Do not introduce negative amounts to express direction.
- Derive period dates in `America/Argentina/Cordoba` and business dates from `ar_today()`.

## Changing TypeScript

- Route writes through the existing services: `comprobanteService`, `cuentasService`,
  `suppliersService`, `productService`, `inventoryMovementsService`.
- Keep money math out of visual components.
- Draft/cart arithmetic before submission is legitimate. Recomputing a canonical balance is not.
- Keep TypeScript strict; do not introduce `any` to silence a financial type error.
- Use the centralised `logger`, never bare `console.log` (`CLAUDE.md`).

## Never claim an unverified result

Do not state that a migration applied, a test passed or a balance reconciles unless the command
actually ran and you saw the output. In financial work an invented green result is worse than no
result.
