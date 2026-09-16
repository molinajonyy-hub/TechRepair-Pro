# ARCA Self-Service · WSASS homologación device name

Base: `main` `29df5312ddbfa5fb73db09b82a7f2261a8d44000`, prod DB tip `20261001120000`.
Migration: `supabase/migrations/20261002120000_arca_selfservice_wsass_homologacion_alias.sql`.
Reviewed rollback: `docs/arca-selfservice-wsass-alias/rollback.sql`.

## Finding (real homologación smoke, 2026-09-15)

The smoke ran on Demo Local Pro (`f6262268`) through the #133 Preview against production.

1. The wizard accepted `techrepair-demo-homo`, and `prepare_initial` generated a CSR with that CN.
2. WSASS ("Autogestión Certificados Homologación") rejected that name in "Nombre simbólico del DN":
   *«El Nombre simbólico del DN sólo puede contener números y/o letras»*.
3. The DN was created as `techrepairdemohomo` with the same CSR. **WSASS issued the certificate with CN = the symbolic
   name**, not the CSR CN.
4. The upload failed as designed with `CERTIFICATE_ALIAS_MISMATCH`: no LoginCms and no hold. But the flow had no way
   forward, because homologación can never issue a certificate whose CN contains `-` or `.`.
5. The flow was rebuilt with the owner's approval (cancel + second prepare with `techrepairdemohomo`) and finished:
   exactly 1 LoginCms, issuer `Computadores Test`, `connected` / `next_action = none`.

The authority is `public.arca_selfservice_prepare_initial`, so the fix belongs there and not only in the browser.

## Change

`arca_selfservice_prepare_initial` validates the alias per environment. The environment is already validated
earlier in the function, and anything else falls into `ELSE false` (fail-closed):

| Environment | Rule | Status |
|---|---|---|
| `homologacion` | `^[A-Za-z0-9]{3,50}$` — letters and digits only; no dot, hyphen, underscore, space or accent | **new** |
| `produccion` | `^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$` | unchanged (no evidence to change it) |

- The response for an invalid alias is still `INVALID_ALIAS`; no new code.
- The body is copied verbatim from `20260930120000`; only the alias block differs.
- The signature is unchanged, so `CREATE OR REPLACE` keeps owner, ACL (service_role-only) and comment.
- An explicit `REVOKE ALL … FROM PUBLIC` is a no-op today; it documents that the function never starts open.

**Not changed:** CUIT, razón social, PV, idempotency (`request_hash`), Vault, CSR, private key, holds, certificate
validation, WSAA, activation, cancel, permissions, grants, RLS, CORS, emission.
**No DML:** existing configurations, including connected ones, stay byte-identical. The migration post-check
enforces this.

### Migration post-conditions (hard `RAISE`)

- **Rules:** the homologación and producción rules are present, with a single overload.
- **Function attributes:** ACL, owner and comment are identical to before; SECURITY DEFINER and `search_path` are
  unchanged; EXECUTE is service_role only.
- **No drift:** every other function in `public` and `private` has the same `pg_get_functiondef` md5.
- **No DML:** credentials, rotations (count and row md5), audit, Vault and `arca_config` (row md5) are unchanged.

## Tests

### `tests/sql/arca_wsass_homologacion_alias.test.sql`

Run with `npm run test:sql:arca-wsass-alias`. One transaction with ROLLBACK.

| Test | Covers |
|---|---|
| W01 | one signature, SECDEF, fixed `search_path`, EXECUTE service_role only, no PUBLIC |
| W02 | homologación accepts `abc`, `techrepair`, `techrepairdemohomo`, `techrepairdemolocal`, `techrepair20301234567`, mixed case, digits only, exactly 50, leading/trailing spaces (btrim, as before) |
| W03 | homologación → `INVALID_ALIAS` for: `ab`, 51 chars, `techrepair-demo`, `.demo`, `_demo`, space, `técnico`, `ñ`, `Á`, `demo/arca`, `@`, `#`, `+`, `,`, `:`, quotes, backslash, `*`, tab, newline, full-width, Arabic digits, emoji, empty, NULL, only spaces |
| W04 | producción: explicit cases (`.` and `-` still valid; `ab`, `-abc`, `.abc`, `_`, space, 51 chars, accents still rejected), plus a 336-alias corpus compared against the previous regex in both directions — not widened, not narrowed |
| W05 | unknown / spaced / uppercase environment is still `INVALID_AMBIENTE`; an invalid alias only ever returns `INVALID_ALIAS` |
| W06 | full prepare with real key + CSR: a hyphen alias in homologación writes nothing (no Vault, no row); an alphanumeric alias gives `SETUP_PREPARED`; replay stays `SETUP_ALREADY_PREPARED`, one row |
| W07 | a business already connected in homologación with an old hyphen alias stays `ARCA_ALREADY_CONFIGURED`, config unchanged |
| W08 | the probes left no rows, config, secrets or audit |

