# ARCA Self-Service · Phase 2A — initial setup engine + wizard contract

Baseline: `main` = `228d53081a174757fcd5a521e6704b0cde4cbb58` (prod DB `20260929120000`).
Candidate migration: `20260930120000_arca_selfservice_phase2a_initial_setup.sql`.
New Edge Function: `arca-selfservice-setup` (`verify_jwt = true`). **Not merged, not deployed.**

A business with **no** ARCA credential can configure ARCA end to end:
fiscal data → server-side RSA key (Vault only) → PKCS#10 CSR → user submits it to ARCA → uploads the
issued certificate → structural validation → **non-fiscal** WSAA LoginCms with the PENDING pair →
atomic activation. **PENDING → VERIFY → ACTIVATE**, never "activate and hope".

A WSAA expiration is never invented, and an ambiguous LoginCms is never blindly repeated. The database holds a
durable, equipo-scoped wait that survives cancel (sections L1–L3, owner review 2).

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
`verification_started_at`, `verified_wsaa_token/_sign/_token_expires`, `verification_attempt_id`,
`verification_hold`, `verification_retry_not_before`). Holds (L3) are orthogonal to the step: a row at step
`certificate` or `verification` can carry one (own or inherited); a verified row never does (CHECK).

| `state` | `setup_kind` | certificate | `wsaa_verified_at` | Phase 1 `setup.step` | `next_action` |
|---|---|---|---|---|---|
| — (no row) | — | — | — | — (`not_started`) | `start_setup` |
| `pending_rotation` | `initial` | none | NULL | `certificate` | `continue_setup` |
| `pending_rotation` | `initial` | attached | NULL | `verification` | `continue_setup` |
| `pending_rotation` | `initial` | attached | set (ticket stored) | `activation` | `continue_setup` |
| `completed` | `initial` | installed | set | `completed` | `none` (every activation installs a TA with > 90 min) |
| `cancelled` | `initial` | purged | — | history (keeps its hold) | `start_setup` |

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
| attach / verify | read-only; `verification_material` decrypts the pending secret for the Edge only while unverified and with no active hold, and records the pessimistic hold in the same UPDATE |
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
`CERTIFICATE_REPLACED` (only before verification and never while an attempt is in flight (< 7 min); replacing
never releases a hold).

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

## L. Pending WSAA verification (fail-closed, never blindly repeated)

`verify` action, at most **one** LoginCms per request and never an automatic retry:

1. The Edge mints an attempt nonce (`crypto.randomUUID()`) and calls
   `verification_material(business, actor, attempt)`. It checks, in this order:
   - a durably recorded verification returns `ALREADY_VERIFIED` (no key);
   - any active **effective hold** (own row, or a cancelled initial row of the same equipo) refuses with
     its bounded state plus `retry_after_seconds` (no key);
   - otherwise it revalidates the certificate and Vault, and in the **same UPDATE that releases the key**
     stores `verification_hold='in_flight'` and `verification_retry_not_before = clock_timestamp() + 12 h 30 min`.
2. `buildTRA('wsfe')` → `signTRAWithPEM` → `callWSAA` (90 s race; the verbatim `callWSAA` cannot be aborted,
   so a short timeout adds ambiguity and no safety) → `parseWSAAResponse` → **`validateWsaaTicket`**.
3. With a valid TA, `record_verification(fp, cert sha, token, sign, exact expirationTime)` is tried up to 3
   times on transport errors. Success clears the hold, then activation runs.
4. Every other outcome is reported with `record_verification_failure(attempt, code, observed_expires)`,
   also up to 3 tries. The database decides the hold.

Never FECAESolicitar / FECompConsultar / WSFE (guard E2). Nothing is written to `arca_config` before
activation (Q12, Q14).

### L1. Expiration is never invented (owner blocker 1)

The previous `Date.parse(expirationTime) || now + 12 h` fallback was removed (guard E4 forbids `Date.parse` and
`12 * 60 * 60 * 1000` in the handler). A TA is eligible only when **all** of these hold:

- `token` and `sign` are non-blank (≤ 16384 / 4096 chars);
- `expirationTime` matches `YYYY-MM-DDTHH:MM:SS(.fraction)?(Z|±HH:MM)` with real calendar fields. That covers
  WSAA's real shape `2026-09-14T22:10:54.622-03:00`; a value without an offset is ambiguous local time and is
  rejected;
