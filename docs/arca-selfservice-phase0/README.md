# ARCA Self-Service · Phase 0 — legacy write hardening + canonical owner/admin authority

Baseline: `main` = `0fc37104c5d5eb81da20cbaef2dae6c0ee061b33` (prod DB `20260927120000`).
Security hardening only. No wizard, no CSR generation, no Vault writes, no credential rotation.

## Canonical ARCA management authority

```
active profile of the actor IN that business
AND role IN ('owner','admin')
AND settings_sensitive resolves TRUE (private.capability_resolve)
```

| Layer | Implementation |
|---|---|
| SQL | `private.arca_actor_can_manage(business, actor)`; `public.is_business_owner_or_admin` now delegates to it (same signature, still service_role-only) |
| Edge | `_shared/arcaManagementAuthority.ts::authorizeArcaManager` = `authorizeArcaCaller({capability:'settings_sensitive', roles:['owner','admin']})`, users only; `resolveManagedBusiness` rejects a body `business_id` ≠ tenant |
| UI | `src/lib/arcaAuthority.ts::canManageArca` (presentation only) |

A manager with `settings_sensitive=true` does not pass. An admin with `settings_sensitive=false`
does not pass. Inactive owner/admin, cross-business, malformed override: fail closed.

`afip-wsaa` is unchanged (capability-only, `roles` not passed) and is not redeployed.

## What changed

| Unsafe path (before) | After |
|---|---|
| `save_arca_certificate_legacy`: owner/admin replaced `cert_file` with no key/CUIT/validity check | Fail-closed stub `ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED`, no EXECUTE for anyone, not SECDEF |
| `set_arca_estado_conexion`: browser wrote `estado_conexion` | Fail-closed stub `ARCA_CLIENT_CONNECTION_STATE_WRITE_RETIRED`; `afip-wsaa` records state server-side |
| `save_arca_config_legacy`: CUIT/alias/ambiente/web_service/expires_at freely mutable | See field set below |
| `arca_config` table: anon/authenticated `INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN` + policy `arca_config_plan_write` (ALL, any member role) | `REVOKE ALL` from PUBLIC/anon/authenticated; policy dropped; only service_role policies remain |
| `arca-credentials` Edge accepted `private_key_pem` | 410 stub, never reads the body |
| `arca-rotate-prepare/activate` took tenant from body + `is_business_owner_or_admin` | `authorizeArcaManager` + `resolveManagedBusiness` + SQL defence in depth |
| Settings ARCA tab: certificate textarea, retired CSR button, CSR banner, client state writes, no role gate | Removed; management gated; identity fields read-only when a certificate/credential exists |

### Final `save_arca_config_legacy` field set (signature unchanged)

| Field | Rule | Why |
|---|---|---|
| `razon_social` | editable | business data, not part of the certificate subject |
| `punto_venta` | editable, 1..99998 | each emission attempt snapshots its PV at claim (`arca_emission_attempts.punto_venta`); ARCA rejects a PV not enabled |
| `cuit`, `alias`, `ambiente` | editable only with NO active credential and NO certificate; otherwise must equal stored (`ARCA_FIELD_LOCKED`) | subject is `CN=alias, serialNumber=CUIT`; ambiente selects the WSAA/WSFE endpoint |
| `web_service` | never (null or stored value) | emission always uses `wsfe` |
| `expires_at` | never (null or stored value) | derived from the X.509 by rotation finalization |

Tenant is resolved by identity (`get_my_profile`); a foreign `p_business_id` is `FORBIDDEN`.

## Legitimate writers kept (all outside anon/authenticated)

- `afip-wsaa` (service_role client): WSAA token/sign cache and `estado_conexion`.
- SECURITY DEFINER RPCs owned by postgres: rotation activate/finalize/rollback, `save_arca_config_legacy`.
- `afip-cae` reads via `afip-wsaa` and claim RPCs; never writes `arca_config`.
- postgres for local seeds/fixtures.

## Rollout compatibility matrix

