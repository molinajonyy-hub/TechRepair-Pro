# Lote 0 — WSAA authorization containment

Scope: WSAA entry authorization and the unavoidable CAE caller boundary. No
migration, RLS, RPC definition, financial calculation, certificate, Vault secret,
or credential rotation is included. No public Beta certification is implied.

## Baseline and production evidence before deployment

- Original checkout HEAD: `70a2d181384e72d028d8c808f6e99b2061d21438`.
- Fetched `origin/main`: `89e46033f389724446408eacf21eb41fc67f3011`.
- Implementation worktree: `techrepair-wsaa-containment`, branch
  `codex/wsaa-lote0-containment`, based on that remote main.
- Original checkout had no tracked edits. Its preexisting untracked discovery
  documents and mobile audit/evidence files were left untouched.
- Production project: `vrdxxmjzxhfgqlnxmbwx` (`techrepair-pro`). CLI: `2.109.1`.
- Measured via `supabase functions list --project-ref vrdxxmjzxhfgqlnxmbwx -o json`:

| Function | Version | Status | verify_jwt | updated_at (Unix ms) |
| --- | --- | --- | --- | --- |
| afip-wsaa | 12 | ACTIVE | false | 1785275733406 |
| afip-cae | 18 | ACTIVE | true | 1787090670817 |
| afip-fe-query (unchanged) | 3 | ACTIVE | true | 1786649063247 |

Downloaded production source equals the baseline source after CRLF-to-LF
normalization. SHA-256 values:

| Source | SHA-256 |
| --- | --- |
| afip-wsaa/index.ts | 0779ad6e392fcfbf94f2edf5ab6e4ee63dd7c628b6b4611a533720351935cfa5 |
| afip-wsaa/keyResolver.ts | 7109489996a36515237792380b8f12b0288dbf8081a80a9fc50e26a984b5c759 |
| afip-cae/index.ts | a81a19dc9f3baeb284bf2a09c2cbe9bfeb6ba7548f86ddaa647d93a5af8d134c |

Source equality was independently checked before editing. No request against another customer's
configuration was used to reproduce the vulnerable behavior.

## Threat model and callers

The old deployed WSAA handler accepted body-selected business IDs before any
identity/membership/capability check. With gateway verification disabled,
anonymous requests could reach privileged configuration reads, credential
resolution/refresh and token/sign responses. Authenticated foreign-tenant and
same-tenant callers without fiscal settings authority were equally unchecked.
This proves an exposed code path, not historical unauthorized access.

| Caller | Runtime / authorization | Business ID source | Needs token/sign | Beta-required |
| --- | --- | --- | --- | --- |
| Settings → ArcaService.testConnection → getWSAAToken | Browser, session user JWT | AuthContext business | No; only presence flags | Yes, configuration/test |
| afip-cae | Edge, Supabase client sends configured service credential | Persisted emission attempt, now scoped to verified caller business | Yes, WSFE internal use | Yes, issuance |
| afip-fe-query | Edge, service credential after existing user/active profile/owner-admin/business checks | Verified profile | Yes, read-only WSFE queries | Yes, query/reconciliation UI |
| scripts/audit-arca-cae-integrity.mjs | Operator CLI, explicit service credential | Selected audit candidate | Yes, internal read-only query | Operational tooling, not automatic Beta path |
| Tests/guards/docs | Offline mocks or source references | Synthetic fixtures | Synthetic only | Validation only |

No other runtime WSAA callers were found. All actual calls use service `wsfe`.
Supabase SDK code and an offline transport test establish the internal
`Authorization: Bearer <configured service key>` behavior without exposing a key.
The browser's only token consumer tested token/sign truthiness; its adapter now
reads tokenOk/signOk. The old browser still receives the successful connection
response, but its diagnostic flags remain false until the adapter is released.
No frontend production deployment is part of this lot.

## Implemented authorization contract

- WSAA human: verify bearer with Auth `getUser`, read `get_my_profile` with that
  user's JWT, require the matching active canonical identity, check the existing
  `current_user_can('settings_sensitive')`, and match the body business ID.
- CAE human: the same identity/membership contract with `comprobantes`. Its
  service-role attempt lookup additionally filters by the verified business.
  CAE cannot relay a foreign attempt to WSAA. This minimal CAE change is required:
  before containment it had no in-function user check despite using service role.
