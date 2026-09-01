# Lote 3 — Phase A implementation-candidate report

## A. Baseline

- Main audited: `origin/main@cb9299652d11cc5b3fd3d595407c1454eb5486e0`.
- Isolated branch: `codex/action-write-authority-lote3`.
- Worktree: `techrepair-vite-lote3-authority`; the dirty primary checkout was not modified.
- Commit and PR: the immutable identifiers are recorded in the PR/final handoff because a commit cannot contain its own hash.
- Production baseline evidence: `docs/security-lote3/production-before.json`; catalog metadata only, no commercial rows or secrets.

## B. Role/capability matrix

No capability or role was created. `current_user_can(text)` remains canonical and a partial boolean profile override wins over the role default.

| Capability | owner | admin | manager | tech | sales | cashier | viewer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `finance` | yes | yes | no | no | no | yes | no |
| `comprobantes` | yes | yes | yes | no | yes | yes | no |
| `inventory` | yes | yes | yes | no | yes | no | no |
| `orders` | yes | yes | yes | yes | yes | yes | yes |
| `orders_create` | yes | yes | yes | yes | yes | yes | no |
| `orders_change_status` | yes | yes | yes | yes | yes | yes | no |
| `orders_view_financials` | yes | yes | yes | no | yes | yes | no |
| `customers` | yes | yes | yes | no | yes | yes | no |
| `settings_sensitive` | yes | yes | no | no | no | no | no |
| `wholesale` | yes | yes | yes | no | yes | no | no |

Overrides tested: default `true` + explicit `false` denies; default `false` + explicit `true` allows. Owner special behavior remains unchanged. `personal_finance` remains out of scope.

## C. is_staff inventory

- Definition unchanged: membership roles are `owner`, `admin`, `manager`, `tech`, `sales`, `cashier`, and `viewer`; it is not redefined as an action-authority helper.
- Production before: 75 dependent policies — 25 SELECT, 21 INSERT, 18 UPDATE, 10 ALL, 1 DELETE; 50 had write semantics.
- Candidate after: 11 policies, all generic operational SELECT; zero write policies and zero sensitive-read policies depend on `is_staff()`.
- Retained reads: device/inspection/document/order workflow metadata, warranties, and WhatsApp templates. Sensitive finance, cost, supplier, payment, commission, WhatsApp-log, task and wholesale reads use capabilities (plus feature where applicable).

## D. 25 RPC matrix

All 25 were already tenant-bound by Lote 2. The candidate moves the preserved implementation to `private`, denies direct client execution, and exposes a signature/default/return-compatible public wrapper whose first action is the canonical authority gate.

| Function | Current problem | Capability | Active member | Candidate fix | Regression |
| --- | --- | --- | --- | --- | --- |
| `close_cash_session_atomic` | membership only | `finance` | required | wrapper before effects | pass |
| `create_comprobante_checkout_atomic` | membership only | `comprobantes` | required | wrapper before idempotency/effects | pass |
| `create_credit_note_finance_reversal` | membership/service path | `comprobantes` | required for user; trusted service retained | wrapper | pass |
| `create_credit_note_from_comprobante` | membership only | `comprobantes` | required | wrapper | pass |
| `create_expense_with_finance` | membership only | `finance` | required | wrapper | pass |
| `create_manual_cash_movement_atomic` | membership only | `finance` | required | wrapper | pass |
| `create_order_payment_atomic` | membership only | `comprobantes` | required | wrapper | pass |
| `create_quick_inventory_purchase_atomic` | membership only | `inventory` | required | wrapper | pass |
| `create_supplier_purchase_atomic` | membership only | `inventory` | required | wrapper | pass |
| `customer_purchase_history` | exposed amounts with customer-only UI | `customers` + `orders_view_financials` | required | combined wrapper + UI guard | pass |
| `delete_comprobante_with_finance` | membership only | `comprobantes` | required | wrapper | pass |
| `finance_dashboard_summary` | sensitive membership read | `finance` | required | wrapper | pass |
| `finance_health_check` | sensitive membership read | `finance` | required | wrapper | pass |
| `finance_health_check_v2` | sensitive membership read | `finance` | required | wrapper | pass |
| `finance_pending_historicals` | owner/admin hardcode | `finance` | required | capability wrapper; redundant role gate removed | pass |
| `generate_finance_insights` | finance read/write engine, UI-only plan gate | `finance` + `advancedFinance` plan | required | plan then capability wrapper | pass |
| `get_checkout_request_status` | membership only | `comprobantes` | required | wrapper | pass |
| `open_cash_session_atomic` | membership only | `finance` | required | wrapper | pass |
| `pay_supplier_free_atomic` | membership only | `inventory` | required | wrapper | pass |
| `pay_supplier_purchase_atomic` | membership only | `inventory` | required | wrapper | pass |
| `replace_comprobante_payment` | membership only | `comprobantes` | required | wrapper | pass |
| `reverse_manual_cash_movement` | membership only | `finance` | required | wrapper | pass |
| `reverse_operating_expense_atomic` | membership only | `finance` | required | wrapper | pass |
| `reverse_order_payment_atomic` | membership only | `comprobantes` | required | wrapper | pass |
| `update_inventory_dollar_prices` | membership only | `settings_sensitive` | required | wrapper | pass |

