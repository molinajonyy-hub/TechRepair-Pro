# ARCA Self-Service · Phase 2B — setup wizard UI

Baseline: `main` = `2f4808bbdf4dc3b7ae64ed8739164e1dca0285d7` (tag `stable-arca-selfservice-phase2a-v1`),
prod DB tip `20260930120000`, Edge `arca-selfservice-setup` v1 (`verify_jwt = true`), status `contract_version` 1.
Branch `claude/arca-selfservice-phase2b-wizard`. Phase 2B is product + UX + integration on the Phase 2A
contract. The Phase 2A backend is not redesigned.

---

## 1. Discovery

### A. Architecture found

| Surface | Where | What it does today |
|---|---|---|
| Entry point | `src/pages/Settings.tsx`, tab `arca` ("Integración ARCA"), `?tab=arca` | One `surface-raised` block: read-only notice, `ArcaStatusCard`, and, only when configured or identity-locked, a legacy "Configuración" panel |
| Status authority | `ArcaService.getSelfServiceStatus` → RPC `get_arca_selfservice_status` → `parseArcaSelfServiceStatus` (`src/lib/arcaStatus.ts`) | Canonical Phase 1 read model. Fail-closed parser; Phase 2A adds `setup.verification_hold` / `retry_not_before` |
| Status card | `src/components/settings/ArcaStatusCard.tsx` | Pure presentation (`describeArcaStatus`). The empty state says "Próximamente vas a poder configurarlo…" |
| Wizard contract | `src/lib/arcaSetupWizard.ts` | Pure `deriveArcaSetupWizard(status)` → screen, step, actions, hold, `confirmCancel`, plus hold copy. Not rendered anywhere yet |
| Setup client | `src/services/arcaSetupService.ts` | The only caller of Edge `arca-selfservice-setup`: `prepare`, `getRequestFile`, `attachCertificatePem/DerBase64`, `verifyAndActivate`, `cancel`; fail-closed `parseArcaSetupResponse` |
| Edge | `supabase/functions/arca-selfservice-setup` | Manager authority + plan + SQL owner/admin; durable WSAA holds decided by SQL (Phase 2A README L1–L3) |
| UI authority mirror | `src/lib/arcaAuthority.ts` `canManageArca` (active + owner/admin + `settings_sensitive`) | Presentation only; the server decides |
| Plan gate | `business_has_feature('arca')` (Edge) and `status.available` (Phase 1) | `basico` has no ARCA; `pro` / `full` do |
| "Probar conexión" | `Settings.handleTestArcaConnection` → `ArcaService.testConnection` → `getWSAAToken(…, force_refresh = true)` → Edge `afip-wsaa` | **Forces a new LoginCms** while the installed ticket is valid. Result: `coe.alreadyAuthenticated`, then afip-wsaa marks `estado_conexion='error'`. Reports via `alert()` |
| Legacy config panel | Settings (configured only): CUIT/ambiente/alias locked, PV + razón social editable via `save_arca_config_legacy`, "Sincronizar Parámetros" (local `arca_parametros` defaults, no WSAA) | Stays for configured businesses |
| Tutorial | `src/pages/Tutorials.tsx` `TutorialARCA` | **Stale**: tells users to click a nonexistent "Generar CSR para AFIP", paste the `.crt`, and never regenerate. Its ARCA-portal steps are the only in-repo documentation of the portal flow (Administración de Certificados Digitales → alias + CSR → `.crt`; Administrador de Relaciones → alias + WSFE) |
| Shared UI | `src/ui` (`AppModal` with `mobilePresentation`, `AppButton`, `AppInput`, `AppConfirmDialog`, `MobileActionBar`, `AppBadge`), tokens `src/lib/tokens.ts`, CSS `src/index.css` | The order-intake wizard (MOBILE-2A, `NewOrder.tsx` + `.intake-*`) is the established step pattern: eyebrow "Paso X de N", progress bar, step card, desktop actions + `MobileActionBar` |
| Guards | Phase 0 (legacy writes), Phase 1 S5 (status RPC only in `arcaService`, card has no Supabase, Settings renders `<ArcaStatusCard`), Phase 2A F1–F3 (browser has no key material or private tables; only `arcaSetupService` invokes the Edge; wizard derivation pure) | All must stay green |
| Tests | Vitest `arcaPhase1Status`, `arcaPhase2aSetupContract`, `arcaPhase0Authority`; node unit `arcaConfigWriteContract` pins `arca-test-connection` / `arca-save-config` markup | E2E `m7-local` (local Supabase, owner storageState, destination guard); the edge runtime is **not** started in CI |