- WSAA internal: constant-time digest comparison with the exact existing
  `SUPABASE_SERVICE_ROLE_KEY`. No trust in decoded role claims, Origin or an
  unsigned internal header. The server caller owns tenant authorization.
- Production definitions of `get_my_profile` and `current_user_can` were read
  before implementation. Existing role defaults and boolean overrides remain
  authoritative; malformed restrictions fail closed. No new role/capability.
- Service clients/configuration/Vault/WSAA are reached only after authorization.
  Rejected requests cannot write configuration or its error fields.
- Browser responses allowlist success, presence/cache flags and optional expiry;
  token/sign remain on the verified internal path only.
- Unexpected errors use a fixed sanitized message. Error writes use only the
  previously authorized context, never a re-parsed body.
- JWT gateway verification is explicitly true for WSAA and CAE in config.toml.
  CORS remains a browser policy, not authorization.

## Local validation

All fixtures/mock transports are offline; no test issues a fiscal document.

```powershell
npm.cmd run typecheck
npm.cmd run lint:errors
node node_modules/eslint/bin/eslint.js supabase/functions/_shared/arcaAuthorization.ts supabase/functions/afip-wsaa/authorizationBoundary.ts tests/unit/arcaWsaaAuthorization.test.ts --quiet
deno check supabase/functions/afip-wsaa/index.ts supabase/functions/afip-cae/index.ts
node --test "tests/unit/arca*.test.ts" "tests/unit/afip*.test.ts" tests/unit/auditScriptExecution.test.ts
deno test --allow-env tests/deno/arcaWsaaCrypto.test.ts tests/deno/afipCaePreSend.test.ts
node scripts/finance/guard-afip-s2-wsaa-vault.mjs
node scripts/finance/guard-afip-s4c-legacy-purge.mjs
node scripts/guards/afip-query-readonly.mjs
node scripts/guards/sales-point-contract.mjs
npm.cmd run build
git diff --check
```

Coverage includes anonymous/invalid identity, foreign business, absent fiscal
capability, inactive profiles, malformed permissions, canonical and legacy
membership, cached and refreshed mock responses, secret response filtering,
authenticated error writes, the actual Supabase internal transport, and both
allowed/scoped-rejected CAE pre-send paths. Existing signing and fiscal
reconciliation behavior remains covered. Build warnings about chunk size and
mixed static/dynamic imports are unrelated and were not changed.

## Limited deployment and post-deployment protocol

Commit and push the dedicated branch only after green gates. CAE goes first to
close its privileged relay while old WSAA remains compatible; then deploy WSAA.
CLI 2.109.1 help supports these exact single-function commands:

```powershell
supabase functions deploy afip-cae --project-ref vrdxxmjzxhfgqlnxmbwx --use-api
supabase functions deploy afip-wsaa --project-ref vrdxxmjzxhfgqlnxmbwx --use-api
supabase functions list --project-ref vrdxxmjzxhfgqlnxmbwx -o json
```

Never deploy all functions, use --prune or pass --no-verify-jwt for these targets.
Download deployed sources into a separate temporary directory for comparison.
Anonymous/invalid-JWT POSTs must return 401/403 with no token/sign/config. Check
allowed/disallowed-origin preflights separately. A foreign-tenant production
test requires two isolated QA accounts; never select another real customer.

The available own account was verified active with both capabilities, but has
no ARCA configuration. Its safe production smoke can establish authorization
and the expected configuration-not-found response, not a real cached-ticket or
issuance success. Do not create configuration or refresh/rotate credentials to
turn that limitation into a passing operational test. Report it explicitly.

## Remaining WSAA-only debt

- An authorized configured QA tenant is needed for a positive cached-ticket
  production smoke; two isolated QA tenants are needed for cross-tenant smoke.
- The existing fe-query caller uses owner/admin checks rather than sensitive
  capability overrides and has narrower legacy-profile handling. Unchanged.
- Existing service credentials identify a shared trusted server class, not an
  individual Edge; per-caller least privilege is a later design task.
- Historical access was not assessed in this containment lot. Exposed code is
  not proof of abuse; any evidence of actual abuse needs separate incident and
  revocation decisions. Do not automatically rotate credentials.
- Existing WSAA cache/refresh concurrency, fallback environment/PFX behavior and
  cache-write error handling are unchanged and remain outside this auth fix.

Stop after deployment certification and safe smokes; await independent review.
