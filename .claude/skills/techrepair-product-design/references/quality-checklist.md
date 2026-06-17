# Quality checklist

Select checks relevant to the task.

Do not run destructive or production-changing checks without authorization.

## Static validation

Preferred commands, after confirming package scripts:

- TypeScript type checking.
- ESLint error gate.
- Production build.

Use the project's existing scripts when available.

Typical examples:

```bash
npx tsc --noEmit
npm run lint:errors
npm run build
```

Do not assume these commands exist without reading `package.json`.

## Tests

Search for relevant:

- Unit tests.
- Integration tests.
- Playwright tests.
- Smoke tests.
- Finance tests.
- Cash-register tests.
- Customer-account tests.
- Stock tests.
- ARCA tests.

Run the smallest relevant suite first.

Do not convert failing tests into skips merely to obtain green output.

## Visual verification

When the environment allows running the application, verify:

- Default state.
- Empty state.
- Populated state.
- Loading.
- Error.
- Disabled state.
- Selected state.
- Keyboard focus.
- Hover.
- Small viewport.
- Large viewport.
- Overflow.
- Text clipping.
- Contrast.
- Long content.
- Large monetary values.

## Accessibility verification

Check:

- Semantic controls.
- Accessible names.
- Focus-visible.
- Logical tab order.
- Keyboard activation.
- Escape behavior.
- `aria-expanded`.
- `aria-controls`.
- `aria-pressed`.
- `aria-selected`.
- Error association.
- Non-color state indicators.
- Reduced motion.

## Operational flows

For POS and receipts, check when applicable:

- Cash payment.
- Transfer.
- Mercado Pago.
- Card payment.
- Installments.
- Surcharges.
- Mixed payment.
- Customer account.
- With customer.
- Without customer.
- Manual product.
- Manual service.
- Barcode scan.
- Factura A.
- Factura C.
- Credit note.
- Remito.
- ARCA enabled.
- ARCA disabled.
- Success screen.
- F2.
- F4.
- Escape.
- Full screen.
- Sound.

For other modules, identify equivalent critical workflows before editing.

## Regression review

Before finishing, inspect the diff for:

- Accidental financial changes.
- Changed service contracts.
- Removed test IDs.
- Hardcoded values.
- Dead imports.
- Debug logging.
- Unrelated formatting.
- Global CSS leakage.
- Broken responsive rules.
- Missing error states.
- Unnecessary dependency changes.

## Final report format

Report:

1. Scope completed.
2. Files modified.
3. Behavior preserved.
4. Visual changes.
5. Interaction changes.
6. Accessibility changes.
7. Static checks.
8. Tests.
9. Manual verification.
10. Remaining risks.
11. Git status.
12. Suggested checkpoint name, only if requested.
