# SEC-08E — Auxiliary financial reads

## Baseline and isolation

- Base: `3f9ac158478069c92f6614798f5d218a6820e6a1`, verified after `git fetch origin --prune --tags`; stable tag `stable-sec-08d-finance-insights-rls-v1`.
- Branch: `codex/sec08e-auxiliary-financial-reads`.
- Implementation worktree: `C:/Users/molin/CascadeProjects/techrepair-sec08e`.
- Original worktree HEAD: `03e6785449dd233733e2eb1e1d3cada92881b14d`, branch `claude/sec08c-supplier-finance-visibility`. Its existing 16 modified screenshots and 9 untracked entries were preserved. HEAD, porcelain status and SHA-256 of modified/untracked files match the initial snapshot. Existing worktrees were inventoried before creating this one.
- Tests used a schema-only, disposable local Docker database (`sec08e_certification`), synthetic actors/data and a dedicated local PostgREST container. No application rows were copied. Successful runs removed the test database and container. Dependencies were copied to the isolated worktree; no lockfile changes.

## Root cause and canonical authority

| Surface | Original bypass | Preserved authority |
| --- | --- | --- |
| `comprobante_annulments` | Tenant membership SELECT plus whole-table grants exposed four reverted monetary columns. `annul_comprobante_atomic` also returned them on idempotent replay. | Cash, CC and commissions follow per-document payment access: `comprobantes`, plus `orders_view_financials` for linked orders. Per-document COGS follows `can_view_inventory_cost`, plus linked-order financial authority; period-level `finance` alone does not grant raw document costs. |
| `customer_account_payment_allocations` | `cap_alloc_select` accepted active membership without the financial gate applied by `get_payment_allocations`. | Exact existing `user_can_view_order_amounts(business_id, auth.uid())`: active canonical/legacy profile using `COALESCE(user_id,id)` with owner/admin/manager/cashier/sales role, or registered business owner. This helper is role-based and does **not** interpret profile capability overrides. SEC-08E preserves that contract. |
| `parts_used` | Tenant + `is_staff()` SELECT and full-column grants exposed `unit_price`/generated `subtotal`; frontend used wildcard reads. | Same operational tenant/staff boundary, with `current_user_can_in_business(..., 'orders_view_financials')` for monetary fields. |

## Post-fix path audit

One migration: `20260922120000_sec08e_auxiliary_financial_reads.sql`, the timestamp following SEC-08D in the repository ledger. It contains DDL/grants only and was successfully applied twice.

| Table → RLS/grant | View/RPC | Frontend |
| --- | --- | --- |
| Annulments retain tenant-filtered operational metadata; SELECT on the four amounts is revoked from PUBLIC/anon/authenticated. | `v_comprobante_annulment_amounts` applies tenant, linked-order and per-field authorities. The original annulment implementation moves to private with no browser execute; a wrapper filters its response. Its original implementation body is preserved byte-for-byte. | Existing `comprobanteService` consumes success/error/replay metadata, not the reverted amounts. Ledger views can still read annulment status/date/IDs. |
| Allocations have exactly one SELECT policy, using self-only `can_view_payment_allocations(business_id)`. | The wrapper calls the existing internal helper for `auth.uid()` only. The two-argument helper remains uncallable by authenticated users; `get_payment_allocations` is unchanged. | `AllocationHistory` already uses `get_payment_allocations`; no consumer changes required. |
| Parts retain original operational RLS and explicit operational SELECT grants; price/subtotal grants are revoked. | `v_parts_used_amounts` restores the tenant/staff/financial checks. | Order detail embeds explicit operational columns; list/create use the same explicit selection and hydrate amounts from the authorized view. Restricted monetary fields are absent, never fabricated as zero. Totals use the authorized projection. Create omits the generated subtotal from INSERT. |

The two read-only views deliberately run as postgres-owned DEFINER views with `security_barrier=true`: invoker execution cannot read revoked base columns. All references are schema-qualified; the views restore authorization explicitly. Public function wrappers use `search_path=pg_catalog,pg_temp`, postgres ownership, no anon/PUBLIC execute and minimal authenticated/service grants. The private implementation has no browser/service execute grant. No authorization helper, capability definition, fiscal calculation or existing SEC-08A/B/C/D migration was rewritten.

Catalog and HTTP checks cover effective/inherited column privileges, concurrent SELECT/ALL allocation policies, private helper exposure, writable-view default grants, direct reads, sensitive filters/order, views, RPC replay and PostgREST embeds. Restricted base-column requests return permission errors; restricted projections/allocations return no financial rows. Existing finance sales/collections/P&L and order payment state views remain queryable.

