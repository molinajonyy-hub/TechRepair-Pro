# SEC-08E pre-merge rollout safety review

Verdict: **BLOCKED for the complete production rollout**. N/N+1 frontend compatibility is corrected and tested. Applying the lockdown while an old tab can still execute breaks legitimate order/parts reads. The repository has no enforced client-retirement boundary. This review does not authorize merge, production deployment, migration or tag.

## A. Verified baseline and pipeline

PR #110 was OPEN at `fe68866c38acf30ec7847c15e11ccf56752f682f`; `origin/main` was `3f9ac158478069c92f6614798f5d218a6820e6a1` after `git fetch origin --prune`. Both GitHub Actions jobs for that head were SUCCESS. Work was confined to the existing `techrepair-sec08e` worktree.

- **Vercel:** repository operations documentation explicitly states that main merges auto-deploy, independently of manual DB changes (`docs/p0-first-steps-1.md`, rollout section; `docs/auditoria-finanzas/m6/deploy-production.md`, risks section). Live GitHub deployment records corroborate the integration: vercel[bot] created Production deployment **6286793471** for certified main on 2026-09-05 23:01:25 UTC, with success status, and Preview deployment **6296852963** for the initial PR head on 2026-09-06 19:08:58 UTC. `vercel.json` builds with `npm run build` and publishes `dist`; no migration command is present.
- **Supabase:** the sole tracked Actions workflow is `.github/workflows/ci.yml`. Its Supabase operations create/tear down disposable local E2E infrastructure. It contains no linked/production `db push`, production credentials or production migration job. Existing operations documentation says production migrations are applied manually. Build scripts do not apply them.
- **Ordering:** Vercel and a manual Supabase operator can run independently. There is no DB/frontend dependency, deployment lock, automatic migration sequencing or shared readiness condition in this repository. Actions `concurrency` only cancels competing CI runs; it does not serialize production Vercel and Supabase operations.
- **Inspection limit:** the connected Vercel account returned no teams; current dashboard settings and external Supabase integration settings were not accessible. Claims above are grounded in tracked automation, operations documentation and current GitHub deployment records; they do not certify unknown external automation. No deployment was triggered for inspection.

### Coexistence window

`useUpdateDetector.ts` checks `version.json` after 10 seconds, every five minutes and on focus. `UpdateBanner.tsx` requires a user click and can be dismissed. `hardReload()` unregisters service workers only when the user invokes it. No active SW registration was found in current source; the PWA manifest alone does not force upgrades. This does not exclude historical workers in existing browsers.

Vite emits hashed assets and `version.json`. Repointing a deployment/CDN alias cannot replace JavaScript already loaded in a tab. Old clients can therefore coexist for an **unbounded** duration (including suspended/offline tabs returning later), not merely five minutes or the Vercel build duration. No configured maximum version age or mandatory refresh closes that window. New frontend with old schema can also coexist indefinitely until the manual migration is run; the corrected frontend preserves essential operations during that interval.

## B. Real compatibility matrix

`npm run test:sec08e:rollout` clones schema only into the owned disposable local database. It extracts the actual service modules from certified main and the initial PR head without checking out another branch, and exercises those plus the working candidate through real Supabase-js/PostgREST/JWT requests. Only the authentication identity provider is supplied locally; table reads, writes, capabilities, profile lookup and projections execute against PostgreSQL. No browser visual interaction is claimed.

Each cell covers owner with order-financial permission and limited tech without it, and executes order detail, parts list, creation and total. The baseline/schema mutations are confined to synthetic fixtures. Failed legacy inserts/hydration witnesses are cleaned between cases.

| Frontend | DB | Before correction | Final result |
| --- | --- | --- | --- |
| Old (`main`) | Pre-SEC-08E | Detail/list/total work but leak prices to tech. Create already fails `428C9` by explicitly inserting generated subtotal. | Unchanged; existing create defect is not attributed to rollout. |
| New | Pre-SEC-08E | Initial PR: detail/list/create fail `PGRST205`; authorized total also fails. Limited total is null. INSERT may have already succeeded before hydration fails. | Detail/list/create succeed for both actors, with monetary fields absent. Total is null, never a fabricated zero. |
| Old (`main`) | Post-SEC-08E | Detail/list/total fail `42501` for both actors. Create retains its existing `428C9` failure. | **Still incompatible.** Final column protections were not weakened to support wildcard legacy clients. |
| New | Post-SEC-08E | Initial PR behaves correctly. | Correct: owner receives price `7103.19`, generated subtotal and authorized total `21309.57`; tech retains operations without amounts and receives null total. Create succeeds for both. |

The runner additionally simulates a **post-migration missing view** by renaming only `v_parts_used_amounts` while keeping the migration helper. List and authorized total reject with `PGRST205`. The missing-view failure is not silently treated as pre-migration compatibility.

## C. Exact cause and correction

