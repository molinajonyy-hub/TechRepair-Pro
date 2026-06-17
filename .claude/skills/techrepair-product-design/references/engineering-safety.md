# Engineering safety

## Architectural rule

The frontend must not become the definitive authority for financial balances, stock integrity or transactional state.

Use existing services, RPCs, triggers and database constraints.

Do not bypass them.

## Protected areas

Do not modify without explicit task approval:

- Supabase schema.
- Migrations.
- RLS.
- RPC functions.
- Database triggers.
- Financial calculations.
- Cash calculations.
- Stock synchronization.
- Customer-account balances.
- Supplier-account balances.
- ARCA contracts.
- Receipt payment synchronization.
- Installment and surcharge rules.
- Commercial-status rules.

A visual task does not authorize business-logic changes.

## Service boundaries

Preserve:

- Service method contracts.
- Field names.
- Database names.
- RPC arguments.
- Return shapes.
- Error semantics.

Do not insert directly into protected financial tables from a UI component.

Do not duplicate calculations already owned by services or the database.

## React and TypeScript

Requirements:

- Keep TypeScript strict.
- Do not introduce `any` to hide errors.
- Do not disable ESLint rules for convenience.
- Avoid stale effects and incorrect dependencies.
- Avoid duplicated derived state.
- Avoid unnecessary rerenders.
- Keep business logic out of purely visual components.
- Prefer explicit types.
- Reuse project utilities.

## Components

Before creating a component:

- Search for an existing equivalent.
- Check shared primitives.
- Check existing tokens and styles.
- Confirm extraction reduces complexity.

Do not split a component into many files merely to reduce line count.

Extract when there is:

- A coherent responsibility.
- Repeated behavior.
- Independent rendering complexity.
- Clear testability.
- Reusable visual structure.

## Styling

- Scope feature-specific styles.
- Avoid new global rules that affect unrelated screens.
- Reuse existing CSS variables.
- Do not create a parallel design system.
- Avoid hardcoding colors repeatedly.
- Preserve light/dark theme behavior where applicable.

## Data-testid

Never remove or rename existing `data-testid` values without explicit approval.

New test IDs may be added.

Before editing a tested flow, search for every test referencing the component.

## Critical input behavior

Preserve existing behavior for:

- Barcode scanning.
- Keyboard shortcuts.
- Focus management.
- Anti-double-submit protection.
- Draft autosave.
- Draft restoration.
- Before-unload protection.
- Full-screen behavior.
- Sound behavior.
- Success states.

Do not casually rewrite timing-sensitive scanner logic.

## Git safety

Before changes:

- Inspect `git status`.
- Identify unrelated modified or untracked files.
- Do not overwrite existing work.

During changes:

- Keep scope focused.
- Do not stage unrelated files.
- Do not touch brand-guide PDF/HTML files unless explicitly requested.

After changes:

- Show `git status`.
- Show `git diff --stat`.
- List modified files.
- Do not commit or push unless explicitly requested.

## Dependencies

Do not install:

- New npm dependencies.
- Git.
- Scoop.
- System packages.
- Browser extensions.
- MCP servers.

Unless explicitly authorized.

Prefer existing dependencies and native platform capabilities.

## Honesty

Never report:

- A test as passed when it was skipped.
- A build as clean when it was not run.
- A visual flow as verified when the application was not opened.
- A push as successful without the command result.

State limitations directly.
