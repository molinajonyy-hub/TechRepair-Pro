# PRE-BETA-2E — Rollout de configuración de Auth productiva + smokes

**Fecha del registro:** 2026-09-29 · **Estado:** **EJECUTADO SEGÚN EL OWNER — EVIDENCIA INCOMPLETA EN
EL REPO.** No se declara `CLOSED` (§5). El pendiente humano de **invitaciones** quedó **completado
mediante PRE-BETA-2F**.

## 0. Por qué existe este documento

2E fue un rollout **sólo de configuración** (Dashboard de Supabase y Resend), sin código, sin PR y
sin migraciones. Hasta hoy el repo tenía únicamente:

- el **plan** y su orden exacto — `pre-beta-2d-auth-ux-tokenhash.md` §16–§17, marcado «NO ejecutado»;
- la **configuración objetivo** — `pre-beta-2b-auth-production-inventory.md` §D.

No había ningún registro de la **ejecución**: ni en `docs/`, ni en los PRs #153–#156 (sus únicos
comentarios son de Vercel), ni en ramas o worktrees de PRE-BETA-2. Éste es el primer registro
canónico de 2E. No se inventa evidencia: cada fila dice de dónde sale.

### Etiquetas

| Etiqueta | Significado |
|---|---|
| **PLAN** | lo que pedía 2D §17 / 2B §D |
| **REPO / GITHUB** | verificable en el repo o en GitHub |
| **OWNER** | reportado por el owner el 2026-09-29, sin detalle adicional salvo que se indique |
| **2F** | evidencia productiva del smoke de PRE-BETA-2F (`pre-beta-2f-invitation-email-delivery.md` §15), reportada por el owner con detalle |
| **SIN REGISTRO** | no hay evidencia en el repo ni en el reporte del owner |

Lo que reportó el owner sobre 2E (2026-09-29), sin agregarle nada:

- «PRE-BETA-2E está prácticamente cerrado en producción» (brief de 2F);
- los smokes de **signup, recovery, Google, Clic y notificaciones de contraseña/seguridad** ya se
  realizaron;
- **Leaked Password Protection: NOT AVAILABLE ON CURRENT PLAN**;
- logout roto en la pantalla «Solicitud en revisión» de Clic → post-beta;
- el smoke humano de 2F **completa el pendiente de invitaciones** que había quedado abierto en 2E.

---

## 1. Qué fue 2E y qué resolvió 2F

| | PRE-BETA-2E | PRE-BETA-2F |
|---|---|---|
| Naturaleza | configuración de Auth productiva + smokes | código nuevo: entrega de invitaciones por correo |
| Cambios | Dashboard: Redirect URLs, plantillas, largo mínimo, HIBP, notificaciones | Edge `send-business-invitation`, UI de envío/reenvío, secret propio de Resend |
| PR | ninguno | #156 (merge `ba12efc`) |
| Smoke de invitación | estaba en el paso 8 y quedó **pendiente** | **lo completó** (2F §15.3–§15.4): correo entregado, enlace canónico, alta con el correo invitado, aceptación en el taller existente, sin taller nuevo, reenvío con la misma invitación |
| Otros efectos | — | su smoke también ejerció en producción el **alta + confirmación de correo** de una cuenta nueva (paso 8 de 2E) y cerró **P3-7** |

---

## 2. Estado por paso (2D §17)

| # | Paso (PLAN) | REPO / GITHUB | OWNER / 2F | Estado |
|---|---|---|---|---|
| 1 | Merge + deploy de 2D | #155 **MERGED** 2026-09-28 20:04:35Z. `8026880` es ancestro de `ba12efc`, que es lo que sirve `www` (2F §15.1) | — | **CUMPLIDO** |
| 2 | Verificar versión productiva en `www` **y** en `clicmayorista.com.ar` | `www` cubierto por lo anterior | `clicmayorista.com.ar/version.json`: **SIN REGISTRO** | **CUMPLIDO en `www`**; portal sin registro (menor) |
| 3 | Redirect URLs **exactas**: agregar las 4 `…/auth/callback`; quitar `https://www.techrepairpro.app/**`, `https://techrepairpro.app/**` y **`http://localhost:5173/**`**; Site URL `www` | — | **SIN REGISTRO** | **SIN EVIDENCIA** — peso de **seguridad** (2B marcó `localhost` como riesgoso) |
| 4a | *Reset password* = `supabase/templates/recovery.html` (`token_hash`) | la plantilla versionada existe y la fija el guard `auth-email-templates` | OWNER: smoke de recovery **realizado**. El criterio de §17 (enlace `…/auth/callback?token_hash=…&type=recovery`, reuso → «El enlace ya no es válido») **SIN REGISTRO** | **REPORTADO, CRITERIO SIN REGISTRO** — es lo que cierra **BLK-3** (§3) |
| 4b | *Confirm signup* = `supabase/templates/confirmation.html` | ídem | 2F: alta de una cuenta nueva + confirmación del correo en producción **OK**. Si se pegó la plantilla versionada (español, soporte visible): **SIN REGISTRO** | **flujo PASS**; contenido de la plantilla sin registro. La plantilla de alta ya era `token_hash` antes de 2E (2B §B.4) |
| 5 | *Minimum password length* = **8**; *Require current password when updating* **OFF** | — | **SIN REGISTRO** | **SIN EVIDENCIA** |
| 6 | Leaked Password Protection ON **sólo si el plan la expone** (2D §16.5) | — | OWNER: **NOT AVAILABLE ON CURRENT PLAN** | **CUMPLIDO según §16.5** — documentado y no bloquea; el frontend ya maneja `weak_password` (2D) |
| 7 | Notificaciones *Password changed* y *Email changed* ON | — | OWNER: smoke de notificaciones de contraseña/seguridad **realizado**. Qué toggles quedaron ON: **SIN REGISTRO** | **REPORTADO** |
| 8 | Smokes productivos completos | — | ver §2.1 | **PARCIAL con detalle / resto reportado** |