| Frontend | Backend | Result |
|---|---|---|
| old | old | today's production. Unsafe paths reachable |
| **new** | old | **safe.** New UI calls only `get_arca_config_safe` and `save_arca_config_legacy` with the same signature (`p_web_service`/`p_expires_at` null → preserved; identity null when locked → preserved). No retired RPC, no textarea, no client state write. The backend is still permissive for other clients until step C |
| old (stale tab) | hardened | fail closed and visible: pasting a certificate → `ARCA_LEGACY_CERTIFICATE_WRITE_RETIRED` alert; unchanged identity + PV edit → OK (SQL A07 proves the old payload shape); a failed connection test no longer persists `estado_conexion` (the old client swallows that RPC error in a try/catch) |
| **new** | hardened | **target.** Proven locally over HTTP and in a real browser |

### Intended sequence (owner approval required at each step)

A. Merge the PR → Vercel deploys the new frontend (no backend dependency).
B. Verify the SERVED bundle: no `save_arca_certificate_legacy`/`set_arca_estado_conexion`/`private_key_pem` strings in the lazy chunks (search every `assets/*.js`, not just `index-*.js`).
C. Read-only preflight (`preflight-readonly.sql`), then `supabase db push --linked` of `20260928120000`. Its own post-conditions abort the transaction on any deviation.
D. Redeploy `arca-credentials` (410 stub), `arca-rotate-prepare` and `arca-rotate-activate` with verify_jwt as declared in `config.toml` (true). Do **not** redeploy `afip-wsaa` or `afip-cae`.
E. Verify: catalog fingerprint (the migration post-conditions again, read-only); HTTP anon → `arca-credentials` 410; the active credential fingerprint is still `72cd45e0…` and `expires_at` is unchanged; the Clic owner sees the panel. No WSAA force refresh, no FECAESolicitar, no test invoice. The next organic emission proves `afip-cae` → `afip-wsaa` → Vault.

Step D is independent of C: the rotation endpoints work against both backends (the SQL helper exists either way).

## Rollback

- Frontend: redeploy the previous Vercel deployment.
- DB: `rollback.sql` (manual, transactional). Verified locally: after running it, the normalized source hash, SECDEF flag and ACL of the 4 functions, the `arca_config` client ACLs and the policies match the production catalog measured 2026-09-12. Re-applying Phase 0 afterwards reproduces the identical catalog. **It reopens the exposures**; prefer a partial rollback (authority section vs table-grant section are independent). Then run `supabase migration repair --status reverted 20260928120000`.
- Edge: redeploy the previous `arca-credentials`/`arca-rotate-*` from `0fc3710` (the stub only removes a dormant path; rollback is almost never needed).
- None of these touch credentials, Vault, rotations, `cert_file` or the WSAA cache.

## Evidence

- `tests/sql/arca_phase0_hardening.test.sql`: 13/13 (auth matrix, grants, stubs, locked fields, service_role cache, read model, credential material unchanged).
- `scripts/security/arca-phase0-postgrest.mjs`: 101 assertions / 93 real HTTP requests, 0 failures.
  Negative control (`ARCA_P0_NEGATIVE_CONTROL=1` against the rolled-back = production contract): 22/101 fail. Owner PATCH-equivalent via `save_arca_certificate_legacy` replaced a live certificate with an attacker certificate; CUIT/ambiente/alias/expires_at were changed; tech/viewer INSERT passed privileges + RLS (stopped only by the unique key); admin with `settings_sensitive=false` authorized.
- `scripts/guards/arca-phase0-legacy-writes.mjs`: self-test 21 fixtures; runs in CI (`npm run test:arca-phase0`).
- Deno: `arcaManagementAuthority.test.ts`, `arcaCredentialsRetired.test.ts` (full suite 190/190).
- Visual: `evidence/` — owner without certificate, owner with certificate (identity locked, PV save round-trip through the hardened RPC, certificate unchanged), admin without `settings_sensitive` (read-only).

## Phase 2 debt recorded (not done here)

- `testConnection` still forces a WSAA refresh (`force_refresh: true`) on the live credential, and a manager with a `settings_sensitive=true` override can still trigger it via `afip-wsaa` (capability-only by design; not redeployed in Phase 0).
- `getPuntosVenta` still returns the configured PV instead of querying `FEParamGetPtosVenta`.
- `arca_store_credential` (service_role-only) remains dormant with no caller; retire or reuse in the setup phase.
- Rotation endpoints still echo any `Origin` in CORS (CORS is out of scope for this phase).
