# ARCA Self-Service · Phase 1 — canonical status read model + integration card

Baseline: `main` = `41cd3eb08c55200fb033d63209bf4585b7f64069` (prod DB `20260928120000`).
**Read-only.** No Vault writes, no key/CSR generation, no certificate upload or activation, no
rotation, no WSAA refresh, no FECompConsultar/FECAESolicitar, no row mutation.

## A. Contract — `public.get_arca_selfservice_status(p_business_id uuid DEFAULT NULL) → jsonb`

```jsonc
{
  "contract_version": 1,
  "available": true,                // plan has feature 'arca'; false → shape kept, no metadata
  "status": "connected",            // unavailable | not_configured | setup_in_progress |
                                    // pending_verification | connected | attention
  "configured": true,
  "environment": "produccion",      // homologacion | produccion | null (anything else → null)
  "cuit": "20XXXXXXXXX",            // 11 digits or null
  "razon_social": "…", "punto_venta": 10, "alias": "…",
  "certificate": {
    "present": true,
    "expires_at": "2028-07-25T23:58:12+00:00",   // notAfter of the X.509, never arca_config.expires_at
    "days_remaining": 681,
    "renewal_state": "healthy",     // not_configured | unknown | healthy | expiring | urgent | expired
    "matches_credential": true
  },
  "credential": { "active": true },
  "connection": { "state": "connected", "last_verified_at": "2026-09-11T13:31:12.597+00:00" },
  "setup": { "state": "completed", "kind": null, "step": null, "started_at": null },
  "attention": [],                  // bounded enum, see G
  "can_manage": true,
  "next_action": "none"             // start_setup | continue_setup | verify_connection | renew_certificate | none
}
```

Additions versus the brief, all derived from real schema: `contract_version`, `available`, a
server-side `status` summary (so the UI never infers it), `certificate.matches_credential`,
`renewal_state = unknown` (certificate present but unparseable), `setup.started_at`, `attention`.

## B. Factual source of every field

| Field | Source (read in the SECURITY DEFINER RPC, owned by postgres) |
|---|---|
| environment, cuit, razon_social, punto_venta, alias | `public.arca_config` (bounded/normalized: `arca_norm_cuit`, PV 1..99998) |
| certificate.present | `arca_config.cert_file` non-blank |
| certificate.expires_at / days_remaining / renewal_state | `private.arca_cert_validity(private.arca_pem_to_der(cert_file)).not_after` vs `now()` |
| certificate.matches_credential | SPKI SHA-256 of the cert (`arca_rsa_pubkey_from_cert` → `arca_rsa_public_key_fingerprint_sha256`) = `arca_private_key_credentials.private_key_fingerprint`. **Vault is never decrypted** |
| credential.active | `arca_private_key_credentials.credential_status = 'active'` AND the `vault.secrets` row EXISTS |
| connection.state / last_verified_at | `arca_config.estado_conexion` ∈ {`conectado`,`error`} + `ultima_sincronizacion`, both written server-side by `afip-wsaa`; evidence older than `coalesce(credential.rotated_at, created_at)` is ignored |
| setup.* | `private.arca_credential_rotations` rows in `pending_rotation` / `activated_pending_verification` only |
| can_manage | `private.arca_actor_can_manage(tenant, auth.uid())` (Phase 0 authority) |
| available | `public.business_has_feature('arca')` |
| status, attention, next_action | derived from the facts above in `private.arca_selfservice_status` |

Never read by the read model: `wsaa_token`, `wsaa_sign`, `vault.decrypted_secrets`, `csr_pem`,
`certificate_pem`, `prev_*` checkpoints, `pfx_password`, `ultimo_error` (the migration's own
post-condition aborts if the derivation source mentions any of them). `pfx_file` is read for presence only.

Production measurement (read-only, 2026-09-12): exactly one `arca_config` row (Clic): `conectado`,
last sync 2026-09-11 13:31 UTC, credential active since 2026-07-27 11:58 UTC with Vault secret present,
cert notAfter 2028-07-25 23:58:12 UTC (= stored `expires_at`), cert SPKI matches the credential, one
rotation `completed/purged`, owner has `can_manage`, plan has `arca`. Derivation ⇒
`connected / healthy / completed / none / can_manage=true`.

## C. Authorization

