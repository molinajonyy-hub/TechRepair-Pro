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

## Rollback

The normal R2B rollback keeps the hook installed and restores the explicit R2A
state in one transaction:

```sql
BEGIN;

UPDATE private.client_contract_config
   SET enforcement_state = 'disabled',
       minimum_contract = NULL,
       updated_at = now()
 WHERE singleton IS TRUE
   AND enforcement_state = 'enabled'
   AND minimum_contract = 1;

COMMIT;
```

The operator must verify that exactly one row changed and that the resulting
state is disabled/NULL. This rollback is operational SQL, not an executable
forward migration in this PR.

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

- ORDERS-V2-0.1 production human smoke has passed.
- R2A remains stable in production.
- Production activation has explicit approval.

R3, SEC-08F, the `public.users` blocker, production deployment, production
migration, automatic merge, and release tagging are outside this PR.
