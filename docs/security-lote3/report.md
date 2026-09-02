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
- Mobile2A SQL coexistence suite: pass after aligning its legacy bridge fixture with Lote 3 authority. It now proves same-tenant `viewer` direct secret writes have zero effects, then exercises set/repeat/clear and Vault no-recursion with an authorized owner; the cross-tenant probe also uses that authorized actor so tenant isolation is tested independently.
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

---

# Phase B corrective addendum (authoritative over Phase A where different)

## A. Baseline integrity

Work continued only in the isolated Lote 3 worktree. Phase B started from
`da114ee89123cec8eec4630262acbcdbba24d869`; audited main remained
`cb9299652d11cc5b3fd3d595407c1454eb5486e0`. The prior commits were not amended.

## B. Independent-review blockers addressed

1. Supplier DELETE: the Phase A ALL policies and table grant allowed a browser
   to bypass stock reversal, debt cleanup and the deletion tombstone. A
   savepoint control reproduces that corrupt result. Phase B removes both direct
   DELETE grants/policies; the same role matrix is denied with zero effects, and
   `delete_supplier_purchase_safe` still reverses stock and records the tombstone.
2. Comprobante UPDATE: a table-level grant let sales/cashier forge paid totals,
   CAE and fiscal numbering without payment or ledger rows. A rollback control
   reproduces it. Authenticated now has only column UPDATE on `observaciones`
   and `updated_at`; remito issuance uses `issue_remito_atomic`.
3. Payment INSERT: membership-only `cp_insert` let viewer manufacture a payment,
   paid receipt and both ledger effects. A rollback control reproduces it.
   Phase B drops the policy and revokes browser INSERT/UPDATE/DELETE; canonical
   replacement creates reconciled payment and ledger effects.

## C. Supplier safe-delete contract

`supplier_purchases` and `supplier_purchase_items` expose no authenticated
DELETE grant and no DELETE/ALL policy. Product deletion already called
`delete_supplier_purchase_safe`; the UI is preserved. A valid manager safe
delete changes stock 10 → 8, removes purchase/items/debt and writes the immutable
deletion record.

## D. Comprobantes protected-column contract

The real table has 65 columns. Authenticated may directly update only
`observaciones` and `updated_at`. The other 63 are protected:

`id`, `order_id`, `customer_id`, `tipo`, `numero`, `punto_venta`, `fecha`,
`subtotal`, `impuestos`, `total`, `estado`, `cae`, `cae_vencimiento`,
`afip_response`, `condicion_fiscal`, `created_at`, `business_id`, `created_by`,
`estado_fiscal`, `tipo_comprobante_fiscal`, `numero_comprobante`,
`resultado_fiscal`, `observaciones_fiscales`, `error_codigo`, `error_mensaje`,
`request_data`, `response_data`, `fecha_emision_fiscal`, `currency`, `total_ars`,
`total_usd`, `exchange_rate`, `type`, `number`, `date`, `tax`, `status`,
`estado_comercial`, `es_fiscal`, `emitir_en_arca`, `numero_fiscal`,
`descuento_total`, `recargo_total`, `total_bruto`, `total_cobrado`,
`saldo_pendiente`, `total_comisiones`, `total_neto`, `payment_status`,
`payment_provider`, `payment_channel`, `payment_integration`,
`external_reference`, `provider_order_id`, `provider_payment_id`, `gross_amount`,
`fee_amount`, `net_amount`, `amount_paid`, `payment_approved_at`, `local_id`,
`comprobante_original_id`, `numero_secuencial`.

This fail-closed boundary covers identity/tenant links, economic totals,
reconciliation, lifecycle/annulment, fiscal authorization/numbering and provider
state. The descriptive note remains usable; canonical transitions stay in
SECURITY DEFINER functions/triggers.

## E. comprobante_payments canonical-write contract

Authenticated retains capability-gated SELECT only. INSERT/UPDATE/DELETE and
`cp_insert` are absent. The only historical browser writer,
`comprobanteService.registrarPago`, had no callers and was removed; static guard
exception E1 was retired. Checkout and `replace_comprobante_payment` are the
canonical writers.

