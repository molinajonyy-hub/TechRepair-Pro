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
| CSS | `src/index.css` | Scoped `.arca-setup-*` block on existing tokens; one small step eyebrow, no progress bar; reduced-motion aware |

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

### Smoke follow-up: WSASS device name and a single step indicator

The real homologación smoke (§3) found that **WSASS only accepts letters and digits** as the device name
("Nombre simbólico del DN") and writes that name into the certificate CN. The authoritative fix is in
`arca_selfservice_prepare_initial` (separate PR #136, migration `20261002120000`). This PR is only the UX mirror.

- **Alias rule per environment** (`src/lib/arcaFiscalInput.ts`):
  - `ARCA_ALIAS_PATTERNS = { homologacion: /^[A-Za-z0-9]{3,50}$/, produccion: /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/ }`
    is an exact mirror of the server.
  - `aliasError(alias, ambiente)` gives the homologación message: "En homologación ARCA acepta únicamente letras y
    números. Usá entre 3 y 50 caracteres." Producción keeps its previous messages.
  - The only global single regex was removed.
- **Visible hint** under the field: "ARCA usa este nombre dentro del certificado. En homologación sólo puede contener
  letras y números."
- **Environment change:** switching the environment marks the alias as touched, so a producción-valid name with `.`
  or `-` shows as invalid immediately in homologación. `prepare` is never sent while it is invalid.
- **Suggestion:** lowercase, no accents, `a-z0-9` only, 3–50 (`techrepairclic`, `techrepairdemolocal`,
  `techrepair20301234567`). It is valid in both environments.
- **Guide (homologación)**, from what the smoke showed:
  - use exactly the name TechRepair Pro shows, letters and digits only;
  - first time: create the certificate normally;
  - existing name/DN with a new file: «agregar certificado a DN existente»;
  - "Si el DN ya tenía autorizado WSFE, esa autorización se conserva."
  - The producción guide is unchanged.
- **`CERTIFICATE_ALIAS_MISMATCH`:**
  - "El nombre del certificado no coincide con el nombre del equipo configurado." + "Generá el certificado usando
    exactamente el nombre que muestra TechRepair Pro."
  - `arcaSetupErrorForAmbiente` appends "En homologación, ARCA acepta sólo letras y números." only in homologación,
    so producción never gets that claim. `INVALID_ALIAS` gets the same treatment.
  - No CN, DER, subject or raw code is ever shown.
- **Step indicator:**
  - The gradient `.intake-progress` bar and the modal subtitle "Paso N de 6 · label" are gone.
  - Each screen shows one small eyebrow "Paso N de 6" (`arca-setup-step`, referenced by the heading's
    `aria-describedby`) above its heading: one reference to the step number, no repeated label, no gradient,
    percentage or animation.
  - During `prepare` the step stays **1**, with "Generando archivo para ARCA…" as the status. There is no transient
    "Paso 2" screen; the 6-step model stays in the docs and contract tests.
- **Guard:**
  - B10: per-environment rule by behavior, no global regex, `aliasError` receives the environment, suggestion without
    `.`/`-`.
  - B11: no progress bar or step subtitle; "Paso … de" exactly once.
  - B12: guide copy, error copy and environment-aware errors.
  - The server/frontend comparison is `scripts/guards/arca-wsass-alias-contract.mjs` (PR #136) once both are on `main`.

### Tutorial

`src/pages/Tutorials.tsx` steps 3, 4 and 6 now describe the wizard (generate the file in the app, present it in
ARCA with the same device name, upload the `.crt` and verify). The removed "Generar CSR para AFIP" / paste-the-
`.crt` instructions and a link that pointed to the WSAA WSDL are gone.

---

## 3. Verification

### Unit / contract / UI (`npm run test:arca-phase2b`, in CI)

| Suite | Covers |
|---|---|
| `scripts/guards/arca-phase2b-wizard-contract.mjs` (+ `--self-test`, 32 planted violations) | B1 no WSAA ticket from the browser (`afip-wsaa` invoke, `force_refresh`, "Probar conexión"); B2 no local progress / no backend outside services / components never call the Edge service; B3 screen from `deriveArcaSetupWizard(status)`, verify/activate only under `view.actions.includes('verify')`; B4 no secret material named in the UI; B5 errors through `describeArcaSetupError`, certificate classified before sending, no raw code rendered; B6 re-read on focus/online/visibility/hold expiry; B7 Settings mounts the panel with the hook; B8 fullscreen on mobile, no backdrop close; B9 honest copy; B10 alias rule per environment (behavioral), no global regex, suggestion without `.`/`-`; B11 no progress bar, "Paso … de" once; B12 WSASS guide and alias-mismatch copy, environment-aware errors |
| `tests/components/arcaPhase2bWizardContract.test.ts` (47; 13 new for the smoke follow-up: per-environment alias rule and corpus vs the server regexes, producción→homologación revalidation, suggestion, hint, WSASS guide, `CERTIFICATE_ALIAS_MISMATCH` / `INVALID_ALIAS` per environment) | every entry state; hold never offers verify (5 reasons × 2 steps); countdown and refresh timing; cancel copy per risk; every backend failure state has a mapped, jargon-free message; unknown/injected codes → generic; CUIT mod-11 incl. the 11→0 and 10→invalid cases; alias suggestion always valid; certificate file rules (PEM/DER ok; key blocks, PKCS#12/#8, `.key/.pfx/.p12`, CSR, oversize, unsupported rejected); guide uses only status data and one allowlisted link |
| `tests/components/arcaPhase2bWizardUi.test.tsx` (45; 19 new: suggestion/hint; homologación with hyphen, dot, underscore, space, accent → field error and **no `prepare`**; `techrepairdemohomo` sent; producción still sends a hyphen alias; producción→homologación revalidates immediately; single step eyebrow on 4 screens + Listo, no progress bar, no repeated label, no step on the cancel confirmation; WSASS guide notes; alias mismatch message in homologación and producción) | no plan → nothing rendered and no Edge call; read-only → only "Actualizar estado"; connected → no CTA and no "Probar conexión"; CUIT prefill/format, explicit environment, error linked via `aria-describedby`; double click → one `prepare` / one `verify`, same verify key on retry; server error shown from the map, on the field, without the raw code; request file re-fetched on every download; key file rejected locally and never sent; PEM upload → re-read; 5 hold reasons → no verify button; inherited hold on the certificate step; ambiguous verify → hold replaces the action notice; activation step reuses verify; cancel confirmation strong/simple and nothing sent before confirming; "Listo" only for `connected` + `none`, no material in the DOM; status hook re-reads on mount/focus/online/visibility (bursts collapsed), at `retry_not_before`, ignores stale responses, never keeps a stale state after a failed read, no `localStorage`/`sessionStorage` |
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
| 11 | WSASS device name (smoke follow-up) | suggestion is `[a-z0-9]`; `techrepair-demo-homo` is valid in producción and flips to invalid the moment homologación is picked; prepare is blocked with **0 Edge prepare calls and 0 rotation rows**; the alphanumeric name continues; eyebrow "Paso 3 de 6" once, no progress bar; guide shows «agregar certificado a DN existente» and "esa autorización se conserva"; a certificate issued with another CN (what WSASS did) gives `CERTIFICATE_ALIAS_MISMATCH` with the homologación detail and **0 LoginCms**; the right certificate → verify → Listo with **1 LoginCms**; stored alias is alphanumeric; no leaks |

Every screen in flows 1 and 11 also asserts a single step reference: `arca-setup-step` = "Paso N de 6", the heading
text, no `[role=progressbar]` / `.intake-progress`, and exactly one "Paso N de 6" in the dialog.

Server-side permission matrix (owner, admin, admin without `settings_sensitive`, manager with the capability,
tech, sales, cashier, viewer, inactive owner/admin, other tenant) is enforced and tested by the Phase 2A SQL suite
(`tests/sql/arca_phase2a_initial_setup.test.sql`) and the Phase 1 `can_manage` derivation; the UI only mirrors
`status.can_manage`.

Screenshots: `docs/arca-selfservice-phase2b/screenshots/` (generated by the spec into `test-results/` and copied once,
so later E2E runs never overwrite versioned PNGs).

### Homologación smoke with real ARCA — PASSED (2026-09-15)

#### Setup

| | |
|---|---|
| Frontend | Vercel Preview of this branch at `b6c9073` (production Supabase). This PR was **not** merged and Phase 2B was **not** deployed to production. |
| CORS | A temporary exact origin through `ARCA_SETUP_EXTRA_ORIGINS`, read only by `arca-selfservice-setup` (PR #134, guard G7). It was closed after the smoke; see below. |
| Tenant | **Demo Local Pro** (`f6262268`, `pro`, active), approved by the owner. Preflight: no business CUIT, no ARCA rows, `not_configured` / `start_setup`. Clic, Demo Empresa Full and cuenta prieba were not used. |
| Login | A person logged in as the tenant owner. No password, Clave Fiscal, token or cookie passed through the assistant. |
| ARCA | Homologación, PV 1, CUIT …6165, WSASS steps done manually by the owner. |

#### Timeline (UTC, Edge logs + audit)

| Time | Action | Result |
|---|---|---|
| 15:01:41 | prepare (1 POST) | `SETUP_PREPARED`, RSA 2048 / 65537. The key went straight to Vault and its fingerprint equals the CSR's. |
| 15:04:50 | download request file | 200, no audit |
| 15:27:39 | upload certificate | **409 `CERTIFICATE_ALIAS_MISMATCH`** (see finding P1). Fail-closed: no certificate stored, no ARCA call, no hold. |
| 15:33:03 | cancel (owner-approved) | `SETUP_CANCELLED`. The unused key was deleted from Vault; no hold existed. |
| 15:33:27 | prepare again with alias `techrepairdemohomo` | `SETUP_PREPARED`, new key |
| 15:33:44 | download request file | 200 |
| 15:42:13 | upload certificate | `CERTIFICATE_ATTACHED`. Issuer `C=AR, O=AFIP, CN=Computadores Test`; subject CN `techrepairdemohomo` + serialNumber; valid until 2028-09-14; key match. |
| 15:43:55.631 → 15:43:56.316 | verify (**1 POST**) | `verification_started` → `VERIFIED` → `ACTIVATED`, with `ticket_installed: true` |

#### Measurements

- **LoginCms count: exactly 1.** One `verification_started` event and one verify POST. No second verification was attempted.
- **Ticket expiry:** `2026-09-16T03:43:56.033Z`, 12 h after issuance.
- **Clock delta, server ↔ ARCA:** the TA `generationTime` (expiry − 12 h = `15:43:56.033`) falls inside the server window
  `[15:43:55.631, 15:43:56.131]`, so |Δ| ≤ 0.5 s.
- **Activation:**
  - The rotation is `completed` (activated = finalized).
  - One `active` credential uses the rotation's Vault secret, and its fingerprint matches the certificate.
  - `arca_config` is `conectado` in homologación, with the certificate and ticket installed and no pfx or password.
- **Final status:** `connected` / `next_action = none`, renewal `healthy`, `matches_credential` true. The wizard showed "Listo".
- **No emission:** CAE 182 → 182, emission attempts 142 → 142. Demo Local Pro has 0 of both. FECAESolicitar was never called.
- **Leak audit:**
  - No function console output other than boot and shutdown.
  - Every audit row since the start of the smoke has `details` null or the bounded activation summary, and a scan for
    `-----BEGIN`, `PRIVATE KEY`, `<token>`, `<sign>` and XML base64 found nothing.
  - No rotation or config text contains a private key.
  - `authenticated` and `anon` have no SELECT on `arca_config.wsaa_token` / `wsaa_sign` or on the rotations table.
  - The browser only ever handled the CSR and the certificate, both public.

#### Findings

1. **P1: WSASS device names.** WSASS homologación only accepts letters and digits in "Nombre simbólico del DN", and it
   writes that name into the certificate CN.
   - The fiscal step and the server regex `^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$` accept `.` and `-`.
   - So an alias like `techrepair-demo-homo` can never pass upload in homologación.
   - The guide's "Usá exactamente este nombre de equipo" cannot be followed either.
   - The error "El certificado es de otro equipo" does not tell the user that ARCA rewrote the name.
   - **Addressed.** The server authority is PR #136 (homologación `^[A-Za-z0-9]{3,50}$`, producción unchanged). The
     UX mirror, guide and error copy are in this PR (§2, "Smoke follow-up").
2. **WSASS re-issue.** A new CSR for an existing device needs "agregar certificado a DN existente". "Nuevo certificado"
   fails with "El ALIAS ya existe". The `wsfe` authorization survives because it is tied to the DN.
   - **Addressed:** the homologación guide says both.
3. **UX: progress bar.** The gradient bar under the header repeated "Paso N de 6" and didn't match the design system.
   - **Addressed:** removed; one "Paso N de 6" eyebrow above the heading.
4. **Out of scope.** Tracked separately, not changed here:
   - "¿Olvidaste tu contraseña?" (PKCE link) lands on the dashboard without the new-password form;
   - `arca-rotate-prepare` / `arca-rotate-activate` echo any CORS origin;
   - `afip-wsaa` refreshes in the last 30 minutes of a ticket.

#### Temporary CORS closed (P0)

1. `supabase secrets unset ARCA_SETUP_EXTRA_ORIGINS`: the name is absent afterwards; the `APP_URL` digest is unchanged.
2. Redeploy of `arca-selfservice-setup`.
   - The plain `functions deploy` printed "No change found" and did **not** create a version.
   - `--use-api` produced **v5**: `verify_jwt = true`, deployed source equal to `main` `29df531` in all 9 files.
3. The OPTIONS matrix (before and after v5) passed 10/10:
   - the Preview origin gets **no** `Access-Control-Allow-Origin`;
   - `www` and apex are allowed;
   - other Vercel previews, look-alikes, `http`, and arbitrary origins are blocked.
4. A POST without a JWT returns 401.

`arca-rotate-prepare` and `arca-rotate-activate` still echo any origin. That is pre-existing Phase 0 debt, unchanged
by this work.

### Clic fingerprint (production, read-only)

- **Before the work:** `arca_config` row md5 `dbbb4aa2…`, credential md5 `1f8f633a…`, 54 Vault secrets, 1 rotation,
  0 self-service initial rows, status `connected` / `none`, DB tip `20260930120000`.
- **After the work:** identical on every field. Phase 2B performed no production writes.
- **Smoke, before (13:30:45Z) and after (15:48:44Z):** identical on every Clic-scoped field.
  - Config row incl. WSAA cache: `dbbb4aa2…`.
  - Credential `1f8f633a…` and its Vault secret metadata.
  - Rotations `cc3f025b…` (1).
  - Audit 51 / max 52.
  - Emission attempts `5572567e…` (142) and CAE rows `718016e2…` (182).
  - Status `connected` / `none`.
  - DB tip `20261001120000`.
  - The 54 pre-existing Vault secrets have the same metadata.
- **Global deltas:** all belong to Demo Local Pro. One live Vault secret, 2 rotations (1 cancelled, 1 completed),
  1 config row, 1 credential and 8 audit rows.
