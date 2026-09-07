# SEC-08E R1 — compatibility client + client contract

R1 can ship against the current pre-SEC-08E schema without a database migration.
It prepares the browser for a later gate; it does not install that gate or close
the database surfaces reserved for R3. **The marker is forgeable and is not a
security authority. RLS and capabilities remain authoritative.**

**#110 remains blocked and must not be merged as a single rollout.**

## A. Baseline and scope

- `origin/main`: `3f9ac158478069c92f6614798f5d218a6820e6a1`, fetched with
  `git fetch origin --prune --tags`; no intervening main changes.
- New branch: `codex/sec08e-r1-compatible-client-contract`.
- Isolated worktree: `C:/Users/molin/CascadeProjects/techrepair-sec08e-r1`.
- #110 remains OPEN at `a0ff8f75aad09166bc3e1efe160e83ce210b1686`.
- Original worktree's dirty screenshots/untracked material and #110's clean
  worktree were preserved. No cherry-pick, merge, tag or manual deployment.

## B. Frontend extraction

The initial R1 reused #110's `partsUsedAccess.ts`, scoped `api.ts` changes,
optional monetary fields and 15 unit tests. The transition correction preserves
authorized pre-schema amounts and expands the compatibility suite to 37 tests.
There are no R1 changes under `supabase/`, no copied migration, backend gate,
minimum-client config, grants/revokes, policies or capability changes.

Order detail's parts embed, parts list and INSERT returning use explicit
operational columns. Hydration first reads `v_parts_used_amounts`, discards stale
monetary fields and attaches actual authorized values (including a real zero).
Only after the exact paired absence below may it read legacy monetary columns,
and only for businesses explicitly authorized by the existing backend RPC. Existing other order
embeds are unchanged. INSERT no longer supplies generated `subtotal`; callers
still supply `unit_price` for writing, but cannot infer a readable price from it.

Only this paired absence is accepted as a transitional schema:

1. `PGRST205` with the exact missing `public.v_parts_used_amounts` schema-cache message.
2. `PGRST202` with the exact missing `public.can_view_payment_allocations(p_business_id)` schema-cache message.

The helper probe uses `p_business_id: null`. Missing-view errors on a migrated
schema, authorization, network, unexpected SQL and server errors propagate.
The original R1 returned absent amounts/null totals even for an authorized owner
before R3. That was a product regression during the transition window. Now,
`current_user_can_in_business(business_id, 'orders_view_financials')` must return
literal `true` before any legacy monetary request. This existing backend helper
checks owner or active profile membership and capability overrides in that
specific business. No client role matrix, cached profile or client marker grants
access. Any capability error propagates.

Hydration groups the operational rows by business and reads only
`id, unit_price, subtotal`, filtered by that business and the current part IDs.
A missing row business fails closed. Total resolves the order's business through
a minimal RLS-protected `orders(business_id)` lookup, checks the same capability,
and uses either the projection or, after exact paired absence, a legacy
`subtotal` query filtered by business and order. Invisible orders and limited
actors return `null` without selecting monetary subtotal. Generated INSERT
subtotal remains untouched; create returning is hydrated through this same path.

Pre-schema authorized actors keep real prices/subtotals/totals. Limited actors
never issue legacy monetary queries. Post-schema always uses the protected view;
missing view with existing helper, missing helper with an existing view, 42501,
PGRST116, timeout, network/500 or different schema-cache messages never enable
legacy access. A lockdown racing an already-authorized legacy read produces its
normal database error; it is not swallowed. No deployment/permission result is
cached. This transitional client behavior does not repair pre-existing raw DB
column exposure; the later DB lockdown remains necessary and authoritative.

## C. Compiled contract and actual HTTP coverage

`src/lib/clientContract.ts` defines `TECHREPAIR_CLIENT_CONTRACT = 1`. The central
`src/lib/supabase.ts` instance supplies `global.headers`:

```text
x-techrepair-client-contract: 1
x-techrepair-client-build: <compiled __BUILD_COMMIT__>
```

Neither mutable storage, query parameters nor remote `/version.json` determine
the contract. Build hashes are diagnostic, never compared for compatibility.