- `now < E ≤ now + 12 h 10 min`. The upper bound is the documented TA lifetime (12 h, ARCA WSAA technical
  spec) plus 10 min clock tolerance, identical to SQL.

The check runs in `wsaa.ts` (`wsaaLoginWithPendingPair` returns only validated TAs) **and** again at the
handler boundary; SQL re-checks the bounds with the DB clock. Missing, empty, unparsable, past or
out-of-bound → `WSAA_RESPONSE_INVALID`: no record, no activation, no cache write. Because a TA *was* issued, it
is an ambiguous outcome (hold below). A parseable but rejected E is passed as `p_observed_expires`.

### L2. Outcome classification

| Outcome | Code | Disposition | Durable hold |
|---|---|---|---|
| Material RPC error / malformed material (key never in memory) | `VERIFICATION_NOT_DISPATCHED` | not dispatched | cleared only for the same `in_flight` attempt |
| Signing failed (before `callWSAA`) | `SIGNING_FAILED` | definitive | `cooldown` 60 s |
| SOAP fault on the exact spec allowlist: `coe.notAuthorized`, `cms.bad`, `cms.bad.base64`, `cms.cert.notFound/expired/untrusted/invalid`, `cms.sign.invalid`, `xml.bad`, `xml.source.invalid`, `xml.destination.invalid`, `xml.version.notSupported`, `xml.CEE.notAuthorized`, `xml.generationTime.invalid`, `xml.expirationTime.expired/invalid`, `wsn.notFound`, `wsn.unavailable` | `WSAA_SERVICE_NOT_AUTHORIZED` / `WSAA_CERTIFICATE_REJECTED` / `WSAA_REJECTED` / `WSAA_UNAVAILABLE` | definitive (validated before a TA is issued) | `cooldown` 60 s (5 min for unavailable), same `in_flight` attempt only |
| `coe.alreadyAuthenticated` | `WSAA_TICKET_ALREADY_ISSUED` | ticket_active | `ticket_active`, ≥ now + 12 h 30 min |
| Timeout after dispatch, transport error, 5xx/HTML without a SOAP fault, `wsaa.internalError`, `wsaa.unavailable`, **any unknown/duplicated/truncated faultcode**, unreadable 200 | `WSAA_RESULT_UNKNOWN` | ambiguous | `result_unknown`, ≥ now + 12 h 30 min |
| TA received but invalid (L1) | `WSAA_RESPONSE_INVALID` | ambiguous | `result_unknown`, ≥ max(now + 12 h 30 min, min(E + 10 min, now + 24 h 10 min)) |
| TA received, DB record rejected or all 3 tries failed | `VERIFICATION_RECORD_FAILED` | ambiguous | same as above |
| Anything the database does not recognise | normalized to `WSAA_RESULT_UNKNOWN` | ambiguous | `result_unknown` |

The faultcode is extracted from the raw reply (Axis form `<faultcode xmlns:ns1="…">ns1:coe.x</faultcode>`). The
closing tag is required, there must be exactly one element, and matching is exact. `WsaaLoginError` keeps only
that validated token, as a non-enumerable property; the raw ARCA text never leaves `wsaa.ts` and never reaches a
response, a log or the audit.

## L3. Durable retry authority (owner blocker 2)

Columns on `private.arca_credential_rotations`: `verification_attempt_id` (Edge nonce, unique),
`verification_hold` (`in_flight | result_unknown | ticket_active | verification_expired | cooldown`) and
`verification_retry_not_before`.

CHECKs:
- hold NULL ⇔ retry NULL;
- for a live initial row, verified ⇔ token + sign + expires present, `expires > verified_at`, and no hold.

**Why 12 h 30 min.** The ARCA WSAA technical specification states that a TA is valid for 12 h from issuance, and
`coe.alreadyAuthenticated` means "El CEE ya posee un TA válido". The window measured from the moment the key
leaves is:

| Component | Time |
|---|---|
| TA lifetime | 12 h |
| DB↔WSAA clock tolerance (same as the ticket bound) | 10 min |
| Supabase Edge wall-clock ceiling (the request cannot reach WSAA later) | ≤ 400 s |
| Lock wait and WSAA processing slack | remainder |
| **Total** | **12 h 30 min** |