| | Rule |
|---|---|
| EXECUTE | `authenticated` only (REVOKE PUBLIC, anon, service_role). Derivation `private.arca_selfservice_status` has no EXECUTE for any client role or service_role and is **not** SECURITY DEFINER |
| Read | tenant = `get_my_profile().business_id`, must be in `user_business_ids()` (active membership) — same semantics as `get_arca_config_safe`. Unauthenticated → `42501 UNAUTHENTICATED`; inactive / no tenant → `42501 FORBIDDEN` |
| `p_business_id` | confirmation only; ≠ resolved tenant → `42501 FORBIDDEN`. Never used as authority |
| Plan without `arca` | stable shape, `available=false`, no metadata, `can_manage=false`, `next_action=none` |
| can_manage | canonical Phase 0 rule: active profile AND owner/admin AND `settings_sensitive`. The UI uses it for copy only; management stays re-authorized server-side |

## D. Implementation

`supabase/migrations/20260929120000_arca_selfservice_phase1_status_read_model.sql` — one transaction,
two functions, grants, post-conditions (grants, SECDEF flags, forbidden reads, `get_arca_config_safe`
kept). No DDL on tables, no DML.

## E. Secret-exposure proof

- SQL S19: the exact key set of the response is asserted for owner / tech / no-plan tenant with every
  sentinel seeded (cert PEM, token, sign, Vault secret, CSR, `ultimo_error`, fingerprint); none appear;
  `secret_id` not present.
- HTTP: every 200 response (11 actors × POST/GET × with/without confirmation) checks the exact root key
  set and absence of 17 forbidden strings.
- Static guard S3/S4: forbidden reads + output keys ⊆ allowlist across every `jsonb_build_object`.
- UI parser copies only contract fields; component test feeds a payload with `cert_file`, `wsaa_token`,
  `certificate_pem`, `csr_pem`… and asserts they are dropped.

## F. Pending-state derivation

