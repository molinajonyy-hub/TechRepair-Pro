# SEC-08F — Fresh Candidate #2: local certification manifest

This manifest records the local evidence committed with the refreshed candidate.
The final candidate SHA, GitHub checks and Preview status are recorded in the
[PR #132 description and checks](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/132).
Those remote gates must pass on this exact candidate before a GO decision.
No merge, production migration or production deployment is part of this refresh.

## Base and collision

- Current main: `2f4808bbdf4dc3b7ae64ed8739164e1dca0285d7`.
- Branch: `codex/sec08f-final-security-sweep`.
- Conservative main merge: `7033c56a4d9dca02c24df8e0333f939a911336cb`.
- Merge-base is the current main above.
- Historical candidate `55a6cd19a276a99a7d8850c763e281dcda4401b8`, based on
  `228d53081a174757fcd5a521e6704b0cde4cbb58`, is obsolete.
- Main's maximum migration was `20260930120000_arca_selfservice_phase2a_initial_setup.sql`.
- SEC-08F's old `20260930120000_sec08f_remaining_read_authority.sql` collided with it.
- After inspecting the complete refreshed inventory, SEC-08F was renamed to
  `20261001120000_sec08f_remaining_read_authority.sql`, a free, later version.
- Migration SQL is byte-for-byte unchanged: SHA256
  `0DF786AA616F2FA10756B845370687F13BFBB14D82239617F00BC0B718FF96B3`.

ARCA Phase 2A, application code, Edge Functions and all main migrations remain
identical to main. Only SEC-08F and its certification material differ.

## Complete diff inventory

A = SEC-08F implementation or original evidence. B = refresh/reference/certification.
Paths below are relative to the repository. There are no category C files.

| File | Category and reason |
| --- | --- |
| `.github/workflows/ci.yml` | A/B: SEC-08F matrix job, R3 migration gap, renamed migration references |
| `package.json` | A: canonical `test:sec08f` command |
| `scripts/security/sec08f-local.mjs` | A/B: dynamic matrix, renamed migration, five preservation assertions |
| `supabase/migrations/20261001120000_sec08f_remaining_read_authority.sql` | A/B: unchanged SEC-08F SQL at unique version |
| `docs/security-sec08f/local-matrix.json` | B: fresh 189-assertion JWT matrix and exact preservation snapshots |
| `docs/security-sec08f/regressions.json` | B: fresh pre/post SQL regression outcomes |
| `docs/security-sec08f/rollback-review.sql` | A/B: reviewed rollback, mechanically exact main policy restoration |
| `docs/security-sec08f/pr-body.md` | B: refreshed review description |
| `docs/security-sec08f/report.md` | A/B: original discovery retained and explicitly marked historical |
| `docs/security-sec08f/validation.json` | A: unchanged historical Candidate #1 validation |
| `docs/security-sec08f/query-plans.json` | A: unchanged historical discovery plans |
| `docs/security-sec08f/production-candidate-shapes.json` | A: unchanged historical read-only catalog snapshot |
| `docs/security-sec08f/production-catalog.json` | A: unchanged historical read-only catalog snapshot |
| `docs/security-sec08f/production-health.json` | A: unchanged historical read-only health snapshot |
| `docs/security-sec08f/production-logs.json` | A: unchanged historical read-only log summary |
| `docs/security-sec08f/fresh-candidate-2/report.md` | B: this refresh manifest |
| `docs/security-sec08f/fresh-candidate-2/validation.json` | B: current local gate results |
| `docs/security-sec08f/fresh-candidate-2/migration-validation.json` | B: all 272 application entries, ledger and hash |
| `docs/security-sec08f/fresh-candidate-2/security-audit.json` | B: fresh final RLS, effective grants, views and related function definitions |
| `docs/security-sec08f/fresh-candidate-2/guard-comparison.json` | B: identical scanner outputs against detached current main |
| `docs/security-sec08f/fresh-candidate-2/r3-regressions.json` | B: refreshed R3 regression evidence |

## Contract and security

- `recurring_expenses`: authenticated SELECT requires the existing
  `current_user_can_in_business(business_id, 'finance')`; tenant-bound owner/admin
  and permitted roles succeed, denied overrides/limited/inactive/other-tenant actors
  cannot read the witness. Anonymous table and column SELECT are absent.
- `cash_registers`: the same finance authority; `FOR ALL` is split into DML
  policies so it cannot imply SELECT. Existing write authority is preserved.
- `payment_orders`: authenticated and anonymous table/column SELECT are absent,
  including for owners. Service-role SELECT remains. Existing DML is preserved;
  this refresh makes no DML redesign.
- RLS remains enabled on all three. Final policies, effective grants and real JWT
  outcomes are independently captured; policy presence alone is not the proof.
- No dependent views were found. The only exact table reference in public/private
  function bodies is `private.generate_finance_insights`, which is not executable
  by anon/authenticated. Its public wrapper requires tenant-bound `finance` and
  `advancedFinance` through `private.require_action_authority`. The canonical
  finance helper and wrapper are unchanged. No alternative browser read path was
  introduced or found for these witnesses.
- A substring hit in `pay_recurring_expense` refers to
  `personal_recurring_expenses`, not the SEC-08F table.

## Clean migrations and local gates

`npm.cmd run e2e:ci-local -- --reset --project=m7-local` resets only the local
Docker Supabase stack. All 272 migrations applied exactly once; ARCA Phase 2A
preceded SEC-08F. Repository and ledger have zero duplicate versions; the final
ledger maximum is `20261001120000`. Full order is in `migration-validation.json`.

| Gate | Local result |
| --- | --- |
| SEC-08F dynamic | PASS, 189 assertions (previous 184 plus five preservation checks) |
| R1 central SDK | PASS, 4 cases |
| Associated frontend | PASS, 104 tests across 7 files |
| TypeScript | PASS |
| ESLint errors gate | PASS |
| Vite production build | PASS, existing subscription dynamic-import warning |
| E2E candidate after explicit reset | PASS, 163/163 in 7.8 minutes |
| R3 matrix | PASS, 274 assertions; pre R1 3 pass/1 intended skip, post R1 4 pass, fault 1 pass |
| Rollback/reapplication | PASS, exact snapshots and unchanged data/ARCA |
| Deno current suite | PASS, 220 tests including ARCA Phase 2A and fiscal-date regression |
| ARCA Phase 0 | PASS, 15 component tests and guard/self-test |
| ARCA Phase 1 | PASS, 33 component tests (previous 28), guard/self-test |
| ARCA Phase 2A | PASS, 35 component tests, 31 guard fixtures |
| Edge CORS, R2A/R2B, fiscal read-only, UI governance | PASS |
| GitHub CI / Vercel Preview | Remote gates: consult exact HEAD checks on PR #132 |

## Rollback

The review SQL restores only the prior policies and grants of the three target
tables. The one refresh adjustment is in `cash_registers_business_select`:
`profiles.id = auth.uid()` becomes `profiles.id = (SELECT auth.uid())`, matching
the actual main definition exactly. The original review SQL was semantically
equivalent here, but failed the new exact catalog comparison. No candidate
migration SQL needed adaptation.

The harness compares complete target table/column ACLs, RLS and policies before
the candidate and after rollback, then compares candidate and reapplied states.
It also compares ARCA/AFIP function body hashes/config/ACLs, constraints and the
three target tables' data hashes. All match. Migration history is preserved;
ARCA Phase 2A is not rolled back and no data is deleted.

## Additional findings, not corrected here

- Global static scanners still exit 1 on main and candidate with identical
  outputs: 2 SECURITY DEFINER search-path findings, 20 execute-exposure findings,
  6 owner-view findings. These are not scanner PASS results. Compared with the
  old base, Phase 2A introduces 17 additional static exposure flags on main;
  SEC-08F adds zero. They require their own triage, not changes in this PR.
- Existing SQL regression debt persists: Etapa 1 P&L `PX3 operating_expenses`,
  Etapa 7 checkout `FORBIDDEN`, and the already-recognized intermittent Phase B
  `order_parts.name` fixture failure. The harness records pre/post outcomes and
  retains its original exact known-outcome handling; no tests were weakened.
- The preliminary E2E run on the pre-candidate local schema returned 162 pass
  and one failure in `replace-lost-response`. It does not certify Candidate #2.
  The explicitly reset candidate run passed all 163 tests, including that case; no test or application fix was made.
- Identity/privacy follow-ups and payment-order DML remain outside this scope.

Final GO requires all current-head required CI checks, Preview and candidate E2E
to pass, a fresh main check, and the 21-file A/B-only diff. Review only: no merge.
