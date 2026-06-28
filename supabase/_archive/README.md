# `supabase/_archive/` — historical SQL (NOT the source of truth)

Everything in this folder is **historical provenance only**. It is **not** applied by
any tool and must **not** be used to provision a new environment.

The source of truth for the database schema is the squashed **baseline migration** in
`supabase/migrations/` (generated from the live remote — see
[`../MIGRATION_BASELINE_PLAN.md`](../MIGRATION_BASELINE_PLAN.md)). Pre-baseline migrations
live in `supabase/migrations/_legacy/` (the CLI loader ignores subdirectories).

## Why these were archived

The project was bootstrapped by hand-running loose `.sql` in the Supabase dashboard, and
`migrations/` was started later as a *delta-only* log on top of an already-populated
remote. As a result neither `supabase db reset` (no base schema) nor `supabase db push`
(divergent/colliding versions) was safe. The baseline cutover fixes that; these files are
kept only so the original intent of each change remains auditable.

## `loose-scripts/` — former `supabase/*.sql`

Multiple **competing** definitions of the same schema (e.g. `schema.sql`, `setup.sql`,
`final_setup.sql` each define ~11 of the same base tables). Treat as read-only history.

| Category | Files |
|---|---|
| Base schema (full) | `schema.sql`, `setup.sql`, `final_setup.sql` |
| Base schema (modules) | `business_auth_setup.sql`, `comprobantes_schema.sql`, `inventory.sql`, `inventory_connected_schema.sql`, `currency_system.sql`, `brands_models_system.sql`, `notifications.sql`, `payments.sql`, `payments_architecture.sql`, `parts_costs.sql`, `inspections.sql`, `create_missing_tables.sql`, `schema_updates.sql`, `add_product_multicurrency.sql`, `mp_local_integration.sql` |
| RLS / grants | `rls_policies.sql`, `rls_policies_safe.sql`, `grant_permissions.sql`, `fix_grants_all.sql` |
| Targeted fixes / patches | `fix_comprehensive_integration.sql`, `fix_comprobantes_module.sql`, `fix_comprobantes_rls.sql`, `fix_customers_business_context.sql`, `fix_customers_rls.sql`, `fix_customers_rls_comprehensive.sql`, `fix_exchange_rates_rls.sql`, `fix_function_search_path.sql`, `fix_generar_numero_comprobante.sql`, `fix_relationships.sql`, `fix_rls_business_isolation.sql`, `fix_rls_ownership.sql`, `fix_rls_secure.sql`, `fix_rls_select_all.sql`, `fix_users.sql`, `fix_view_permissions.sql`, `currency_settings_save_patch.sql`, `auth_profile_timeout_patch.sql`, `security_linter_and_inventory_patch.sql` |
| Diagnostics | `verify_tables.sql` |

## `loose-scripts/_dev-only-DANGER/` — never run against a shared DB

These **disable RLS, drop all policies, or truncate/reset data**. They were development
shortcuts. Running any of them against staging/prod would be a security and data-loss
incident. Kept only as a record of what once existed; do not resurrect.

`disable_rls_all.sql`, `disable_rls_completamente.sql`, `disable_rls_for_development.sql`,
`disable_rls_only.sql`, `disable_comprobantes_rls.sql`, `nuclear_option.sql`,
`emergency_fix.sql`, `clean_all_policies.sql`, `enable_rls_simple.sql`,
`fix_ultra_simple.sql`, `fix_simple.sql`, `fix_working.sql`

> Once the baseline is validated and merged, these `_dev-only-DANGER/` files can be deleted
> outright (a follow-up in `MIGRATION_BASELINE_PLAN.md`).