## F. finance_pending_historicals

The wrapper first requires active same-tenant `finance`, then requires the
canonical profile role to be exactly owner/admin. Manager, tech, sales, cashier
and viewer are denied even if an override could otherwise grant finance.

## G. payment_transactions read contract

No Beta browser reader exists. Authenticated has no SELECT or DML and no policy;
service-role history/storage access, rows, FKs, indexes and triggers are kept.

## H. Canonical identity gate

`private.require_action_authority` now obtains business and active state from the
existing `get_my_profile()` canonical identity helper. It no longer duplicates
nullable profile ordering. An explicit inactive profile denies, and a duplicate legacy
fixture resolves only to the canonical newest linked profile without widening
the stale tenant.

## I. Service-role gate

Measured locally inside SECURITY DEFINER: `current_user`/`session_user` are
`postgres`; an authenticated DB role with forged JWT `role=service_role` still
has effective setting `authenticated`; a real service request has setting
`service_role`. Therefore bypass uses `current_setting('role', true)`, not
`auth.role()` and not `current_user`. Forged claim is denied; real service access
passes in SQL and PostgREST controls.

## J. RLS/grants after-state

| Table | anon/PUBLIC | authenticated | service role | Policies / parallel paths |
| --- | --- | --- | --- | --- |
| `supplier_purchases` | SELECT grant; RLS yields no tenant for anon | SELECT/INSERT/UPDATE; no DELETE | no direct table grant | three inventory-capability policies; no DELETE/ALL |
| `supplier_purchase_items` | SELECT grant; RLS yields no tenant for anon | SELECT/INSERT/UPDATE; no DELETE | no direct table grant | three inventory-capability policies; no DELETE/ALL |
| `comprobantes` | no effective table privilege | SELECT/INSERT/DELETE, UPDATE only `observaciones,updated_at`; existing manager-only DELETE predicate unchanged | no direct table grant | capability INSERT/UPDATE plus existing SELECT/delete predicates; column grant blocks protected fields before RLS can permit them |
| `comprobante_payments` | none | capability SELECT only; no INSERT/UPDATE/DELETE | no direct table grant | one SELECT policy, no write policy |
| `payment_transactions` | none | none | SELECT/INSERT/UPDATE baseline grants | no policies; service role bypasses RLS by platform contract |

The catalog sweep found no permissive policy that OR-reopens any of the four
closed operations.

## K. Tests

- Phase B SQL authority suite: 1,054 assertions passed. It includes the three
  rollback-only old-exploit controls, all-role candidate negatives, zero-effect
  fingerprints, canonical positive paths, owner/admin diagnostics,
  browser/service transaction reads, forged-service claims and duplicate-profile
  resolution.
- Real signed-JWT Kong/PostgREST matrix: 65 requests passed across every direct
  surface and the affected valid supplier, remito, payment and service paths.
- Lote 2: 441 assertions plus migration apply/rollback/idempotent-reapply passed.
  Mobile 2A SQL, its guard, finance-write guard, SECURITY DEFINER guards and the
  fragile-function-definition guard also passed with their mutation self-tests.
- Unit tests: 1,100/1,100. Focused Vitest: 19/19 across the credit-note association
  regression and Mobile 2A intake service/model. `typecheck`, `lint:errors` and
  production build passed; the build retains only the pre-existing chunk-size
  warnings.
- Mobile 2A local Playwright: 3/3 passed. The requested Caja/comprobante legacy
  spec stopped before reaching the Lote 3 path because it still requests
  `inventory-new-button`; the product and `tests/e2e/README.md` identify
  `inventory-new-product-button` as canonical and explicitly record the former
  selector as baseline legacy debt. The two supplier smoke checks passed and the
  detail block was conditionally skipped after the preceding failure. No
  out-of-scope product or fixture change was made to manufacture green.

