# SEC-08F — final discovery and remaining read-authority closure

## A. Current main

The isolated worktree branch `codex/sec08f-final-security-sweep` is based on
current `origin/main` at `228d53081a174757fcd5a521e6704b0cde4cbb58`.
Main advanced from the requested checkpoint `c7e05ebe55a0ae53e07eba14bf842a857fa4d7f1`.
Every intervening commit was inspected: expense write compatibility, internal
ARCA authentication and claim recovery, Edge CORS, fiscal-date work, and ARCA
self-service phases 0 and 1. None changes the three SEC-08F candidate tables,
their browser consumers, or the R2/R3 authority contracts.

## B. PR #110 final state

PR #110, `fix(security): close SEC-08E auxiliary financial read bypasses`, is
closed and unmerged. Its head remains `a0ff8f75aad09166bc3e1efe160e83ce210b1686`.
The closing comment records that PR #122 / SEC-08E R3 superseded it. No commit
was merged, cherry-picked, or deleted from the historical record.

## C. Production health

Read-only checks against production project `vrdxxmjzxhfgqlnxmbwx` on
2026-09-14 confirmed:

- the client-contract gate is exactly `enabled / 1`;
- `pgrst.db_pre_request` is `public.check_client_contract`;
- R3 migration `20260922120000` and its two views, wrapper, and private
  implementation are installed;
- the private R3 implementation body remains
  `72f9a16bec124d6588c23a4ce21685bf`;
- ledger entries `20260921120000`, `20260922120000`, `20260923120000`,
  `20260924120000`, `20260926120000`, `20260927120000`, `20260928120000`,
  and `20260929120000` are applied;
- all three application URLs answered HTTP 200;
- a bounded one-hour window contained 364 Edge responses and 13 PostgreSQL
  entries, with zero HTTP 409/503 and zero client-contract update,
  configuration, or identity errors.

The exact snapshots are in `production-health.json`, `production-logs.json`,
and `production-candidate-shapes.json`. No production write was performed.

## D. Complete discovered surface inventory

The fresh production catalog contains 96 public tables, 26 public views, and
200 `SECURITY DEFINER` functions. `production-catalog.json` records table and
column grants, RLS, permissive policies, view options and definitions, function
configuration, execute exposure, and body hashes. The sweep correlated this
catalog with current frontend table/RPC usage and migration history.

Three current authenticated read paths are category A. Production contains
five real recurring-expense rows with nonzero amounts and 15 cash-register rows,
11 with nonzero balances. `payment_orders` is empty today, but the policy and
grant expose future rows; a synthetic exact-value witness proved the path.

## E. Proven current exposures

| Surface | Current-main/current-production path | Exact dynamic witness |
| --- | --- | --- |
| `recurring_expenses` | Full authenticated table SELECT plus permissive `re_select` checks membership only and does not require an active profile or `finance`. The table includes name, category, amount, currency, schedule and notes. | Limited technician and viewer read amount `4812.34`; inactive admin also read the row. |
| `cash_registers` | Full authenticated table SELECT. Membership-only `cash_registers_business_select` and authenticated `cr_write FOR ALL` both grant reads without `finance`; balances, openings, exchange rate and notes are exposed. | Limited technician and viewer read ARS balance `5823.45`; inactive admin also read the row. |
| `payment_orders` | Full authenticated table SELECT. `po_select` and `po_write FOR ALL` expose requested/net/fee amounts, provider identifiers, QR/deep links and raw response to every same-tenant actor. | Limited technician and viewer read amount `6934.56` and raw marker `SEC08F_RAW_PROVIDER_WITNESS`. |

Cross-tenant actors could not read any witness before the fix. This confirms
the defect is missing read authority inside a tenant, rather than missing tenant
isolation. Direct reads, wildcard responses, embeds, filters, and ordering were
exercised through real PostgREST and signed JWTs.

## F. Actor matrix

| Actor | Recurring expenses after candidate | Cash registers after candidate | Payment orders after candidate |
| --- | ---: | ---: | ---: |
| Owner | Yes | Yes | No browser SELECT |
| Admin | Yes | Yes | No browser SELECT |
| Cashier | Yes | Yes | No browser SELECT |
| Manager | No | No | No browser SELECT |
| Sales | No | No | No browser SELECT |
| Limited technician | No | No | No browser SELECT |
| Limited viewer | No | No | No browser SELECT |
| Inactive admin | No | No | No browser SELECT |
| Admin with `finance=false` override | No | No | No browser SELECT |
| Cross-tenant owner | No | No | No browser SELECT |
| Anonymous | No | No | No browser SELECT |
| Service role | Grant unchanged | Grant unchanged | Yes |