Authorization order is JWT → canonical active profile → tenant → applicable plan → capability/capabilities → preserved implementation/resource validation/locks/effects. Existing JSON/exception behavior after the gate is preserved; authority rejection is SQLSTATE `42501` / `FORBIDDEN`.

## E. payment_transactions

- Before: authenticated had SELECT/INSERT/UPDATE/DELETE, `pt_write` allowed same-tenant ALL, and `trig_pt_approved` could turn an approved browser row into `financial_movements`, `business_finance_entries`, and a paid comprobante.
- Call graph audit found no legitimate Beta browser writer after MP POS Connect was disabled. Historical reads remain legitimate.
- Candidate: drops `pt_write`; revokes authenticated INSERT/UPDATE/DELETE; explicitly retains authenticated SELECT and trusted service-role DML; table/history, columns, FKs, indexes and triggers are untouched.
- Trigger safety is achieved upstream: `trig_pt_approved` remains, but an authenticated browser cannot create or approve a transaction.

## F. Direct-write alternative paths

- All 25 public RPCs are wrappers; the implementations in `private` are not executable by authenticated or service role.
- The legacy permissive `inventory.tenant_isolation` ALL policy was found by a negative test and removed because it OR-bypassed capability policies. The separate wholesale portal read remains.
- Browser direct writes on touched operational tables are capability-gated. Finance guard retains its two pre-existing allowlisted/documented browser paths (`expenses` E3 and `comprobante_payments` E1), now under capability RLS.
- `whatsapp_logs` direct browser inserts are legitimate manual/copy handoff logging and now require `customers OR orders_change_status`.

## G. RLS/grants changes

- 50 `is_staff` write policies were replaced/split into existing capability policies; task and wholesale feature checks remain additive.
- Sensitive SELECT moved to `finance`, `inventory`, `orders_view_financials`, `comprobantes`, `customers OR orders_change_status`, or `wholesale` as applicable.
- Payment commission read (`comprobantes`) is separated from configuration writes (`settings_sensitive`).
- `tasks` and `warranties` anon/PUBLIC DML grants are revoked. Migration postconditions abort if an `is_staff` write, inventory bypass, or those anon grants remain.
- RPC and payment table grants are explicit for PUBLIC, anon, authenticated, and service role.

## H. Negative controls

- Original payment flaw restored locally: viewer INSERT + approved UPDATE succeeds and creates both ledger layers and marks the comprobante paid; savepoint rollback restores the candidate.
- Old `is_staff()` contracts were restored locally for representative comprobantes, finance, inventory, settings, payment commissions, order create/update, tasks, WhatsApp and sensitive-read groups; viewer regained the forbidden access in every control.
- Candidate repetitions deny or return zero visible rows and preserve fingerprints.
- The static guard self-test mutates RPC mapping, plan entitlement, payment revoke/reopen, inventory bypass, UI gate and negative-control evidence and detects every mutation.

## I. Role matrix results

For each of 25 RPCs the SQL suite tests owner, admin, manager, tech, sales, cashier, viewer and `tech` with explicit true override against measured `current_user_can` results. It also tests anonymous, no profile, inactive, foreign tenant, missing capability and admin explicit false. Cashier keeps Caja/POS through the existing `finance`/`comprobantes` defaults; tech/sales do not gain finance; viewer performs no sensitive Lote 3 action. All cases passed.

## J. Sensitive reads

The five finance read RPCs deny actors without `finance`. `generate_finance_insights` additionally denies an owner of a `basico` business without `advancedFinance`. Customer purchase history requires both customer and order-financial capabilities, and the Customer Detail UI neither calls nor displays that history/totals without the financial half. Direct sensitive reads for expenses, inventory/suppliers, order payments, commissions, WhatsApp logs and wholesale were exercised with old-policy and candidate controls.

