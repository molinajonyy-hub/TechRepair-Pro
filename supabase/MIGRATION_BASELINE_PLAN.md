# Supabase migration baseline — runbook

Goal: a clean, self-contained migration baseline so `supabase db reset` works from zero
and Preview Branches faithfully reproduce the hosted project
(`vrdxxmjzxhfgqlnxmbwx` / techrepair-pro).

Status legend: ✅ done in this branch · ⏳ needs the DB password (run by a human) · 🔒 prod write (explicit approval each time).

---

## FINAL BASELINE — generated & verified (2026-06-28)

> This section records the concrete, verified outcome. The Phases below remain the procedure;
> the values here are authoritative. **Not committed yet** — pending review of the two `db diff`
> commands in section 10.

### 1. Baseline final
- **Version:** `20260628190324`
- **File:** `supabase/migrations/20260628190324_remote_baseline.sql`
- **Final size:** `544714` bytes
- **Final SHA-256:** `8E2301B881A63B318875D9A9E43D433033E1C32E285A3B3902C1E0A94678111E`
  - **Replaces** the pre-ACL/Storage hash `7F50C4E0DA65FEEE8965E2DA7A9B8379CDA8EA9FCA91ECF8A010D725A628AF6C`
    (526139 bytes) — that earlier value is **superseded** and no longer valid.
- **Only active SQL** in `migrations/` (everything else lives in `migrations/_legacy/`, ignored by the CLI).

### 2. Parity demonstrated
`supabase db reset --no-seed` finished with **exit 0** (no warnings) and rebuilt, matching production exactly:
100 tables · RLS 100/100 · 1607 columns · PK 100 · FK 221 · UNIQUE 27 · CHECK 115 · indexes 399 ·
views 6 · functions 157 · SECURITY DEFINER 104 · triggers 52 · policies(public) 269 · buckets 4 · policies(storage) 4.
ACL parity was validated **object-by-object via catalogs** (`information_schema` / `pg_*`), not by counts alone.

### 3. Table & column ACLs (appended at end of baseline)
- `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;`
- **143 explicit GRANTs** equivalent to production (tables + views; no `WITH GRANT OPTION`).
- Column-level grants restored for `service_role` (REVOKE ALL above would wipe them):
  - `public.businesses`: 15 billing columns (`access_source, current_period_*, grace_until, last_payment_*, last_webhook_at, mp_*, subscription_*, updated_at`).
  - `public.subscription_checkout_sessions`: `status, updated_at`.
- Validated object-by-object (grantee/table/privilege and grantee/table/column), not just counts.
- The generator artifact for the 143 GRANTs is kept **outside the repo** (scratchpad) — **never commit scratchpad artifacts**.