The matrix first proved the three pre-fix witnesses, then ran the post-fix
matrix. It also executes the reviewed rollback, reproves the pre-fix witnesses,
reapplies the candidate, and reruns the final authority checks against the same
separate PostgREST process. Results are in `local-matrix.json`.

## G. Frontend consumers

`/expenses` and `/caja` are protected by the existing `finance` permission.
`useRecurringExpenses.ts` currently performs `select('*')` and direct CRUD, so
its intended read authority already matches the route. The active Caja product
uses `cajas`, whose read is already protected by `finance OR comprobantes`; no
current frontend code reads legacy `cash_registers` directly.

No current frontend table or browser RPC consumes `payment_orders`. MP POS
Connect is disabled for Beta, and `payment_transactions` already follows the
same service-only browser-read contract. No compatibility projection or
contract-1 fallback is required. The candidate changes no frontend file and
adds no N+1 authorization request.

Other checked consumers explain the non-A classifications: `sales_points`
selects explicit operational columns; checkout consumes
`payment_method_buttons`; receipt/settings flows consume business identity;
ARCA reference catalog reads consume `arca_parametros`; order assignment still
uses both the legacy `public.users` technician ID and newer profile identity.

## H. Authority map

| Surface | Reused authority | Decision |
| --- | --- | --- |
| `recurring_expenses` | `business_id = current_user_business_id()` plus `current_user_can_in_business(business_id, 'finance')` | Exactly matches the live route and adjacent finance ledgers. |
| `cash_registers` | Same tenant-bound `finance` capability | Protects balances while keeping the legacy DML contract. |
| `payment_orders` | No Beta browser reader exists | Revoke authenticated SELECT and retain service-role history. No new capability is invented. |

No role-name list, new helper, view, RPC, capability, or `SECURITY DEFINER`
function is introduced.

## I. A/B/C/D/E classifications

| Class | Surfaces | Reason and disposition |
| --- | --- | --- |
| **A — fix now** | `recurring_expenses`, `cash_registers`, `payment_orders` | Material amounts or provider payloads are reproducibly readable without the product's intended authority. The correction is independent and bounded. |
| **B — already secure / intentional** | Order financial projections and amount helpers; order items/parts; `parts_used`; customer payment allocations; comprobante payments and annulment amount projection; inventory cost projections; supplier finance; account movements; finance insight views; `expenses`; `financial_movements`; `business_finance_entries`; `cajas`; `payment_transactions`; `business_invitations`; `owner_withdrawals`; personal-finance tables; WhatsApp connection metadata | Existing tenant plus capability/self/owner boundaries were rechecked. Secret WhatsApp tokens remain Vault/service-only. No SEC-08F change is needed. |
| **B — operational read** | `business_settings`, `payment_method_buttons`, `sales_points` | Current product flows require tenant operational/fiscal identity, checkout configuration, or point-of-sale metadata. No stored secret was found in these paths. Narrowing them needs a separate product contract, not evidence of an SEC-08F amount bypass. |
| **C — later security lot** | `businesses`, `payments`, `subscription_events`; `arca_emission_attempts`; `whatsapp_message_logs` | Subscription/admin, ARCA attempt diagnostics, and communications payload/privacy have distinct authorities and consumers. Deferral is safe for this lot because none provides a path to the three SEC-08F witnesses or previously protected SEC-08 amounts. Follow-up must define owner/admin or narrow projections and migrate each consumer before revoking base reads. |
| **D — product/identity dependency** | `public.users`, `profiles`, `customers` | Contact/identity data is broad, but it is coupled to team lookup, customer/order workflows, legacy `orders.technician_id`, and newer `assigned_profile_id`. Safe remediation requires the technician identity and Orders/customer access projects explicitly excluded from SEC-08F. |
| **E — false positive / non-sensitive** | `arca_parametros` rows currently limited to IVA rates, currencies and comprobante types | The live rows are reference catalogs, not credentials or financial records. Secrets remain outside this table. |

The category-C/D debt is visible and bounded. Its deferral does not leave an
alternate route to SEC-08F, R3, or earlier SEC-08 protected values.

## J. `public.users` boundary

Production still has `users_select USING (true)` for authenticated users and
table columns for name, email, phone, role and active state. The legacy
`orders.technician_id` points to `public.users`; current application queries
still use that relationship, while newer paths use `assigned_profile_id` and
`profiles`. `profiles` also supports team/assignment flows.

