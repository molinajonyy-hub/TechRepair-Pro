# PRE-BETA-2E — Rollout de configuración de Auth productiva + smokes

**Fecha del registro:** 2026-09-29 · **Estado:** **CERTIFIED / CLOSED FOR CONTROLLED BETA**

- Configuración **E1–E4 CONFIRMADA** por el owner.
- **BLK-3 CLOSED** (§3).
- Smokes **PASS**, salvo **uno sin evidencia**: Google con una identidad **nueva** (nunca vista por
  Supabase). Queda **pendiente**, no se inventa, y **no bloquea** (§5).
- El pendiente humano de **invitaciones** quedó **completado mediante PRE-BETA-2F**.

No se marca `CLOSED` pleno sin ese sub-smoke, con el mismo criterio que 2C aplicó a BLK-2: no
declarar una cobertura que no se midió.

## 0. Por qué existe este documento

2E fue un rollout **sólo de configuración** (Dashboard de Supabase y Resend): sin código, sin PR y
sin migraciones. Hasta el 2026-09-29 el repo tenía únicamente:

- el **plan** y su orden exacto — `pre-beta-2d-auth-ux-tokenhash.md` §16–§17, marcado «NO ejecutado»;
- la **configuración objetivo** — `pre-beta-2b-auth-production-inventory.md` §D.

No había ningún registro de la **ejecución**: ni en `docs/`, ni en los PRs #153–#156 (sus únicos
comentarios son de Vercel), ni en ramas o worktrees de PRE-BETA-2. Éste es el primer registro
canónico de 2E. Cada fila dice de dónde sale la evidencia.

### Etiquetas

| Etiqueta | Significado |
|---|---|
| **PLAN** | lo que pedía 2D §17 / 2B §D |
| **REPO / GITHUB** | verificable en el repo o en GitHub |
| **OWNER** | reportado por el owner el 2026-09-29, sin más detalle que el indicado |
| **OWNER-CONFIRMADO** | confirmación explícita y detallada del owner (2026-09-29), ítems E1–E5 |
| **2F** | evidencia productiva del smoke de PRE-BETA-2F (`pre-beta-2f-invitation-email-delivery.md` §15) |
| **TESTS 2D** | cobertura automatizada de 2D (unit, componentes, E2E con correo real en Mailpit): **no** es evidencia de producción |
| **SIN REGISTRO** | no hay evidencia en el repo ni en los reportes del owner |

Lo que reportó el owner sobre 2E (2026-09-29), sin agregarle nada:

- «PRE-BETA-2E está prácticamente cerrado en producción» (brief de 2F);
- se realizaron los smokes de signup, recovery, Google, Clic y notificaciones de contraseña/seguridad;
- Leaked Password Protection: **NOT AVAILABLE ON CURRENT PLAN**;
- logout roto en la pantalla «Solicitud en revisión» de Clic → post-beta;
- el smoke humano de 2F completa el pendiente de invitaciones de 2E;
- confirmaciones E1–E5 con detalle (§2, §5), incluida la aclaración de que **no** hay evidencia
  explícita del smoke de Google con una identidad nueva.

---

## 1. Qué fue 2E y qué resolvió 2F

| | PRE-BETA-2E | PRE-BETA-2F |
|---|---|---|
| Naturaleza | configuración de Auth productiva + smokes | código nuevo: entrega de invitaciones por correo |
| Cambios | Dashboard: Redirect URLs, plantilla de recovery, largo mínimo, notificaciones (HIBP: no disponible) | Edge `send-business-invitation`, UI de envío/reenvío, secret propio de Resend |
| PR | ninguno | #156 (merge `ba12efc`) |
| Smoke de invitación | estaba en el paso 8 y quedó **pendiente** | **lo completó** (2F §15.3–§15.4): correo entregado, enlace canónico, alta con el correo invitado, aceptación en el taller existente, sin taller nuevo, reenvío con la misma invitación |
| Otros efectos | — | su smoke también ejerció en producción el **alta + confirmación de correo** de una cuenta nueva (paso 8 de 2E) y cerró **P3-7** |

---

## 2. Estado por paso (2D §17)

