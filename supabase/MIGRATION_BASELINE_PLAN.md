# Supabase migration baseline — runbook

Goal: a clean, self-contained migration baseline so `supabase db reset` works from zero
and Preview Branches faithfully reproduce the hosted project
(`vrdxxmjzxhfgqlnxmbwx` / techrepair-pro).

Status legend: ✅ done in this branch · ⏳ needs the DB password (run by a human) · 🔒 prod write (explicit approval each time).

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
  - Remote `20260626174811 owner_system_owner_activation` has **no local file** (drift the
    other way).
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