## Dynamic actor matrix

Results for records in tenant A; “yes” for protected amounts means access through the authorized view/RPC, except allocations where direct table reads are also allowed.

| Actor | Annulment amounts | Allocation amounts | Part amounts | Operational parts |
| --- | --- | --- | --- | --- |
| Limited tech | No | No | No | Yes |
| Limited viewer | No | No | No | Yes |
| Owner A | All four | Yes | Yes | Yes |
| Cashier / sales | Cash, CC, commissions; COGS hidden | Yes | Yes | Yes |
| Manager, canonical profile without `user_id` | All four | Yes | Yes | Yes |
| Owner B, cross-tenant | No | No | No | No |
| Inactive admin A | No | No | No | No |
| Anonymous | No | No | No | No |

## Validation

- `node scripts/security/sec08e-local.mjs`: **220 assertions passed**, reproducing all three original raw SQL leaks, applying SEC-08E twice, checking unchanged canonical RPC definitions and unchanged annulment implementation, then exercising real PostgREST/JWT actors. Default source is local `supabase_db_techrepair-vite`; `SEC08E_SOURCE_CONTAINER` accepts only a local Supabase container name. No database URL argument is accepted. The fixture harness disables triggers/FKs only while loading synthetic witnesses in its owned disposable database; actual read/RPC assertions run normally.
- SQL regressions passed: SEC-08A orders, phase B pivots, phase C payments, SEC-08B inventory costs, SEC-08C supplier finance, SEC-08D finance insights, new SEC-08E catalog checks, `p0a1u2_allocation_ui_contract_test.sql`, and `etapa0_annulment_ledger_test.sql`.
- A tech with an explicit `orders_view_financials` grant can read part amounts but cannot read allocations, preserving the allocation RPC's existing role-based contract.
- Component tests: **50 passed** across `sec08ePartsUsedAccess`, `allocationModal`, `allocationHistory`, and `orderFinancialSummary`. Includes operational order detail, authorized zero values, stale amount removal, failed-projection errors and safe insert-returning selection.
- TypeScript (`tsc --noEmit`), focused ESLint of the three changed application files and full `src` ESLint with zero errors, Vite build with synthetic local configuration, and `git diff --check`: passed. Build retains an existing large-chunk warning; component runs emit existing React test/router warnings.
- Five focused SEC-08A/B/C static guards passed. SECDEF exposure guard passes for the new migration.
- `npm run test:sec08e` is the focused repeatable entry point (Docker security tests plus new component tests).

### Explicit limitations

- Historical `etapa7_rpc_integration_comprobante_annulment_test.sql` fails with `FORBIDDEN` at its second-tenant checkout fixture, before reaching annulment. The same failure was executed and observed on baseline and candidate. It is not reported as a passing M7 suite; its assertions were not weakened. The existing Etapa 0 annulment suite and real authorized/restricted RPC replay checks pass.
- Global SECDEF exposure guard reports the same two existing findings in `20260912120000_sec08a_phase_b_financial_pivots.sql` (`current_user_can`, `get_order_financial_amounts`). SEC-08E adds none.
- The blanket view-invoker guard flags four certified SEC-08B views on baseline and those same four plus the two deliberate SEC-08E projections on candidate. It does not model explicitly gated column-protection views. This is an acknowledged guard incompatibility, not a green global-guard result; effective grants, tenant isolation and capabilities of both new views are covered by catalog and dynamic tests. No broad guard exception or SEC-08B change was introduced.
- No full E2E, browser visual verification or production validation. There are no UI, interaction-layout, theme or accessibility changes. **The original migration-first rollout advice is superseded:** old wildcard clients fail after column revocation. See [pre-merge rollout review](rollout-safety.md) for measured compatibility, the frontend-first correction and the outstanding client-retirement gate before lockdown.

## Integrity and scope

No real-data DML, production migration/deployment, fiscal changes, new capabilities, plan/features changes, productive profile edits or changes to SEC-08A/B/C/D contracts. SEC-08F and the pending commercial-document/subscription product decisions remain outside this change. The original dirty worktree is intact. Only the isolated SEC-08E branch is intended for one commit and a review PR to main, without merge or tag.

Changed files: this report; `package.json`; `src/lib/supabase.ts`; `src/services/api.ts`; `src/services/partsUsedAccess.ts`; the single SEC-08E migration; `scripts/security/sec08e-local.mjs`; `tests/fixtures/sec08e.sql`; `tests/components/sec08ePartsUsedAccess.test.ts`; `tests/sql/sec08e_auxiliary_financial_reads.test.sql`.
