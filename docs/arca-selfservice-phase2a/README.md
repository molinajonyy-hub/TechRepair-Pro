# ARCA Self-Service · Phase 2A — initial setup engine + wizard contract

Baseline: `main` = `228d53081a174757fcd5a521e6704b0cde4cbb58` (prod DB `20260929120000`).
Candidate migration: `20260930120000_arca_selfservice_phase2a_initial_setup.sql`.
New Edge Function: `arca-selfservice-setup` (`verify_jwt = true`). **Not merged, not deployed.**

A business with **no** ARCA credential can configure ARCA end to end:
fiscal data → server-side RSA key (Vault only) → PKCS#10 CSR → user submits it to ARCA → uploads the
issued certificate → structural validation → **non-fiscal** WSAA LoginCms with the PENDING pair →
atomic activation. **PENDING → VERIFY → ACTIVATE**, never "activate and hope".

Renewal is out of scope. Any business with a credential row (any status), a loaded certificate/PFX, or
a live renewal row is refused with `ARCA_ALREADY_CONFIGURED` by every setup RPC. Clic is excluded by
construction and was never touched.

An adversarial design review (security / ARCA protocol / state machine) ran before implementation.
It found 2 blockers and 6 majors, all folded in: `cuit_emisor` for emission, Phase 1 guard self-test
targeting, certificate identity by DER bytes, `setup_kind='initial'` scoping, WSAA HTTP-500 faults,
ticket loss / concurrent verifies, issuer label semantics, and idempotency-key reuse after cancel.

---

## A. Reusable backend pieces (exact)

| Piece | Where | Reused for |
|---|---|---|
| `private.arca_actor_can_manage` / `public.is_business_owner_or_admin` | Phase 0 | authority in every setup RPC |
| `authorizeArcaManager`, `resolveManagedBusiness` | `_shared/arcaManagementAuthority.ts` | Edge authority |
| `private.arca_credential_rotations` + one-pending unique index | S4A / S4B-2A / S4B-2C | the setup state machine |
| `private.arca_rsa_pubkey_from_private/_from_csr/_from_cert`, `arca_rsa_public_key_fingerprint_sha256`, `arca_csr_subject`, `arca_canonical_subject`, `arca_x500_name`, `arca_pem_to_der`, `arca_key_fingerprint` | S3A / S4A / S4B-1b | key/CSR/cert structural parsing |
| `private.arca_validate_rotation_certificate` | S4B-2A | single CERTIFICATE block, no private key, RSA ≥2048 e=65537, SPKI == pending key, exact subject, notBefore/notAfter |
| `private.arca_cert_validity`, `arca_key_matches_certificate`, `arca_get_private_key_for_signing` | S4B-2A / S3A | activation readback |
| `vault.create_secret` + readback in one savepoint | S4A pattern | no orphan secrets |
| key/CSR generation parameters (RSA 2048, e=65537, SHA-256) | `arca-rotate-prepare` | `arca-selfservice-setup/crypto.ts` |
| `toAfipDate`, `buildTRA`, `verifyCertKeyMatch`, `signTRAWithPEM`, `callWSAA`, `parseWSAAResponse` | `afip-wsaa/index.ts` | `_shared/wsaaLogin.ts` (verbatim, guard-pinned) |
| `_shared/scopedCors.ts` | canonical CORS allowlist | Edge CORS (no new origins) |
| `get_arca_selfservice_status` | Phase 1 | wizard step authority |

Measured production facts used (read-only): the live certificate subject is exactly
`CN=<alias>, serialNumber=CUIT <11>`; issuer `C=AR, O=AFIP, CN=Computadores`.

## B. State machine

No new state values. One additive column set on `private.arca_credential_rotations`
(`setup_kind`, `fiscal_snapshot`, `certificate_der_sha256`, `certificate_issuer`,
`verification_started_at`, `verified_wsaa_token/_sign/_token_expires`).

| `state` | `setup_kind` | certificate | `wsaa_verified_at` | Phase 1 `setup.step` | `next_action` |
|---|---|---|---|---|---|
| — (no row) | — | — | — | — (`not_started`) | `start_setup` |
| `pending_rotation` | `initial` | none | NULL | `certificate` | `continue_setup` |
| `pending_rotation` | `initial` | attached | NULL | `verification` | `continue_setup` |
| `pending_rotation` | `initial` | attached | set (ticket stored) | `activation` | `continue_setup` |
| `completed` | `initial` | installed | set | `completed` | `none` (or `verify_connection` if ticket < 30 min) |
| `cancelled` | `initial` | purged | — | history | `start_setup` |

