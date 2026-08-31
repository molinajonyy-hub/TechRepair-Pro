# Lote 2 — SECURITY DEFINER tenant authority / Phase A

**Implementation candidate; no production rollout authorized.** Inventory and validation date: 2026-08-31.

## A. Baseline

- Main after both fetches: `3ce69b7b69f2816c0162948c89e43bec5753595c` (expected; no new commits).
- Branch: `codex/secdef-tenant-authority-lote2`.
- Isolated worktree: `C:/Users/molin/CascadeProjects/techrepair-secdef-lote2`.
- Original checkout remains at `70a2d181384e72d028d8c808f6e99b2061d21438`; discovery documents and mobile evidence remain untouched.
- Followed repository Product Design/Engineering Safety instructions. No frontend, dependencies, table design, general RLS, triggers, billing or accounting formulas changed.

## B. Production catalog before

Real `pg_proc`, `pg_namespace`, `pg_roles`, `proacl`, `aclexplode(COALESCE(proacl,acldefault(...)))`, `has_function_privilege` and schema USAGE inspection, in explicit read-only transactions. Production project: `vrdxxmjzxhfgqlnxmbwx`.

| Schema | SECURITY DEFINER | PUBLIC EXECUTE | anon EXECUTE | authenticated EXECUTE |
| --- | ---: | ---: | ---: | ---: |
| public | 192 | 32 | 34 | 139 |
| private | 13 | 1 | 1 | 1 |
| Total | **205** | **33** | **35** | **140** |

ACL counts are not exploit counts. Excluding trigger/event-trigger returns and the private schema, the corresponding public-function counts are **6 / 8 / 113**. The two intentional anon additions are the public wholesale portal projections. There are 32 trigger/event-trigger functions across both schemas. Private schema USAGE is denied to user roles, including for `private.arca_rotation_record`, which still has PUBLIC function EXECUTE.

Artifacts:

- `catalog-before.json`: all 205 exact signatures, identity arguments, returns, owners, search_path, ACL entries, effective grants, schema USAGE, definition hashes, trigger bindings, migration provenance and source/SQL caller occurrences.
- `definitions-before.sql`: production definitions of the nine touched candidates, with CRLF normalized; exact and normalized hashes are in the catalog. **Evidence, not a migration**.
- `exploitability-matrix.md`: complete 205-row classification and source-migration table.
- `caller-metadata.json`: no matching policy or cron caller for the nine candidates; SQL parents and triggers are separately captured in the catalog.

No business rows, credentials, Vault values, user emails, tokens or production identifiers other than the project reference were selected for these artifacts. Source occurrence lists include tests/comments and require the runtime interpretation below.

## C–D. Confirmed candidates and caller graph

All nine had authenticated EXECUTE, with PUBLIC and anon revoked. None is an anonymous RPC vulnerability. The four original high-priority functions are still reachable in production before rollout; they were not falsely cleared based on an old migration.

