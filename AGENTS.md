# Repository instructions for coding agents

## UI/UX authority — mandatory

These instructions apply to every coding agent working in this repository.

Before analyzing, proposing, or modifying frontend code, read in full:

- `.claude/skills/techrepair-product-design/SKILL.md`

Always read before modifying application code:

- `.claude/skills/techrepair-product-design/references/engineering-safety.md`

Read the other references linked by the Product Design Skill whenever they are relevant to the task.

The Product Design Skill is the canonical UI/UX authority for TechRepair Pro. `DESIGN_SYSTEM.md` is a secondary, historical implementation reference only. If the Product Design Skill conflicts with `DESIGN_SYSTEM.md`, feature-local patterns, recent implementation, or generic best practices, the Product Design Skill wins unless an explicit newer product decision in the repository supersedes a specific point.

Mandatory product-design principles:

- Reuse before inventing.
- Do not create parallel visual patterns for the same semantic action.
- Design mobile intentionally; do not merely shrink desktop layouts.
- Keep touch targets at least 44 px.
- Preserve existing functionality.
- Do not trade reliability for visual novelty.
- Do not mix a redesign, broad refactor, business-logic changes, database changes, and dead-code removal in one change.
- Light and dark modes must follow the current tokens and theme architecture.
- POS is a deliberately protected visual island wherever the Product Design Skill documents it.
- Mi Guita is visually distinct and must not be used as the TechRepair Pro baseline.
