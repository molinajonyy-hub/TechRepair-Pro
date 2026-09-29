# PRE-BETA-2 — Cierre

**Fecha:** 2026-09-29 · **Base:** `origin/main` = `ba12efcd6e146cc6da1887ab2fb157f493af16fe` (merge de #156)

## Veredicto

**PRE-BETA-2 — CERTIFIED / CLOSED FOR CONTROLLED BETA.**

- Las seis etapas están cerradas.
- Los tres bloqueantes de 2A están cerrados; BLK-2 lo está *for controlled beta*, desde 2C.
- La configuración de Auth de 2E está **confirmada** (E1–E4).
- Queda **una sola verificación sin evidencia**: el smoke de **Google con una identidad nueva**.
  - No se inventa; queda como **P1 pre-beta**.
  - Con la evidencia del repo **no es un blocker real** (`pre-beta-2e-auth-production-rollout.md` §5.1).

No se declara `CLOSED` pleno sin ese sub-smoke. Es el mismo criterio que 2C aplicó a BLK-2: no
declarar una cobertura que no se midió. Con el PASS del sub-smoke, un commit sólo de documentación
deja este archivo en **PRE-BETA-2 — CERTIFIED / CLOSED**.

---

## 1. Estado por etapa

| Etapa | Qué fue | Estado | Evidencia |
|---|---|---|---|
| **2A** | Discovery read-only de auth/onboarding; definió BLK-1/2/3 y el plan 2B→2E | **DONE** | `pre-beta-2a-discovery.md` |
| **2B** | Contención de la cuenta demo + inventario de Auth productiva | **CLOSED** — BLK-1 CLOSED | `pre-beta-2b-auth-production-inventory.md` · PR #153 MERGED |
| **2C** | Resend / SMTP: endurecimiento, rotación de key, deliverability | **CLOSED** — BLK-2 CLOSED FOR CONTROLLED BETA | `pre-beta-2c-email-hardening.md` · PR #154 MERGED |
| **2D** | UX de auth + contrato `token_hash` en el repo | **CLOSED** — en producción (ancestro de `ba12efc`) | `pre-beta-2d-auth-ux-tokenhash.md` · PR #155 MERGED |
| **2E** | Rollout de configuración de Auth productiva + smokes | **CERTIFIED / CLOSED FOR CONTROLLED BETA** — E1–E4 confirmados, BLK-3 CLOSED, 1 sub-smoke pendiente | `pre-beta-2e-auth-production-rollout.md` |
| **2F** | Invitaciones por correo | **CERTIFIED / CLOSED** — completó el smoke de invitaciones de 2E | `pre-beta-2f-invitation-email-delivery.md` §15 · PR #156 MERGED |

## 2. Bloqueantes de 2A

| Bloqueante | Estado | Dónde se cerró |
|---|---|---|
| **BLK-1** — cuenta demo del portal con contraseña pública | **CLOSED** | 2B (ban verificado, credencial fuera del código, guard en CI) |
| **BLK-2** — SMTP productivo | **CLOSED FOR CONTROLLED BETA** · ampliación de deliverability pendiente (segundo proveedor ≠ Gmail), **no bloquea** | 2C §K |
| **BLK-3** — contrato de plantillas | **CLOSED** | 2D (en producción) + 2E paso 4a (E2: `recovery.html` con `token_hash`, smoke con reuso rechazado) |

## 3. Lo único pendiente de PRE-BETA-2

| Pendiente | Tipo | ¿Blocker real? | Acción |
|---|---|---|---|
| Smoke de **Google con identidad nueva** (2D §17 paso 8, «Google nuevo y existente») | verificación sin evidencia | **No.** Lo que 2E cambió en OAuth (E1) ya lo probó Google con cuenta existente (PASS); el alta de un usuario nuevo no tiene rama por proveedor y ya había 4 owners de Google provisionados en producción; 2D sólo cambió el copy de error de Google (2E §5.1) | **P1 pre-beta.** Correrlo antes de invitar testers que entren con Google (~5 min; pasos en 2E §5.1) |

---

## 4. Deudas que NO bloquean este cierre

### 4.1 Declaradas por el owner (2026-09-29)

| Deuda | Prioridad / decisión |
|---|---|
| Clic Mayorista: mantenimiento y mejoras | post-beta |
| Logout que no responde en la pantalla «Solicitud en revisión» de Clic | post-beta (no invalida el smoke del portal) |
| Leaked Password Protection | **NOT AVAILABLE ON CURRENT PLAN** (2D §16.5: documentado, no bloquea) |
| CI no ejecuta la suite unit de forma canónica | P2, **antes del Release Candidate**. **Vigente**, verificado en `ba12efc`: ningún job llama a `npm run test:unit` y el job `quality` usa Node 20 |
| **SaaS Support Inbox** | **P0 pre-beta** (2D §16.4). No bloquea el cierre de PRE-BETA-2, **sí** la beta |
| SaaS Admin | pendiente |
| Mercado Pago | sólo para suscripciones SaaS (regla vigente en `CLAUDE.md`) |
| Mi Guita | oculto para la beta |
| ~~Invitaciones por email~~ | **ya no es deuda**: la cerró PRE-BETA-2F |

### 4.2 Registradas en los informes de PRE-BETA-2

| Deuda | Prioridad | Fuente |
|---|---|---|
| Smoke de Google con identidad nueva | **P1 pre-beta** | 2E §5.1 |
| Deliverability con un proveedor distinto de Gmail | no bloquea | 2C §K |
| El ban de la cuenta demo del portal vence el **2027-09-28**: extenderlo o dejar una contraseña aleatoria **antes** de esa fecha | acción del owner con fecha | 2B §A.5 / §D |
| Copy versionado de *Confirm signup* sin registro de haberse pegado (el contrato `token_hash` ya estaba vigente y el flujo dio PASS) | P3 | 2E §2 paso 4b |
| `services/auth.ts` muerto, con un redirect fuera de la allowlist (P3-8) | P3 | 2D §15.1 |
| Invitación pendiente bloquea crear el negocio propio (P3-1) | P3 | 2D §15.1 |
| Onboarding de una sola oportunidad (P3-11) | P3 | 2D §15.1 |
| «Olvidé mi contraseña» dentro del portal mayorista | P3 | 2D §15.1 |
| `showToast` interpola con `innerHTML` en toda la app | seguridad, tarea aparte | 2F §13 |
| Cuota de Resend Free (100/día) compartida entre Auth e invitaciones | seguimiento | 2F §13 |
| `expire_old_invitations()` sin cron; `PermissionsMatrix` del modal de invitación sin persistir | P3 | `docs/p0-p2-invitations.md` §12 |

**Cerradas por PRE-BETA-2F** (salen de la lista de 2D §15.1): P3-7 (links de invitación con
`window.location.origin`) y el envío automático de invitaciones (`docs/p0-p2-invitations.md` §12).

---

## 5. Fuentes

Documentación y evidencia del repo y de GitHub (PRs #153–#156), más lo que el owner reportó y
confirmó el 2026-09-29, rotulado **OWNER** / **OWNER-CONFIRMADO** en cada informe. No se consultó
producción para este cierre.