| Function | Production service EXECUTE | Runtime caller / role / Beta requirement | Production issue | Candidate contract |
| --- | ---: | --- | --- | --- |
| `repair_missing_stock_movements(uuid,boolean)` | yes | `StockRepairTool.tsx:58`, mounted by `Inventory.tsx:3127`; authenticated owner/admin; required by existing product workflow | Caller-selected tenant drives stock writes, without an actor guard | USER_RPC: canonical active tenant + `inventory` + owner/admin |
| `preview_missing_stock_movements(uuid)` | yes | Same mounted component, line 43; authenticated owner/admin | Cross-tenant stock/sales read; joined parent and inventory tenant were not bound | READ_RPC: same independent authority as repair; every joined resource bound |
| `delete_supplier_purchase_safe(uuid,uuid,uuid)` | no | `Suppliers.tsx` → `suppliersService.deletePurchaseSafe:325`; authenticated, inventory capability | Caller-selected tenant allows stock reversal/deletion; caller-selected user for movement/tombstone attribution | USER_RPC: canonical active tenant + `inventory`; audit only `auth.uid()` |
| `backfill_remito_fm(uuid[])` | no | Historical SQL maintenance; baseline + 6F3 legacy-script reference; no UI, Edge, SQL parent, policy or cron caller found | Arbitrary remito IDs drive cross-tenant financial writes | INTERNAL_ONLY: existing postgres owner only |
| `check_user_limit_before_invite(uuid)` | no | `UsersManagement.tsx:270`; `/users` requires `users`; canonical invitation RPC requires owner/admin | Tenant-selected membership count/plan read before invitation | READ_RPC: canonical active tenant + `users` + owner/admin; subscription calculation unchanged |
| `pay_comprobante_from_account_atomic(uuid,uuid,uuid,numeric,text,text,date,uuid,uuid,text)` | yes | Published SQL compatibility wrapper; no current UI/Edge/SQL parent found; composes existing guarded payment/allocation RPCs | Document existence/read precedes the child's authorization; existing and missing foreign IDs return different results | USER_RPC: existing child contract `finance` + canonical active tenant, before the document read; signature/composition retained |
| `user_can_allocate_payments(uuid,uuid)` | yes | Only `allocate_account_payment_atomic`, `get_allocation_workspace` (both SECDEF, passing authenticated actor) | Direct RPC lets a caller probe another actor's tenant permission; **no direct financial write** | INTERNAL_ONLY: revoke direct users, preserve service/owner and nested calls |
| `user_can_reverse_allocations(uuid,uuid)` | yes | Only `reverse_payment_allocation_atomic`, `get_allocation_workspace`, `get_payment_allocations` (guarded SECDEF) | Same arbitrary-actor permission probe | INTERNAL_ONLY; no change to permission rules |
| `user_can_view_order_amounts(uuid,uuid)` | yes | Only `get_order_financial_amounts`, `get_allocation_workspace`, `get_payment_allocations`, `get_customer_unallocated_credit` (guarded SECDEF) | Same direct actor/tenant probe | INTERNAL_ONLY; no general Orders RBAC change |

The five additional candidates were discovered by the catalog/source/ID sweep, not assumed from names. The last three are low-detail permission disclosures, not financial-write exploits. Their guards still run inside unchanged parent RPCs; integration suites verify those parents.

Source searches covered frontend RPCs, deprecated wrappers, Edge functions, active/archived migrations, SQL definitions (including invoker parents), tests and scripts. Catalog queries covered policies, triggers and cron. No deployed Edge source or out-of-repository private operator script was exported; absence claims are limited to repository/runtime catalog evidence.

## E. False positives cleared

- `create_default_payment_buttons(uuid)`: **no authenticated/anon/PUBLIC EXECUTE**. Historical defaults implementation is not an exposed user RPC. Left intact; manual MP tender configuration unchanged.
- `snapshot_arca_original_identity(uuid,uuid)` and the other snapshot RPCs: **no user EXECUTE**; Edge service consumers preserve their existing contracts. Left intact.
- `finance_log_audit`, `finance_begin_audit_scope`, period helpers and other internal helpers: direct user access already closed; see per-function C/E entries. No broad grant churn.
- `private.arca_rotation_record`: function ACL alone looks public, but user schema USAGE is denied. No human RPC path found. Left intact.
- `_require_platform_admin` and guarded admin RPCs: explicit platform-role authority, not caller business identity. Left intact.
- Trigger returns cannot be called as regular RPCs. This does **not** clear writes that indirectly fire them (notably the separately deferred payment_transactions issue).
- Retired crypto, old finance summary and register-order-payment surfaces remain closed.

Matrix totals: **A 34, B 79, C 33, D 32, E 23, F 4, G 0**. Of the 34 A rows, **9 are fixed candidates here**; **25 explicitly retain Lote 3 action/active-membership debt** despite having actor-to-tenant checks. They are not presented as safe. This is not a global RBAC certification.

## F–G. Migration and resulting grants

One migration: `supabase/migrations/20260907120000_secdef_tenant_authority.sql`.