Changing either identity table inside SEC-08F could break Orders and technician
assignment or create two inconsistent identities. It is category D and was not
modified. The later project must first choose the canonical technician ID,
migrate reads and foreign keys, define team-directory visibility, and only then
replace broad base-table access with the required projection or policies.

## K. Proposed fix scope

The smallest coherent lot is one fresh migration:

1. require active same-tenant `finance` authority for
   `recurring_expenses` SELECT and remove the obsolete anon grant;
2. require the same authority for `cash_registers` SELECT and split its legacy
   `FOR ALL` policy into INSERT/UPDATE/DELETE policies so writes remain intact;
3. remove browser SELECT from `payment_orders`, split its `FOR ALL` write policy,
   and preserve service-role history and authenticated same-tenant DML.

The scope excludes frontend changes, public identity, Tasks, Orders, ARCA,
subscriptions, R2/R3 semantics, capability architecture, and production state.

## L. Implementation

`20260930120000_sec08f_remaining_read_authority.sql` implements that scope. It
contains migration-time postconditions for the sole finance SELECT policies,
closed payment-order browser SELECT, absent implicit `ALL` reads, preserved
authenticated DML, and preserved service-role access. It does not create a
projection or definer function because no current browser reader needs one.

## M. Tests and matrix

`scripts/security/sec08f-local.mjs` builds an owned disposable database, brings
its ledger exactly to current main, starts independent PostgREST, signs real
actor JWTs, records pre-fix witnesses, applies only the candidate, and checks
the final authority and ledger. It then certifies rollback and clean
reapplication without altering migration history. It also runs the R1 central
SDK against the current R3 schema and real disposable PostgREST. The final run
passed 184 assertions plus the four R1 integration cases.

The harness also executes the SEC-08A/B/C/D/E, allocation, annulment and finance
SQL suites before and after the candidate. No assertion is disabled or weakened.
Exact normalized outcomes are in `regressions.json`.

## N. R2/R3 regression

The disposable run proved the gate remains `enabled / 1`, the hook remains
`public.check_client_contract`, missing/0 contracts return exact HTTP 409,
contract 1 succeeds, and arbitrary high contract `999999` does not grant
financial reads. The R3 annulment wrapper body is unchanged. A limited
technician remains unable to read R3 part amounts and an authorized owner keeps
working access. The disposable ledger differs from current main only by
`20260930120000`.

## O. Static guards

The repository's self-tests pass for `SECURITY DEFINER`, execute exposure, view
invoker behavior, SEC-08A/B/C, R2A/R2B, current ARCA, Edge and fiscal guards.
The focused SEC-08A/B/C, R2B, ARCA, Edge and fiscal source guards pass. The R2A
source guard reports the already-applied R2B activation, which is its historical
fail-closed purpose; its self-test passes and SEC-08F does not change either lot.

The three global scanners were run in both a detached clean-main worktree and
the candidate. Their results match exactly: two `check_client_contract`
search-path findings, three existing SECDEF execute findings, and six certified
owner-privilege views. SEC-08F adds none. Exact counts and test outcomes are in
`validation.json`.

The candidate itself adds no function, view, execute grant, column grant,
cross-tenant oracle, or search path. Its policy/grant state is dynamically
verified through PostgREST after application.

## P. Performance

Representative `EXPLAIN` plans in `query-plans.json` use the existing
business-key indexes for both finance-filtered tables. The policy calls the
existing tenant/capability helpers; there is no new per-row frontend query,
unbounded projection, or missing-key scan introduced by SEC-08F.

## Q. Files changed

- `.github/workflows/ci.yml`: adds the isolated SEC-08F matrix job;
- `package.json`: adds `test:sec08f`;
- `supabase/migrations/20260930120000_sec08f_remaining_read_authority.sql`:
  candidate authority closure;
- `scripts/security/sec08f-local.mjs`: owned disposable pre/post matrix and
  regression harness;
- `docs/security-sec08f/`: production discovery, dynamic evidence, query plans,
  regression outcomes, this report, and rollback review material.

## R. PR and CI

Fresh PR #132 publishes this candidate. CI moves the candidate migration
aside while Supabase starts at current main, restores it for the harness, runs
`npm run test:sec08f`, and tears the stack down. This preserves a genuine
pre-fix witness in CI instead of starting from an already-fixed schema.

The PR is review material only. It must not be merged or deployed without a
separate explicit production rollout authorization.

## S. Final security inventory

