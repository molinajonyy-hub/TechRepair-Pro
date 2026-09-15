SEC-08F restricts recurring-expense and legacy cash-register reads to the existing
tenant-bound `finance` authority, and removes authenticated/anonymous SELECT from
`payment_orders`. Existing DML and service-role payment-order history are preserved.

Fresh Candidate #2 merges current main `2f4808bbdf4dc3b7ae64ed8739164e1dca0285d7`
without changing ARCA Phase 2A. The obsolete Candidate #1 was `55a6cd19` on `228d5308`.
Its SEC-08F migration collided with ARCA's `20260930120000` version. After inspecting
the refreshed inventory, SEC-08F was renamed to
`20261001120000_sec08f_remaining_read_authority.sql`; SQL bytes are unchanged.

Local certification:

- Clean reset: 272 migrations, ARCA before SEC-08F, each once, zero duplicate versions.
- Real PostgreSQL/PostgREST/JWT matrix: 189 assertions (184 existing plus five exact
  rollback/ACL/RLS/data/ARCA preservation assertions); R1 central SDK 4/4.
- R3 matrix: 274 assertions; associated frontend: 104 tests; Deno: 220 tests.
- ARCA components: Phase 0 15, Phase 1 33, Phase 2A 35, all PASS with their guards.
- TypeScript, lint, build and focused guards PASS.
- Candidate E2E after explicit reset: 163/163 PASS in 7.8 minutes.
- Rollback/reapplication PASS. One mechanical rollback expression now exactly matches
  main: `profiles.id = (SELECT auth.uid())`. No candidate SQL logic changed.
- Global static scanners match current main exactly, with existing findings 2/20/6;
  these are baseline failures, not clean scanner results. Known SQL fixture debt is
  recorded separately. No scope expansion or application/ARCA edits.

The complete 21-file A/B inventory, current security catalog, migration application
order, regression outcomes and historical/current evidence distinction are in
[`docs/security-sec08f/fresh-candidate-2/report.md`](docs/security-sec08f/fresh-candidate-2/report.md).
This committed manifest precedes the remote checks. Final HEAD, CI and Preview
outcomes belong in this PR's description/checks once the push completes.

Review only. No automatic merge, production migration, or production deployment.
