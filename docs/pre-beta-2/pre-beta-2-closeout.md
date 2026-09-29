# PRE-BETA-2 — Cierre

**Fecha:** 2026-09-29 · **Base:** `origin/main` = `ba12efcd6e146cc6da1887ab2fb157f493af16fe` (merge de #156)

## Veredicto

**PRE-BETA-2 — NOT CLOSED. Queda 1 gate abierto: la evidencia de PRE-BETA-2E.**

Con la documentación y la evidencia del repo, 2A, 2B, 2C, 2D y 2F están cerradas. 2E fue ejecutada
según el owner, pero el repo no registra qué quedó configurado ni qué probó cada smoke. Dos de esas
cosas cierran riesgos que las etapas anteriores dejaron abiertos a propósito: **BLK-3** (plantilla de
recovery a `token_hash`) y el recorte de las **Redirect URLs** (incluido `http://localhost:5173/**`).

No es un defecto conocido: **no hay ningún reporte de falla** en 2E. Es un gate de **evidencia**, y se
cierra con una confirmación del owner, sin código ni deploy
(`pre-beta-2e-auth-production-rollout.md` §5, ítems E1–E5).

---

## 1. Estado por etapa

| Etapa | Qué fue | Estado | Evidencia |
|---|---|---|---|
| **2A** | Discovery read-only de auth/onboarding; definió BLK-1/2/3 y el plan 2B→2E | **DONE** | `pre-beta-2a-discovery.md` |
| **2B** | Contención de la cuenta demo + inventario de Auth productiva | **CLOSED** — BLK-1 CLOSED | `pre-beta-2b-auth-production-inventory.md` · PR #153 MERGED |
| **2C** | Resend / SMTP: endurecimiento, rotación de key, deliverability | **CLOSED** — BLK-2 CLOSED FOR CONTROLLED BETA | `pre-beta-2c-email-hardening.md` · PR #154 MERGED |
| **2D** | UX de auth + contrato `token_hash` en el repo | **CLOSED** — en producción (ancestro de `ba12efc`) | `pre-beta-2d-auth-ux-tokenhash.md` · PR #155 MERGED |
| **2E** | Rollout de configuración de Auth productiva + smokes | **EJECUTADO SEGÚN EL OWNER — EVIDENCIA INCOMPLETA** | `pre-beta-2e-auth-production-rollout.md` (primer registro de su ejecución) |
| **2F** | Invitaciones por correo | **CERTIFIED / CLOSED** — completó el smoke de invitaciones de 2E | `pre-beta-2f-invitation-email-delivery.md` §15 · PR #156 MERGED |

## 2. Bloqueantes de 2A

| Bloqueante | Estado | Dónde se cerró |
|---|---|---|
| **BLK-1** — cuenta demo del portal con contraseña pública | **CLOSED** | 2B (ban verificado, credencial fuera del código, guard en CI) |
| **BLK-2** — SMTP productivo | **CLOSED FOR CONTROLLED BETA** · ampliación de deliverability pendiente (segundo proveedor ≠ Gmail), **no bloquea** | 2C §K |
| **BLK-3** — contrato de plantillas | **CIERRE PENDIENTE DE EVIDENCIA** — 2D cumplido; falta registrar el paso 4a de 2E | 2E §3 |

## 3. Gate abierto — detalle exacto

| # | Falta | Tipo | Bloquea |
|---|---|---|---|
| E1 | Redirect URLs finales: exactas, sin comodines, sin `http://localhost:5173/**` | evidencia · **seguridad** | el cierre formal de PRE-BETA-2 |
| E2 | *Reset password* = `recovery.html` (`token_hash`) + criterio del smoke | evidencia · **cierra BLK-3** | ídem |
| E3 | Largo mínimo 8 · *Require current password* OFF | evidencia | ídem |
| E4 | Notificaciones *Password changed* / *Email changed* ON | evidencia | ídem |
| E5 | PASS explícito de recovery, Google, portal Clic, notificaciones | evidencia | ídem |

Con E1–E5 confirmados por el owner, un commit sólo de documentación cambia este archivo a
**PRE-BETA-2 — CERTIFIED / CLOSED**.

---

## 4. Deudas que NO bloquean este cierre

### 4.1 Declaradas por el owner (2026-09-29)

| Deuda | Prioridad / decisión |
|---|---|
| Clic Mayorista: mantenimiento y mejoras | post-beta |
| Logout roto en la pantalla «Solicitud en revisión» de Clic | post-beta |
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
| Deliverability con un proveedor distinto de Gmail | no bloquea | 2C §K |
| El ban de la cuenta demo del portal vence el **2027-09-28**: extenderlo o dejar una contraseña aleatoria **antes** de esa fecha | acción del owner con fecha | 2B §A.5 / §D |
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

Sólo documentación y evidencia del repo y de GitHub (PRs #153–#156), más lo que el owner reportó el
2026-09-29 (rotulado **OWNER** en cada informe). No se consultó producción para este cierre.