Why the ticket is stored *before* activation: WSAA refuses a second LoginCms for the same certificate
and service while a ticket is valid (`coe.alreadyAuthenticated`, up to 12 h). Discarding it would break
afip-wsaa's first real login; losing it between verify and activate would block retries. So: verify →
persist the ticket on the pending row → activate (retryable without WSAA) → ticket moves to the active cache.

Legacy renewal rows keep `setup_kind` NULL; Phase 1 now derives `kind = coalesce(setup_kind, 'renewal')`
(a NULL row is a renewal by construction). This is the only Phase 1 change; `contract_version` stays 1.

## C. Authorization (initial setup)

Edge (`handler.ts`), in order, before any data RPC:
1. `authorizeArcaManager`: real user JWT, exactly one active profile, role owner/admin,
   `settings_sensitive` via `current_user_can` (malformed override fails closed). Server credentials are not actors.
2. Strict per-action field allowlist (`private_key*`, `signing_key_pem`, `secret_id`, `expires_at`,
   `estado_conexion`, `rotation_id`, `web_service`, `wsaa_token`… → `400 UNEXPECTED_FIELD`).
3. `resolveManagedBusiness`: a body `business_id` may only confirm the identity tenant.
4. `business_has_feature('arca')` with the **user's** JWT (canonical plan gate).
5. `is_business_owner_or_admin` (SQL defence in depth).

SQL (every RPC): `auth.role() = 'service_role'` gate, `is_business_owner_or_admin(business, actor)`,
advisory lock `arca_rotation:<business>`, `setup_kind = 'initial'` on every live-row selection, and
`private.arca_selfservice_is_configured` exclusion. Matrix proven in SQL (Q02) and over HTTP (local E2E):
owner/admin pass; admin without capability, manager with override, tech, sales, cashier, viewer, inactive
owner/admin, other business, anon, authenticated-as-caller all refused without writes.

## D. Fiscal data contract (`prepare`)

| Field | Rule |
|---|---|
| `cuit` | `^\s*\d{2}-?\d{8}-?\d\s*$`, prefix ∈ {20,23,24,27,30,33,34}, mod-11 check digit (raw 10 invalid). Must equal `business_settings.cuit` when the canonical profile declares one (`CUIT_TENANT_MISMATCH`) |
| `razon_social` | 1..200 chars (trimmed) |
| `ambiente` | `homologacion` \| `produccion` |
| `punto_venta` | integer 1..99998 (ARCA not queried) |
| `alias` | `^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$` — it is the certificate CN; PrintableString only (no `_`) |
| `idempotency_key` | `^[A-Za-z0-9._:-]{8,128}$` |

Written in the same savepoint as the Vault secret and the setup row: `arca_config.cuit`, `cuit_emisor`
(the column emission snapshots), `razon_social`, `ambiente`, `punto_venta`, `alias`, `web_service='wsfe'`.
Never from the client: expiry, web_service, connection state, credential/Vault ids, certificate, ticket.
While a setup is live, `save_arca_config_legacy` locks CUIT/alias/ambiente (PV stays editable).

## E. Key generation

`crypto.ts::generateSetupKeyAndCsr`: node-forge RSA 2048, e=65537, in Edge memory only, only after the
probe answered `KEY_REQUIRED` with the server-authorized subject. The PEM goes to exactly one place:
the service_role RPC argument. The database re-derives (n,e), size (exactly 2048), exponent and SPKI
fingerprint; a declared fingerprint that does not match is `KEY_GENERATION_FAILED`.

## F. Vault lifecycle

| Event | Vault |
|---|---|
| prepare | `vault.create_secret(name 'arca-private-key-setup:<business>:<setup>')` + decrypted readback fingerprint check, in one savepoint with the config upsert and the row insert. Any failure rolls all three back (Q06: induced insert failure → 0 new secrets, `arca_config` byte-identical) |
| attach / verify | read-only; `verification_material` decrypts the pending secret for the Edge only while unverified |
| activate | the same secret id becomes `private.arca_private_key_credentials.private_key_secret_id` (no copy) |
| cancel | `DELETE FROM vault.secrets`, row `private_key_secret_id := NULL` (column now nullable; CHECK keeps it NOT NULL while pending) — no dangling reference for renewal finalize check #11 |