### Phase 2A suite and fixtures

The homologación Phase 2A flows used `qa-initial-setup`, which is now rejected. The synthetic fixtures were
regenerated with `CN=qainitialsetup` (`scripts/security/gen-arca-phase2a-fixtures.ts`, `--node-modules-dir=none`).
The suite and the local E2E script use alphanumeric aliases. The Phase 2A contract is otherwise unchanged
(Q03 keeps `_`, space and 2-char aliases as `INVALID_ALIAS`).

### Guard `scripts/guards/arca-wsass-alias-contract.mjs`

Runs in CI via `npm run test:arca-wsass-alias`.

| Rule | What it enforces |
|---|---|
| A1 | the **latest** `prepare_initial` definition validates the alias per environment with `INVALID_ALIAS`, `ELSE false`, and `v_alias = btrim(coalesce(p_alias,''))`; a later migration that restores a global rule or drops the check fails |
| A2 | **behavior, not text**: the extracted regexes run over a 523-string corpus; homologación must equal `[A-Za-z0-9]{3,50}` and producción must equal the previous rule |
| A3 | when `src/lib/arcaFiscalInput.ts` declares `ARCA_ALIAS_PATTERNS` (PR #133), the frontend regexes must accept and reject exactly what the server does across the corpus; until then it is reported, not blocking |

Self-test: 12 planted regressions detected, plus a positive control (a correct frontend mirror passes).

## Local verification

Run on an isolated stack (`project_id` `techrepair-wsass-alias`, API 55421; `config.toml` restored before commit).

| Check | Result |
|---|---|
| `supabase start` / `db reset` (all migrations + this one) | OK; post-check NOTICE |
| WSASS suite | 8/8 (W01–W08) |
| Phase 2A SQL suite | 22/22 (Q01–Q22) |
| Phase 0 / Phase 1 SQL suites | OK |
| Phase 2A local E2E (real handler, simulated WSAA) | 74 assertions, 2 simulated LoginCms, 0 failures |
| Reviewed rollback | ACL, owner, comment and ledger identical; definition md5 `4958b261…` = current main **and** production |
| Negative control | on the rollback, the WSASS suite **fails** at W03 (`techrepair-demo` → `KEY_REQUIRED`) |
| Reapply | definition md5 `27f3d933…` = first apply; WSASS suite green |
| Guards | `arca-wsass-alias` + self-test OK; `arca-phase2a` + self-test (31) OK |
| `guard-secdef-exposure` (not in CI, red on main) | main 20 findings → branch 21; the extra one is R5 on this function, the same class Phase 2A already has (the guard does not recognize the `auth.role() = service_role` gate); R2 is resolved by the explicit REVOKE |

## Production (read-only, 2026-09-15 19:09 UTC)

Nothing was applied.

- **DB:** tip `20261001120000`; `20261002120000` is not applied.
- **`prepare_initial`:** definition md5 `4958b261…`, identical to main and to this PR's rollback; the old rule is
  present; ACL `{postgres=X, service_role=X}`.
- **No pending setups** and **no homologación configuration with `.` or `-`** in its alias, so the rule affects
  no live row.
- **Demo Local Pro:**
  - `connected` / `none`, alias `techrepairdemohomo`;
  - rotations `b584f1bf` cancelled + `aaf2c95e` completed;
  - config row md5 `fa1516ba…`; 0 attempts, 0 CAE.
- **Clic:** config `dbbb4aa2…`, credential `1f8f633a…`, rotations `cc3f025b…`, audit 51, attempts 142, CAE 182 —
  identical to the smoke fingerprints.
- No WSAA call, no certificate, no CORS change, no emission.

## Rollout (when approved; not done here)

1. `supabase db push` of this single migration; the dry-run must show exactly one.
2. Read-only post-check:
   - `prepare_initial` definition md5 equals the local apply (`27f3d933…`);
   - the ACL is unchanged;
   - Demo Local Pro and Clic fingerprints are unchanged.
3. There is no Edge redeploy (the Edge does not validate the alias).
4. The frontend mirror ships with #133. The two can be deployed in either order:
   - DB first: an old wizard that sends a hyphen alias in homologación gets `INVALID_ALIAS` — the correct outcome,
     instead of a dead end at upload.
   - Frontend first: the UI is stricter than the server, which is harmless.

## Follow-ups (out of scope)

- `arca-rotate-prepare` / `arca-rotate-activate` echo any CORS origin (Phase 0 debt).
- "¿Olvidaste tu contraseña?" (PKCE link) lands on the dashboard without the new-password form.
- `afip-wsaa` refreshes during the last 30 minutes of a ticket and still honors `force_refresh` server-side.
