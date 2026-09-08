# SEC-08E R2 — Backend client contract gate

## A. Baseline

- `origin/main`: `3b8406cfdb37b371309a270eb0360d3d73714e6f`, fetched with prune and tags.
- Branch: `codex/sec08e-r2-client-contract-gate`.
- Isolated worktree: `C:/Users/molin/CascadeProjects/techrepair-vite/.worktrees/sec08e-r2-client-contract-gate`.
- Production latest migration, read-only on 2026-09-08: `20260921120000`.
- Production PostgreSQL: 17.6. Local Supabase PostgREST: 14.5; local PostgreSQL: 17.6.
- PR #110 remains OPEN, not merged, at `a0ff8f75aad09166bc3e1efe160e83ce210b1686`.
- `20260922120000_sec08e_auxiliary_financial_reads.sql` was not copied, edited, or applied.

## B. Gate architecture

`20260923120000_sec08e_r2a_client_contract_gate_disabled.sql` creates:

- the single-row `private.client_contract_config` table;
- `public.check_client_contract()`;
- the database-scoped `pgrst.db_pre_request` setting for `authenticator`.

PostgREST 14.5 calls the hook after it has established transaction-scoped request
settings and changed into the request role. The function reads:

- `current_setting('role', true)`, which was dynamically proven as
  `authenticated`, `anon`, or `service_role`;
- the signed JWT `role` from `request.jwt.claims`;
- the normalized header map from `request.headers`.

An internal exemption requires both the actual database request role and the
signed JWT claim to be `service_role`. `x-role`, `x-user`, `x-business`,
`x-service-role`, client build SHA, timestamps, and the contract header never
influence identity or authority.

The strict exposed-value grammar is `^(0|[1-9][0-9]*)$`. Leading zeros,
negative values, decimals, empty values, alphabetic values, internal whitespace,
and comma-ambiguous representations fail. HTTP optional whitespace around a
field value is removed by the PostgREST 14 HTTP parser before `request.headers`
is created; ` 1 ` therefore reaches the hook as canonical `1` and is accepted.

PostgREST 14 also collapses repeated header fields before `db_pre_request`; the
real raw-socket probe observed two contract fields (`1`, then `2`) as the single
value `2`. The database hook cannot detect multiplicity that the HTTP layer has
already discarded. Any ambiguity it does expose (for example `1,2`) is rejected.
The marker remains non-authoritative, so this parser behavior cannot grant data
access or capabilities.

## C. Rollout

R2A is an atomic installation with explicit state `disabled` and
`minimum_contract = NULL`. The config row is inserted before the hook setting;
if installation fails, PostgreSQL rolls back both. A missing or damaged config
later returns a sanitized 503 only for authenticated Data API traffic. Anonymous
behavior and signed service-role work remain available, avoiding a whole-platform
outage while failing safe for the browser surface.

R2B is `20260923121000_sec08e_r2b_client_contract_gate_minimum_1.sql`. It locks
and verifies the exact R2A disabled state, then atomically sets `enabled` and
minimum 1. R2B must be promoted in a separate operator-controlled release after
R2A is healthy. This work did not apply either migration to production.

R3 remains the later SEC-08E financial lockdown. It is independent from R2B and
must not be combined with client-contract activation.

Emergency disable preserves the Data API and requires only:

```sql
UPDATE private.client_contract_config
SET enforcement_state = 'disabled', minimum_contract = NULL, updated_at = now()
WHERE singleton IS TRUE;
```

If the hook itself must be withdrawn:

```sql
ALTER ROLE authenticator IN DATABASE postgres RESET pgrst.db_pre_request;
NOTIFY pgrst, 'reload config';
```

A request whose pre-request check completed before activation may finish its
existing transaction. Every new request sees the current config and is checked.
The real concurrent test held an admitted RPC open, activated R2B, observed that
RPC complete, and observed a new headerless request fail immediately. There is
no timer, tab count, grace wait, or delayed security mechanism.

## D. Error contract

PostgREST 14.5 requires `DETAIL` to contain both `status` and `headers`. The
productive exception is a `PGRST` SQLSTATE with sanitized JSON and produced:

```http
HTTP/1.1 409
Content-Type: application/json

{
  "code": "CLIENT_UPDATE_REQUIRED",
  "message": "Actualizá la aplicación para continuar.",
  "details": null,
  "hint": null
}
```

The matrix checks the complete JSON object and verifies it contains no function,
schema, SQL, or claim detail.

## E. Coverage

| Surface | Covered | Evidence |
| --- | --- | --- |
| REST GET | Yes | Headerless authenticated GET returned exact 409; contracts 1 and 2 reached RLS. |
| REST POST | Yes | Real `parts_used` insert with `Prefer: return=representation` returned 201. |
| REST PATCH | Yes | Real update with returning completed after the gate. |
| REST DELETE | Yes | Real delete with returning completed after the gate. |
| RPC POST | Yes | `current_user_can_in_business` and a concurrent test RPC were gated. |
| HEAD | Yes | Compatible HEAD reached the table and returned 200. |
| Embed/select relationship | Yes | `orders` with embedded `customers` returned the authorized relation. |
| GraphQL | Yes | Local `pg_graphql` 1.5.11 through `graphql_public.graphql` rejected a headerless request and executed a compatible query through the same PostgREST 14.5 hook. |
| Auth HTTP | No | GoTrue is a separate service. |
| Storage HTTP | No | Storage API is a separate service. |
| Realtime/WebSocket | No | Realtime is a separate service. |
| Edge Function HTTP | No | Edge HTTP itself is separate; its subsequent Data API calls are covered. |
| Direct SQL | No | This is a PostgREST request hook. |