## K. Mutator fingerprints

Rejected probes compare before/after hashes across cajas, financial movements, both ledger layers, finance audit/insights, comprobantes/payments, orders/payments, expenses, inventory/movements, supplier purchases/items/movements, accounts/movements and payment transactions. Every candidate reject was zero-effect.

## L. PostgREST

Real local Kong/PostgREST used valid locally signed authenticated JWTs and a positive control before negatives. Sixteen requests covered finance positive, true/false overrides, anonymous/viewer/inactive/foreign, combined customer-financial authority, payment SELECT retention and DML denial, finance RLS writes, the inventory parallel-policy regression, and authorized direct-write controls. Pass.

## M. Regression tests

- Fresh local migration rebuild: pass.
- Lote 3 SQL authority/negative suite: pass; 25 RPCs and all role/tenant/override/plan groups.
- Lote 2 tenant-authority suite: pass, 441 assertions; internal allocation/order-amount helpers remain non-executable directly and function through legitimate parents.
- Components: 11 files / 187 tests passed across Caja, MP POS containment, customer/CC, orders, finance and POS customer search.
- `typecheck`, `lint:errors`, production build, finance-write guard, SECURITY DEFINER guard, exposure guard, fragile-function-definition guard and diff check: pass (build has existing chunk-size warnings).
- Focused E2E candidate: 14 passed, 17 conditional skips, 4 legacy failures. Baseline comparison reproduced the inventory selector-parser failure, inventory-history console assertion and obsolete New Order testid. The Caja→comprobante case reached an obsolete `inventory-new-button` selector on candidate; baseline conditionally skipped before that step, while the baseline UI snapshot/source also lacks that testid. No application/test fixture was altered to manufacture green.
- Two unchanged standalone SQL fixtures remain red outside this candidate: MP POS fixture omits its required business row; `prebeta_order_amounts_identity` attempts direct execution of the helper intentionally closed by Lote 2. The authoritative Lote 1 component/guards and Lote 2 441-assertion suite pass.

## N. CI/guards

CI runs the small Lote 3 static guard plus its mutation self-test. The heavy Docker/JWT suites remain explicit local commands. The guard prevents loss of any of the 25 mappings, the advanced-finance entitlement, payment DML containment, inventory bypass removal, Customer Detail gate and negative-control evidence.

## O. Authority ambiguities

1. The product has no destructive comprobante/refund capability. The minimal Beta decision keeps `comprobantes`; finer delete/refund authority is product debt.
2. Supplier purchasing and supplier payment both use `inventory`; current routes/defaults do not distinguish financial supplier settlement. A new capability was not invented.
3. Order payment/reversal aligns with the existing POS tender capability `comprobantes`, not generic `orders` or broad `finance`.
4. Inventory/supplier operational tables contain cost/debt fields while RLS is row-level. Sales currently has `inventory` but not `inventory_view_costs`; server-side column sanitization would require an API/view redesign and remains explicit post-Beta debt.

None of these ambiguities leaves membership-only write authority in the candidate.

## P. Deferred debt

- Billing/mp-subscription: known separate lot; untouched.
- Mi Guita/personal finance: out of Beta and untouched.
- Plan/pricing redesign: none; existing `tasks`, `mayorista`, and `advancedFinance` entitlements are only preserved/enforced.
- P2: introduce product-approved destructive comprobante/refund and supplier-payment capability granularity; design cost-sanitized inventory/supplier read APIs; repair the four legacy E2E harness assertions and two stale standalone SQL fixtures.
- P3: theoretical TRUNCATE hygiene and broader legacy SECURITY DEFINER debt remain outside this lot.

## Q. Production preflight

The before snapshot is catalog-only and records 25 definitions/ACLs/search paths, the exact `is_staff` definition and 75 policies, plus payment columns/grants/policies/triggers/indexes/FKs. Immediately before PR, the preflight re-read the same metadata in a read-only transaction twice: both comparisons passed. Function behavior is compared with a comment/whitespace-normalized semantic hash (raw hashes remain in evidence) because the Management API can corrupt an ornamental Unicode comment byte without changing SQL; signatures, owners, flags, ACLs and search paths remain exact comparisons. No production DML, migration, grant, deploy or DB push is authorized or performed.

## R. Recommendation

Phase A is an implementation candidate only. Open the PR, do not merge/deploy/push DB, and require independent adversarial review before any rollout.
