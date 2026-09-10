# SEC-08E R3 — fresh current-main certification

## Decision and immutable boundaries

This candidate is extracted and revalidated from PR #110 against current
`origin/main`. It prepares the three-surface lockdown; it does not apply SQL to
production, repair migration history, merge either PR, change the R2 client
gate, start SEC-08F, or touch `public.users`, Tasks V2, or Orders product work.

The branch started from `99aa12b863cc5abe93fc741bf7c7ae4866bc87d0`.
Before publication, main advanced to `2e243d9332f0353efdd826e3653b290c5e7ce50b`.
Every intervening commit was inspected. They modify only Tasks V2 application
and test files. No migration, security authority, finance surface, or R3
frontend dependency changed. The candidate is rebased onto that current main.

## Extraction map from PR #110

| #110 artifact | R3 treatment | Reason |
| --- | --- | --- |
| `20260922120000_sec08e_auxiliary_financial_reads.sql` | Reused byte-for-byte | Every statement and referenced authority was rechecked against current main and production. The reserved historical version is still absent and has no collision. |
| `tests/sql/sec08e_auxiliary_financial_reads.test.sql` | Reused | Its catalog contract remains current. |
| Synthetic fixture | Reused, then extended with an additional active admin actor | Preserve measured witnesses and cover every requested actor. |
| Old disposable harness | Rewritten | Its `max(version) < R3` premise is false. The new harness compares the complete migration-version set and requires R2A/R2B present while R3 is absent. |
| Old frontend compatibility commits | Discarded | Current main already includes the final corrected behavior from R1. No frontend file is changed. |
| Old rollout conclusions/docs | Discarded and rewritten | R2B is now active in production; “no retirement gate exists” is obsolete. |
| Old package scripts | Rewritten | The new entry point runs the fresh current-main matrix. |

PR #110 remains open and untouched at `a0ff8f75aad09166bc3e1efe160e83ce210b1686`.

## Production precheck and migration gap

Read-only checks on project `vrdxxmjzxhfgqlnxmbwx` at
`2026-09-10T12:30:53Z` confirmed:

- client gate exactly `enabled / 1`;
- `pgrst.db_pre_request=public.check_client_contract`;
- `20260921120000`, R2A `20260923120000`, and R2B `20260924120000` applied;
- R3 `20260922120000` absent;
- no R3 projection or private annulment implementation installed.

A one-hour production log query ending `2026-09-10T12:40:36Z` observed 119
API responses with zero HTTP 409 and zero HTTP 503. Eight PostgreSQL log entries
contained zero `CLIENT_UPDATE_REQUIRED` and zero
`CLIENT_CONTRACT_CONFIGURATION_ERROR`. This is bounded evidence, not a claim
about traffic outside that window.

The intentional ledger gap is preserved. The future rollout must execute only
`20260922120000_sec08e_auxiliary_financial_reads.sql`; generic `db push`,
`db push --include-all`, or `migration up` is unsafe until the gap is closed.

## Current bypasses and authorities

Production catalog discovery reconfirmed RLS on all three tables and the
original bypasses:

| Surface | Current bypass | R3 authority |
| --- | --- | --- |
| `parts_used` | Full table grants plus staff RLS expose `unit_price` and generated `subtotal` to limited staff through direct reads, wildcard, embeds, filters, and ordering. | Operational columns remain readable. Amounts move to `v_parts_used_amounts`, gated by same-tenant active staff plus `orders_view_financials`. |
| `customer_account_payment_allocations` | Its sole SELECT policy accepts active membership, wider than `get_payment_allocations`. | The sole effective SELECT policy delegates to a self-only wrapper around existing `user_can_view_order_amounts(business_id, auth.uid())`. No new role/capability contract. |
| `comprobante_annulments` | Tenant-member SELECT and table grants expose four reverted amounts; idempotent RPC replay returns the same copies. | Metadata remains tenant-readable. Payment reversals follow `comprobantes` plus linked-order finance; COGS follows inventory-cost authority. The public RPC wrapper redacts only its response. |

The disposable pre-R3 stack included the active contract gate and reproduced
all three leaks through real PostgREST/JWT as a limited technician.

## Supplemental surfaces

`recurring_expenses`, `cash_registers`, and `payment_orders` remain broad
tenant-member financial reads. Each is classified **B: separate later SEC-08
scope**. They have separate consumers, write contracts, and authority choices;
none is required to make the three R3 surfaces internally correct. They are not
silently added here.

## Frontend compatibility

Current main already satisfies the post-R3 contract:

- operational `parts_used` selections are explicit; there are no wildcard
  financial reads or financial embeds;
- protected values hydrate from `v_parts_used_amounts`;
- the exact pre-R3 compatibility path first proves both R3 objects absent,
  checks financial authority in the exact business, and performs bounded raw
  reads only for authorized users;
- missing migrated view, permission, network, JWT, SQL, and marker-probe errors
  propagate;
- stale amounts are stripped, restricted amounts stay absent, totals use
  `null`, and generated `subtotal` is omitted from inserts.

No frontend file is part of R3. The real central SDK/service matrix passed on
both schemas for owner and limited tech: order detail, parts list, parts create,
and parts total. Post-R3 the owner receives real amounts; the tech receives no
amount properties and total `null`. A separate fault test proves a missing
migrated projection is not hidden as generic compatibility.

## Migration semantic and annulment safety review

Current production definitions were captured before the candidate. The
definitions of `user_can_view_order_amounts`,
`current_user_can_in_business`, `can_view_inventory_cost`,
`comprobante_is_order_linked`, `get_payment_allocations`, and all other existing
functions are unchanged by R3, except the deliberate placement of
`annul_comprobante_atomic`.