| Rotation state | setup | kind | step |
|---|---|---|---|
| `pending_rotation` | in_progress | renewal if an active credential exists, else initial | `certificate` (CSR exists, waiting for ARCA's certificate) |
| `activated_pending_verification` | in_progress | idem | `verification` |
| `completed` (incl. purged), `rolled_back`, `cancelled`, `failed`, `activation_failed` | completed if configured, else not_started | null | null |

`csr` and `activation` steps are reserved in the enum for Phase 2 (no current state maps to them).
A renewal waiting for the certificate keeps `status=connected` (the live credential still signs) and
adds a notice.

## G. Renewal-state derivation

`expired` if notAfter ≤ now · `urgent` if ≤ 15 days · `expiring` if ≤ 60 days · else `healthy`
(boundaries inclusive, tested at ±1 s). `days_remaining = floor(seconds/86400)`, 0 when expired.
Certificate absent → `not_configured`; present but unparseable → `unknown` + `certificate_unreadable`.

Attention reasons: `certificate_expired`, `certificate_unreadable`, `credential_certificate_mismatch`,
`credential_missing` (cert without active credential), `certificate_missing` (credential without cert),
`connection_error`, `legacy_pfx`.

`status`: attention if any reason · else setup_in_progress (in progress and not configured) · else
not_configured · else pending_verification (activated rotation or connection ≠ connected) · else connected.

## H. next_action rules (first match)

1. rotation in progress → `continue_setup`
2. not configured → `start_setup`
3. renewal expired/urgent/expiring/unknown or pair mismatch → `renew_certificate`
4. connection ≠ connected → `verify_connection`
5. → `none`

`next_action` describes what the business needs, independent of the viewer; the UI decides what to
offer using `can_manage`.

**Product decision (Phase 1):** start/continue/renew have no UI yet. The card surfaces the warning as
**informational text** and renders no button for them (no dead CTA). `verify_connection` is served by
the pre-existing “Probar conexión” button (owner/admin only, behaviour unchanged).

## I–L. UI

- `src/lib/arcaStatus.ts` — pure contract parser (fail-closed: any unknown enum/shape → null) + copy.
- `src/components/settings/ArcaStatusCard.tsx` — presentation only (tokens, light/dark, lucide icons,
  `dl` metadata grid, notices). No Supabase access.
- `Settings.tsx` → Integración ARCA: the two banners and the left “Estado de Conexión” panel that
  interpreted `estado_conexion`/`ultimo_error` are replaced by the card. The configuration form (PV
  editable, identity locked) and its data-testids are kept, and shown only when ARCA is configured.
  Mobile: stack grid `minmax(0,1fr)`, form grid auto-fit, buttons wrap.
- **Empty state** (new tenant): “No configurado” + “ARCA todavía no está configurado” + “Conectá tu
  negocio con ARCA…”. No technical form.
- **owner/admin** (`can_manage`): empty state says the guided assistant is coming; configured state
  keeps “Probar conexión”, “Guardar configuración”, “Sincronizar parámetros”.
- **non-manager**: same status card, read-only notice kept, empty state asks the owner/admin.
- No CSR / PKCS#10 / Vault / WSAA / fingerprint wording (asserted in the component test).

Evidence (local stack, synthetic certificate): `evidence/owner-connected-{desktop,mobile}.png`,
`evidence/owner-not-configured-{desktop,mobile}.png`.

## M–N. Tests and guards

| Suite | Result (local) |
|---|---|
| `tests/sql/arca_phase1_status.test.sql` (`npm run test:sql:arca-phase1`) | 20/20 — covers A–P of the brief plus C′ (credential without Vault secret), D′ (never verified), D″ (evidence older than credential), mismatch, unreadable, PFX, all terminal rotation states, bounded free-text `estado_conexion` |
| Negative control: 8 mutants of the migration (completed counted as in progress, loose `estado_conexion`, raw `estado_conexion` in output, `can_manage=true`, foreign `p_business_id` accepted, cert-only = configured, urgent at 30 days, stale evidence counted) | 8/8 caught; a 9th (`ultimo_error` in output) is rejected by the migration post-condition itself |
| `scripts/security/arca-phase1-postgrest.mjs` | 876 assertions / 53 HTTP requests / 0 failures |
| `tests/components/arcaPhase1Status.test.tsx` | 28/28 |
| `scripts/guards/arca-phase1-status-contract.mjs` + `--self-test` | OK; 14 planted violations each caught by its own rule |
| Phase 0 regressions: `test:arca-phase0`, `test:sql:arca-phase0`, `tests/unit/arcaConfigWriteContract` | green |

CI runs `npm run test:arca-phase1` (static + jsdom). SQL/HTTP suites need the local stack.

## O. Rollout compatibility

| Frontend | Backend | Result |
|---|---|---|
| old | old | today |
| old | **Phase 1** | unchanged: old UI never calls the new RPC; `get_arca_config_safe` untouched |
| **new** | old | safe but degraded: RPC 404 → card “No se pudo leer el estado de ARCA”; config form still shown from `get_arca_config_safe` presence flags; emission unaffected |
| **new** | **Phase 1** | target |

**Order: DB first, then frontend.** A. read-only preflight (`preflight-readonly.sql`) → B. `supabase db
push --linked` (dry-run must list exactly `20260929120000`) → C. `postdeploy-verify-readonly.sql` →
D. merge → Vercel → E. verify served bundle contains `get_arca_selfservice_status` in the Settings
chunk (search every `assets/*.js`) → F. owner human smoke. No Edge redeploy.

## P. Rollback

- Frontend: redeploy the previous Vercel deployment.
- DB: `rollback.sql` (drops the two functions, asserts `get_arca_config_safe` intact) then
  `supabase migration repair --status reverted 20260929120000`. Verified locally: rollback → re-apply →
  20/20. Reopens nothing (Phase 1 added no write path).

## Q. Production-safe verification plan

1. `preflight-readonly.sql` — run 2026-09-12 (read-only): tip `20260928120000`, Phase 1 absent,
   helpers present, no rotation in progress, Clic owner `can_manage=true`, audit max id 50, vault 54.
2. After push: `postdeploy-verify-readonly.sql` inside `BEGIN READ ONLY … ROLLBACK`: catalog; Clic via
   derivation and via RPC with owner claims; fingerprint (cert md5, credential fp8, rotations, audit max
   id, vault count) identical to step 1.
3. Browser: Clic owner → Configuración → Integración ARCA shows Conectado / Producción / PV 10 /
   Vigente / 25/07/2028 / last connection date. Do **not** press “Probar conexión” (it forces a WSAA
   refresh — Phase 2 debt). No test invoice.

## Phase 2 notes

- The contract already carries `setup.kind/step/started_at`; Phase 2 adds states by mapping new rotation
  states (e.g. initial setup without an active credential) — no API replacement needed; bump
  `contract_version` only for breaking changes.
- `testConnection` still forces a WSAA refresh; `getPuntosVenta` is synthetic (unchanged from Phase 0).