### 2.1 Paso 8 — smokes

| Smoke (PLAN) | Evidencia | Estado |
|---|---|---|
| alta + confirmación en otra pestaña | 2F §15.3: alta con el correo invitado + confirmación → OK (la «otra pestaña» no está detallada) | **PASS** (2F) |
| **invitación a un QA** | 2F §15.3–§15.4 | **PASS — completado mediante PRE-BETA-2F** |
| recovery completo | OWNER: realizado | **REPORTADO** (resultado/criterio sin registro) |
| Google, nuevo y existente | OWNER: realizado | **REPORTADO** (detalle sin registro) |
| portal `clicmayorista.com.ar` (alta, login sin confirmar → reenvío, confirmación en el mismo origen) | OWNER: smoke de Clic realizado; **hallazgo**: logout roto en «Solicitud en revisión» | **REPORTADO** — hallazgo → post-beta (§6) |
| notificaciones de seguridad | OWNER: realizado | **REPORTADO** |
| link de alta reusado (no cae en recovery) · reenvío + 429 · login sin confirmar + reenvío en la app · perfil desactivado | — | **SIN REGISTRO** |
| Resend → Emails: `delivered`, sin bounces nuevos | 2F: los correos de invitación `Delivered`. Correos de Auth: **SIN REGISTRO** | parcial |
| Logs → Auth: sin 500 en `/signup`, `/recover`, `/resend`, `/verify` | — | **SIN REGISTRO** |

---

## 3. BLK-3

BLK-3 (2A) quedó en 2B como **IDENTIFIED — acotado a Recovery**, con cierre definido así: «**2D**
(clasificación de `otp_expired` sin `type`, desplegado primero) **+ 2E** (plantilla de recovery a
`token_hash`)».

- 2D: **cumplido** (en producción, paso 1).
- 2E paso 4a: el owner reporta el smoke de recovery **realizado**, pero no quedó registrado que el
  enlace sea `token_hash` ni el resultado del reuso.

**Estado de BLK-3: CIERRE PENDIENTE DE EVIDENCIA.** Probablemente cerrado; sin registro no se puede
declarar.

---

## 4. Lo que 2E no tenía que tocar (y no hay indicios de que se haya tocado)

Site URL (`www`), Confirm Email ON, Custom SMTP de Resend, sender, OTP 3600 s / 8, *Secure email
change* ON, Google ON, Anonymous/Phone/SAML OFF (2B §D, columna «igual»). No hay reporte de cambios
sobre ellos.

---

## 5. Gate abierto — qué falta para declarar 2E `CLOSED`

**Es un gate de EVIDENCIA, no un defecto conocido.** No hay ningún reporte de falla en los pasos de
2E; lo que falta es dejar registrado **qué** quedó configurado y **qué** probó cada smoke. Hace falta
una confirmación del owner, sin código ni deploy:

| # | Confirmar | Por qué importa |
|---|---|---|
| **E1** | Redirect URLs finales = las 4 exactas de §17 paso 3, **sin comodines y sin `http://localhost:5173/**`**; Site URL `https://www.techrepairpro.app` | **seguridad** (2B); además H3: la entrada exacta del portal tiene que seguir |
| **E2** | *Reset password* = `recovery.html` versionada (asunto `Restablecé tu contraseña — TechRepair Pro`); en el smoke, el enlace fue `https://www.techrepairpro.app/auth/callback?token_hash=…&type=recovery` y el reuso mostró «El enlace ya no es válido» | **cierra BLK-3** |
| **E3** | *Minimum password length* = 8 y *Require current password when updating* OFF | contrato de contraseña de 2D; OFF es obligatorio para recovery |
| **E4** | *Password changed* y *Email changed* ON | paso 7 |
| **E5** | Resultado **PASS** explícito de los smokes reportados: recovery, Google (nuevo y existente), portal Clic, notificaciones | hoy constan como «realizados» |
| E6 | *(opcional)* ¿se pegó `confirmation.html`?; Logs de Auth sin 500; sin bounces nuevos de Auth en Resend | verificación de cierre; no cambia el veredicto si E1–E5 están OK |

Con E1–E5 confirmados, este documento pasa a **CERTIFIED / CLOSED**, BLK-3 a **CLOSED** y
`pre-beta-2-closeout.md` a **PRE-BETA-2 — CERTIFIED / CLOSED**, en un commit sólo de documentación.

---

## 6. Hallazgos y deudas de 2E (no bloquean)

| Hallazgo | Prioridad | Fuente |
|---|---|---|
| Logout roto en la pantalla «Solicitud en revisión» de Clic Mayorista | post-beta | OWNER |
| Leaked Password Protection no disponible en el plan actual | documentado (2D §16.5); no bloquea | OWNER |