Initial hydration and total calculation unconditionally required the new view. A frontend-first deployment could fail after an otherwise valid operational query or successful INSERT. A DB-first deployment revokes the columns still requested by old wildcard services. Neither naive deployment ordering is safe.

`isPreSec08eSchema` accepts only this exact pair:

1. `PGRST205` naming precisely `public.v_parts_used_amounts` in the schema cache.
2. A self-only probe of `can_view_payment_allocations(p_business_id: null)` returning `PGRST202` naming precisely that helper/signature.

Both objects are introduced by the same atomic SEC-08E migration. If the helper is present, a missing view remains an error. Probe errors propagate. Permission, JWT, connection, server, unexpected SQL and other missing-object errors do not trigger compatibility behavior. No capability result is used to grant financial access. No schema-state result is cached, so a live tab uses the protected projection on its next request after migration.

Hydration retains only operational columns on confirmed pre-migration responses, including stripping stale amounts. Authorized totals return null while the projection is unavailable. There is no fallback to raw monetary columns for any actor, no fake zero and no generic error suppression. The final migration, grants, RLS and RPC contracts are unchanged by this review.

## D. Required two-phase rollout — proposal, not executed

1. **Compatibility phase:** release the corrected frontend against pre-SEC-08E DB, with the lockdown migration explicitly held. Since tracked migrations are manual, this is a separate operator action, not a timing race with Vercel. Verify detail/list/create and the deliberate temporary absence of monetary fields.
2. **Client-retirement gate:** establish and verify an enforceable way to retire every incompatible client before lockdown, including open, offline and suspended tabs. The existing dismissible banner, a five-minute wait, CDN completion, and a version.json response from a fresh browser do **not** prove this. A controlled maintenance/client-upgrade procedure or an appropriately designed version boundary needs separate operational agreement and evidence; this review does not introduce session invalidation or a broad app refresh mechanism.
3. **Lockdown phase:** only after that gate is satisfied, apply the unchanged SEC-08E migration, verify the protected projections/permissions, and resume operations on compatible clients. Do not restore financial column grants to make old clients work. After lockdown, reverting the frontend to certified main is an incompatible rollback; retain a compatible build or correct forward.

The two phases do not need a second SQL migration: the existing single transaction is the final lockdown. Holding it must be explicit; running an indiscriminate migration push during the compatibility phase defeats the plan. Backend leaks present in the old schema remain until lockdown, so compatibility is not production security completion. **No safe retirement gate is currently implemented or demonstrated: overall pre-merge rollout remains BLOCKED.**

## E. Regression protection and checks

- The rollout matrix asserts results rather than just collecting logs: 12 version/actor/schema cases plus one real migrated-schema missing-view fault case. The fault case is selected in a separate invocation after fault injection; skipped cases in each invocation are not counted as passes.
- Focused component tests cover paired object absence, authorized hydration, stale amounts, and propagation of permission/JWT/network/server/SQL/unrelated-object/probe failures.
- `npm run test:sec08e` retains the dynamic security and existing SQL regressions; `npm run test:sec08e:rollout` adds repeatable compatibility validation. A separate Node Vitest config keeps the normal component suite's no-network rule intact.
- Executed locally: **220 security assertions and nine SQL suites passed**, **15 focused component tests passed**, and **13 selected real compatibility/fault cases passed**. TypeScript, focused ESLint, Vite build, five SEC-08A/B/C guards and `git diff --check` passed. The build retains its existing large-chunk warning. CI for the new commit is checked separately after push; local results do not stand in for CI.
- No tests against production and no global E2E run locally. Historical M7, global SECDEF and blanket view-invoker limitations from the initial report still apply; they are not relabeled green.

## F. RBAC confirmation

Before SEC-08E, `get_payment_allocations` already called `user_can_view_order_amounts(p_business_id, auth.uid())`. The helper from `20260828120000_order_amounts_canonical_profile_identity.sql` checks registered owner or active canonical/legacy membership with role owner/admin/manager/cashier/sales. It does not consult capability overrides. The earlier `20260826120000_p0p6_capability_rbac.sql` explicitly records this helper as deferred work.

SEC-08E's direct-table policy delegates to that exact helper and does not widen the RPC contract. The role-versus-override discrepancy is existing RBAC debt for a future decision, not corrected here. A tech financial override permits protected part amounts but still does not permit allocation amounts under the historical role gate.

## G. Changed files and integrity

Application: `src/services/partsUsedAccess.ts`, `src/services/api.ts`. Tests/tooling: `tests/components/sec08ePartsUsedAccess.test.ts`, `tests/integration/sec08eRollout.test.ts`, `scripts/security/sec08e-local.mjs`, `scripts/security/sec08e-rollout.mjs`, `vitest.sec08e-rollout.config.ts`, `package.json`. Documentation: this review and the corrected rollout note in `report.md`.

Second commit requested: `fix(security): make sec-08e rollout backward compatible`, on the existing PR branch only. No migration change, production DML, merge, production deploy, tag, SEC-08F, fiscal change or permission redesign. The original worktree was not accessed or modified during this review.
