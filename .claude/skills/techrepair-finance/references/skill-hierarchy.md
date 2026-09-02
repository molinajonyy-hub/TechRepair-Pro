# Skill hierarchy for financial work

This mirrors the design-skill hierarchy already established in `CLAUDE.md`, applied to finance.

## Level 0 — Product authority

**`techrepair-finance`** (this skill).

The authority for any financial reasoning about TechRepair Pro: schema, ledger, RPCs, triggers,
accounting rules, definitive balances, caja logic, payment logic, economic classification,
anulaciones, reconciliation, period closes, Argentine fiscal compliance, ARCA, and current backend
behaviour.

> **A financial skill may suggest methodology, but TechRepair Pro's implemented financial model
> remains authoritative.**

## Level 1 — Trusted external methodology (subordinate)

Not installed today. If reconciliation, variance-analysis, close-management, financial-validation
or audit-methodology skills are installed later, they may contribute **methods only**: how to
structure a reconciliation, how to decompose a variance, how to sample for a control test.

They may never redefine: what revenue is, when it is recognised, what a period close means here,
what a movement is classified as, or how a balance is computed.

Any recommendation from Level 1 that contradicts Level 0 is discarded — that specific
recommendation, not the whole skill.

## Level 2 — Data tooling, currently installed

The `data` plugin is installed. It validates **data**; it does not define **business semantics**.

Useful and safe:

- `data:validate-data` — check calculations, aggregations, denominators, period completeness,
  timezone alignment, and whether a conclusion is supported. Its catalogue of pitfalls maps
  directly onto real risks here: *join explosion* (duplicating movements when joining payments to
  comprobantes), *average of averages* (badly weighted margin), *denominator shifting* (changing
  what counts as active between periods), *timezone mismatches* (UTC timestamps versus
  `America/Argentina/Cordoba` period dates), *incomplete period comparison*.
- `data:explore-data` — profiling; duplicates here can mean broken idempotency.
- `data:statistical-analysis` — anomaly detection over movements and caja.
- `data:analyze`, `data:create-viz`, `data:build-dashboard` — analysis and presentation.

Constraint that applies to all of them:

- `data:sql-queries` / `data:write-query` are **read-only** against TechRepair Pro. No `INSERT`,
  `UPDATE`, `DELETE`, `ALTER` or migration against financial data. Every write goes through the
  canonical RPC.
- `data:validate-data` does not become a financial authority. It can prove an aggregation is
  arithmetically wrong. It cannot decide that revenue should be recognised differently.
- `data:data-context-extractor` generates data-context skills. Do not use it on this domain: it
  would produce a second artefact competing with this one for Level 0 authority.

## Level 3 — Requires explicit request

The official Anthropic `finance` plugin is **deliberately not installed** (audit of 2026-09-01).
It is atomic — installing it brings all eight skills — and three of them
(`close-management`, `journal-entry-prep`, `audit-support`) declare `user-invocable: false`, so
they can self-activate.

If it is ever installed, then:

- It is subordinate to `techrepair-finance`.
- Its GAAP, ASC and SOX recommendations are **external** and never apply automatically.
- No skill in it may redefine TechRepair Pro's revenue recognition, period close, journal entries
  or financial statements.
- `finance:variance-analysis` and `finance:reconciliation` are the two with real transferable
  method and the least embedded assumptions.
- `finance:financial-statements`, `finance:journal-entry`, `finance:journal-entry-prep`,
  `finance:close-management`, `finance:sox-testing` and `finance:audit-support` must never
  activate automatically on this product.

Also Level 3, never automatic: anything assuming QuickBooks, Stripe, Square, PayPal, US GAAP, SOX,
investment banking, private equity, valuation or enterprise accounting.

## Relationship with `techrepair-product-design`

They are siblings with different jurisdictions and must not duplicate authority.

- `techrepair-product-design` owns UI, UX, layout, visual hierarchy, components and design tokens.
- `techrepair-finance` owns financial meaning, sources, calculation and flows.

A screen that displays money is usually a product-design task. It becomes a finance task the
moment the change touches what a number means, where it comes from, or when it is written.

When both apply, finance constrains and product-design shapes: the number is decided here, the
presentation there.