The live `annul_comprobante_atomic` body hash is
`72f9a16bec124d6588c23a4ce21685bf`. Its body matches the immutable canonical
source used by #110 after normalizing line endings. The disposable test proves
that body moves byte-for-byte to
`private.sec08e_annul_comprobante_impl`, browser roles cannot execute it, and
the public wrapper preserves authentication, fiscal operations, stock changes,
idempotency, errors, and success metadata while redacting response amounts by
existing authorities. Real idempotent replay is covered for allowed and denied
actors.

R2A, R2B, `check_client_contract`, the database hook, frontend request headers,
and Update Required UX are untouched. The disposable stack asserted
`enabled/1` and the same hook before migration, after R3, after rollback, and
after R3 reapplication. Contract 1 works; missing/0 receives the exact 409;
`999999` passes compatibility but grants no financial authority.

## Disposable actor matrix

The real PostgreSQL 17/PostgREST 14 matrix used synthetic owner, admin, manager,
cashier, sales, limited technician, limited viewer, inactive user, cross-tenant
owner, anonymous, and service-role actors.

| Actor | Operational parts / annulment metadata | Part amounts | Allocations | Annulment payment amounts | COGS |
| --- | --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes | Yes |
| Admin / manager | Yes | Yes | Yes | Yes | Yes |
| Cashier / sales | Yes | Yes | Yes | Yes | No |
| Limited technician / viewer | Yes | No | No | No | No |
| Inactive user | No | No | No | No | No |
| Cross-tenant owner | No | No | No | No | No |
| Anonymous | No | No | No | No | No |
| Service role | Contract exemption only where intended; database authority remains explicit. |

Direct protected-column reads, wildcard, embeds, filters, ordering, projections,
allocation RPC parity, cross-tenant isolation, inactive users, anonymous users,
and real annulment replay were checked. The final run completed 274 assertions.

## Regression, guards, and performance

Passed before and after R3: SEC-08A orders, SEC-08A phase C, SEC-08B, SEC-08C,
SEC-08D, allocation UI SQL, and the Etapa 0 annulment ledger. SEC-08A phase B
ran 20 bounded times on each side and was compared with its measured clean-main
outcome set. A separate 60-run clean-main probe produced 56 passes and four
identical `order_parts.name sigue legible` fixture failures; R3 does not modify
the function, table, policy, or grant involved. The current R1 frontend matrix
passed on both schemas. The focused component set passed 104 tests. Edge
contract forwarding passed 3 tests. TypeScript, ESLint with zero errors,
production build, and `git diff --check` passed.

Two historical SQL suites fail identically on clean current main and candidate:

- Etapa 1 P&L: `PX3 operating_expenses = SOLO el gasto operativo (20000)`;
- Etapa 7 annulment integration: fixture checkout returns `FORBIDDEN` before
  reaching the annulment call.

Assertions were not weakened or skipped. Exact normalized outcomes are stored
in `regressions.json`.

Focused SEC-08A/B/C guards and R2A/R2B guards pass. The three global guards have
measured baseline findings:

- `guard:secdef`: two existing R2A `check_client_contract` findings on both
  clean main and candidate;
- `guard:secdef-exposure`: three existing findings on both trees;
- `guard:view-invoker`: clean main flags four certified SEC-08B views; candidate
  flags those four plus the two deliberate R3 projections.

The R3 projections must run with owner privileges because invoker views cannot
read the revoked base columns. They use security barriers, explicit same-tenant
and capability predicates, read-only grants, and are tested dynamically. No
guard is disabled or allowlisted.

Synthetic query plans show bounded access: primary-key lookup for parts and
annulments, the existing `idx_parts_used_order_id` for order hydration, and
`idx_cap_alloc_business` for allocations. There is no unbounded frontend
projection or N+1 amount hydration; the frontend batches part IDs and groups
the transitional fallback by business. Fixture execution times are evidence of
plan shape only, not production latency.

## Rollout and rollback review

Future production order after explicit authorization:

1. merge this PR;
2. wait for the current contract-1 frontend deployment;
3. verify it against pre-R3 production;
4. repeat the read-only gate, hook, ledger, log, schema, and function-body checks;
5. execute exactly `20260922120000_sec08e_auxiliary_financial_reads.sql` with
   `psql -X --set=ON_ERROR_STOP=1 --file ...`;
6. verify grants, policies, views, wrapper/private implementation, gate, and
   technical smoke;
7. record only `20260922120000` as applied after the SQL and postconditions pass;
8. re-read the ledger and run owner human smoke.

The reviewed rollback SQL is documentation, not a migration. It validates a
complete R3 installation and the exact implementation hash, drops the two
views and wrapper, restores the measured pre-R3 policies and grants, moves the
unchanged implementation back to `public`, and preserves the active R2B hook
and configuration. It deliberately restores the known pre-R3 leaks, so only
the retained contract-1 frontend may be used. Migration history is not altered
automatically; any emergency history decision must follow verified database
state. The rollback was executed successfully only in the owned disposable
database, followed by a clean R3 reapplication.

## Evidence and production integrity

- `production-discovery.json`: current catalog/function snapshot, read-only;
- `current-production-precheck.json`: latest gate/hook/ledger check;
- `production-log-precheck.json`: bounded production log counts;
- `disposable-run.log`, `final-r3.log`, `regressions.json`,
  `query-plans.json`: dynamic evidence;
- `guards.json`, `typecheck.log`, `lint.log`, `build.log`,
  `components.log`, `edge-forwarding.log`: validation evidence;
- `rollback-review.sql`: reviewed, disposable-tested rollback procedure.

Production integrity at candidate publication: R3 is not applied; its migration
history remains absent; R2B remains enabled/1; the hook remains
`public.check_client_contract`.