### B. Reuse
- The Phase 1 status read model and parser (the only lifecycle authority), `describeArcaStatus`, and `ArcaStatusCard` for configured tenants.
- `deriveArcaSetupWizard` and `arcaSetupService` (extended, not replaced).
- `AppModal` (fullscreen on mobile), `AppButton`, `AppInput`, `AppConfirmDialog`, `MobileActionBar`, and the intake wizard visual language.
- The tutorial's validated portal steps as guide content (without the stale app instructions).

### C. Replace
- The empty-state "Próximamente…" hint → a real entry (CTA / progress / hold).
- "Probar conexión" (force LoginCms) → a server status re-read that never requests a ticket.
- `alert()` feedback in the ARCA tab → inline, accessible state.
- The stale tutorial steps that reference the removed CSR/paste flow.

### D. Debt / duplication
- `ArcaService.testConnection` + `getWSAAToken(forceRefresh)` becomes dead code. It is removed from the browser, and a guard prevents a forced refresh from coming back.
- `arcaConfig` (`get_arca_config_safe`) and Phase 1 status coexist in Settings. The legacy panel keeps using the safe config only for editable PV / razón social.
- afip-wsaa refreshes during the last 30 minutes of every ticket. That is out of scope and tracked as a follow-up.
- `Settings.tsx` is a ~1.6k-line page. The wizard lives in its own feature folder so the page only mounts it.

### E. UX proposal
- The ARCA tab shows one **entry panel** derived from status:
  - not configured → "Conectar ARCA";
  - in progress → step summary + "Continuar configuración";
  - hold → explanation + server time, no verify;
  - connected → status card;
  - no plan → product state;
  - read-only → notice.
- **Wizard** in `AppModal` (large on desktop, fullscreen on mobile). It can always be closed and resumes from the server:
  1. **Datos fiscales** — CUIT with live formatting and check-digit feedback, razón social, environment as two explicit choices, PV with a short hint, alias as an editable suggestion.
  2. **Generar archivo** — `prepare`; the key is generated server-side.
  3. **Presentarlo en ARCA** — "Descargar archivo para ARCA" (re-downloadable) plus a short guide per environment, structured for future screenshots and links.
  4. **Subir certificado** — drag and drop plus file picker; PEM or DER; validating / valid / rejected states.
  5. **Verificar conexión** — single-flight verify + activate progress; the hold replaces the button with a server-authoritative wait and a presentation-only countdown.
  6. **Listo** — only after a refetch shows `connected` + `next_action = none`.
- **Cancel** always goes through a confirmation. When ARCA may hold an access, the stronger copy is used.
- **Errors** go through one mapping module (`code → category, title, message, action, retry policy`).
- **Refetch** on mount/open, window focus, `visibilitychange`, `online`, `retry_not_before` expiry, and after every mutation. No local state machine.

### F. Risks
- **Hold bypass by UI state** → the screen is derived only from status; after any failure the wizard refetches; verify is never rendered during a hold.
- **Double verify** → one in-flight lock per action, disabled controls, and the server lease/hold as the real guard.
- **Leaking secrets** → the browser only receives CSR PEM (public), filename and bounded states. Guards F1 and E1 apply, plus a new leak check.
- **"Probar conexión" breaking a valid ticket** → replaced by a status re-read.
- **Guard coupling** (Phase 1 S5 requires `<ArcaStatusCard` in Settings; node unit pins test ids) → kept, and tests updated deliberately.
- **Local E2E needs the Edge function** (no edge runtime in CI) → a Deno harness runs the real `handler.ts` against local PostgREST with fake WSAA; Playwright routes the function URL to it.
- **Homologación smoke** needs a real QA login, a tenant with an ARCA plan, a real CUIT with Clave Fiscal, and manual ARCA portal steps. `cuenta prieba` is suspended without a plan. `Demo Local Pro` / `Demo Empresa Full` are active, clean candidates, but using them needs owner approval.

---

## 2. Implementation

No migration, no Edge change, no RLS/grant change. `contract_version` stays 1. `afip-wsaa` and
`_shared/wsaaLogin.ts` are untouched.

### Layers