| # | Paso (PLAN) | Evidencia | Estado |
|---|---|---|---|
| 1 | Merge + deploy de 2D | REPO/GITHUB: #155 **MERGED** 2026-09-28 20:04:35Z; `8026880` es ancestro de `ba12efc`, que es lo que sirve `www` (2F §15.1) | **CUMPLIDO** |
| 2 | Verificar la versión productiva en `www` **y** en `clicmayorista.com.ar` | `www` cubierto por lo anterior. `clicmayorista.com.ar/version.json`: SIN REGISTRO. El smoke del portal (§2.1) corrió con el frontend servido | **CUMPLIDO** en `www`; portal sin registro de `version.json` (menor) |
| 3 | Redirect URLs **exactas**; quitar los comodines y `http://localhost:5173/**`; Site URL `www` | OWNER-CONFIRMADO **E1** (lista abajo) | **CONFIRMADO** |
| 4a | *Reset password* = `supabase/templates/recovery.html` (`token_hash`) | OWNER-CONFIRMADO **E2** (detalle abajo) | **CONFIRMADO** — **cierra BLK-3** |
| 4b | *Confirm signup* = `supabase/templates/confirmation.html` | 2F: alta de una cuenta nueva + confirmación del correo en producción **OK**. Si se pegó la versión versionada (español, soporte visible): SIN REGISTRO | **flujo PASS**. El contrato funcional (`token_hash`) ya estaba vigente antes de 2E (2B §B.4); el copy versionado queda sin registro (no bloquea) |
| 5 | *Minimum password length* = **8**; *Require current password when updating* **OFF** | OWNER-CONFIRMADO **E3** | **CONFIRMADO** |
| 6 | Leaked Password Protection ON **sólo si el plan la expone** (2D §16.5) | OWNER: **NOT AVAILABLE ON CURRENT PLAN** | **CUMPLIDO según §16.5** — documentado, no bloquea; el frontend ya maneja `weak_password` (2D) |
| 7 | Notificaciones *Password changed* y *Email changed* ON | OWNER-CONFIRMADO **E4**: las dos **ON** | **CONFIRMADO** |
| 8 | Smokes productivos completos | ver §2.1 | **PASS**, salvo Google con identidad nueva (**pendiente**) |

**E1 — Redirect URLs finales (OWNER-CONFIRMADO):**

| Queda | Se eliminó |
|---|---|
| `https://www.techrepairpro.app/auth/callback` | `https://www.techrepairpro.app/**` |
| `https://techrepairpro.app/auth/callback` | `https://techrepairpro.app/**` |
| `https://clicmayorista.com.ar/auth/callback` | `http://localhost:5173/**` |
| `https://www.clicmayorista.com.ar/auth/callback` | |

Site URL: `https://www.techrepairpro.app`. Coincide exactamente con 2D §17 paso 3 y conserva la
entrada exacta del portal (2D H3).