## G. CSR

PKCS#10 SHA-256, subject exactly `CN=<alias>, serialNumber=CUIT <cuit>` (no C/O/ST/L). SQL requires
canonical subject equality with the authorized subject, CSR SPKI == key SPKI, CSR bits == key bits.
Rejected without writes: extra attributes, CSR of another key, 1024-bit key, false declared fingerprint,
certificate passed as key, alias in request ≠ CSR (Q05). Real Deno test verifies the CSR signature and attributes.

## H. CSR retrieval / resume

- `prepare` replay: same idempotency key + same semantic request hash + live → `SETUP_ALREADY_PREPARED`
  with the **stored** CSR; the probe answers it without generating a key.
- `csr` action → `arca_selfservice_get_csr(business, actor)`: the live initial setup of the identity
  tenant only; no setup id is accepted. Filename `techrepair-arca-<cuit>.csr`.
- The wizard resumes from Phase 1 status (`setup.step = certificate`), not from local storage.

## I. Certificate upload / parse

Edge (`normalizeCertificateInput`): exactly one of `certificate_pem` / `certificate_der_base64`, ≤ 64 KB,
any `PRIVATE KEY` block → `400 KEY_MATERIAL_NOT_ACCEPTED`, exactly one CERTIFICATE block, parsed with
node-forge and re-emitted. SQL is the authority: validation wrapped so a hostile DER returns
`CERTIFICATE_INVALID` instead of aborting; stored as canonical PEM re-encoded from the validated DER;
identity = SHA-256 of the DER bytes. Same bytes → `CERTIFICATE_ALREADY_ATTACHED`; same key, other bytes →
`CERTIFICATE_REPLACED` (only before verification and outside a verification lease).

## J. Certificate ↔ key

Structural SPKI (modulus + exponent) equality with the pending key fingerprint (S4B-2A validator), then
at activation a decrypted readback: `arca_key_matches_certificate(active key, installed cert)`. Verification
and activation are bound to the exact certificate bytes (`p_expected_certificate_sha256`): a certificate
swapped between reading the material and recording the ticket is `CERTIFICATE_CHANGED` (Q13).

## K. CUIT / identity — proven vs configured

| Check | Strength |
|---|---|
| CSR subject `serialNumber = CUIT n`, `CN = alias` | proven (parsed from DER, exact) |
| certificate subject serialNumber CUIT == setup CUIT | proven → `CERTIFICATE_CUIT_MISMATCH` |
| certificate CN == alias | proven → `CERTIFICATE_ALIAS_MISMATCH` |
| no extra subject attributes | proven → `CERTIFICATE_SUBJECT_MISMATCH` |
| issuer label `c=AR`, `o∈{AFIP,ARCA}`, production `cn='Computadores'` | label only (measured on the live production cert); **not** a CA signature check |
| homologación issuer CN | soft (non-empty): the WSASS CA CN was not measured |
| certificate really issued by ARCA for this CUIT/service | **protocol-proven only by WSAA LoginCms**, required before activation |
| `cuit_emisor` used by emission | set at activation to the verified certificate CUIT; a different stale value → `FISCAL_IDENTITY_MISMATCH` (Q17); the emission claim snapshots it (Q16) |
| `business_settings.cuit` | configured metadata; enforced equal when present |

## L. Pending WSAA verification

`verify` action: `verification_material` (2-minute single-flight lease; returns the exact certificate PEM,
its DER SHA-256, the pending fingerprint and the decrypted pending key **only if not yet verified**) →
`buildTRA('wsfe')` → `signTRAWithPEM(cert, pending key)` → `callWSAA(cms, ambiente)` (30 s race) →
`parseWSAAResponse` → `record_verification(fp, cert sha, token, sign, expires)` retried ×3 on transport
errors → `activate`. Never FECAESolicitar / FECompConsultar / WSFE (guard E2; the local E2E counts exactly one
LoginCms). Nothing is written to `arca_config` before activation (Q12, Q14).