| Surface | Sensitive fields | Current read authority after candidate | Fix lot | Production status | Remaining debt | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Orders/order financials | prices, totals, costs, margins | Tenant-bound `orders_view_financials`; narrower inventory-cost authority where applicable | SEC-08A/B | Applied | None in SEC-08 | SEC-08A/B SQL and post-matrix regressions |
| Customer account/payment allocations | balances, allocated amounts | Self-only wrapper over `user_can_view_order_amounts` | SEC-08E R3 | Applied | None in SEC-08 | R3 regression and production catalog |
| `parts_used` | unit price, subtotal | Operational base columns; amount projection requires order-financial authority | SEC-08E R3 | Applied | None in SEC-08 | R3 regression and catalog |
| Comprobante annulment copies | reversed cash, account, commission, COGS amounts | Metadata base; authority-redacted amount projection/RPC | SEC-08E R3 | Applied | None in SEC-08 | wrapper hash and R3 regression |
| `finance_insights` and ledgers | revenue, costs, balances, margins | Same tenant plus `finance` | SEC-08D | Applied | None in SEC-08 | SEC-08D regression/catalog |
| Supplier finance | purchase costs, debts, payments | Same tenant plus canonical finance authority | SEC-08C | Applied | None in SEC-08 | SEC-08C regression/catalog |
| `recurring_expenses` | amount, currency, schedule, notes | Same tenant plus active `finance` | SEC-08F | Candidate only | Await explicit rollout | Pre/post exact witness and policy assertions |
| `cash_registers` | openings, balances, exchange rate, notes | Same tenant plus active `finance` | SEC-08F | Candidate only | Await explicit rollout | Pre/post exact witness and policy assertions |
| `payment_orders` | amounts, provider IDs, QR/deep link, raw response | Service-role SELECT only; browser DML contract preserved | SEC-08F | Candidate only | Await explicit rollout | Pre/post exact witness and grant assertions |
| `public.users` / `profiles` | name, email, phone, role, permissions | Broad operational identity reads | Technician identity project | Deferred D | Canonicalize IDs and team-directory projection | Production catalog plus frontend/FK scan |
| `customers` | contact, address, document, notes | Same-tenant operational read | Orders/customer access project | Deferred D | Define customer visibility and migrate consumers | Production catalog plus frontend scan |
| Subscription tables | account/payment lifecycle metadata | Existing subscription/admin paths | Separate security lot | Deferred C | Define narrow owner/admin read model | Production catalog |
| `arca_emission_attempts` | CUIT, attempt status, errors, CAE diagnostics | Active same-tenant membership | Separate ARCA security lot | Deferred C | Migrate to canonical safe status RPC/projection, then revoke raw reads | Production catalog/current-main ARCA scan |
| `whatsapp_message_logs` | phone, message payload, error | Active same-tenant membership | Separate communications security lot | Deferred C | Define role/projection and migrate consumers | Production catalog; Vault token separation |
| Operational configuration | business identity, checkout fees, POS metadata | Same-tenant operational reads | Existing product contract | Intentional B | Revisit only with a product authority decision | Catalog and active consumer scan |
| `arca_parametros` | reference JSON | Tenant reference catalog; live types are IVA, currency and comprobante types | None | E | None | Production shape snapshot |

## T. Remaining debt

The remaining debt is explicitly outside SEC-08F: technician identity and
team/customer-directory visibility (D), plus subscription/admin, ARCA attempt
diagnostics and WhatsApp message-log privacy (C). Each needs its own consumer
inventory and authority decision before any base read is revoked. None can read
the SEC-08F witnesses or bypass the already-certified SEC-08 amount controls.

Two old SQL tests fail identically before and after the candidate on current
main: Etapa 1 P&L fails `PX3 operating_expenses = SOLO el gasto operativo
(20000)`, and Etapa 7 checkout reaches existing `FORBIDDEN` before annulment.
SEC-08A phase B also has a known intermittent fixture failure at
`order_parts.name sigue legible`; the harness ran it ten times on each side and
accepts only that exact known clean-main outcome. These are recorded debt, not
weakened candidate assertions.

## U. Exact next action

Review the fresh PR and its CI. If approved, issue a separate explicit
production rollout authorization for exactly migration `20260930120000`. Do
not use a generic migration push, merge automatically, repair history, tag, or
start the deferred identity/product work as part of this candidate.

SEC-08F — FRESH CANDIDATE CERTIFIED, READY FOR EXPLICIT PRODUCTION ROLLOUT REVIEW
