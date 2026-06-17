# Design system

## Brand architecture

The ecosystem has two visual identities.

### Índigo · Gestión

Used by TechRepair Pro management modules.

Primary character:

- Indigo.
- Graphite.
- Deep blue.
- Neutral light text.
- Controlled depth.
- Precise interaction.

### Verde · Mi Guita

Used only by Mi Guita personal finance.

Primary character:

- Green.
- Mint.
- Financial wellbeing.
- Friendly guidance.
- Miguita mascot.

Do not cross logos or primary brand colors between products.

## TechRepair Pro color behavior

Use indigo as an accent that guides attention.

Do not flood the interface with bright indigo.

Recommended semantic roles:

- Indigo: primary action, focus, selected state, active navigation.
- Green: success, healthy stock, positive confirmation.
- Red: error, destructive action, critical state.
- Amber: warning, attention, pending risk.
- Neutral gray/blue: structure and secondary information.

## Dark interface reference

Use existing project tokens first.

When a feature lacks suitable tokens, values equivalent to these may guide the design:

```css
--pos-bg: #07111f;
--pos-surface: #0c1829;
--pos-surface-elevated: #111f33;

--pos-text-primary: #f8fafc;
--pos-text-secondary: #b8c4d6;
--pos-text-muted: #8494aa;

--pos-border: #263750;
--pos-border-hover: #3a4f70;

--pos-accent: #6366f1;
--pos-accent-hover: #7477ff;
--pos-accent-soft: rgba(99, 102, 241, 0.14);

--pos-success: #34d399;
--pos-warning: #fbbf24;
--pos-danger: #f87171;
```

Do not add these globally without first checking current tokens.

## Contrast

Target WCAG AA for functional text.

Avoid:

- Text with extremely low opacity.
- Dark blue text on dark blue surfaces.
- Muted text that looks disabled.
- Invisible placeholders.
- Disabled controls with no explanation.
- Using color as the only state indicator.

Guidelines:

- Primary text should be clearly readable.
- Secondary text must remain readable.
- Labels should generally be at least 12–13 px.
- Mobile text inputs should use at least 16 px where iOS zoom is relevant.
- Important controls should generally be at least 44 px high.
- Monetary values should use tabular numbers.

## Hierarchy

Each screen should clearly answer:

1. Where am I?
2. What is the main task?
3. What should I do next?
4. What changed after my action?
5. What prevents me from continuing?

Avoid making every section equally prominent.

## Progressive disclosure

Show advanced options only when relevant.

Examples:

- Card installments after selecting card.
- Mercado Pago variants after selecting Mercado Pago.
- Account-current details after selecting account current.
- Tax details only when required.
- Advanced filters after requesting them.
- Destructive options inside deliberate menus.

Do not remove functionality merely to appear minimal.

## Surfaces and borders

Avoid wrapping every element in a card.

Use:

- Spacing.
- Background shifts.
- Section separators.
- Typography.
- Focus states.

Borders should support structure, not create visual cages.

## Interaction states

Interactive elements need:

- Default.
- Hover.
- Focus-visible.
- Active.
- Selected.
- Disabled.
- Loading.
- Error.
- Success when relevant.

Selected states should not depend only on color.

Use icons, checkmarks, labels, borders or shape changes where appropriate.

## Motion

Use subtle transitions, generally around 150–200 ms.

Motion should explain:

- Opening.
- Selection.
- Addition.
- Removal.
- Confirmation.
- Reordering.

Avoid decorative motion that interrupts work.

Respect `prefers-reduced-motion`.

## Icons

Reuse Lucide React where already available.

Do not use emoji as button icons inside the management system.

Icon-only controls need accessible labels and tooltips where useful.

## Responsive

Responsive behavior must be intentional.

Desktop:

- Optimize for operational density.
- Preserve primary actions.
- Avoid excessive empty space.

Tablet:

- Reduce columns carefully.
- Preserve clear totals and actions.

Mobile:

- Prioritize touch.
- Use sticky summaries where useful.
- Consider bottom sheets for secondary checkout panels.
- Prevent horizontal overflow.
- Keep primary actions accessible.
- Avoid iOS input zoom.

Do not solve mobile by merely shrinking desktop.
