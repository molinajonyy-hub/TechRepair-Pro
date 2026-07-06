# M6 — Ledger lockdown y flujos operativos atómicos

Objetivo: cerrar las rutas operativas que todavía pueden generar inconsistencias
(escrituras client-side, falta de idempotencia, borrados/ediciones peligrosos,
cobros de CC sin caja, caja abierta/cerrada desde el frontend, movimientos sin
reverso simétrico). **Regla central**: toda operación económica entra por una RPC
atómica, idempotente cuando pueda repetirse, con ownership check, RLS endurecida y
reverso seguro (append-only).

## Baseline
`HEAD = origin/main = 1b23bc25aba62c5979e7af4eefa420bc8d56d1c5` (Etapa 0 + Etapa 1 +
hotfix `/finance/reports` + limpieza `Finance.tsx`, todo desplegado y verificado).
El tag `stable-finance-accounting-model-v1` apunta a `3def653` (dos commits atrás — verificado).

## Documentos
- [write-surface-map.md](write-surface-map.md) — Fase 1: mapa de todas las escrituras económicas todavía posibles desde `src/`, cruzado con las RPCs existentes.
- [m6-plan.md](m6-plan.md) — Fase 2: clasificación por flujo (A–F) + alcance exacto + secuencia de implementación + riesgos de deploy.

## Fuera de alcance (explícito)
M7, M8, gráficos nuevos, rediseño de dashboard, motor de explicaciones, cierres
mensuales, normalización de los 45 FM sin caja, corrección de los 2 comprobantes
legacy desincronizados, backfills especulativos, ARCA (salvo regresión), Edge
Functions, secrets, cambios visuales grandes. No recalcular históricos; no
modificar montos ni fechas históricas.

## Estado
- **Fase 0** (git baseline) — ✅
- **Fase 1** (mapa de escrituras) — ✅ (este commit, docs-only)
- **Fase 2** (clasificación/plan) — ✅
- **Fases 3–13** (implementación) — pendiente (Commit 2), ver [m6-plan.md](m6-plan.md).