The installed SDK's `SupabaseClient.ts` passes these headers and its custom
fetch to PostgREST REST/RPC, Functions HTTP and Storage; unit tests exercise
all four through the actual application singleton. Auth HTTP also receives
global headers in the SDK initializer. No direct frontend GraphQL calls exist;
an RPC-based GraphQL call would inherit REST headers. Independently constructed
GraphQL fetches must use an explicitly configured transport: there is no claim
that arbitrary browser fetches inherit SDK headers. Existing raw Edge Function
fetches outside this SDK instance also do not inherit its headers. No WebSocket
or Realtime transport coverage is claimed.

## D. Future error and update UX

The global custom fetch inspects only this Supabase origin's Data API paths
(`/rest/v1/…` and `/graphql/v1`). Only HTTP **409** plus JSON
`code: "CLIENT_UPDATE_REQUIRED"` activates the process-local update latch.
It reads `response.clone()` and returns the original response unchanged so
Supabase and service callers retain the actual error/status/body.

Different 409, 401, 403, 42501, network failures, 500 and malformed JSON do not
activate the latch. A response arriving before React mounts is retained, and
duplicate responses do not produce duplicate notifications.

The existing `UpdateBanner` consumes the latch as `mandatory`: assertive alert,
“Actualizá la aplicación para continuar.”, one Update action and no dismiss
button. A previously dismissed optional notice cannot suppress it. The existing
rail, dark visual island, mobile safe-area handling and 44 px targets remain.
It deliberately leaves forms mounted so users can recover/copy entered data.
The future server gate will deny incompatible Data API work; this banner is
not a frontend authorization barrier.

No auto logout, session mutation, storage clearing or automatic reload. A user
click awaits all legacy service-worker unregistrations and then uses
`location.replace()` on the same path/query/hash with a fresh `_tr_update`
nonce. Repeated manual attempts replace that nonce. The current app registers
no SW; its deployment emits content-hashed assets, `version.json` and an SPA
index rewrite. Fresh document navigation avoids reusing the old document URL;
awaited unregistration prevents a historical SW from controlling the next
document. No new SW or blanket CacheStorage deletion is introduced. Preparation
failure shows a retry action; there is no automatic loop. As with any user
reload, unsaved in-memory form state is not persisted by this mechanism.

`/version.json` remains a separate optional build-time notice (initial deferred
check, five-minute polling and focus check). Its dismissal behavior remains.
**Bundles older than R1 cannot recognize CLIENT_UPDATE_REQUIRED.** Their
retirement is future R2 rollout work. The R1 UI alone does not retire them.

## E. Real frontend/schema matrix

| Frontend | Disposable DB | Owner | Limited tech |
| --- | --- | --- | --- |
| R1 | pre-SEC-08E, through SEC-08D | Detail/list/create preserve legitimate prices/subtotals; exact total | Operational behavior; amounts absent; total `null`; zero legacy monetary queries |
| R1 | post-SEC-08E | Detail/list/create work; authorized projected amounts; exact total | Detail/list/create work; amounts absent; total `null` |

The same real central client and services execute against real PostgREST and
PostgreSQL. Only session identity and local gateway path routing are supplied
by the test adapter. Every HTTP request asserts both headers. The pre-schema owner issues exactly
four minimal, scoped legacy monetary queries across detail/list/create/total;
the tech issues zero. Neither actor issues any legacy monetary query post-schema.
Witness values:
existing price `7103.19`, subtotal `21309.57`; synthetic create `2 × 17.25`,
subtotal `34.50`; authorized total including that insertion `21344.07`.
Cross-tenant parts return no rows, order detail rejects with `PGRST116`, and
the post-schema amount projection returns no foreign rows. A cross-tenant
create through the real service propagates PostgreSQL `42501`.

Run from this worktree with Node and a running local Supabase Docker stack:

```sh
node scripts/security/sec08e-r1-local.mjs
```

The runner accepts no database URL or production credentials. It requires the
local `supabase_db_techrepair-vite` source to be pre-SEC-08E, makes a schema-only
clone into a new `sec08e_r1_certification` database, and refuses to replace any
existing database. Source ledger tested: `20260920120000`; remaining main
migrations are replayed only into the clone. No source rows, cron or vault
secrets are copied. Local PostgREST binds a random loopback port.