The static Lote 3 guard passes and its self-test detects 13 independent authority
mutations. A clean local rebuild applies the candidate after temporarily
neutralizing seven pre-existing migration assertions whose ACL expectations no
longer match the current earlier migration chain; those temporary edits are not
part of the candidate.

The production preflight re-read catalog metadata only and passed against
`origin/main@cb9299652d11cc5b3fd3d595407c1454eb5486e0`: 25 RPCs, 75
`is_staff` policies and `payment_transactions` metadata remained unchanged.

Direct SQL execution as `anon` of any function whose EXECUTE ACL is revoked
causes a PostgreSQL SIGSEGV in this local Supabase image. The same crash was
reproduced on the exact Phase A baseline and on a trivial revoked function, so it
is runtime/baseline-equivalent rather than candidate behavior. SQL verifies the
anonymous ACL with `has_function_privilege` and zero-effect fingerprints; real
anonymous HTTP/PostgREST requests verify the actual boundary without a crash.

## L–N. Diff, commits and PR

Exact files, new commit hashes and the final PR head are recorded after commit;
this tracked report intentionally does not invent a commit's self-hash.

## O. Production

NO DEPLOY. NO DB PUSH. NO PRODUCTION WRITE. The corrective migration was applied
only to a disposable local Supabase rebuild. Do not merge this PR before a
second independent adversarial review.

## P. Separate remaining pre-Beta debt

SEC-08 remains a pre-Beta blocker and is not downgraded: inventory cost
visibility, supplier financial visibility, order financial visibility, and
`device_password` visibility require their dedicated lot. Billing, Mi Guita,
role/capability redesign and general SEC-08 work were not mixed into Phase B.

## Q. Recommendation

The Phase B candidate has completed its local authority gates and is suitable
for a second independent adversarial review. Do not merge or deploy from this
document alone; remote CI status and immutable commit/PR identifiers belong in
the final handoff.

# Phase C corrective addendum (authoritative over Phase B where different)

The second independent adversarial review confirmed the three original Lote 3
P1s CLOSED and reported two further confirmed P1s of the same family, both
pre-existing rather than introduced by Phase B. Phase C closes exactly those two
and nothing else.

## A. Scope

| Finding | Exploit confirmed by the review | Phase C contract |
|---|---|---|
| P1-N1 | `sales` POSTs `/comprobantes` supplying `cae`, `numero_fiscal`, `estado_fiscal='emitido'`, `es_fiscal=true`, `total_cobrado`, `estado_comercial='pagado'`; row persists (HTTP 201) | no authenticated INSERT grant, no INSERT policy |
| P1-N2 | `owner`/`admin`/`manager` DELETE `/comprobantes`; row destroyed, `delete_comprobante_with_finance` bypassed | no authenticated DELETE grant, no DELETE policy |

Phase B's UPDATE allowlist closed the forgery-by-mutation vector. Creation
reached the same forged outcome, so the column allowlist alone was not the whole
boundary. Deletion was the comprobante-side twin of the supplier direct DELETE
that Phase B had already closed.

## B. Direct INSERT caller inventory

Every writer of `public.comprobantes` reachable from the browser, classified:

| Caller | Flow | Disposition |
|---|---|---|
| `comprobanteService.crear` → `create_comprobante_checkout_atomic` | POS / checkout | canonical RPC, unchanged |
| `comprobanteService.crearNotaCredito` → `create_credit_note_from_comprobante` | credit note | canonical RPC, unchanged |
| `comprobanteService` → `issue_remito_atomic` | remito issuance | canonical RPC (Phase B), unchanged |
| `comprobanteService` → `annul_comprobante_atomic` | annulment | canonical RPC, unchanged |
| `comprobanteService` → `delete_comprobante_with_finance` | deletion | canonical RPC, unchanged |
| ARCA fiscal issuance (`afip-cae` edge function) | fiscal | `service_role`, unaffected by browser grants |
| `facturacionService.crearComprobante` | legacy non-fiscal draft | **direct INSERT, zero callers → removed** |
| `facturacionService.crearComprobanteIndependiente` | legacy non-fiscal draft | **direct INSERT, zero callers → removed** |