Failure classification (the verbatim `callWSAA` throws on HTTP 500, which is how WSAA returns faults):
`coe.alreadyAuthenticated` → `WSAA_TICKET_ALREADY_ISSUED` (409, `retry_after_seconds: 43200`);
`coe.notAuthorized` → `WSAA_SERVICE_NOT_AUTHORIZED`; `cms.*` → `WSAA_CERTIFICATE_REJECTED`;
`wsn/wsaa.unavailable`, non-SOAP 5xx, network, timeout → `WSAA_UNAVAILABLE` (503); signing → `SIGNING_FAILED`;
anything else → `WSAA_REJECTED`. The raw fault text is never returned, logged or audited; the audit gets the code.

## M. Activation transaction

Inside one savepoint after all gates (verified row, fp + DER sha match, certificate revalidated incl. expiry,
issuer, fiscal identity == certificate identity, Vault readback):
INSERT credential (active, pending secret id, SPKI fps) → UPDATE `arca_config` (cert_file canonical PEM,
expires_at = notAfter, web_service, cuit_emisor, ticket only if > 30 min remain else `desconectado`) →
UPDATE row `completed` (activated/finalized, ticket purged) → readback (`arca_get_private_key_for_signing`
fingerprint, key↔cert match, exactly one credential). Any exception → `ACTIVATION_FAILED`, nothing persisted,
setup stays at step `activation` (Q15, induced trigger failure). Replays: same key → `ALREADY_ACTIVATED`;
other key for the same fp/cert → `ALREADY_ACTIVATED`; retried `verify` → `SETUP_ALREADY_COMPLETED`.
Existing renewal rollback on an initial row returns `PREVIOUS_CHECKPOINT_MISSING` (no previous pair).

## N. Cancel / abandon

`cancel` → `arca_selfservice_cancel`: live initial row only; refuses if a credential uses that secret;
deletes the pending Vault secret; nulls secret id, certificate PEM and ticket; `cancelled`. `arca_config`
fiscal data stays (identity unlocks). Idempotent (`SETUP_NOT_IN_PROGRESS`); after completion →
`SETUP_ALREADY_COMPLETED`. The consumed idempotency key returns `IDEMPOTENCY_KEY_CONSUMED` (mint a new one).
The legacy S4A cancel RPC now ignores initial rows and also nulls the secret id it deletes.

## O. Phase 1 status integration

Proven at every transition (SQL Q07/Q11/Q14/Q15/Q16/Q17/Q18 and the local E2E):
`not_configured/start_setup` → `setup_in_progress/initial/certificate` → `…/verification` → `…/activation`
→ `connected/completed/none`. `contract_version` unchanged (1). Guard + migration post-condition still
forbid the derivation from reading ticket, snapshot, PEMs or decrypted Vault.

## P. API surface

Edge `arca-selfservice-setup` (POST JSON):

| action | body | success states |
|---|---|---|
| `prepare` | `idempotency_key, cuit, razon_social, ambiente, punto_venta, alias` | `SETUP_PREPARED`, `SETUP_ALREADY_PREPARED` (+ `csr {pem, filename}`) |
| `csr` | — | `CSR_AVAILABLE` |
| `certificate` | `certificate_pem` \| `certificate_der_base64` | `CERTIFICATE_ATTACHED`, `CERTIFICATE_ALREADY_ATTACHED`, `CERTIFICATE_REPLACED` |
| `verify` | `idempotency_key` | `ACTIVATED`, `ALREADY_ACTIVATED`, `SETUP_ALREADY_COMPLETED` (+ `connection`, `expires_at`) |
| `cancel` | — | `SETUP_CANCELLED`, `SETUP_NOT_IN_PROGRESS` |

HTTP: 200 success · 400 body · 401/403 authority/plan/tenant · 409 business state · 413 size · 422 fiscal
validation · 503 unavailable. All optional `business_id` may only confirm the tenant.

SQL (service_role only): `arca_selfservice_prepare_initial`, `_get_csr`, `_attach_certificate`,
`_verification_material`, `_record_verification`, `_record_verification_failure`, `_activate`, `_cancel`.

Why a new function instead of reusing `arca-rotate-*`: those are renewal endpoints (identity from the current
certificate, activate → verify) and still carry the Phase 0 CORS-echo debt; changing them would mean
redeploying renewal. Shared logic is reused (SQL helpers, authority, crypto parameters, WSAA helpers).
`afip-wsaa` is **not** modified or redeployed: its helpers are copied verbatim and pinned by guard W1.

## Q. Idempotency