## F. Role behavior

- `authenticated`: checked only after the database role and signed JWT claim
  agree; when enabled it must present an exposed canonical integer at least 1.
- `anon`: remains subject to its existing grants/RLS. The before/after probe
  returned the same existing `42501` response for `businesses`, never the gate's
  409.
- `service_role`: exempt only when both PostgREST identity signals are the
  signed service role. Its test RPC completed with no contract header.
- `authenticator`: connection role only, not accepted as a request identity.

## G. Security properties

`FORGED CONTRACT DOES NOT GRANT AUTHORITY` is a named real test. A limited tech
sent contract `999999`: compatibility passed, while
`current_user_can_in_business(..., 'orders_view_financials')` remained false.
The same actor with contract 1 remained limited. A user from business B with
contract 1 received no rows from business A. The owner with contract 1 retained
normal access. Existing RLS and capability code owns every authorization result.

## H. Edge Functions

The focused inventory found ten functions with service credentials:
`afip-cae`, `afip-fe-query`, `afip-wsaa`, `arca-credentials`,
`arca-rotate-activate`, `arca-rotate-prepare`, `mp-subscription`, `mp-webhook`,
`whatsapp-send`, and `whatsapp-send-message`. Their privileged Data API clients
are already exempt through the signed service role.

Nine functions also construct a user-JWT client. Seven use it only for
`auth.getUser()` and then use a service-role client for Data API work:
`afip-fe-query`, `arca-credentials`, `arca-rotate-activate`,
`arca-rotate-prepare`, `mp-subscription`, `whatsapp-send`, and
`whatsapp-send-message`. Auth is outside this gate, so they require no change.

`afip-wsaa` and `afip-cae` pass the user client to `authorizeArcaCaller`, which
calls `get_my_profile` and `current_user_can_in_business` over PostgREST. They now
forward the incoming contract header exactly. They do not invent a missing
header or sanitize a malformed one; the backend gate makes that decision.
Three Deno tests cover compatible, missing, and malformed forwarding, and both
complete Edge entrypoints pass `deno check`.

## I. Tests

- R2 real PostgreSQL/PostgREST matrix: **33/33 passed**.
- Edge contract forwarding: **3/3 passed**.
- R1 focused component contract/update/reload regression: **22/22 passed**.
- R1 real pre-SEC-08E matrix: **3 passed, 1 intentional post-only skip**.
- R1 real post-SEC-08E compatibility matrix: **4/4 passed**. The R3 schema was
  applied only inside R1's disposable certification database from immutable
  #110 test material, never to the source or production.
- SEC-08A, SEC-08A phase B, SEC-08A phase C, SEC-08B, and SEC-08C static guards:
  **5/5 passed**.
- `deno check` for `afip-wsaa/index.ts` and `afip-cae/index.ts`: passed.
- `git diff --check`: passed.

The R2 runner creates a schema-only disposable database and a dedicated
loopback-only PostgREST container. It refuses to replace an existing database,
copies no source rows/secrets/cron, verifies ownership before cleanup, and removes
both resources after success or failure.

## J. public.users supplemental discovery

**SEC-08 SUPPLEMENTAL OPEN BLOCKER CONFIRMED — public.users cross-tenant PII.**

Read-only production evidence, without printing row values:

- `public.users` exists and contains 3 rows.
- It contains `name`, `email`, `phone`, and `role` plus operational columns.
- Policy `users_select` is `TO authenticated USING (true)`.
- A real `SET LOCAL ROLE authenticated; SELECT count(*)` saw all 3 rows.
- All 3 legacy IDs currently lack a matching `profiles.id`.
- `profiles` provides the tenant-aware replacement fields `business_id`,
  `full_name`, `email`, `phone`, `role`, `is_active`, and permissions.
- No production database function or view definition matched a read from the
  legacy table.
- Production has 0 orders with `technician_id` and 6 with
  `assigned_profile_id`, but the FK `orders_technician_id_fkey` still references
  `public.users(id)`.
- Live frontend readers remain: order embeds in `api.ts`/`useOrder.ts`, fallback
  lookups in `useOrderSimple.ts`, `Reports.tsx`, and the legacy `api.ts`
  `usersService`. The newer management service reads `business_users_view`.

Closing `users_select` immediately would stop the confirmed disclosure, but the
remaining order relationship and frontend reads could fail or lose technician
names. SEC-08F/final closure must first move technician identity fully to
`profiles`/`assigned_profile_id`, remove legacy readers and the FK dependency,
then revoke or retire `public.users` in a separate change.

## K. Changed files

- Two R2 migrations: disabled infrastructure and explicit activation.
- R2 disposable real-stack runner and production read-only discovery SQL.
- Shared Edge forwarding helper, two necessary callers, and three Deno tests.
- `package.json` adds the focused `test:sec08e-r2` command.
- This audit/rollout report.

No frontend source, Orders V2 surfaces, customer/device intake, checklist UI,
print cleanup, customer edit, or R3 SQL changed.

## L. Git and CI

The implementation is intended as two commits: R2A infrastructure first, then
R2B activation plus evidence. The branch is pushed and proposed to `main` for
review only. CI status is recorded in the PR; no merge, deploy, or tag is part
of this block.

## M. Integrity

- No production migration, gate activation, deploy, merge, or tag.
- No application of SEC-08E R3.
- No changes to PR #110.
- No changes or reversions to Orders V2.
- No changes to R1 frontend behavior.
