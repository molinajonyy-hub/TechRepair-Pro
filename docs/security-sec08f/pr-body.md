Production and current main still let any same-tenant authenticated actor read
recurring expense amounts, legacy cash-register balances, and future Mercado
Pago payment-order amounts/provider payloads. This candidate requires the
existing tenant-bound `finance` authority for the two live/legacy finance
tables and removes browser SELECT from the retired Beta payment-order path,
while preserving existing DML and service-role history.

The migration is intentionally limited to those three category-A findings. It
does not change frontend code, public identity, Orders, Tasks, ARCA,
subscriptions, capabilities, R2/R3 semantics, or production state.

Validation:

- 184 real PostgreSQL/PostgREST/JWT assertions across owner, admin, manager,
  cashier, sales, limited technician/viewer, inactive, cross-tenant, anonymous,
  finance override and service-role actors;
- exact pre-fix witnesses for all three surfaces, followed by post-fix denial;
- reviewed rollback, restored witness proof, clean reapplication and unchanged
  migration history;
- R1 central SDK integration: 4/4;
- focused SEC-08E frontend: 104/104;
- R2 contract forwarding: 3/3;
- ARCA Phase 0: 15/15; Phase 1: 28/28; Fiscal Date Part 2: 34/34;
- TypeScript, ESLint errors-only, production build and `git diff --check` pass;
- global security scanners match detached current main exactly (2 SECDEF
  search-path, 3 execute-exposure and 6 owner-view findings; zero added).

Full discovery, classifications, production read-only snapshots, query plans,
regression outcomes and rollback review material are under
`docs/security-sec08f/`.

This PR is ready for review only. Do not merge or apply migration
`20260930120000` without separate explicit production rollout authorization.