**E2 — Reset password (OWNER-CONFIRMADO):** la plantilla productiva se reemplazó por
`supabase/templates/recovery.html`, asunto `Restablecé tu contraseña — TechRepair Pro`, contrato
`{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.

**E3 — Contraseña (OWNER-CONFIRMADO):** *Minimum password length* = 8 · *Require current password when
updating* = OFF.

**E4 — Notificaciones (OWNER-CONFIRMADO):** *Password changed* = ON · *Email changed* = ON.

### 2.1 Paso 8 — smokes

| Smoke (PLAN) | Evidencia | Estado |
|---|---|---|
| alta + confirmación en otra pestaña | 2F §15.3: alta con el correo invitado + confirmación → OK (la «otra pestaña» no está detallada) | **PASS** (2F) |
| **invitación a un QA** | 2F §15.3–§15.4 | **PASS — completado mediante PRE-BETA-2F** |
| **recovery completo** | OWNER-CONFIRMADO (E2): llegó al callback con `token_hash` / `type=recovery`; abrió `/reset-password`; permitió cambiar la contraseña; la nueva funcionó; el enlace reutilizado se detectó como ya usado / no válido | **PASS** |
| **Google, cuenta existente** | OWNER-CONFIRMADO: «google ok» durante el rollout productivo | **PASS** |
| **Google, identidad NUEVA** (nunca vista por Supabase) | SIN REGISTRO. El owner aclara explícitamente que no tiene evidencia suficiente | **PENDIENTE** — no se inventa (§5) |
| **portal Clic** — alta, correo de confirmación, confirmación en el mismo origen | OWNER-CONFIRMADO: alta; correo de confirmación; el callback vuelve a `clicmayorista.com.ar`; termina en «Solicitud en revisión» | **PASS** para el flujo que era gate. El logout que no responde en esa pantalla es deuda **post-beta** (§6) y no invalida el smoke |
| portal Clic — login sin confirmar → reenvío | SIN REGISTRO en producción. TESTS 2D: `portalAuthUx*` (componentes, en CI) | sin registro productivo; no forma parte del gate E1–E5 |
| **notificación *Password changed*** | OWNER-CONFIRMADO: llegó durante el smoke de recovery | **PASS** |
| notificación *Email changed* | toggle **ON** (E4). **No** hubo smoke de cambio de email y no se registra uno | toggle confirmado; smoke no requerido por el plan (§17 paso 7 sólo pide el de contraseña) |
| link de alta reusado (no cae en recovery) · reenvío + 429 · login sin confirmar + reenvío en la app · perfil desactivado | SIN REGISTRO en producción. TESTS 2D: E2E `email-verification.spec.ts` #7 (link usado nunca en recovery), unit `authErrors.test.ts` (429), componente `inactiveProfile.test.tsx` (perfil desactivado) | sin registro productivo; no forma parte del gate E1–E5 |
| Resend: `delivered` y sin bounces nuevos | 2F: los correos de invitación `Delivered`. Correos de Auth: SIN REGISTRO | parcial; opcional |
| Logs → Auth: sin 500 en `/signup`, `/recover`, `/resend`, `/verify` | SIN REGISTRO | opcional |

---

## 3. BLK-3 — CLOSED

BLK-3 (2A) quedó en 2B como **IDENTIFIED — acotado a Recovery**, con este cierre: «**2D**
(clasificación de `otp_expired` sin `type`, desplegado primero) **+ 2E** (plantilla de recovery a
`token_hash`)».

- 2D: **cumplido** — en producción (paso 1).
- 2E paso 4a: **cumplido** — OWNER-CONFIRMADO E2: la plantilla es `recovery.html` con `token_hash`, y
  el smoke productivo midió exactamente el contrato: callback con `token_hash` / `type=recovery`,
  cambio de contraseña, contraseña nueva válida y reuso del enlace rechazado.

**BLK-3: CLOSED.**

---

## 4. Lo que 2E no tenía que tocar

Site URL (`www`), Confirm Email ON, Custom SMTP de Resend, sender, OTP 3600 s / 8, *Secure email
change* ON, Google ON, Anonymous/Phone/SAML OFF (2B §D, columna «igual»). No hay reporte de cambios
sobre ellos. E1 confirma la Site URL sin cambios.

---

## 5. Estado del gate E1–E5 y la verificación pendiente

| Ítem | Estado |
|---|---|
| E1 Redirect URLs exactas, sin comodines ni `localhost` | **CONFIRMADO** |
| E2 *Reset password* `token_hash` + smoke | **CONFIRMADO** — BLK-3 CLOSED |
| E3 mínimo 8 · *Require current password* OFF | **CONFIRMADO** |
| E4 *Password changed* / *Email changed* ON | **CONFIRMADO** |
| E5 PASS de recovery, Google, portal Clic, notificaciones | **PASS**, salvo **Google con identidad nueva: PENDIENTE** |

### 5.1 Google con identidad nueva — por qué no es un blocker real

El plan (2D §17 paso 8) pide literalmente «Google nuevo y existente». El de identidad nueva **no se
hizo con evidencia**, así que queda pendiente. Sin embargo, con la evidencia del repo **no bloquea**:

1. **Lo único que 2E cambió en el camino OAuth es E1** (redirect exacto a `/auth/callback`). Ese
   camino es el mismo para una identidad nueva y para una existente, y el de cuenta existente dio
   **PASS** con la configuración de E1 ya aplicada.
2. **El alta de un usuario nuevo no tiene rama por proveedor.** 2A §4: la única señal es
   `email_confirmed_at` leído server-side; Google y email terminan en el mismo estado
   (`AUTHENTICATED_WITHOUT_BUSINESS` → `/no-business`); test `canonicalProvisioning` «Google y email
   convergen». En producción ya había **4 owners de Google provisionados** por ese camino (2A §3,
   flujo 9).
3. **2D no tocó nada exclusivo de identidades nuevas de Google**: sólo cambió el copy de error de
   Google (2D §3.4). El llamado OAuth (`signInWithOAuth` + `getAuthCallbackUrl()`) no cambió.
4. El alta de una cuenta **nueva** por correo (mismo estado final) dio PASS en producción (2F).

**Riesgo residual:** la creación de la identidad nueva del lado de GoTrue con la allowlist nueva.
Es bajo, pero el impacto sería alto para la beta: las altas nuevas con Google son un camino
principal de los beta testers.

**Clasificación: P1 pre-beta — verificación de ~5 minutos.** Recomendado correrla **antes de invitar
testers que vayan a entrar con Google**. Con cualquier cuenta de Google que nunca haya entrado:

1. «Continuar con Google» desde `https://www.techrepairpro.app/login`;
2. vuelve a `/auth/callback` y termina en `/no-business` → «Creá tu taller»;
3. la creación del taller por la autoridad canónica funciona;
4. logout y login con Google otra vez → entra al taller.

Con ese PASS, un commit sólo de documentación pasa este registro y `pre-beta-2-closeout.md` a
**CERTIFIED / CLOSED** pleno.

---

## 6. Hallazgos y deudas de 2E (no bloquean)

| Hallazgo | Prioridad | Fuente |
|---|---|---|
| Smoke de Google con identidad nueva | **P1 pre-beta** (verificación, §5.1) | OWNER |
| Logout que no responde en la pantalla «Solicitud en revisión» de Clic Mayorista | post-beta | OWNER |
| Leaked Password Protection no disponible en el plan actual | documentado (2D §16.5); no bloquea | OWNER |
| Copy versionado de *Confirm signup* (`confirmation.html`) sin registro de haberse pegado | P3 — el contrato funcional ya está vigente y el flujo dio PASS | §2 paso 4b |