| Operation | Key | Behaviour |
|---|---|---|
| prepare | client key + semantic hash (business, cuit, alias, ambiente, PV, razón social, RSA-2048-65537) | replay → same CSR, no key generated, no secret; hash mismatch → `IDEMPOTENCY_CONFLICT`; other key while live → `SETUP_IN_PROGRESS`; key of a cancelled/completed setup → `IDEMPOTENCY_KEY_CONSUMED` |
| concurrent prepares | advisory lock | second call replays; its key is discarded in memory (never stored) |
| attach | DER SHA-256 | same bytes → no-op |
| verify | 2-min lease + `wsaa_verified_at` | one LoginCms at a time; verified → never again |
| record | fp + DER sha | replay → `ALREADY_VERIFIED` |
| activate | client key + hash(business, setup, fp, sha) | replay → `ALREADY_ACTIVATED`; mismatch → `IDEMPOTENCY_CONFLICT` |
| cancel | state | idempotent |

## R. Secret-exposure proof

- SQL Q20: 176+ browser-path RPC responses contain no `PRIVATE KEY`, `signing_key_pem`, secret ids, ticket
  sentinels, fingerprints, `certificate_pem`, `wsaa_*`; audit rows contain no PEM/ticket and fingerprints ≤ 16 chars.
- Material never leaves for a verified setup, a configured business or an unauthorized actor (Q02, Q14).
- Deno: every response and every non-record RPC argument checked for key/ticket/fingerprint/fault text.
- Local E2E: all Edge responses checked for key, ticket, secret ids and any 64-hex string.
- Guards: Edge cannot log, spread RPC results or put material in responses; frontend cannot name
  `signing_key_pem`, generate keys, or touch private tables.

## S. Tests and negative controls

| Suite | Result (local) |
|---|---|
| `tests/sql/arca_phase2a_initial_setup.test.sql` (`npm run test:sql:arca-phase2a`) | 20/20 |
| Negative control: 16 migration mutants | 16/16 rejected (15 by the suite, 1 by the migration's own post-condition) |
| `tests/deno/arcaSelfServiceSetup.test.ts` (in `npm run test:deno`) | 18/18 |
| `scripts/security/arca-phase2a-local.ts` (`npm run test:local:arca-phase2a`) | 54 assertions, 77 PostgREST requests, 1 simulated LoginCms, 0 failures, 0 residue |
| `tests/components/arcaPhase2aSetupContract.test.ts` | 18/18 |
| Phase 1 SQL (updated S12) / Phase 0 SQL | 21/21 / 13/13 |
| Rollback → re-apply | Phase 0 13/13, Phase 1 21/21, Phase 2A 20/20 |

## T. Static guards

- `scripts/guards/arca-phase2a-setup-contract.mjs` (F1–F3, E1–E3, W1, M1–M3): 21 planted violations, each caught by its own rule.
- `arca-phase0-legacy-writes.mjs`: `arca-selfservice-setup` registered as a management Edge (index + handler), 2 new fixtures (23 total).
- `arca-phase1-status-contract.mjs`: self-test now mutates the file holding the latest definition; new case for an insecure later redefinition; `verified_wsaa`/`fiscal_snapshot` forbidden reads (15 fixtures).
- `edge-cors-client-contract.mjs`: `arca-selfservice-setup` classified `sdk/scoped` (13/13 self-test).

## U. Rollout compatibility

| Frontend | DB | Edge | Result |
|---|---|---|---|
| current | current | none | today |
| current | **2A** | none | safe: nothing calls the RPCs; Phase 1 status identical for existing tenants (only NULL-kind *pending* rows change kind; prod has none); `save_arca_config_legacy` unchanged for configured tenants (already locked) |
| current | 2A | **deployed** | safe: no browser caller until 2B; endpoint requires owner/admin + feature + unconfigured |
| **2B** | 2A | deployed | target |
| 2B | old | any | wizard actions fail closed (`SETUP_UNAVAILABLE`); status card unaffected |

Order: 1) DB (additive) → 2) Edge `arca-selfservice-setup` → 3) production backend verification **without
any Clic mutation** (catalog, grants, `ARCA_ALREADY_CONFIGURED` for Clic through a rolled-back probe, anon/
authenticated denials over HTTP) → 4) Phase 2B frontend → 5) real smoke **only** with a dedicated fresh QA
tenant in homologación (`«cuenta prieba» 3b52e902…` is the designated QA tenant; never Clic) → 6) production
ARCA only after the owner approves.

## V. Rollback