### 4. Default privileges
- Local broadening came from `pg_default_acl` of role **`postgres`**.
- Its `defaclnamespace` was **`2200` = `public`** specifically — **not global** (`0`).
- Production has **no** such public/global defaults.
- Neutralized **only** `postgres` defaults on `public` for **TABLES** and **SEQUENCES**, for **anon / authenticated / service_role**:
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES|SEQUENCES FROM anon, authenticated, service_role;`
- `supabase_admin` defaults were **not touched** (local-image infrastructure; app migrations create tables as `postgres`).

### 5. Functions / pg_trgm
- The **20 sensitive functions** (admin/billing/Vault/WhatsApp RPCs; PUBLIC revoked) match production **exactly** and were **not modified**.
- The **31 `pg_trgm` extension functions** carry extra explicit `anon/authenticated/service_role` EXECUTE **in the local image**, granted by **`supabase_admin`** (its default ACL at extension install).
- Production already allows EXECUTE via **PUBLIC** → **no effective escalation**.
- We did **not** use `SET ROLE`, `GRANTED BY`, nor modify `supabase_admin`.
- Classified as an **expected platform difference**, NOT application schema drift. (`db diff` would not surface it; catalog comparison did.)

### 6. Storage
- Baseline includes **bucket definitions only** for the 4 buckets, with fields: `id, name, public, file_size_limit, allowed_mime_types, avif_autodetection, type` (`ON CONFLICT (id)` updates `name` + the rest).
- **No** `storage.objects` rows, **no** files, **no** `owner`/`owner_id`, **no** timestamps, **no** signed URLs, **no** secrets.
- The **4 PERMISSIVE policies** of `storage.objects` (bucket `business-assets`) were copied **exactly** from production.
- The baseline reproduces the **current** state; any hardening of those policies (e.g. tighter isolation) will be a **new migration**, not a silent change here.

### 7. pg_cron
- `billing-expire-trials` — `0 3 * * *` — `SELECT public.expire_trials();`
- `billing-enforce-grace` — `5 3 * * *` — `SELECT public.enforce_grace_period();`
- **Documented only; NOT auto-created.** Preview Branches and local must **not** run billing automatically.
  Enable manually only in authorized environments (idempotent `cron.schedule(...)` snippet is in the baseline as a comment).

### 8. Limitations & managed objects (NOT in the baseline)
- Vault secrets are **not** exported.
- Auth config is **not** exported.
- Storage files/objects are **not** exported.
- Cron is **not** auto-activated.
- `pg_net` and other internal objects may vary by local image version.
- These are **platform/managed** differences and must **not** be mistaken for `public` schema drift.

### 9. Local ports (Windows)
- `54420–54429` (the committed `+100` remap) fall inside a **Windows excluded range** (`54372–54471`, Hyper-V/winnat) → Docker cannot bind them.
- Used **`55420–55429` temporarily** to run `supabase start` / `db reset` locally.
- `config.toml` was **restored** afterwards (zero net change). The temp remap is **not** part of the baseline or any commit.

### 10. db diff — REQUIRED before commit
```bash
supabase db diff --linked --schema public
supabase db diff --linked --schema storage
```
- Do **not** apply the output; do **not** auto-generate a migration from it.
- Classify any diff as: real / platform / ordering-formatting (non-semantic) / blocking.
- ACL was already compared via catalogs because `db diff` does not fully cover privileges.

**Results (2026-06-28 — both finished `Finished supabase db diff on branch main`):**

- **`--schema public`** — single item: constraint `business_settings_dolar_source_check`
  rendered as DROP + ADD NOT VALID + VALIDATE. Catalog comparison (local vs prod):
  both `convalidated=true`, `condeferrable=false`, `condeferred=false`, column `dolar_source`.
  - prod : `CHECK (((dolar_source)::text = ANY ((ARRAY['nacional'::character varying, 'cordoba'::character varying])::text[])))`
  - local: `CHECK (((dolar_source)::text = ANY (ARRAY[('nacional'::character varying)::text, ('cordoba'::character varying)::text])))`
  - Same accepted set `{nacional, cordoba}`, same rejects. Difference = whole-array vs
    per-element cast rendering only. **Category 4** (cast/representation, no semantic change).
    **NOT blocking. Baseline NOT modified.**
- **`--schema storage`** — 3 policies re-rendered (upload/update/delete on `business-assets`);
  `Public read business assets` matched (absent from the diff). Catalog comparison: all 3
  PERMISSIVE, role `{authenticated}`, same `cmd`, same USING/WITH CHECK predicate
  (`bucket_id='business-assets' AND auth.uid() IN (SELECT user_id FROM profiles WHERE COALESCE(user_id,id)=auth.uid())`).
  - Only difference: prod uses unaliased `profiles` / local uses alias `p`
    (`profiles.user_id` vs `p.user_id`). **Category 4** (alias/representation, no semantic change).
    **NOT blocking. Policies NOT modified** (per "do not chase an empty db diff").
- **Conclusion:** no Category-1 (blocking) differences in either schema. **Caveat:** `db diff`
  (migra) is **not fully stable** for normalized CHECK constraints and RLS policies — it
  re-renders semantically-identical expressions as DROP/ADD; and it does **not** compare
  ACLs/grants at all (those were validated separately, object-by-object, via catalogs).

### 11. Phase 3 (reconciliation) — still pending explicit approval
- **Additive** strategy: keep the **133** remote migrations; stamp **only** `20260628190324` as applied.
- Do **not** run the baseline SQL on production; do **not** `db push` before the repair.
- Immediately before the repair, re-verify (read-only): `count = 133`, `max(version) = 20260626174811`. If changed → STOP.
- Rollback: `supabase migration repair --status reverted 20260628190324`.

### 12. Future commit (after both db diff reviewed, no blockers)
`chore(supabase): add verified remote schema baseline` — includes **only**:
- `supabase/migrations/20260628190324_remote_baseline.sql`
- `supabase/MIGRATION_BASELINE_PLAN.md`

Excludes: `tests/sql/owner_portal_isolation.test.sql`, scratchpad, backups, db diff output, temp config, any file with remote data. **No Co-Authored-By, no push.**

---

## Diagnosis (verified read-only, 2026-06-26)

- **Base schema was never in `migrations/`.** The first historical migration
  (`20240411_add_logo_url_to_business_settings`) is `ALTER TABLE business_settings …`,
  but nothing in `migrations/` ever *creates* `business_settings` — it lived in loose
  `supabase/*.sql`. So a from-scratch `db reset` died on file #1.
- **Remote history is divergent: 133 remote migrations vs 20 local files.** The remote
  is contiguous `20260413`→`20260609` (~110 migrations) with **no local file at all**.
  Local `migrations/` only captured a thin, non-contiguous recent slice.
- **Three naming regimes collide:**
  - 8-digit date-only (the local files: `20240411`…`20260626`).
  - Standard 14-digit `db push` (remote; only `20260623100000/101000/120000/121000`
    match local exactly).
  - MCP `apply_migration` — stored the **filename (date prefix included) as the migration
    *name*** and assigned a fresh timestamp as the *version*. Visible in the history table
    as e.g. `version 20260624132701, name "20260623130000_grant_billing_service_role_privileges"`.
- **Specific `db push` hazards (why push is unsafe today):**
  - Remote `20240411` = `add_arca_parametros_table` (a *different* migration) → both local
    `20240411` files would be **silently skipped**.
  - Local `20240413/14/15`, `20260415/16/18` versions are **absent** remotely → push would
    **re-execute** them onto prod (objects already exist under other versions).
  - Remote `20260626174811 owner_system_owner_activation` had **no local file** (drift the
    other way). **Resolved:** archived as
    `migrations/_legacy/20260626174811_owner_system_owner_activation.sql` (the real remote
    version, not the local `20260626160000`); the CLI ignores `_legacy/`, so it is never
    re-applied. See "Owner activation" below.
- **Local also has internal duplicate versions:** `20240411 ×2`, `20260622 ×2`.

**Conclusion:** do not try to reconcile 133 rows. Local is a strict subset of prod, so
**squash a single baseline from the remote schema**, archive the old files, and stamp the
baseline as already-applied on remote (additive — keep the 133 rows as audit history).

---

## Phase 0 — repo hygiene & scaffolding  ✅ (this branch)

- Untracked `supabase/.temp/` (machine-local CLI state; it was committed before the
  `.gitignore` rule existed). `git rm -r --cached supabase/.temp`.
- Committed `supabase/config.toml` (was untracked). Ports remain remapped +100 to coexist
  with another local stack; `[db.migrations] enabled = true`; `[db.seed] enabled = false`.
- Archived the 20 active migrations → `supabase/migrations/_legacy/` (CLI ignores subdirs).
- Archived the 54 loose `supabase/*.sql` → `supabase/_archive/loose-scripts/`
  (dangerous RLS-disablers/nukes quarantined in `_dev-only-DANGER/`). Seeds kept in place.
- The active `migrations/` path is now **empty** → `db reset` succeeds but builds an empty
  schema until the baseline (Phase 1) is added.
- **Consolidated into `main`** (2026-06-28) via `git cherry-pick` of the Phase 0 commit
  `1c08bbc` → new commit `91baf38`. The shared parent was `37c4899`, so it applied with **no
  conflicts**. `main` now carries Phase 0 **plus** the owner-activation work (entitlements
  centralization + tests). The owner activation migration was archived to `_legacy/`, which
  now holds **22** files.

---

## Owner activation — data migration already applied (do NOT reapply)

The System Owner activation (`molina.jonyy@gmail.com` → business "Clic" `aa930802…`:
`pending_activation → active`, plan `full`, permanent `manual_grandfathered` override) was
already applied to **production** via MCP `apply_migration`, recorded remotely as version
**`20260626174811`**, name `owner_system_owner_activation` — the **newest of the 133** remote
rows.

- It is a **DATA migration** (UPDATE on `businesses` + an audit row in
  `subscription_admin_actions`), **not** DDL.
- The Phase 1 schema baseline (`db dump`) captures **schema only**, so it will **NOT** contain
  this UPDATE. The effect is already live in prod data and persists independently of the baseline.
- The local file is archived as
  `migrations/_legacy/20260626174811_owner_system_owner_activation.sql` **for historical
  evidence only**. `_legacy/` is ignored by the Supabase CLI ⇒ it is **never re-loaded or
  re-applied** (and the SQL is idempotent regardless).
- Phase 3 reconciliation stays **additive**: it stamps only the **new baseline** as applied and
  **preserves the 133 historical remote rows** (including `20260626174811`). The owner row is
  never deleted or rewritten.
- `supabase migration repair` will **not** run without explicit approval; immediately before it,
  re-verify (read-only) that prod is unchanged (`max(version)` still `20260626174811`,
  `count(*)` still `133`).

---

## Phase 1 — generate the baseline from remote  ⏳ (needs DB password; run by a human)

The baseline version is **not pinned in advance**. It is a real 14-digit UTC timestamp
generated at dump time, strictly greater than the latest remote migration version. The DB
password is entered interactively and is **never** written to a file, the repo, or this doc.

Before dumping (read-only):
1. Re-confirm the latest remote version and migration count:
   `select max(version), count(*) from supabase_migrations.schema_migrations;`
2. Confirm nothing schema-affecting was applied since the diagnosis — `max(version)` and
   `count` must match the previous check. If they changed, re-diagnose before continuing.

Then generate the version and dump the live schema:

```bash
supabase link --project-ref vrdxxmjzxhfgqlnxmbwx   # once, if not linked

LAST_REMOTE="<max(version) confirmed in step 1>"          # e.g. 20260626174811
BASELINE_VERSION="$(date -u +%Y%m%d%H%M%S)"
[ "$BASELINE_VERSION" -gt "$LAST_REMOTE" ] || { echo "ABORT: $BASELINE_VERSION <= $LAST_REMOTE"; exit 1; }
BASELINE_FILE="supabase/migrations/${BASELINE_VERSION}_remote_baseline.sql"
echo "$BASELINE_VERSION"          # record this — Phase 3 must reuse the exact value
supabase db dump --linked -f "$BASELINE_FILE"            # prompts for the DB password
```

After the dump, **before anything else**:
- **Inspect for secrets / real data.** The dump must be schema/DDL only. Grep it for JWTs
  (`eyJ`), connection strings (`postgres://`), API keys, and any decrypted `vault.` /
  `pgsodium` values or secret literals. `supabase_vault` stores ciphertext + key ids — confirm
  no plaintext secrets, and no real customer rows leaked in (e.g. via `COPY` / `INSERT`).
- **Document non-reproducible objects.** Note anything `db dump` can't recreate locally
  (event triggers, objects in `auth` / `storage` / `vault`, cron jobs, roles/grants the local
  stack doesn't pre-provision) so the baseline or a companion migration covers them.
- `CREATE EXTENSION` lines for the extensions in use — `pgcrypto`, `uuid-ossp`, `pg_trgm`
  (installed in `public`), `supabase_vault`, `pgsodium`, `pg_cron`, `pg_graphql`, `pg_net` —
  must be present and provided by the local stack image. If `storage` buckets/policies are
  needed, dump them into a companion `${BASELINE_VERSION_2}_storage_baseline.sql`.

---

## Phase 2 — make `db reset` green locally  ⏳

```bash
supabase start
supabase db reset          # must rebuild prod's schema from the baseline alone
supabase migration list    # local should show just the baseline
```

Iterate on the baseline file until reset is clean (typical fixes: extension ordering,
`SET search_path`, event triggers, or objects in non-`public` schemas).

Then **compare local against production** to prove fidelity (read-only; the diff should be
empty): `supabase db diff --linked --schema public`. Record any residual diff.

---

## Phase 3 — reconcile remote history (ADDITIVE)  🔒 (prod write — requires explicit re-approval)

> ⚠️ Do not run this phase without a fresh, explicit go-ahead. It must use the **real**
> `$BASELINE_VERSION` of the file generated in Phase 1 — never a value pinned in this doc.
> Immediately before running it, re-verify (read-only) that production has not changed since
> the dump (same `max(version)` / `count` as Phase 1, step 1).

Chosen strategy: **stamp the baseline as applied, keep the 133 historical rows.** This
prevents a future `db push` from trying to re-create the whole schema on prod, while
preserving the audit trail. It adds exactly one row and is fully reversible.

Back up first (history snapshot + full schema safety dump):

```bash
supabase db dump --linked --data-only --schema supabase_migrations -f backups/schema_migrations.sql
supabase db dump --linked -f backups/full_schema.sql
```
*(The complete 133-version/name list is also preserved in this session's transcript.)*

Then stamp the baseline applied **without re-running it** on prod, using the real version:

```bash
supabase migration repair --status applied "$BASELINE_VERSION"
supabase migration list     # baseline now matches remote; nothing pending to push
```

Rollback if needed: `supabase migration repair --status reverted "$BASELINE_VERSION"`
(removes the row; the 133 historical rows were never touched).

> Do **not** run `supabase db push` until after this repair — pre-repair it would attempt
> to apply the entire baseline schema onto prod.

---

## Phase 4 — branching strategy  (after baseline is trustworthy)

- New change ⇒ a **new migration on top of the baseline** (14-digit version). Never edit
  the baseline file.
- Ship with `supabase db push` (now safe) or via Preview Branch merge.
- Preview Branches run `migrations/` from scratch ⇒ they reproduce hosted because
  baseline ≡ remote.
- Stop using MCP `apply_migration` for routine changes (it caused the version/name drift).
  Reserve it for emergencies and immediately backfill a matching local file.

---

## Phase 5 — cleanup follow-ups

- Author a curated `seed.sql` (small, deterministic reference rows) and flip
  `[db.seed] enabled = true`.
- Delete `supabase/_archive/loose-scripts/_dev-only-DANGER/` outright.
- Optionally squash the 133 phantom rows into the baseline row later (truncate-and-reseed
  with backup) if a pristine history table is wanted — not required for correctness.
