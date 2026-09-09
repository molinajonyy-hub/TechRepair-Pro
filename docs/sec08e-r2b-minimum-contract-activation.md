# SEC-08E R2B — minimum client contract 1

## Scope

R2B changes only the singleton compatibility configuration installed by R2A.
It does not replace `public.check_client_contract()`, change the PostgREST hook,
or grant any role, capability, tenant, or row authority. RLS and capabilities
remain authoritative after compatibility succeeds.

The executable migration is
`20260924120000_sec08e_r2b_client_contract_gate_minimum_1.sql`. The retired
`20260923121000` artifact must remain absent.

## Atomic transition

The migration runs in one transaction and locks the singleton row with
`SELECT ... FOR UPDATE`. It accepts exactly this precondition:

```text
enforcement_state = disabled
minimum_contract = NULL
```

It then updates exactly one row to:

```text
enforcement_state = enabled
minimum_contract = 1
```

`NOT FOUND`, a different state, a non-null prior minimum, or a row count other
than one raises an exception and aborts the transaction. Reapplying the
migration therefore fails. Concurrent activation attempts serialize on the row
lock; only the first valid transition can commit.

No PostgREST reload is required for this transition. The R2A hook is already
loaded and reads the configuration row for every new request. A request whose
pre-request check completed before activation may finish. Every later request
is evaluated against enabled/1; no timer or tab count participates.

## HTTP and identity contract

An authenticated request with no contract, contract 0, or malformed contract
receives exactly:

```json
{
  "code": "CLIENT_UPDATE_REQUIRED",
  "message": "Actualizá la aplicación para continuar.",
  "details": null,
  "hint": null
}
```

The status is HTTP 409. Contract 1 and future integers such as 2 continue to
normal RLS and capability evaluation. HTTP normalizes surrounding optional
whitespace before PostgREST exposes a header; internal whitespace, leading
zeros, decimals, negatives, empty values, alphabetic values, and comma-joined
ambiguous values are rejected.

`anon` keeps its existing grants and RLS behavior. `service_role` is exempt only
when both the effective PostgREST database role and the signed JWT claim are
`service_role`. Browser-controlled role, user, business, build, or service-role
headers cannot create an exemption.

`FORGED CONTRACT DOES NOT GRANT AUTHORITY`: a limited technician may pass
compatibility with contract 999999, but finance capability checks still deny
access. A cross-tenant request with contract 1 still receives no protected
rows. An owner with contract 1 retains normal access.

## Client and Edge compatibility

The current R1 frontend sends `x-techrepair-client-contract: 1` and the compiled
`x-techrepair-client-build`. No frontend change is part of R2B.

`afip-wsaa` and `afip-cae` forward the incoming contract header exactly on
user-scoped PostgREST calls. They do not invent a missing value or repair a
malformed value. Their signed service-role clients remain exempt.

## Critical production migration order

Production intentionally has a non-contiguous migration history:

| Version | Stage | Production status |
| --- | --- | --- |
| `20260921120000` | pre-R2 baseline | applied |
| `20260922120000` | SEC-08E R3 | **not applied** |
| `20260923120000` | SEC-08E R2A | applied |
| `20260924120000` | SEC-08E R2B | **not applied** |

R3 has an older timestamp than R2B but must remain pending. An authorized R2B
rollout therefore must **not** use `supabase db push`, `supabase db push
--include-all`, or any other generic migration sweep. Such a command can apply
R3 before R2B, which is outside the authorized sequence.

## Future authorized production procedure

This procedure is documentation for a future explicitly authorized rollout. It
is not executed while preparing or reviewing this PR.

1. Revalidate production read-only. Require R2A applied, R3 absent, R2B absent,
   the singleton configuration exactly disabled/NULL, and the hook exactly
   `public.check_client_contract`.
2. Execute only the reviewed file with the controlled production connection.
   `ON_ERROR_STOP` makes `psql` exit at the first error; the file's own
   `BEGIN`/`COMMIT` supplies the transaction boundary:

   ```sh
   psql "$CONTROLLED_PRODUCTION_DB_URL" -X --set=ON_ERROR_STOP=1 \
     --file supabase/migrations/20260924120000_sec08e_r2b_client_contract_gate_minimum_1.sql
   ```

3. Verify immediately and read-only that the state is exactly enabled/1, the
   PostgREST hook is unchanged, R3 remains absent, and no unexpected migration
   history entry appeared.
4. Only after the SQL command and every postcondition succeed, reconcile the
   single R2B history entry:

   ```sh
   supabase migration repair 20260924120000 --status applied --linked
   ```

5. Re-read migration history. The expected result is `20260921120000` applied,
   `20260922120000` absent, `20260923120000` applied, and `20260924120000`
   applied.

Migration repair records what successfully happened; it must never hide a
failed, partial, or unverified SQL execution.

## Rollback

The normal R2B rollback keeps the hook installed and restores the explicit R2A
state in one fail-closed transaction:

```sql
BEGIN;

DO $rollback$
DECLARE
  v_state text;
  v_minimum integer;
  v_rows integer;
BEGIN
  SELECT enforcement_state, minimum_contract
    INTO v_state, v_minimum
    FROM private.client_contract_config
   WHERE singleton IS TRUE
     FOR UPDATE;

  IF NOT FOUND
     OR v_state <> 'enabled'
     OR v_minimum IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SEC-08E R2B rollback precondition failed';
  END IF;

  UPDATE private.client_contract_config
     SET enforcement_state = 'disabled',
         minimum_contract = NULL,
         updated_at = now()
   WHERE singleton IS TRUE;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'SEC-08E R2B rollback expected one row';
  END IF;
END
$rollback$;

COMMIT;
```

The row lock serializes competing state changes. A missing row, any state other
than enabled/1, or a row count other than one raises and rolls back instead of
silently committing a no-op. The operator must still verify the resulting
disabled/NULL state. This is operational SQL in documentation, not a rollback
migration.

Normal config rollback does not alter `supabase_migrations.schema_migrations`.
If R2B was recorded as applied, it remains recorded as applied after the state
returns to disabled/NULL. Do not casually mark it reverted: a later generic
migration operation could otherwise reapply R2B unexpectedly. Any history
decision after an emergency must be based explicitly on the observed database
and incident state.

If the hook itself causes a separate emergency, remove only the database-role
setting and reload PostgREST configuration:

```sql
ALTER ROLE authenticator
IN DATABASE postgres
RESET pgrst.db_pre_request;

NOTIFY pgrst, 'reload config';
```

Neither rollback is executed while preparing this PR.

## Rollout gate

This PR must not be merged until all of the following are true:

- ORDERS-V2-0, ORDERS-V2-0.1, and ORDERS-V2-0.1.1 each have production human
  smoke PASS. Current status is **BLOCKED** by mobile Brand/Model combobox
  clipping; that fix belongs to the separate Orders work.
- R2A remains stable in production.
- Production activation has explicit approval.

Before merge, refresh this PR against the then-current `main`, which is expected
to include the Orders combobox fix. Rerun the R2B real-stack matrix, R1 tests,
Edge forwarding tests, SEC-08 guards, TypeScript, lint, build, and full CI. The
current `e436755` baseline alone is not sufficient authorization to merge.

R3, SEC-08F, the `public.users` blocker, production deployment, production
migration, automatic merge, and release tagging are outside this PR.