No tighter bound is used without proof. The only shorter wait is `E + 10 min` for a TA whose **exact** expiration
WSAA itself returned and the database persisted (`verification_expired`, cancel of a verified setup). The only
longer one is a rejected TA's observed `E + 10 min`, capped at 24 h 10 min (TRA maximum).

**Rules.**
- Only an explicit resolution of the **same** attempt while it is still `in_flight` can shorten the pessimistic
  hold: `NOT_DISPATCHED` clears it, a definitive fault turns it into `cooldown`.
- `result_unknown` and `ticket_active` are monotonic. Only expiry or a successful record ends them (Q12).
- Reports are bound to the attempt row in any state, so a late report extends a **cancelled** row too (Q22).
- A report for an already-verified row returns `ALREADY_VERIFIED` and the Edge proceeds to activation. The
  "committed but response lost" record is resolved without WSAA.
- If the report RPC never answers, the pessimistic hold from dispense stays, and the Edge answers
  `WSAA_RESULT_UNKNOWN` with the conservative 45 000 s.

**The hold is scoped to the equipo, not the row.** `private.arca_selfservice_verification_hold(business, now)`
takes the longest active hold among:
- the live initial row;
- every **cancelled** initial row of the same business with the same subject (`CN=alias, serialNumber=CUIT`).

Cancel keeps the hold columns:
- `in_flight` becomes `result_unknown`;
- a verified but not activated setup becomes `ticket_active` until `E + 10 min`.

A new setup for the same equipo therefore inherits the wait, and a different alias does not (Q22, local E2E).

**In-flight window 7 min** (above the 400 s Edge ceiling). While the live row is `in_flight` and younger than
7 min:
- verify, attach and **cancel** are refused with `VERIFICATION_IN_PROGRESS`, so an Edge that is about to record
  a TA is never pulled from under;
- `retry_after_seconds` for verify is still the real bound (`retry_not_before − now`), never the 7-min label flip;
- attach and cancel report seconds to the 7-min mark.

After 7 min the same hold reads `WSAA_RESULT_UNKNOWN`. Other holds do not block attaching a certificate, and
attaching never releases a hold.

**Cancel cannot revoke a TA.** It purges the key (Vault), certificate and ticket locally and answers
`remote_ticket_possible` (a bounded boolean, true for an active non-cooldown hold). It never claims revocation.

## M. Activation transaction

**Gates.**
1. Replays.
2. Configured exclusion.
3. Live row.
4. **Not verified**: return the effective hold's bounded state if any, else `NOT_VERIFIED`.
5. fp + DER sha binding.
6. **Verified TA gate, before every other gate**:
   - an inconsistent ticket (blank token or sign, NULL expires, `expires ≤ verified_at`,
     `expires > verified_at + 12 h 10 min`) → `VERIFICATION_STATE_INVALID` in the audit;
   - or a TA with ≤ **90 min** left (afip-wsaa reuses its cache only with > 30 min left, plus 60 usable min)
   - → **no activation**. One UPDATE discards the verification and sets hold `verification_expired` until the
     exact `E + 10 min` (no hold if already past) → `VERIFICATION_EXPIRED` + `retry_after_seconds`.
   - The user re-verifies with the **same** certificate; no new ARCA certificate is needed.
   - The CHECK makes an inconsistent state unreachable; Q21 proves the RPC guard also holds with the CHECK
     dropped.
7. arca_config present, certificate revalidated, issuer, fiscal identity == certificate identity, Vault readback.

**Savepoint**, in order:
1. Insert the credential (active, pending secret id, SPKI fps).
2. Update `arca_config`: `cert_file`, `expires_at`, `web_service`, `cuit_emisor`, and **always** the verified TA
   with its exact expiration, `estado_conexion='conectado'`, `ultima_sincronizacion`.
3. Mark the row `completed` (ticket and hold purged).
4. Readback.

Any exception → `ACTIVATION_FAILED`, nothing persisted. **Every `ACTIVATED` is `connection: connected`**, so a
normal setup ends `configured / connected / completed / next_action none` (Q16, Q17, E2E).

## N. Cancel / abandon

`cancel` → `arca_selfservice_cancel`:
- live initial row only;
- refused while `in_flight` < 7 min;
- refuses if a credential uses that secret.