| Layer | File | Responsibility |
|---|---|---|
| Pure | `src/lib/arcaSetupWizard.ts` (extended) | `deriveArcaSetupEntry` (tab entry: loading / unreadable / unavailable / read_only / start / resume / connected / status_only), `arcaSetupVisibleStep` (steps 3/4 are a presentation sub-stage of the server step `certificate`), `arcaHoldCountdown` (presentation only), `nextArcaStatusRefreshMs` (re-read at `retry_not_before` + 2 s, every 10 s while `in_progress`, capped at 15 min), `arcaCancelCopy` |
| Pure | `src/lib/arcaSetupErrors.ts` | The single error map: code → category (input / auth / plan / certificate / arca / hold / ambiguous / activation / network / flow), tone, title, message, action, retry policy (`now` / `after_fix` / `after_hold` / `later` / `never`), field. Unknown or injected codes → safe generic. No raw code or ARCA text is ever rendered |
| Pure | `src/lib/arcaFiscalInput.ts` | CUIT progressive format + the server's mod-11 rule, alias / PV / razón social limits, editable alias suggestion. Never invents a CUIT |
| Pure | `src/lib/arcaCertificateFile.ts` | Local classification: PEM certificate → text; DER X.509 → base64; any key block, `.key/.pfx/.p12`, or a DER container that starts with a version INTEGER (PKCS#12/#8) is rejected **and never sent**; CSR files are recognised with a specific message; 64 KB cap (same as the Edge) |
| Pure | `src/lib/arcaSetupGuide.ts` | Guide content as data per environment (screenshots/links can be added later). Only portal steps already documented in the repo; one official link already used by the product |
| Hook | `src/hooks/useArcaSelfServiceStatus.ts` | The only reader of Phase 1 status for the tab. Re-reads on mount, business change, window `focus`, `visibilitychange`, `online`, hold expiry and after every action; stale responses never overwrite newer ones; a failed read shows "unreadable" (retried every 30 s), never a stale state |
| Hook | `src/hooks/useArcaSetupActions.ts` | One action at a time (synchronous lock). Idempotency keys in memory only: `prepare` reuses its key while the payload is identical, `verify` keeps one key per setup, cancel/consumed/conflict discard them. Every action ends with a status re-read. The request file is fetched from the server on each download. Certificates go through `readArcaCertificateFile` first |
| UI | `src/components/settings/arca-setup/*` | `ArcaSetupPanel` (entry under the status card; owns the actions so the lock survives closing the modal), `ArcaSetupWizard` (`AppModal` lg, fullscreen on mobile, no backdrop close), `ArcaFiscalStep`, `ArcaCertificateSteps` (identity, download + guide, drag-and-drop upload), `ArcaSetupNotices` (hold with countdown, error, info) |
| Page | `src/pages/Settings.tsx` | Uses the hook, mounts the panel under `<ArcaStatusCard status={arcaStatus}`. The legacy "Probar conexión" is gone |
| CSS | `src/index.css` | Scoped `.arca-setup-*` block on existing tokens; reuses `.intake-progress`; reduced-motion aware |

### Screen contract (always derived from status)

| Status | Screen | Visible step | Actions |
|---|---|---|---|
| not configured, can manage | Datos fiscales | 1 (2 while generating) | prepare |
| `in_progress` / `certificate` | Presentá el archivo → Subí el certificado | 3 → 4 (local sub-stage) | download, upload, cancel |
| `in_progress` / `verification`, no hold | Verificar | 5 | verify, replace certificate, download, cancel |
| `verification` + hold `in_progress` | Espera | 5 | download only |
| `verification` + other hold | Espera + countdown | 5 | download, replace certificate, cancel (strong confirmation unless `cooldown`) |
| `in_progress` / `activation` | Terminar activación | 5 | verify (activation only, no WSAA), cancel (strong) |
| `connected` + `next_action = none` | Listo | 6 | — |
| no plan / read-only / anything else | Product state / notice / "the status changed" | — | — |

### "Probar conexión" (P0)

The button called `ArcaService.testConnection` → `afip-wsaa` with `force_refresh = true`: a new LoginCms while
the installed ticket was valid (ARCA answers `coe.alreadyAuthenticated` and the connection was flagged as an
error). It is replaced by **"Actualizar estado"**, which only re-reads the canonical status. `testConnection`,
`getWSAAToken` and the browser path to `afip-wsaa` were removed; `edge-cors-client-contract` no longer lists
`afip-wsaa` as browser-called; guard B1 prevents it from coming back.

**Known debt (not changed here):** `afip-wsaa` itself still accepts `force_refresh` from any authorised caller
and refreshes during the last 30 minutes of each ticket. A server-side cooldown for that path is a follow-up.

### Cancel

Always confirmed, inline in the wizard (no nested modal). Copy is honest: cancelling never revokes anything in
ARCA and does not end a wait; with `result_unknown` / `ticket_active` / `verification_expired` or an unfinished
activation the strong copy is shown. After cancel the status is re-read; re-preparing the same device (alias +
CUIT) shows the inherited wait (E2E flow 6).

### Honest copy (review follow-up)

- **Clave Fiscal:** the entry says the CUIT and access to ARCA with Clave Fiscal are needed for a step on the ARCA site, and that
  TechRepair Pro never asks for or stores the Clave Fiscal. The step-3 guide and tutorial step 1 repeat it. There is no Clave Fiscal
  or password field anywhere in the wizard.
- **Final state:** "La conexión con ARCA quedó configurada correctamente. TechRepair Pro usará esta conexión cuando emitas
  comprobantes electrónicos." The wizard verifies the WSAA connection and activates it; it does not emit, request a CAE or
  call FECAESolicitar, so it no longer promises emission. The Phase 1 card's `connected` line was aligned the same way.
- Pinned by guard B9 (5 planted violations), 5 unit/UI tests and E2E flow 1.

### Tutorial

`src/pages/Tutorials.tsx` steps 3, 4 and 6 now describe the wizard (generate the file in the app, present it in
ARCA with the same device name, upload the `.crt` and verify). The removed "Generar CSR para AFIP" / paste-the-
`.crt` instructions and a link that pointed to the WSAA WSDL are gone.

---

## 3. Verification

### Unit / contract / UI (`npm run test:arca-phase2b`, in CI)

| Suite | Covers |
|---|---|
| `scripts/guards/arca-phase2b-wizard-contract.mjs` (+ `--self-test`, 16 planted violations) | B1 no WSAA ticket from the browser (`afip-wsaa` invoke, `force_refresh`, "Probar conexión"); B2 no local progress / no backend outside services / components never call the Edge service; B3 screen from `deriveArcaSetupWizard(status)`, verify/activate only under `view.actions.includes('verify')`; B4 no secret material named in the UI; B5 errors through `describeArcaSetupError`, certificate classified before sending, no raw code rendered; B6 re-read on focus/online/visibility/hold expiry; B7 Settings mounts the panel with the hook; B8 fullscreen on mobile, no backdrop close |
| `tests/components/arcaPhase2bWizardContract.test.ts` (34) | every entry state; hold never offers verify (5 reasons × 2 steps); countdown and refresh timing; cancel copy per risk; every backend failure state has a mapped, jargon-free message; unknown/injected codes → generic; CUIT mod-11 incl. the 11→0 and 10→invalid cases; alias suggestion always valid; certificate file rules (PEM/DER ok; key blocks, PKCS#12/#8, `.key/.pfx/.p12`, CSR, oversize, unsupported rejected); guide uses only status data and one allowlisted link |
| `tests/components/arcaPhase2bWizardUi.test.tsx` (26) | no plan → nothing rendered and no Edge call; read-only → only "Actualizar estado"; connected → no CTA and no "Probar conexión"; CUIT prefill/format, explicit environment, error linked via `aria-describedby`; double click → one `prepare` / one `verify`, same verify key on retry; server error shown from the map, on the field, without the raw code; request file re-fetched on every download; key file rejected locally and never sent; PEM upload → re-read; 5 hold reasons → no verify button; inherited hold on the certificate step; ambiguous verify → hold replaces the action notice; activation step reuses verify; cancel confirmation strong/simple and nothing sent before confirming; "Listo" only for `connected` + `none`, no material in the DOM; status hook re-reads on mount/focus/online/visibility (bursts collapsed), at `retry_not_before`, ignores stale responses, never keeps a stale state after a failed read, no `localStorage`/`sessionStorage` |
| Phase 1 / 2A suites | unchanged contracts still green; the Phase 1 card hint no longer says "Próximamente" |

### Local E2E (`tests/e2e/m7/arca-selfservice-wizard.spec.ts`)

The CI E2E job does not start Supabase's edge-runtime. `scripts/e2e/arca-setup-edge-harness.ts` serves the **real**
`handler.ts` on 127.0.0.1:5199 with real authority (`authorizeArcaManager` with the browser JWT), real plan check,
real service-role RPCs against local PostgREST, real key/CSR generation and PKCS#7 signing. Only WSAA is simulated
(`ta` / `gateway` 502 / `not_authorized`), plus a synthetic CA that signs the downloaded CSR. It refuses to start
unless `SUPABASE_URL` is local. `e2e:ci-local` starts it (Deno is mandatory in CI; the CI job now installs it).
Playwright routes `/functions/v1/arca-selfservice-setup` to it; the browser code is unchanged.

| # | Flow | Assertions |
|---|---|---|
| 1 | Happy path | invalid CUIT never reaches the server; prepare → step 3 → CSR download (no key material) → upload → verify → "Listo" → card "Conectado"; **exactly 1 LoginCms**; "Actualizar estado" adds none; no Edge response to the browser carries key/ticket/secret ids/attempt ids/64-hex |
| 2 | Reload after prepare | resumes at "Paso 3 de 6"; re-download returns the same request; still 1 prepare |
| 3 | Reload after certificate | resumes at verify; 0 LoginCms |
| 4 | Reload after verify with activation failing | `ACTIVATION_PENDING` → reload → "Terminar activación" → "Listo"; LoginCms stays **1** |
| 5 | 502 during verify | `result_unknown` hold, no verify button, reload keeps it, a direct Edge verify gets 409 `WSAA_RESULT_UNKNOWN`; LoginCms stays **1** |
| 6 | Cancel during `result_unknown` | strong confirmation; after cancel and re-prepare of the same device the hold is inherited and verify stays hidden; LoginCms **1** |
| 7 | Wrong certificate | `CERTIFICATE_KEY_MISMATCH` mapped message, stays on the step; key file rejected locally (no certificate request sent) |
| 8 | No permission (tech) | no wizard entry; direct Edge call → 401/403 `FORBIDDEN`/`UNAUTHORIZED`; 0 LoginCms |
| 9 | No plan (`basico`) | card "No incluido en tu plan", no entry, 0 Edge calls |
| 10 | Mobile 375 / 320 | fullscreen dialog, no horizontal scroll, radios usable with arrow keys, error linked to the field |

Server-side permission matrix (owner, admin, admin without `settings_sensitive`, manager with the capability,
tech, sales, cashier, viewer, inactive owner/admin, other tenant) is enforced and tested by the Phase 2A SQL suite
(`tests/sql/arca_phase2a_initial_setup.test.sql`) and the Phase 1 `can_manage` derivation; the UI only mirrors
`status.can_manage`.

Screenshots: `docs/arca-selfservice-phase2b/screenshots/` (generated by the spec into `test-results/` and copied once,
so later E2E runs never overwrite versioned PNGs).

### Homologación smoke with real ARCA — BLOCKED (needs owner action)

Not executed. Nothing in production was modified. Minimum needed:

1. **Frontend with the wizard reachable** in an environment that talks to the production Supabase. Phase 2B is not
   deployed (this PR is not merged) and running a local app against production is forbidden by the dev preflight.
   Alternative without deploying: call the production Edge directly with the QA owner's session, which still needs (2).
2. **A QA tenant, explicitly approved by the owner.** Read-only check (2026-09-14): `cuenta prieba` (3b52e902) is
   `suspended` with no plan — it must not be reactivated silently. `Demo Local Pro` (f6262268, `pro`, active) and
   `Demo Empresa Full` (a69a72e4, `full`, active) have no ARCA config, credential or rotation. Never Clic.
3. **A login for that tenant's owner**, entered by a person (credentials are never typed by the assistant).
4. **A CUIT with Clave Fiscal level 3** allowed to use the homologación certificate service (WSASS). If the tenant's
   business profile has a CUIT, the wizard CUIT must match it (`CUIT_TENANT_MISMATCH`).
5. **Manual ARCA portal steps** by that person: create the certificate in WSASS with the downloaded file and the
   exact device name, authorise `wsfe` for it, download the `.crt`, upload it in the wizard, press "Verificar
   conexión" **once**.
6. What to measure: certificate issuer accepted for homologación, ticket expiry recorded (TA ~12 h), exactly one
   LoginCms in the Edge logs, no key/ticket/secret in logs or responses, Clic fingerprint unchanged.

### Clic fingerprint (production, read-only)

Taken before the work with the Phase 2A rollout query: `arca_config` row md5 `dbbb4aa2…`, credential md5
`1f8f633a…`, 54 Vault secrets, 1 rotation, 0 self-service initial rows, status `connected` / `none`, DB tip
`20260930120000`. Taken again after the work: identical on every field (config row incl. the WSAA cache,
credential row, Vault count and metadata, rotations, credential audit max id/count, status, DB tip). Phase 2B
performed no production writes.