- Edge: delete / stop `arca-selfservice-setup` (no browser caller before 2B).
- DB: `rollback.sql` (generated by byte-exact extraction of the previous definitions; aborts if a live
  initial setup exists; drops the 8 RPCs + helpers; restores the previous Phase 1 derivation,
  `save_arca_config_legacy`, legacy cancel; keeps columns/audit/credentials) then
  `supabase migration repair --status reverted 20260930120000`. Verified locally: rollback → Phase 0 13/13 →
  re-apply → all suites green.
- Credentials already activated by the flow remain ordinary active credentials (afip-wsaa uses them); rolling
  back the engine does not deactivate them.

## W. Phase 2B UI contract

Screen authority: `deriveArcaSetupWizard(parseArcaSelfServiceStatus(get_arca_selfservice_status))`.
Actions: `arcaSetupService` only. Never persist wizard progress locally.

| Phase 1 status | Screen | Step | Allowed actions |
|---|---|---|---|
| `available=false` | `no_disponible` | — | — |
| configured, no live setup | `listo` | 6 | — |
| `can_manage=false` | `solo_lectura` | — | — |
| not started, no loose cert/credential | `datos_fiscales` | 1 (+2 on submit) | `prepare` |
| in progress, initial, `certificate` | `presentar_en_arca` | 3–4 | `csr`, `certificate`, `cancel` |
| in progress, initial, `verification` | `verificar_conexion` | 5 | `csr`, `certificate`, `verify`, `cancel` |
| in progress, initial, `activation` | `finalizar_activacion` | 5 | `verify`, `cancel` |
| anything else (renewal, attention with loose material, unreadable) | `fuera_de_alcance` | — | — |

User language (steps): 1 Datos fiscales · 2 Generar solicitud · 3 Presentarla en ARCA · 4 Cargar certificado ·
5 Verificar conexión · 6 Listo. The CSR is "archivo de solicitud para presentar en ARCA"; never show private
key, Vault, PKCS#10, WSAA or fingerprints. Suggested copy for bounded states:

| State | Copy intent |
|---|---|
| `INVALID_CUIT` / `CUIT_TENANT_MISMATCH` | CUIT inválido / no coincide con el CUIT del negocio |
| `INVALID_ALIAS` | nombre del equipo: letras, números, punto o guion (3–50) |
| `CERTIFICATE_CUIT_MISMATCH` / `_ALIAS_MISMATCH` | el certificado es de otro CUIT / de otro nombre de equipo |
| `CERTIFICATE_KEY_MISMATCH` | ese certificado no corresponde a esta solicitud (subí el emitido para el archivo descargado) |
| `CERTIFICATE_EXPIRED` / `_NOT_YET_VALID` | vencido / todavía no vigente |
| `WSAA_SERVICE_NOT_AUTHORIZED` | falta autorizar "Facturación electrónica" para este equipo en ARCA |
| `WSAA_TICKET_ALREADY_ISSUED` | ARCA ya emitió un acceso reciente; reintentá más tarde (hasta 12 h) |
| `WSAA_UNAVAILABLE` / `VERIFICATION_RECORD_FAILED` / `ACTIVATION_PENDING` | reintentá; no hace falta volver a ARCA |
| `IDEMPOTENCY_KEY_CONSUMED` | generar una clave nueva y volver a empezar |

Idempotency keys: one `newArcaSetupIdempotencyKey()` per user intent for `prepare`, one for `verify`; reuse on
network retry; mint new after cancel.

## Known debt / decisions for owner review

1. **WSAA timeout race**: a LoginCms that answers after the 30 s race issues a ticket the Edge never records;
   the next verify gets `WSAA_TICKET_ALREADY_ISSUED` (bounded, retry after ≤ 12 h). Accepted for 2A.
2. Homologación issuer CN not measured (soft); production CN measured.
3. "Probar conexión" still forces a WSAA refresh; right after activation it would hit `coe.alreadyAuthenticated`
   and mark `estado_conexion='error'` (afip-wsaa error path). Pre-existing Phase 1 debt; 2B should not offer it
   while a valid cached ticket exists.
4. `_shared/wsaaLogin.ts` duplicates afip-wsaa helpers verbatim (guard-pinned) until afip-wsaa adopts it in a
   separately approved deploy.
5. The renewal flow (`arca-rotate-*`) keeps its CORS echo debt; renewal is Phase 2C/3.
