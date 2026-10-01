# PRE-BETA-3A-2 / 3A-2S — Cierre

**Fecha:** 2026-10-01 · **Base:** `origin/main` = `3d4d142d2add0a4754c67a33dedb3bd32bb68649` (merge de #159)
· **PR:** #160 (`claude/pre-beta-3a-2-canonical-customer`)

## Veredicto

**PRE-BETA-3A-2 — CERTIFIED / READY FOR MERGE.**
**PRE-BETA-3A-2S — CERTIFIED / READY FOR MERGE.**

- **Implementation head:** `52d567bb4c17dfb6710c8f0d1e036c1464a17a2d`.
  - El CI final de implementación sobre ese SHA es el run
    [36809551100](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/36809551100), con
    **13/13 PASS**.
- **Certificación previa aislada:** PR temporal **#161** (cerrado **sin merge**), run
  [36806206654](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/36806206654), **13/13 PASS**
  sobre `91c83e9`.
  - Esa cadena llegó al PR #160 por **fast-forward exacto** desde `a88b98a`: sin rebase, squash,
    cherry-pick ni commits recreados.
- Estado de producción y del PR:
  - **#160 todavía NO está mergeado.**
  - **No hubo deploy.**
  - **No hubo `db push`.**
  - Las dos migraciones **todavía NO fueron aplicadas en producción**.
  - El binding de Portal Clic **sigue pendiente** y se hace **manualmente después del rollout**.
  - «Ready for merge» certifica el código; no dice nada del rollout (§4).

---

## 1. Alcance

| Commit | Qué | Lote |
|---|---|---|
| `9a23280` | `ResponsiveDialog`: el foco queda estable entre re-renders del padre | 3A-2 (fix preexistente, separado a propósito) |
| `a88b98a` | Customer Core canónico + gate Mayorista (UX) | 3A-2 |
| `1968fcc` | Bordes de error visibles en tema claro | 3A-2 |
| `5381883` | Contrato Mayorista en el frontend: Pro+, owner/admin automáticos, resto por capability | 3A-2 |
| `8d2d13c` | Autoridad server-side de Mayorista: entitlement, capability, `wholesale_*`, `customers`, checkout, conversión del portal | 3A-2S |
| `77731ec` | Autoridad interna dedicada de Portal Clic (`internal_tool_principals`) | 3A-2S |
| `a13a810` | Frontend alineado con el servidor + SQL operativos + job de CI | 3A-2S |
| `9db9c10` | Job `quality` en Node 22 (`node --test` sobre `.ts`) | CI |
| `91c83e9` | E2E: contrato Quick Customer actualizado + fechas de negocio AR en fixtures | tests |
| `52d567b` | E2E: tolerancia subpíxel (ε = 0,01 CSS px) en el gate táctil de 44 px | tests |

Migraciones nuevas (append-only, atómicas, PRE/POSTCONDICIONES fail-closed):

- `20261011120000_prebeta3a2s_wholesale_server_authority.sql`
- `20261011130000_prebeta3a2s_portal_clic_internal_authority.sql`

El detalle del contrato, el orden de rollout y el binding están en `README.md` (este directorio).

## 2. Evidencia de CI

| Dónde | Run | SHA | Resultado |
|---|---|---|---|
| PR temporal **#161** (cerrado sin merge) | [36806206654](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/36806206654) (#507) | `91c83e9` | **13/13 PASS** |
| PR **#160** — CI final de implementación | [36809551100](https://github.com/molinajonyy-hub/TechRepair-Pro/actions/runs/36809551100) (#509) | `52d567b` | **13/13 PASS** |

Estado por job en el CI final de implementación (36809551100):

| Job | Resultado |
|---|---|
| PRE-BETA-3A-2S Wholesale + Portal Clic Server Authority | **PASS** (autoridad server-side oficial) |
| E2E Smoke Tests | **PASS** (E2E oficial) |
| TypeScript + Lint + Build | **PASS** (incluye el paso «PRE-BETA-3A-2 — customer creation + wholesale gate», el Customer Core) |
| G2-B · G2-C · G2-C.1 · G2-C.2 · G2-C.3A1 · G2-C.3A3 · G2-C.3B0 | **PASS** |
| SEC-08E R3 · SEC-08F | **PASS** |
| PRE-BETA-1 public.users Tenant Isolation | **PASS** |

El job `PRE-BETA-3A-2S Wholesale + Portal Clic Server Authority` corre sobre el stack oficial de
Supabase (PG17):

1. arranca en PRE-BETA-1 con las dos migraciones apartadas;
2. el preflight de solo lectura da todos los gates en verde;
3. `supabase migration up` deja exactamente dos filas en el ledger;
4. corren el guard y su self-test, el guard read-only, vitest, las matrices SQL como la API
   (Mayorista 175, Portal Clic 56), la verificación post-deploy (16 checks) y el smoke con
   `ROLLBACK`.

Runs intermedios en rojo, todos por tests o CI y ninguno por el producto:

- **#161 run 505:** `quality` corría en Node 20, que no ejecuta `.ts` con `node --test`. Lo corrigió
  `9db9c10`.
- **#161 run 506:** 5 E2E en rojo. Los corrigió `91c83e9`:
  - un assert obsoleto: el CTA de Quick Customer ahora se habilita aunque el formulario sea inválido;
  - dos fixtures que fechaban en UTC mientras el producto usa `ar_today()`: PERIOD_CLOSED y el 0 %
    contextual de Finanzas. Ese run cayó entre las 21:00 y las 24:00 AR del último día del mes. Los
    dos casos se reprodujeron en vivo.
- **#160 run 36807749691 (#508): 12/13**. El E2E falló en `dialog-touch-actions` a 320 px con
  `43.999969482421875`.
  - Ese valor es `44 − 2⁻¹⁵`: ruido float32 de `getBoundingClientRect` con la transformación de
    `modalIn`. No es un alto de layout, porque Chromium redondea el layout a 1/64 px.
  - Lo corrigió `52d567b` sin bajar el contrato de 44 px: con la tolerancia, 43,984375 (una unidad de
    layout menos) sigue fallando.

El commit documental que agrega este archivo no cambia código. Su CI se registra en el PR #160.

## 3. Lo que NO incluye este cierre

- Merge de #160.
- Deploy, `db push` o cualquier cambio en producción.
- Binding de Portal Clic.

## 4. Rollout pendiente (fuera de este PR)

Orden en `README.md` § «Orden de rollout»:

1. preflight de solo lectura;
2. revisión del impacto con producto;
3. migraciones;
4. post-deploy;
5. smoke;
6. frontend en la misma ventana;
7. **binding manual de Portal Clic**, con `portal-clic-binding.sql`: dry-run primero y
   `confirm=yes` después.

Hasta el binding, `/portal-clic` queda cerrado para todos; ese es el estado seguro por defecto.

## 5. Deudas y riesgos que NO bloquean este cierre

### 5.1 Follow-ups pre-beta separados (fuera del alcance de 3A-2/3A-2S; no se arreglan acá)

| Ítem | Detalle |
|---|---|
| `FinanceDashboard.getDateRange` desplaza rangos en hora AR | Bug **preexistente**: aplica `toISOString()` (UTC) sobre fechas locales. En Argentina, entre las 21:00 y las 24:00, «Hoy», «Semana» y el fin de «Este mes» caen en el día siguiente. Ejemplo: el 30/09 a las 22:58 AR, «Este mes» = 09-01..10-01. «Mes anterior» no se ve afectado en zona AR. |
| `tests/sql/owner_portal_isolation.test.sql` obsoleto | Quedó obsoleto frente al contrato nuevo de Portal Clic: el owner ya no lee la configuración privada. **No corre en CI.** Hay que actualizarlo al contrato del principal interno o retirarlo. |

### 5.2 Riesgos del rollout (revisar con producto antes de aplicar)

| Ítem | Estado |
|---|---|
| Negocios **Pro** con `wholesale_portal_enabled = true`: su portal público pasa a operativo | preflight 2b |
| manager y sales sin override pierden Mayorista; admins con override `false` lo recuperan | preflight 2c |
| Ventas a mayoristas de actores sin autoridad, y de Básico con mayoristas históricos, pasan a minorista | por contrato; impacto en preflight 2d/2e |
| El override manual de precio sigue permitido para owner/admin/manager/sales (`manual_override`) | sin cambios en 3A-2S |

### 5.3 Nota sobre una deuda de PRE-BETA-2

`pre-beta-2-closeout.md` §4.1 registró dos cosas: que «CI no ejecuta la suite unit de forma
canónica» y que el job `quality` usaba Node 20.

- `quality` corre en **Node 22** desde `9db9c10`.
- La parte de `npm run test:unit` sigue **vigente**: ningún job la llama. Solo `test:prebeta3a2` corre
  sus tres archivos unit.