It deletes the pending Vault secret and nulls the secret id, certificate PEM and ticket. It **keeps** the hold
(L3) and answers `SETUP_CANCELLED` + `remote_ticket_possible`.
- `arca_config` fiscal data stays (identity unlocks).
- Repeating it is harmless (`SETUP_NOT_IN_PROGRESS`); after completion it returns `SETUP_ALREADY_COMPLETED`.
- The consumed idempotency key returns `IDEMPOTENCY_KEY_CONSUMED` (mint a new one).
- The legacy S4A cancel RPC ignores initial rows and nulls the secret id it deletes.

## O. Phase 1 status integration

Proven at every transition (SQL Q07/Q11/Q12/Q14–Q18/Q22 and the local E2E):
`not_configured/start_setup` → `setup_in_progress/initial/certificate` → `…/verification` → `…/activation`
→ `connected/completed/none`.

Additive, `contract_version` unchanged (1): `setup.verification_hold` (`in_progress | result_unknown |
ticket_active | verification_expired | cooldown`, always the helper's label, never the raw column) and
`setup.retry_not_before` (the stored server bound).
- The deployed Phase 1 parser copies known fields only (extra keys ignored).
- The updated parser reads absent keys as null (a DB without 2A, or the "plan without ARCA" branch).
- It rejects unknown values and a hold without a bound.
- The guard and migration postcondition still forbid the derivation from reading the ticket, snapshot, PEMs,
  decrypted Vault or the attempt id.

## P. API surface

Edge `arca-selfservice-setup` (POST JSON):

| action | body | success states |
|---|---|---|
| `prepare` | `idempotency_key, cuit, razon_social, ambiente, punto_venta, alias` | `SETUP_PREPARED`, `SETUP_ALREADY_PREPARED` (+ `csr {pem, filename}`) |
| `csr` | — | `CSR_AVAILABLE` |
| `certificate` | `certificate_pem` \| `certificate_der_base64` | `CERTIFICATE_ATTACHED`, `CERTIFICATE_ALREADY_ATTACHED`, `CERTIFICATE_REPLACED` |
| `verify` | `idempotency_key` | `ACTIVATED`, `ALREADY_ACTIVATED`, `SETUP_ALREADY_COMPLETED` (+ `connection: connected`, `expires_at`) |
| `cancel` | — | `SETUP_CANCELLED`, `SETUP_NOT_IN_PROGRESS` (+ `remote_ticket_possible`) |

**Hold states** (409, always with `retry_after_seconds`, an integer in [1, 90000]):
- `VERIFICATION_IN_PROGRESS`;
- `WSAA_RESULT_UNKNOWN`;
- `WSAA_TICKET_ALREADY_ISSUED`;
- `VERIFICATION_EXPIRED`;
- `VERIFICATION_COOLDOWN`.

**HTTP status codes:**

| Status | Meaning |
|---|---|
| 200 | success |
| 400 | body |
| 401/403 | authority / plan / tenant |
| 409 | business state or hold |
| 413 | size |
| 422 | fiscal validation |
| 503 | unavailable (`WSAA_UNAVAILABLE`, `ACTIVATION_PENDING`, a material error whose not-dispatched report landed) |

Any optional `business_id` may only confirm the tenant. The attempt nonce never appears in a response.

**SQL (service_role only):**
- `arca_selfservice_prepare_initial`, `_get_csr`, `_attach_certificate`;
- `_verification_material(uuid,uuid,uuid)`, `_record_verification`;
- `_record_verification_failure(uuid,uuid,uuid,text,timestamptz)`;
- `_activate`, `_cancel`.

The old signatures `(uuid,uuid)` and `(uuid,uuid,text)` are dropped, and the postcondition asserts a single
overload.

**Why a new function instead of reusing `arca-rotate-*`.** Those are renewal endpoints (identity from the current
certificate, activate → verify) and still carry the Phase 0 CORS-echo debt; changing them would mean
redeploying renewal. Shared logic is reused (SQL helpers, authority, crypto parameters, WSAA helpers).
`afip-wsaa` is **not** modified or redeployed: its helpers are copied verbatim and pinned by guard W1.

## Q. Idempotency

| Operation | Key | Behaviour |
|---|---|---|
| prepare | client key + semantic hash (business, cuit, alias, ambiente, PV, razón social, RSA-2048-65537) | replay → same CSR, no key generated, no secret; hash mismatch → `IDEMPOTENCY_CONFLICT`; other key while live → `SETUP_IN_PROGRESS`; key of a cancelled/completed setup → `IDEMPOTENCY_KEY_CONSUMED` |
| concurrent prepares | advisory lock | second call replays; its key is discarded in memory (never stored) |
| attach | DER SHA-256 | same bytes → no-op |
| verify / material | Edge nonce (unique) + hold | at most one dispatched attempt per hold window; a reused nonce → `BAD_REQUEST` |
| failure report | attempt id | repeated reports never shorten a hold; definitive only resolves the same `in_flight` attempt |
| record | fp + DER sha | replay → `ALREADY_VERIFIED` |
| activate | client key + hash(business, setup, fp, sha) | replay → `ALREADY_ACTIVATED`; mismatch → `IDEMPOTENCY_CONFLICT` |
| cancel | state | repeated calls are harmless; hold preserved |

## R. Secret-exposure proof

- SQL Q20: 214 browser-path responses carry no `PRIVATE KEY`, `signing_key_pem`, secret ids, attempt ids,
  raw hold values (`in_flight`), ticket sentinels, fingerprints, `certificate_pem` or `wsaa_*`. Audit rows carry no
  PEM, ticket or free text (the unknown code `texto libre <script>` is normalized, Q12), and fingerprints are
  ≤ 16 chars.
- Material never leaves for a verified setup, a held setup, a configured business or an unauthorized actor
  (Q02, Q04, Q12, Q14, Q17, Q22).
- Deno: every response and every non-record RPC argument is checked for key, ticket, fingerprint, nonce and the
  raw fault text. `WsaaLoginError` does not serialize or inspect to the ARCA text.
- Local E2E: all Edge responses are checked for key, ticket, secret ids, attempt ids, `Bad Gateway` text and any
  64-hex string.
- Guards: the Edge cannot log, spread RPC results, or put material, `.fault`/`.detail` or attempt ids in
  responses (E1). The frontend cannot name `signing_key_pem`, generate keys or touch private tables.

## S. Tests and negative controls

| Suite | Result (local) |
|---|---|
| `tests/sql/arca_phase2a_initial_setup.test.sql` (`npm run test:sql:arca-phase2a`) | 22/22 |
| Negative control: 29 migration mutants (incl. 14 for holds/expiry/cancel/inheritance) | 29/29 rejected (28 by the suite, 1 by the migration's own post-condition) |
| `tests/deno/arcaSelfServiceSetup.test.ts` (in `npm run test:deno`) | 30/30 |
| `scripts/security/arca-phase2a-local.ts` (`npm run test:local:arca-phase2a`) | 74 assertions, 102 PostgREST requests, 2 simulated LoginCms (one TA, one ambiguous 502), 0 failures, 0 residue |
| `tests/components/arcaPhase2aSetupContract.test.ts` | 35/35 |
| `tests/components/arcaPhase1Status.test.tsx` | 33/33 |
| Phase 1 SQL (S12, S19 additive keys) / Phase 0 SQL | 21/21 / 13/13 |
| Rollback → re-apply | Phase 0 13/13 on the rolled-back DB; re-apply → Phase 0 13/13, Phase 1 21/21, Phase 2A 22/22 |

Owner-requested controls:

| # | Control | Where |
|---|---|---|
| 1 | token + sign + empty expiration → fail closed, no record/activation | Deno B1 (empty, absent), `validateWsaaTicket` unit, real-fetch TA without `expirationTime` |
| 2 | malformed expiration, no invented +12 h | Deno B1 (no offset, free text, impossible date, space), guard E4 |
| 3 | expiration in the past | Deno B1, `validateWsaaTicket`, SQL Q14 |
| 4 | valid expiration → happy path, exact value recorded | Deno happy path (ms + offset), real-fetch WSAA shape, SQL Q14/Q16, E2E |
| 5 | timeout after dispatch → hold, immediate verify does not call WSAA | Deno B2 (stateful DB model), SQL Q12 |
| 6 | ambiguous transport → no blind retry | Deno B2 (transport, gateway HTML, internalError, unknown coe), E2E (502) |
| 7 | TA received + all records fail → hold, next verify no WSAA | Deno B2 record ×3, SQL Q13 |
| 8 | after the boundary → eligible again | SQL Q12/Q14/Q17 (`elapse`), Deno fake DB |
| 9 | `coe.alreadyAuthenticated` → bounded retry_after, no auto retry | Deno, SQL Q12 |
| 10 | cancel during ambiguity → key cleanup, no revocation claim | SQL Q18/Q22, Deno cancel, E2E |
| 11 | activation refuses missing sign/expiry/inconsistent state | SQL Q21 (CHECK + guard without CHECK), Q17 |
| 12 | no leaks (token, sign, key, secret id, raw ARCA text) | SQL Q20, Deno, E2E, guards |

## T. Static guards

- `scripts/guards/arca-phase2a-setup-contract.mjs`: rules F1–F3, E1–E4, W1, M1–M3, with 31 planted violations,
  each caught by its own rule. New rules:
  - E4: no invented or reinterpreted expiration; the TA is validated in `wsaa.ts` and at the handler boundary;
    the error keeps no raw text;
  - M3 material: effective hold consulted before the key, pessimistic hold in the same UPDATE;
  - M3 failure: exact attempt lookup, unknown code → ambiguous, definitive only for `in_flight`;
  - M3 cancel: hold survives, `remote_ticket_possible`;
  - M3 activate: 90-min TA gate, no ticket-less branch;
  - E1: no `.fault`/`.detail`/attempt id in responses.
- `arca-phase0-legacy-writes.mjs`: `arca-selfservice-setup` registered as a management Edge (23 fixtures).
- `arca-phase1-status-contract.mjs`: `ALLOWED_KEYS += verification_hold, retry_not_before`;
  `FORBIDDEN_READS += verification_attempt_id` (15 fixtures).
- `edge-cors-client-contract.mjs`: `arca-selfservice-setup` classified `sdk/scoped` (13/13 self-test).

## U. Rollout compatibility

| Frontend | DB | Edge | Result |
|---|---|---|---|
| current | current | none | today |
| current | **2A** | none | safe: nothing calls the RPCs; Phase 1 status gains two null keys (ignored by the deployed parser); `save_arca_config_legacy` unchanged for configured tenants |
| current | 2A | **deployed** | safe: no browser caller until 2B; endpoint requires owner/admin + feature + unconfigured |
| **2B** | 2A | deployed | target |
| 2B | old | any | wizard actions fail closed (`SETUP_UNAVAILABLE`); hold keys absent → null; status card unaffected |

The hardening ships **inside** migration `20260930120000`, never as a later migration, so a 2A engine without
durable holds cannot exist.

**Rollout order:**
1. DB (additive).
2. Edge `arca-selfservice-setup`.
3. Production backend verification **without any Clic mutation**:
   - catalog and grants, no legacy overloads, hold CHECKs, zero live holds;
   - `ARCA_ALREADY_CONFIGURED` for Clic through a rolled-back probe of prepare **and** material;
   - anon/authenticated denials over HTTP.
4. Phase 2B frontend.
5. Real smoke **only** with a dedicated fresh QA tenant in homologación (`«cuenta prieba» 3b52e902…` is the
   designated QA tenant; never Clic).
6. Production ARCA only after the owner approves.

## V. Rollback

- **Edge:** delete or stop `arca-selfservice-setup` (no browser caller before 2B).
- **DB:** run `rollback.sql`, then `supabase migration repair --status reverted 20260930120000`. The script:
  - is generated by byte-exact extraction of the previous definitions;
  - aborts if a live initial setup exists;
  - drops the 8 RPCs (new and old signatures), the helpers including the two hold helpers, the hold CHECKs and
    the attempt index;
  - restores the previous Phase 1 derivation, `save_arca_config_legacy` and the legacy cancel;
  - keeps columns, audit and credentials.

  Verified locally: rollback → Phase 0 13/13 → re-apply → all suites green.
- **Credentials already activated by the flow** remain ordinary active credentials that afip-wsaa uses; rolling
  back the engine does not deactivate them. Holds left on cancelled rows are inert without the RPCs.

## W. Phase 2B UI contract

**Screen authority:** `deriveArcaSetupWizard(parseArcaSelfServiceStatus(get_arca_selfservice_status))`.
Actions go through `arcaSetupService` only. Never persist wizard progress locally.

| Phase 1 status | Screen | Step | Allowed actions | `hold` / `confirmCancel` |
|---|---|---|---|---|
| `available=false` | `no_disponible` | — | — | — |
| configured, not in progress, `status=connected` and `next_action=none` | `listo` | 6 | — | — |
| configured otherwise (pending verification, attention, renew) | `fuera_de_alcance` | — | — (the Phase 1 card owns it) | — |
| `can_manage=false` | `solo_lectura` | — | — | — |
| not started, no loose cert/credential | `datos_fiscales` | 1 (+2 on submit) | `prepare` | — |
| in progress, initial, `certificate` | `presentar_en_arca` | 3–4 | `csr`, `certificate`, `cancel` | inherited hold shown; confirm if hold ≠ cooldown |
| in progress, initial, `verification`, no hold | `verificar_conexion` | 5 | `csr`, `certificate`, `verify`, `cancel` | — |
| … `verification`, hold `in_progress` | `verificar_conexion` | 5 | `csr` | hold |
| … `verification`, other hold | `verificar_conexion` | 5 | `csr`, `certificate`, `cancel` (**never** `verify`) | hold; confirm unless `cooldown` |
| in progress, initial, `activation` | `finalizar_activacion` | 5 | `verify`, `cancel` | confirm (a valid ARCA access would be discarded) |
| anything else (renewal, attention with loose material, unreadable) | `fuera_de_alcance` | — | — | — |

**Step labels (user language):** 1 Datos fiscales · 2 Generar solicitud · 3 Presentarla en ARCA ·
4 Cargar certificado · 5 Verificar conexión · 6 Listo.

**Hold rules for 2B:**
- after **any** verify failure, refetch Phase 1 status and render the hold from status, not from the action
  result;
- refetch when `retryNotBefore` passes (one clamped timer) and on window focus;
- the server stays the authority, so an early refetch just shows the hold again;
- never show a retry time as a promise for `in_progress`.

`ARCA_SETUP_HOLD_COPY` (in `src/lib/arcaSetupWizard.ts`):

| Hold | Copy |
|---|---|
| `in_progress` | Estamos verificando la conexión con ARCA. Esto puede tardar unos minutos. |
| `result_unknown` | ARCA puede haber procesado la verificación. Por seguridad vamos a esperar antes de repetirla. |
| `ticket_active` | ARCA ya habilitó un acceso reciente para este equipo. Por seguridad vamos a esperar a que venza antes de volver a verificar. |
| `verification_expired` | La verificación anterior venció antes de terminar la activación. Vamos a esperar a que ARCA la dé por vencida para verificar de nuevo, sin volver a pedir el certificado. |
| `cooldown` | Esperá un momento antes de volver a intentar. |

**Other bounded states:**

| State | Copy intent |
|---|---|
| `INVALID_CUIT` / `CUIT_TENANT_MISMATCH` | CUIT inválido / no coincide con el CUIT del negocio |
| `INVALID_ALIAS` | nombre del equipo: letras, números, punto o guion (3–50) |
| `CERTIFICATE_CUIT_MISMATCH` / `_ALIAS_MISMATCH` | el certificado es de otro CUIT / de otro nombre de equipo |
| `CERTIFICATE_KEY_MISMATCH` | ese certificado no corresponde a esta solicitud (subí el emitido para el archivo descargado) |
| `CERTIFICATE_EXPIRED` / `_NOT_YET_VALID` | vencido / todavía no vigente |
| `WSAA_SERVICE_NOT_AUTHORIZED` | falta autorizar "Facturación electrónica" para este equipo en ARCA (se puede reintentar enseguida después de autorizar) |
| `WSAA_CERTIFICATE_REJECTED` / `WSAA_REJECTED` | ARCA rechazó la verificación; revisá el certificado |
| `WSAA_UNAVAILABLE` / `ACTIVATION_PENDING` | ARCA o el servicio no respondió; reintentá en unos minutos |
| `IDEMPOTENCY_KEY_CONSUMED` | generar una clave nueva y volver a empezar |
| cancel with `remoteTicketPossible` | cancelar no revoca el acceso en ARCA; volver a configurar el mismo equipo puede requerir esperar hasta ~12 h |

**Idempotency keys:** one `newArcaSetupIdempotencyKey()` per user intent for `prepare`, one for `verify`; reuse
on network retry; mint a new one after cancel.

## W2. Temporary QA origin (`ARCA_SETUP_EXTRA_ORIGINS`)

The Phase 2B homologación smoke runs from a Vercel Preview, but `arca-selfservice-setup` only allows the
canonical origins. A dedicated variable adds exact QA origins **to this function only**:

```ts
const cors = createCors(computeAllowedOrigins([
  Deno.env.get('APP_URL'),
  Deno.env.get('ARCA_SETUP_EXTRA_ORIGINS'),
]))
```

- It uses the existing exact-match helper (`_shared/scopedCors.ts`): no wildcard, no regex, no `*.vercel.app`.
  Unset or empty means the current production behaviour (www + apex only).
- No other function reads it, and neither does the browser (guard G7 in `edge-cors-client-contract`).
  `APP_URL` is untouched; it also builds Mercado Pago back URLs and must not be used for QA origins.
- CORS is transport, not authority: a request from the QA origin still needs `verify_jwt`, a valid JWT,
  `authorizeArcaManager`, the tenant, `business_has_feature('arca')` and the SQL owner/admin checks.
- Tests: `tests/deno/arcaSetupPreviewOrigin.test.ts` runs the real `index.ts` without the variable, with it empty,
  and with the exact Preview. It checks look-alikes (another preview, prefix, suffix, subdomain, `http`, port,
  `https://evil.example`), no `*`, a 401 without a JWT, and that the other scoped functions ignore the variable.

Runbook (one origin, removed right after the smoke):

1. `supabase secrets set ARCA_SETUP_EXTRA_ORIGINS=<exact preview origin> --project-ref <ref>`
2. `supabase functions deploy arca-selfservice-setup --project-ref <ref>` (`verify_jwt = true` from `config.toml`)
3. Unauthenticated OPTIONS matrix: www and apex allowed, the Preview echoed exactly, any other preview or origin
   gets no `Access-Control-Allow-Origin`, never `*`.
4. After the smoke, successful or not: `supabase secrets unset ARCA_SETUP_EXTRA_ORIGINS`, **redeploy** the
   function so no warm isolate keeps the old allowlist, then repeat the matrix: the Preview must be blocked again.

## X. Owner review 2 — WSAA fail-closed + ambiguous login (summary)

- **Blocker 1 closed:** there is no fabricated expiration anywhere (L1, guard E4, Deno B1 ×8 cases, SQL Q14).
- **Blocker 2 closed:**
  - durable, equipo-scoped holds decided by SQL (L3);
  - one LoginCms per request, never repeated inside the window;
  - cancel cannot bypass the hold (L2, L3, Q12/Q13/Q22, Deno B2, E2E).
- **Activation:** it requires a complete, coherent verified TA with > 90 min of life, and every activation ends
  connected (M, Q17, Q21).

## Known debt / decisions for owner review

1. **WSAA 30-s ambiguity: CLOSED.** The timeout is now 90 s. Any post-dispatch timeout or transport loss becomes a
   durable 12 h 30 min hold (or a proven shorter/longer bound) that survives cancel and is inherited by the same
   equipo. No LoginCms is repeated inside it.
2. **Homologación issuer CN not measured: QA/homologation validation debt.** The label check is soft by design; the
   cryptographic authority is WSAA LoginCms, which is mandatory before activation. Measure it during the 2B QA
   smoke on the designated QA tenant.
3. **"Probar conexión" after activation.**
   - Settings calls afip-wsaa with `force_refresh=true`, which sends a LoginCms while the installed TA is valid.
     That returns `coe.alreadyAuthenticated`, and afip-wsaa marks `estado_conexion='error'`.
   - afip-wsaa also refreshes during the last 30 min of every TA.
   - Neither can change in 2A (afip-wsaa untouched).
   - **Phase 2B must hide or disable it** while Phase 1 reports connected with a valid cached TA, or route it
     through a TA-honouring server path.
   - The early-refresh behaviour is a separate afip-wsaa follow-up.
4. **`_shared/wsaaLogin.ts` duplicates afip-wsaa helpers: accepted maintenance debt.** Guard W1 keeps them
   token-identical until afip-wsaa adopts the module in a separately approved deploy.
5. **Legacy renewal CORS debt: outside Phase 2A.** The renewal flow (`arca-rotate-*`) is not reused by this flow;
   renewal is Phase 2C/3.
6. **Residuals of the fail-closed choice:**
   - a WSAA clock more than 10 min ahead would make every TA "beyond bound" (repeated holds, no terminal state);
   - a deterministic ambiguous defect has no escalation counter;
   - a lost material response whose not-dispatched report also fails locks for 12 h 30 min;
   - the hold is per business + equipo, not shared across tenants that reuse the same CUIT + alias.

   All are fail-closed and bounded, and they cost UX, not safety.