- Six explicit function replacements; exact-signature ACLs for nine functions. No dynamic `pg_get_functiondef` patching in the migration.
- User-facing guards reuse `_require_business_member`, `current_user_business_id` and `current_user_can`; no new authorization architecture.
- Existing canonical keys: `/inventory` **and `/suppliers` both use `inventory`** (`App.tsx:218–220`). StockRepairTool additionally has an owner/admin gate. No invented `suppliers` capability.
- Purchase deletion keeps `p_user_id` for compatibility but ignores it for auditing, as other modern mutators already do. Unauthorized requests raise SQLSTATE 42501 before locks/effects; paid/replay/NOT_FOUND JSON contracts remain.
- Preview changes from SQL to STABLE PL/pgSQL to perform an independent guard before RETURN QUERY. Its nine-column return shape remains unchanged. Both preview/repair bind parent tenant; preview additionally binds inventory tenant. Repair already binds each inventory lookup/update and skips foreign/missing products.
- Backfill receives qualified relation names and `pg_catalog, pg_temp`; its financial computation is unchanged. All nine touched functions end with that search_path.
- No new service authority: backfill, deletion and invitation preflight lacked service EXECUTE in production and still lack it. Existing service ACLs on user RPCs do not bypass the requirement for a human actor; there is no discovered actorless service caller.

| Function(s) | PUBLIC | anon | authenticated | service_role | postgres owner |
| --- | --- | --- | --- | --- | --- |
| repair, preview, compatibility payment wrapper | no | no | yes, guarded | existing yes, guard still applies | yes |
| delete purchase, invitation preflight | no | no | yes, guarded | no | yes |
| backfill | no | no | no | no | yes |
| three permission helpers | no | no | no | existing yes | yes |

`local-grants.json` records actual post-migration `has_function_privilege`, PUBLIC ACL inspection, owner and search_path for every exact signature.

## H–I. Certification and regressions

| Gate | Result |
| --- | --- |
| Dedicated local schema rebuild | PASS; empty schema clone + three explicit missing baseline migrations; no data/Vault/cron copied |
| Baseline vs production | PASS; all nine original definitions (only CRLF normalization), owners and ACLs match measured production |
| Migration apply / rollback / reapply | PASS; rollback restores definitions/owners/ACLs; second apply is idempotent |
| New SQL security suite | **441 assertions PASS**; fixtures and all effects rolled back |
| Original-flaw negative controls | **9 PASS**; restoring each original body or user grant makes the security suite fail, and each mutation rolls back |
| Real local PostgREST HTTP | **125 requests PASS**, including **121 fingerprinted rejections**; valid signed authenticated JWTs checked by a positive control; invalid-JWT errors cannot count as authorization passes |
| True concurrent sessions | PASS: locked item skipped; concurrent replay does not deduct again; second purchase deletion waits on first transaction, then returns ALREADY_DELETED; exactly one tombstone/movement |
| Existing supplier SQL | PASS: etapa6 supplier lockdown; etapa7 supplier-purchase integration; etapa7 supplier-payment integration |
| Existing allocation/permission SQL | PASS: p0a1 allocations; p0a1u2 UI contract; p0a1u1v order amounts; p0p6 capability RBAC; secdef public-execute lockdown |
| Historical `etapa7_7e1b_mutator_idempotency_test.sql` | **FAIL, baseline-confirmed**: initial NC-C fixture lacks the fiscal identity required by later migrations; fails at NC1 before supplier cases. Same failure reproduced with original production definitions. Not edited or skipped to obtain green |
| Node unit tests | 23 PASS (`wholesalePermissions`) |
| Vitest affected capability/allocation components | 53 PASS in 4 files |
| typecheck / lint:errors / build | PASS; existing build chunk-size/dynamic-import warnings only |
| Existing SECDEF hygiene/exposure guards + self-tests | PASS across 247 migrations |
| Finance-write / reproducible-function-definition guards | PASS |
| `git diff --check` | PASS |

Security matrix includes owner/admin/manager/tech/sales/cashier/viewer A, owner B, inactive profile, no membership, explicit false capability overrides, explicitly enabled inventory override, and both canonical `profiles.id=auth.uid()` and linked `profiles.user_id=auth.uid()` identity forms. It checks anonymous access, A→B tenant, A body→B entity, malformed legacy child→foreign parent/inventory references, same-tenant missing capability, legitimate access, actor forgery, and internal-role contracts.

