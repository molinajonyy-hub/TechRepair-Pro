## Problem and resulting behavior

SEC-08E R2B is active in production, but three auxiliary financial surfaces still disclose protected values to authenticated operational roles that lack financial access: `parts_used.unit_price/subtotal`, `cash_payment_allocations.amount`, and `comprobante_annulments.reverted_payment_total/reverted_cogs`.

This fresh R3 extraction from current `main` revokes those base-column reads, exposes capability-gated projections, and preserves the public annulment RPC through a redacting wrapper around the byte-identical implementation. Limited technicians and viewers retain operational metadata while protected amounts become unavailable; authorized owner, admin, manager, cashier, and sales behavior follows the documented capability matrix.

## Scope

- Adds the historical-gap migration `20260922120000_sec08e_auxiliary_financial_reads.sql` without rewriting migration history.
- Adds disposable PostgreSQL 17/PostgREST 14 verification with real JWT actors, rollback/reapply, contract-state, filter/order/embed, query-plan, and frontend compatibility coverage.
- Adds the SEC-08E R3 CI job and evidence under `docs/security-sec08e-r3/`.
- Reuses the migration and SQL assertions from PR #110 after revalidating them against current `main`; the old PR remains untouched.
- Leaves frontend source unchanged because current R1 code already implements the required projection, exact absence compatibility, and bounded pre-schema fallback behavior.

## Validation

- R3 disposable matrix: 274 assertions passed.
- Focused components: 104 tests passed; R3 command component set: 82 passed.
- Edge contract forwarding: 3 tests passed.
- TypeScript, ESLint with zero errors, production build, and `git diff --check` passed.
- SEC-08A/B/C/D, allocation UI, and Etapa 0 regression suites preserve their measured clean-main outcomes. Existing Etapa 1, Etapa 7, and SEC-08A phase-B baseline behavior is documented with bounded evidence; no assertion was weakened or skipped.
- Rollback was executed only in an owned disposable database and followed by a clean R3 reapplication.

## Production state

Read-only prechecks show R2B enabled at contract 1, `pgrst.db_pre_request=public.check_client_contract`, and no `20260922120000` ledger entry or R3 projection. The latest bounded logs contain no HTTP 409/503 and no contract-configuration errors. No SQL from this PR was applied to production.

Deployment and rollback steps are documented in `docs/security-sec08e-r3/report.md` and `docs/security-sec08e-r3/rollback-review.sql`.