Both removed builders already refused fiscal `tipo` values and only produced
non-fiscal `borrador` rows, so no Beta flow depended on them; they were exposed
through `useComprobantes` but destructured by no component. `recalcularTotales`
was their only remaining consumer and went with them. Nothing was migrated to a
new wrapper because no legitimate browser INSERT remained: creation was already
RPC-only in the product.

## C. Fiscal-forgery old-exploit proof

`tests/sql/lote3_action_write_authority.test.sql` restores the baseline contract
under `SAVEPOINT before_old_comprobante_insert` (grant + `comprobantes_insert`
policy), proves `sales` persists a row carrying `cae='75123456789012'`,
`numero_fiscal='00001-00099999'`, `estado_fiscal='emitido'`, `es_fiscal`,
`total_cobrado=999999`, `estado_comercial='pagado'`, `payment_status='paid'`,
proves that forged document carries no `comprobante_payments`,
`financial_movements` or `business_finance_entries`, then rolls back.

## D. New comprobante-create contract

`authenticated` holds no table-level and no per-column INSERT privilege on
`public.comprobantes`, and no INSERT policy exists. The full actor matrix
(`owner, admin, manager, tech, sales, cashier, viewer, inactive, ownerB`) plus
`anon` is denied with fingerprinted zero effects, and no forged row exists after
the matrix runs.

## E. Direct DELETE old-exploit proof

Under `SAVEPOINT before_old_comprobante_delete` the suite first proves the
canonical path *refuses* the target comprobante (`success:false`, row intact),
then proves the old grant plus `can_manage()` policy let `manager` destroy that
same row outright. That is the precise semantic loss: direct DELETE destroyed
what the canonical reversal exists to protect. Rolled back afterwards.

## F. New canonical-delete contract

`authenticated` holds no DELETE privilege and no DELETE policy on
`public.comprobantes`. Full actor matrix plus `anon` denied with zero effects,
and the comprobante survives the matrix. `delete_comprobante_with_finance`
remains the only route: it still deletes an inert draft, still refuses
non-drafts and fiscally-issued documents, still denies an actor without the
`comprobantes` capability, and leaves `financial_movements` /
`business_finance_entries` counts unchanged.

## G. PostgREST results

`npm run test:postgrest:lote3-authority` — **88 requests, all pass** (65 before
Phase C), with real locally signed JWTs. Adds, for every actor and for `anon`:
forged comprobante POST denied, direct comprobante DELETE denied, plus the
canonical positives (`delete_comprobante_with_finance` removes an inert draft,
refuses a guarded one, and denies `viewer`).

## H. Canonical positive paths

Checkout, credit note, remito issuance, payment replacement, supplier safe
delete and canonical comprobante delete all still succeed and stay reconciled.
`create_comprobante_checkout_atomic`, `create_credit_note_from_comprobante`,
`delete_comprobante_with_finance`, `issue_remito_atomic` and
`annul_comprobante_atomic` are asserted, in the migration itself and in the SQL
suite, to remain `SECURITY DEFINER`, owned by `postgres`, and executable by
`authenticated`.

## I. Regression

| Suite | Result |
|---|---|
| Lote 3 SQL authority | 1105 assertions PASS (1054 before) |
| Lote 3 real PostgREST | 88/88 PASS |
| Lote 2 SQL | 441/441 PASS |
| Lote 3 guard + self-test | PASS, 20 mutations detected (13 before) |
| `no-direct-finance-writes` guard | PASS, 13/13 self-test |
| Vitest components | 707/707 PASS (51 files) |
| Unit | 1080 pass / 1 fail — `safeDevPreflight`, missing `.env.development.local`, identical to the pre-change baseline |
| `tsc --noEmit` | clean |
| `lint:errors` | 0 |
| `npm run build` | OK |
| `git diff --check` | clean |

Migration verified idempotent on reapply.

## J. Production

NO MERGE. NO DEPLOY. NO DB PUSH. NO PRODUCTION WRITE. All evidence is local
Docker, in rolled-back transactions or explicitly cleaned fixtures.