For the post-schema test only, `git show` reads the existing #110 migration and
synthetic fixture from immutable commit
`a0ff8f75aad09166bc3e1efe160e83ce210b1686` into memory. That Git object must be
available locally (a fresh checkout may need `git fetch origin pull/110/head`).
R1 does not carry another copy of the SQL. The clone and its dedicated REST
container are removed on completion, including test failures. This is a
compatibility test of a future schema, not a production migration runner.

## F. Validation and known baseline debt

- Focused R1/affected banner, mobile foundation and portal suites: **71 passed**.
  Covers exact error matching and all requested negative controls, real central
  SDK headers/error propagation/no logout, mandatory override of dismissal,
  pre-mount/remount latch, local data preservation, retry and SW reload ordering.
- Initial R1 customer core/edit/surfaces and intake wizard: **65 passed**; these
  unrelated surfaces are unchanged by the transition correction.
- Real local pre-schema: **3 passed**, one post-only authorization test skipped
  deliberately. Post-schema: **4 passed**, no skips.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/eslint/bin/eslint.js src --ext .ts,.tsx --quiet`: passed;
  **0 errors, 542 existing warnings**. Changed files have the same warning counts
  as main; new source files have zero warnings. `lint:ci`'s older 100-warning
  budget fails on this unchanged debt; CI uses the zero-error `lint:errors` gate.
- Production build: passed using loopback/dummy environment values. Existing
  warnings: subscription module mixed static/dynamic imports and large PDF chunk.
- Relevant guards and self-tests: UI governance, SEC-08A and phases B/C,
  SEC-08B, SEC-08C, mobile session, PWA identity, finance writes passed.
- Aggregate `npm run guards` stops at the historical SECDEF exposure guard:
  `current_user_can` and `get_order_financial_amounts` in
  `20260912120000_sec08a_phase_b_financial_pivots.sql`. The exact failure was
  reproduced on that file extracted from `origin/main`; migration and guard
  are unchanged. Later relevant guards were executed independently.
- React Router v7 future-flag warnings remain in existing component tests.
- Initial R1 browser verification via agent-browser (UX unchanged by this correction): real local app loaded without runtime errors or
  Vite overlay; injected future response retained its readable 409 body and
  showed the mandatory notice. Desktop and 390×844 light/dark captures inspected;
  mobile banner fits 366 px, button height 44 px, no horizontal overflow.
  Clicking Update navigated once to `/login?_tr_update=…`, retained the local
  draft witness, and returned to the app with no update latch or runtime errors.
  Captures: [desktop light](sec08e-r1-evidence/desktop-light.png),
  [mobile light](sec08e-r1-evidence/mobile-light.png),
  [mobile dark](sec08e-r1-evidence/mobile-dark.png).

CI now runs the focused R1 suites in the existing quality job. Existing E2E
remains enabled and is left to CI after PR creation. The disposable pre/post
runner is a separate explicit local test; it is not silently skipped in CI.

## G. Git delivery

Initial commit: `c01260583221951bdc7e16de13db300d8a7f55c2`,
`feat(platform): add compatible client contract for sec-08e rollout`.
Second commit: `fix(platform): preserve authorized amounts during sec-08e transition`.
Both belong to existing PR #111; no replacement PR or history rewrite.
PR title: `feat(platform): add SEC-08E compatible client contract`, targeting main.
Only the R1 branch is pushed. PR/commit/check identifiers are recorded in the
delivery response after CI for the new head completes; no change is made to #110.

## H. Integrity and sequencing

Production: **zero migrations, DDL, DML, capability changes or deployments**.
R1 includes zero deployable SQL. Synthetic DDL/DML occurred only in the named
disposable local test database, as required for pre/post compatibility tests.
The local source database was read only; original and #110 worktrees preserved.

R1 review and production validation precede R2's backend minimum-client gate;
R3's lockdown follows that retirement gate. Neither later phase is implemented
here. **#110 remains blocked and must not be merged as a single rollout.**