Fingerprints cover stock, stock movements, purchases/items/supplier ledger/tombstones, both financial ledgers, comprobantes/items/payments, wholesale orders/items, accounts/movements/allocations and financial audit. Rejects require BEFORE == AFTER. Regression assertions preserve BLOCKED_PAID, successful delete, replay, stock reversal, audit identity, preview shape, normal/negative stock repair, and backfill shape/idempotency.

HTTP/concurrency use a disposable clone of `lote2_certification` and a separate PostgREST container bound to `127.0.0.1:55498`; both are removed afterward. No browser E2E/UI session was run: application code is unchanged, real RPC boundary and affected component suites were tested. The local schema rebuild is **not** a certification of replaying every historical migration from a completely empty Supabase installation. Concurrency tests certify same-item SKIP LOCKED and same-purchase replay, not unrelated stock-writer races.

## J. Files and reproduction

- Migration: function authority and exact grants only.
- `scripts/security/lote2-catalog.sql`, `lote2-callers.sql`: read-only production queries.
- `lote2-build-evidence.mjs`, `lote2-matrix.mjs`, `lote2-preflight.mjs`: sanitized metadata, reviewed classifications and drift comparison.
- `lote2-local.mjs`: local baseline check, rebuild, apply/rollback/reapply, SQL suite, post-grants evidence.
- `lote2-boundary.mjs`: signed JWT/PostgREST and real concurrency; disposable local database/container only.
- `lote2-negative-controls.mjs`: restore one original flaw at a time in rolled-back local transactions.
- `tests/sql/lote2_secdef_tenant_authority.test.sql`: tenant/capability/effect/regression matrix.
- This directory: sanitized review artifacts; original raw captures stay uncommitted in `.lote2-local/`.

From this worktree, with the existing local Docker stack running:

```text
node scripts/security/lote2-local.mjs --rebuild
node scripts/security/lote2-negative-controls.mjs
node scripts/security/lote2-boundary.mjs
```

`LOTE2_DB_CONTAINER` can select another installed local Supabase Docker container. The rebuild fails closed if the nine source functions/ACLs differ from the recorded production baseline. It never accepts a remote DB URL.

Production evidence refresh uses only `supabase db query --linked --file <catalog/callers SQL> -o json` from the already linked original checkout, writing raw output to local files. Then run the offline evidence/preflight script. **Do not execute definitions-before.sql, db push, db reset --linked or the candidate migration against production.**

## K. Commit / PR

Dedicated commit: `fix(security): bind secdef rpc tenant authority`; no Co-Authored-By. PR targets main. Commit and PR identifiers are reported in the task delivery after creation. No merge, deployment or production grant change is included.

## L. Remaining debt

- **LOTE 3 — is_staff/action authority**: the matrix explicitly records 25 actor/tenant-bound RPCs whose active-membership and/or action-capability checks need their own review. No global RLS, `is_staff`, payment semantics or Orders role rules were replaced. The three helper changes only close direct identity-probing entrypoints; their role predicates are unchanged.
- **payment_transactions forged-income**: known indirect SECDEF-trigger write route, excluded here. Trigger-only classification does not mark that route safe.
- **Billing**: mp-subscription/process_mp_subscription_payment and SaaS billing authority remain separate. Invitation preflight protects its read but does not change subscription logic.
- **Mi Guita/scope**: personal functions are classified separately; no personal-finance rebuilding or RPC sweep. No new critical cross-user finding was established in this lot; this is not Beta-scope closure for that product.
- Historical NC-C test fixture needs its own maintenance. Current dedicated supplier/idempotency tests pass despite that unrelated suite failing before reaching supplier cases.
- No production fix is effective until separately reviewed and explicitly rolled out. Source changes and local grants are not proof of deployed containment.

## M. Recommendation

Production read-only preflight: **all 205 definitions, owners, search paths, grants and schema-USAGE results unchanged** since inventory; policy/cron matches for the nine candidates remain empty. See `production-preflight.json` and `caller-metadata.json`.

**READY FOR INDEPENDENT REVIEW** — focused candidate with the baseline-confirmed legacy test failure and Lote 3 debt disclosed. Stop after opening the PR. **NO MERGE. NO DEPLOY. NO APPLY PROD MIGRATION.**
