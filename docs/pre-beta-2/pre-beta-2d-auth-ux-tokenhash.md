# PRE-BETA-2D — Auth UX hardening + `token_hash` readiness

**Fecha:** 2026-09-28 · **Estado:** CLOSED en el repo — PR en revisión del owner, **NO MERGE**.
**Producción de Auth: sin cambios.** No se tocaron Redirect URLs, Site URL, Confirm Email,
plantillas, largo mínimo, Leaked Password Protection, notificaciones de seguridad, SMTP, Resend, DNS,
Google OAuth, usuarios ni DB productiva. No hay migraciones. No se hizo deploy.

| Dato | Valor |
|---|---|
| Base | `origin/main` = **`d50cad830fdd9c283cba9b33ac9edfec46a51ebc`** (merge de #154). Verificado con `fetch` al inicio: **no avanzó**, así que no hubo cambios nuevos de Auth, Login, Signup, Recovery, VerifyEmail, Onboarding, portal, landing, config local ni plantillas que revisar. |
| Producción servida al inicio | `d50cad8` en `www.techrepairpro.app/version.json` **y** en `clicmayorista.com.ar/version.json` (build 2026-09-28 13:44 UTC) |
| Rama | `claude/pre-beta-2d-auth-ux-hardening` |
| Commits | `beb1b20` feat(auth) · `82f8d8e` chore(supabase) · `ffa0399` test(e2e) · este informe |
| Versiones | Node 24.14.1 (local) · Supabase CLI **2.109.1** (la misma que fija CI) · GoTrue local **v2.192.0** · Mailpit v1.30.2 · GoTrue prod v2.197.0 (2A) |
| Informes previos | `pre-beta-2a-discovery.md`, `pre-beta-2b-auth-production-inventory.md`, `pre-beta-2c-email-hardening.md` (leídos completos; no se repite su discovery) |

---

## 0. Resumen

2D deja el frontend y el stack local listos para el rollout de Auth de 2E:

1. **Una sola política de contraseña** (mínimo 8, máximo 72 bytes UTF-8, confirmación) en registro
   principal, portal y ResetPassword. El **login** no la exige (hay cuentas con el mínimo anterior).
2. **Errores cerrados.** Ningún texto de GoTrue ni de `?error_description=` llega a la pantalla:
   alta, login, reenvío, Google y errores por URL pasan por un mapa propio.
3. **`weak_password` / contraseña filtrada** con copy propio en las tres superficies: el frontend ya
   sabe manejar Leaked Password Protection antes de que 2E la active.
4. **Perfil desactivado** = estado terminal propio (sin crear taller, sin reintento, sin aceptar invitación).
5. **Soporte canónico** (`CONTACTO_SOPORTE`) en todas las superficies tocadas y en las plantillas.
6. **Portal:** login sin confirmar distinguido + reenvío oficial; sin PII en logs; alta con errores cerrados.
7. **Landing:** «Probar gratis» abre «Crear cuenta»; el plan sobrevive a la confirmación en otra pestaña.
8. **Fallback de la raíz:** `/?token_hash=…&type=…` (redirect degradado al Site URL) → `/auth/callback`.
9. **Plantillas `token_hash` versionadas** (signup y recovery) + guard que las fija.
10. **Stack local = contrato de producción post-2E:** `[local_smtp]`, mínimo 8, plantillas versionadas; el
    E2E hace click en el **correo real** de Mailpit para signup y recovery.
11. **`otp_expired` sin `type`** ya no se presenta como «restablecer contraseña» sin evidencia; el
    recovery legacy por fragmento sigue funcionando durante la transición.

---

## 1. Archivos

**Nuevos**

| Archivo | Rol |
|---|---|
| `src/lib/passwordPolicy.ts` | Política canónica + mensajes + detección de `weak_password` |
| `src/lib/authErrors.ts` | Clasificadores cerrados: alta, login, reenvío, URL, Google |
| `src/lib/authEmailLink.ts` | Enum de tipos `token_hash` (compartido con AuthCallback) + fallback de la raíz |
| `src/lib/signupIntent.ts` | `?modo=`, ruta del CTA de prueba, plan entre pestañas |
| `supabase/templates/confirmation.html`, `recovery.html` | Plantillas versionadas (español, `token_hash`, soporte) |
| `scripts/guards/auth-email-templates.mjs` | Guard de plantillas + config local + soporte (con self-test) |
| `tests/e2e/setup/mailpit.ts` | Helper compartido de Mailpit (`[local_smtp]`, `[inbucket]` sólo compat) |
| 4 unit + 7 component tests | §13 |

**Modificados:** `src/lib/passwordRecovery.ts`, `src/lib/supabase.ts`, `src/contexts/AuthContext.tsx`,
`src/pages/{Login,AuthCallback,ResetPassword,VerifyEmail,NoBusiness,SubscriptionSuspended,LandingPage,Onboarding}.tsx`,
`src/portal/pages/{PortalLogin,PortalRegister}.tsx`, `src/portal/services/portalService.ts`,
`supabase/config.toml`, `package.json` (scripts del guard), `.github/workflows/ci.yml` (step nuevo en
`quality`), `tests/e2e/m7/{password-recovery,email-verification}.spec.ts`, `tests/e2e/landing.spec.ts`,
`tests/unit/passwordRecovery.test.ts`, `tests/components/portalLoginNoDemo.test.tsx`.

41 archivos, +3099 / −297 (sin CRLF; `--stat` = `--stat --ignore-all-space`). **0 migraciones.**

---

## 2. Política de contraseña — `src/lib/passwordPolicy.ts`

| Regla | Valor | Por qué |
|---|---|---|
| Mínimo | **8 caracteres** (code points) | GoTrue cuenta **bytes**; cada code point ≥ 1 byte ⇒ «≥ 8 caracteres» implica «≥ 8 bytes»: el formulario nunca deja pasar algo que el servidor rechace por corto. 4 emojis (8 unidades UTF-16) **no** son 8 caracteres. |
| Máximo | **72 bytes UTF-8** | bcrypt trunca en silencio más allá de 72 bytes. `ñ×36` pasa, `ñ×37` no. |
| Sólo espacios | rechazado | igual que Lote B |
| Confirmación | obligatoria y coincidente | alta principal, portal y reset |
| Complejidad | ninguna | decisión de beta |

- Placeholder canónico: **«Mínimo 8 caracteres»** (`PASSWORD_PLACEHOLDER`).
- `passwordRecovery.ts` **reexporta** `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_BYTES` y
  `validateNewPassword` delega en `validatePasswordPair`: no hay números duplicados (lo fija
  `tests/unit/passwordPolicy.test.ts` P8/P9).
- Aplicada a: **registro principal** (`Login` modo registro), **PortalRegister**, **ResetPassword**.
- **No aplicada al login** (`Login` modo ingreso): antes el login exigía ≥ 6 del lado del cliente; ahora
  sólo exige que no esté vacío. Motivo: producción tiene cuentas creadas con mínimo 6; bloquearles el
  ingreso desde el formulario sería romperles el acceso. GoTrue valida la fortaleza sólo al fijar una
  contraseña, no al ingresar.
- Producción **sigue en 6** hasta 2E (§17).

---

## 3. Contratos de error — `src/lib/authErrors.ts`

Señales usadas, en orden: `name` (`AuthWeakPasswordError`, `AuthRetryableFetchError`), `code`
(GoTrue ≥ 2024-01-01), `status`, y **sólo como compatibilidad** fragmentos conocidos del mensaje de
versiones viejas. El texto visible sale siempre de un mapa. Valor desconocido ⇒ genérico.

### 3.1 Alta (`signUp`) — app y portal

| `kind` | Señal | Copy app | Copy portal (override) |
|---|---|---|---|
| `weak_password` | `AuthWeakPasswordError` / `code=weak_password` | según `reasons`: `pwned` o vacío → «Esta contraseña no es segura. Elegí otra que no hayas usado en otros servicios.»; `length` → «Usá una contraseña más larga.»; `characters` → «Combiná letras, números y símbolos.» | igual |
| `rate_limited` | 429, `over_email_send_rate_limit`, `over_request_rate_limit` | «Hiciste varios intentos seguidos. Esperá unos minutos y volvé a probar.» | igual |
| `already_registered` | `user_already_exists`, `email_exists`, «already registered» | «Este email ya tiene una cuenta. Iniciá sesión o recuperá tu contraseña.» (sin cambio: ver §16) | «Este email ya está registrado. Intentá iniciar sesión.» |
| `invalid_email` | `email_address_invalid` | «Revisá el email: no parece una dirección válida.» | igual |
| `email_send_failed` | 500 con «error sending…», `email_address_not_authorized` | «No pudimos enviar el correo de confirmación… escribinos a `CONTACTO_SOPORTE`.» | «…Si sigue fallando, contactá al negocio.» |
| `network` | `AuthRetryableFetchError` / status 0 / 502-504 | «No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.» | igual |
| `unknown` | cualquier otra cosa | «No pudimos crear la cuenta. Intentá nuevamente en unos minutos.» | igual |

El 429 del alta **ya no** muestra «Email rate limit exceeded» (2C §H). El `err?.message` de
`Login.tsx` y el `authErr.message` de `registerCustomer` se eliminaron. El INSERT mayorista de la rama
Confirm OFF tampoco devuelve el texto de PostgREST.

### 3.2 Login (`signInWithPassword`)

| `kind` | App | Portal |
|---|---|---|
| `email_not_confirmed` | «Tu cuenta todavía no está confirmada…» + reenvío | «Tu correo todavía no está confirmado. Revisá el email que te enviamos.» + **reenvío** (nuevo) |
| `invalid_credentials` | «Email o contraseña incorrectos. Verificá tus datos.» | «Email o contraseña incorrectos» |
| `rate_limited` | «Demasiados intentos seguidos…» | «Hiciste varios intentos seguidos…» |
| `network` | «No pudimos conectarnos…» | «Error de conexión…» |
| `unknown` (incluye `user_banned`) | «No pudimos iniciar sesión…» | idem |

### 3.3 Reenvío de confirmación

`classifyResendResult`: `sent` · `rate_limited` (429 o «rate limit»/«too many») · `error`. Una sola
fuente para `AuthContext.resendConfirmation` y el portal.

### 3.4 Google

Falla al abrir el flujo → «No pudimos abrir el inicio de sesión con Google. Intentá nuevamente.» (antes
`err.message`).

---

## 4. `error_description` no es UI

`Login.tsx` y `AuthCallback.tsx` **no leen** `error_description`. `classifyAuthUrlError` mira sólo
`error` y `error_code`:

| URL | Resultado |
|---|---|
| `error_code=otp_expired` | «El enlace venció o ya se usó. Pedí uno nuevo.» |
| `error=access_denied` **sin** `error_code` (así reenvía GoTrue el rechazo del proveedor: el usuario canceló en Google) | «Cancelaste el inicio de sesión con Google.» |
| `error=access_denied` **con** código (403 propio de GoTrue), `server_error`, cualquier otro | «No pudimos completar el inicio de sesión. Intentá nuevamente.» |
| sin `error` ni `error_code` | nada |

`?error=x&error_description=TechRepair+fue+hackeado` ⇒ genérico; «hackeado» no aparece (unit A10,
componente L11/C1, **E2E ev#9 en navegador real**). `?motivo=` también es enum cerrado
(`link_invalido`, `enlace_vencido`); un valor desconocido no pinta nada (L13).

---

## 5. Perfil desactivado

`profileErrorKind = 'inactive'` sigue derivando `AUTH_ERROR` (no se tocó la máquina de estados ni los
guards), pero `NoBusiness` lo resuelve **antes** que la invitación y que la rama de reintento:

- título «Tu acceso a este negocio está desactivado»;
- «Un administrador del negocio desactivó tu usuario. Si creés que es un error, pedile que te vuelva a
  habilitar.» + «Si sos el titular del negocio, escribinos a `CONTACTO_SOPORTE`» (mailto);
- única acción: **Cerrar sesión**.

No ofrece «Crear mi taller», ni Reintentar, ni aceptar una invitación guardada. No hay reintento
automático (`get_my_profile` no se vuelve a pedir; nunca se provisiona). Un fallo **transitorio** sigue
en la rama de reintento (I6). Autoridad server-side (`is_active`, RLS) intacta.

---

## 6. Soporte canónico

- `SubscriptionSuspended.tsx`: `soporte@techrepairpro.com` → `CONTACTO_SOPORTE` con `mailto:`.
- Soporte visible también en: perfil desactivado, `/verificar-email` cuando el reenvío falla,
  `/reset-password` inválido, error de envío del alta, y las dos plantillas.
- Regresión bloqueada tres veces: guard S1 (ninguna casilla `@techrepairpro.com` en `src/`), test SC2, y
  el guard T4 (las plantillas sólo contienen `CONTACTO_SOPORTE`).

---

## 7. Portal mayorista

| Punto | Antes | Ahora |
|---|---|---|
| Login sin confirmar | «Email o contraseña incorrectos» | copy propio + **«Reenviar correo de confirmación»** |
| Reenvío | no existía | `supabase.auth.resend({ type: 'signup', emailRedirectTo: getAuthCallbackUrl() })` (API oficial, sin endpoint propio, callback canónico del **origen actual** = `clicmayorista.com.ar/auth/callback`); `sent` / `rate_limited` (sin botón) / `error` (reintentable) |
| Logs del login | `console.log` con email, auth user id y estado del mayorista (en el bundle productivo) | **ninguno**. El resto del servicio usa `logger` sin PII (sólo el código de PostgREST) |
| Alta | 6 caracteres, `authErr.message` crudo | política 8/72 + errores cerrados (§3.1) |

Anti-enumeración: el reenvío sólo se ofrece después de que GoTrue dijo «sin confirmar», y GoTrue responde
igual al reenvío exista o no la cuenta. El modelo privado del portal no cambió.

Regresión: `portalAuthUx` P5 espía `console.*` en los cinco caminos del login; P6 es un guard estático
sobre `portalService.ts` (sin `console.*`, ningún `logger` recibe email/ids). Bundle de producción: 0
archivos con `[loginCustomer]`.

---

## 8. Landing — intención de alta

- Hero, header, menú mobile, CTA final y footer: `navigate(signupPath())` →
  `/login?modo=registro&redirectTo=%2Fonboarding`.
- Pricing: `signupPath(plan)` → `…redirectTo=%2Fonboarding%3Fplan%3Dpro`.
- «Ingresar» sigue en `/login` (login normal).
- `modo` es enum cerrado; `redirectTo` pasa por `sanitizeInternalPath` como cualquier otro: **no hay
  open redirect nuevo**.
- Preservación del destino:
  - misma pestaña: `post_login_redirect = /onboarding?plan=pro` (como antes);
  - **otra pestaña** (el caso normal del enlace del correo): el plan viaja en `localStorage`
    (`trp_signup_plan`, sólo id + hora, TTL 24 h), el onboarding lo consume una vez y `signOut` lo borra;
  - invitaciones (`trp_pending_invite`) y `post_login_redirect`: sin cambios.
- Con sesión, el Login redirige al destino como antes: un usuario logueado que toca «Probar gratis»
  sigue llegando a `/onboarding`.

---

## 9. Fallback de `RedirectTo` degradado

`src/lib/authEmailLink.ts`, llamado en `src/lib/supabase.ts` **antes** de `createClient` y antes de que
monte el router. Si la URL es **exactamente** `/` + `token_hash` (forma de hash, 16-256 caracteres de
`[A-Za-z0-9_-]`, prefijo `pkce_` admitido) + `type ∈ {signup, email, recovery}`, cada uno una sola vez,
sin otros parámetros y sin fragmento ⇒ `replaceState` a `/auth/callback?token_hash=…&type=…` (misma
entrada del historial). Cualquier otra cosa se deja pasar sin tocar. Destino fijo: no es un parser de
redirects (unit R1–R5). `AuthCallback` borra el token de la barra antes de `verifyOtp`. **E2E ev#8**: un
token real en `/` confirma la cuenta.

---

## 10. Plantillas versionadas

`supabase/templates/confirmation.html` y `recovery.html`:

| Plantilla | Asunto | Enlace |
|---|---|---|
| Confirm signup | `Confirmá tu correo — TechRepair Pro` (el mismo de prod) | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup` |
| Reset password | `Restablecé tu contraseña — TechRepair Pro` | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` |

Ambas: español, «TechRepair Pro», «El enlace sirve una sola vez», advertencia de ignorar el correo si no
se pidió la acción, soporte visible `mailto:CONTACTO_SOPORTE`, aviso de no responder (el remitente no
recibe correo, 2C §E). Sin imágenes, sin URLs literales, sin tracking. No prometen una duración (la UI
tampoco). El comentario HTML de cabecera no usa acciones de plantilla.

**Guard** `npm run guard:auth-email-templates[:self-test]` (en `npm run guards` y en CI `quality`):
T1 enlace exacto por tipo · T2 sin `ConfirmationURL`/`SiteURL`/`Token` · T3 sin `http(s)://`, sin
`<img>`, sólo dos `href` permitidos · T4 el literal de soporte **es** `CONTACTO_SOPORTE` (GoTrue no puede
importar TS: se compara contra la constante leída del fuente) · T5 marca + advertencia · C1 config local ·
S1 soporte en `src/`. Self-test: 10 plantillas + 4 configs + 2 checks.

**No se aplicaron a producción.**

---

## 11. Stack local = contrato de 2E

`supabase/config.toml` (sólo local):

- `[inbucket]` → **`[local_smtp]`** (mismas claves; mismo contenedor `supabase_inbucket_<id>` y API de
  Mailpit). Con la config nueva, `supabase status` (CLI 2.109.1) ya no imprime el WARN de deprecación
  (medido).
- `minimum_password_length = 8` (`password_requirements = ""`, `secure_password_change = false` sin
  cambio).
- `[auth.email.template.confirmation]` y `[auth.email.template.recovery]` con `content_path` a los
  archivos versionados. La ruta `./supabase/templates/…` es la que resuelve la CLI 2.109.1 (medido).
- Comentario corregido: decía que producción tenía Confirm Email **apagado**; 2A/2B confirmaron que está
  **encendido**.

**Medido en el stack aislado** (`docker inspect` de GoTrue, sólo variables no secretas):
`GOTRUE_PASSWORD_MIN_LENGTH=8`, `GOTRUE_MAILER_TEMPLATES_{CONFIRMATION,RECOVERY}` servidas por Kong,
asuntos en español, `GOTRUE_SMTP_HOST=supabase_inbucket_prebeta2d:1025`.

Helper compartido `tests/e2e/setup/mailpit.ts`: lee el puerto de `[local_smtp]` (canónico) y de
`[inbucket]` sólo como compatibilidad (gana `local_smtp` si están las dos); `esperarEnlace`,
`ultimoCorreo`, `esEnlaceTokenHash`. Sin parsers TOML duplicados en los specs.

---

## 12. Transición de Recovery y `otp_expired`

### 12.1 Contrato de atribución (el más cerrado posible)

`otp_expired` en el **fragmento** no trae `type`: por sí solo no prueba que el enlace fuera de recovery.

| Llega a `/auth/callback` | Evidencia | Pantalla |
|---|---|---|
| `?token_hash=…&type=recovery`, `verifyOtp` OK | el `type` | `/reset-password` formulario |
| `?token_hash=…&type=recovery`, rechazado (usado/vencido/inventado) | el `type` | `/reset-password` **vencido** |
| `?token_hash=…&type=signup`, rechazado | el `type` | sesión confirmada → sigue; sesión sin confirmar → `/verificar-email?estado=LINK_EXPIRED_OR_INVALID`; sin sesión → `/login?motivo=link_invalido` (sin cambio) |
| `#access_token…&type=recovery` (legacy) | el `type` | `/reset-password` (Lote B, sin cambio) |
| `#error_code=otp_expired` **y** este navegador pidió un recovery hace < 24 h | marca local `techrepair.auth.recovery-requested` = `{v:1, at}` | `/reset-password` **vencido** |
| `#error_code=otp_expired` **sin** esa marca (alta con plantilla por defecto, magic link, cambio de email, recovery legacy abierto en otro dispositivo) | ninguna | **`/login?motivo=enlace_vencido`**: «El enlace que abriste venció o ya se usó. Si querías restablecer tu contraseña, tocá «¿Olvidaste tu contraseña?»… Si estabas confirmando tu correo, iniciá sesión y te ofrecemos reenviarlo.» |

La marca se escribe al pedir «olvidé mi contraseña» (exista o no la cuenta: no revela nada), guarda sólo
la hora, vive en `localStorage` (el enlace se abre en otra pestaña) y **no habilita nada**: el formulario
sigue exigiendo sesión + marca de recovery del mismo usuario. El fragmento se saca de la URL en los dos
casos.

### 12.2 Compatibilidad legacy

La captura del fragmento de Lote B **se mantiene intacta**: los correos de recovery enviados con
`{{ .ConfirmationURL }}` antes de 2E siguen funcionando hasta que vencen (1 h). E2E rec#1b lo prueba
contra GoTrue real con el `action_link` de la admin API (el mismo enlace que produce la plantilla
`ConfirmationURL`): formulario, contraseña vieja 400 / nueva 200, URL sin tokens, «atrás» sin tokens,
reuso → vencido.

**Cuándo se puede retirar el camino legacy:** no antes de 2E + 1 h (vencimiento del OTP). Se recomienda
dejarlo un ciclo más (es inocuo) y retirarlo en un lote propio con su E2E.

---

## 13. VerifyEmail / copy

- Estado nuevo `RESEND_FAILED` («No pudimos reenviar el correo. Probá de nuevo en unos minutos.») en vez
  de caer en `AUTH_ERROR` («No pudimos verificar el estado de tu cuenta»): lo que falla es el envío.
- `RESEND_FAILED` y `AUTH_ERROR` muestran el soporte canónico.
- `RESEND_RATE_LIMITED`, `LINK_EXPIRED_OR_INVALID`, recovery vencido: ya eran propios; se agregó la línea
  de soporte en `/reset-password` inválido.
- Sin rediseño, sin copy informal.

---

## 14. Tests y gates

### 14.1 Nuevos

| Nivel | Archivo | Casos |
|---|---|---|
| unit | `passwordPolicy.test.ts` | 7 → rechazo, 8 OK, 72/73 bytes, multibyte, emojis, espacios, par, placeholder, `weak_password` por motivos, reexport sin duplicar, sin números mágicos en las 3 superficies, ResetPassword → copy propio (10) |
| unit | `authErrors.test.ts` | 429 del alta, `weak_password`, ya registrado, SMTP, red, desconocido sin texto crudo, overrides, login, reenvío, URL (`hackeado` nunca), copy sin inglés (11) |
| unit | `authEmailLink.test.ts` | fallback: tipos válidos, 17 rechazos (path, fragmento, tipo, extras, duplicados, forma), destino fijo, `replaceState` en la misma entrada, enum compartido y orden de arranque (5) |
| unit | `mailpitConfig.test.ts` | `[local_smtp]` canónico / `[inbucket]` compat, config commiteado, mínimo 8, plantillas cableadas, sin «Confirm Email apagado» (5) |
| unit | `passwordRecovery.test.ts` (+4) | `otp_expired` con/sin evidencia, vencimiento de la marca, sin storage, la marca guarda sólo la hora |
| comp | `authUxHardening.test.tsx` | L1–L16, C1–C2, V1 (19) |
| comp | `inactiveProfile.test.tsx` | I1–I6 (6) |
| comp | `portalAuthUx.test.tsx` | P1–P8 (7) |
| comp | `portalAuthUxScreens.test.tsx` | U1–U4 (5) |
| comp | `landingSignupIntent.test.tsx` | hero, header, final, pricing+plan, mobile, Ingresar (6) |
| comp | `signupIntent.test.ts` | `?modo=`, ruta, saneado, plan entre pestañas, sin storage (5) |
| comp | `supportContact.test.tsx` | SubscriptionSuspended, sin `@techrepairpro.com`, plantillas (3) |
| E2E | `password-recovery.spec.ts` | 1 token_hash real + escáner + cross-device · 1b legacy · 2 anti-enumeración · 3 sin enlace · 4 `otp_expired` neutro/atribuido + basura · 5 Google-only · 6 **vencido real** (reloj del servidor) |
| E2E | `email-verification.spec.ts` (+4) | 6 alta por **correo real** en otra pestaña (la original avanza sola) + escáner · 7 link usado nunca en recovery · 8 fallback raíz · 9 política 7 chars + `error_description` |
| E2E | `landing.spec.ts` | CTAs → registro, plan en `redirectTo` |

### 14.2 Gates — CONFIRMADO POR TEST (2026-09-28)

| Gate | Resultado |
|---|---|
| Baseline antes de tocar (unit auth · vitest auth · guards) | 84/84 · 171/171 · 12/12 |
| `tsc --noEmit` | **0** errores |
| ESLint `src --quiet` (`lint:errors`) | **0** errores (2 warnings preexistentes en archivos tocados: `AuthContext` exhaustive-deps, `supabase.ts` no-extra-semi) |
| `npm run test:unit` completo | **1212/1212** |
| vitest completo (`npm run test:components`) | **1354/1354**, 97 archivos. Una corrida previa tuvo 1 falla en `orderIntakeMobile` (escáner de órdenes, no Auth) que pasa 8/8 aislado: flaky por carga |
| Guards: `auth-email-templates`, `auth-redirect`, `no-hardcoded-credentials`, `onboarding-canonical`, `provisioning-authority`, `mobile-session-1a`, `no-real-data`, `tenant-isolation:static` (+ self-tests), `ui-governance`, `ci-e2e` (+ self-test) | **todos OK** |
| `vite build` de producción | OK; bundle (132 archivos): 0 `[loginCustomer]`, 0 `soporte@techrepairpro.com`, 0 `decodeURIComponent` de `error_description`, 0 «Email rate limit exceeded», 0 «Error de Google:», 0 «Mínimo 6» |
| **E2E Auth** (`password-recovery` + `email-verification`) contra GoTrue v2.192 + Mailpit reales, stack aislado | **18/18** |
| **E2E `m7-local` completo** (incluye invitaciones p0p2, routing/onboarding p0p4p5, email verification, recovery, mobile, portal, finanzas…) | **180/180** |
| E2E `landing.spec.ts` | **16/16** |
| **Controles negativos**: las 9 pantallas/servicios de `origin/main` con los tests nuevos | **42 de 46 fallan**, como deben (los 4 que pasan afirman cosas que también valen en `main`: «Ingresar → /login», fallo transitorio → reintentar, plantillas, login con 6) |

### 14.3 Cómo se corrió el E2E

Stack **aislado** para no tocar los de otras sesiones (`techrepair-vite` y `techrepair-mobile2a-expand`
estaban corriendo y no se tocaron): `config.toml` modificado **sólo temporalmente** (`project_id =
"prebeta2d"`, puertos 554xx; API 55421 está en `PUERTOS_PERMITIDOS`),
`supabase start -x studio,logflare,vector,postgres-meta,supavisor,edge-runtime`, `.env.e2e` generado
desde `supabase status` sin imprimir claves, `node scripts/e2e/prepare-local.mjs`, Playwright por
`node node_modules/@playwright/test/cli.js`. Replay limpio de las migraciones OK con CLI 2.109.1. Al
terminar: `supabase stop --project-id prebeta2d --no-backup` (0 contenedores, 0 volúmenes),
`config.toml` restaurado con `git checkout`, `.env.e2e` borrado, 43 PNG de evidencia reescritos por la
suite revertidos. Disco C: 2,8 GB antes y después.

### 14.4 CI

Step nuevo en `quality` (Node 20): guard + self-test + 10 suites de componente de Auth. El E2E de CI
(`e2e-local`, CLI 2.109.1) levanta el stack con el `config.toml` commiteado: **ejercita `[local_smtp]`
y las plantillas versionadas en cada PR**.

---

## 15. Hallazgos nuevos

| # | Hallazgo | Sev. | Tratamiento |
|---|---|---|---|
| H1 | **CI nunca corre `npm run test:unit`**: el job `quality` usa Node 20 (no ejecuta `.ts`) y ningún otro job los llama. Los ~1200 tests de `tests/unit/` son sólo locales. | P2 (proceso) | 2D mitiga en su área (guard `.mjs` + vitest en CI). Lote aparte: un step Node 22 con `npm run test:unit`. |
| H2 | La plantilla de **alta es compartida** por TechRepair Pro y el portal de Clic: un cliente mayorista recibe «Confirmá tu correo — TechRepair Pro» (2B ya había anotado el sender). | P3 | Decisión del owner (§16). Técnicamente posible bifurcar con `{{ if .Data.wholesale_registration }}`, pero agrega riesgo a la plantilla que confirma TODAS las altas. |
| H3 | Un `redirect_to` del portal fuera de la allowlist degradaría al Site URL (`www.techrepairpro.app`): confirmaría el correo, pero la sesión quedaría en el origen equivocado y el cliente mayorista vería «Creá tu taller». Hoy **no ocurre**: `https://clicmayorista.com.ar/auth/callback` está en la allowlist exacta. | P2 latente | 2E: **no** quitar esa entrada al reemplazar los comodines (§17 paso 3). |
| H4 | `src/lib/signupIntent.ts` no puede probarse con `node --test`: `src/types/subscription.ts` reexporta `./subscriptionAccess` sin extensión. | P4 | Test en vitest. Sin cambio en billing. |
| H5 | Login: el mínimo 6 del cliente también se exigía al **ingresar**. | — | Quitado (§2). |

Pendientes de 2A que **no** estaban en el alcance de 2D y siguen abiertos: P3-7 links de invitación con
`window.location.origin`, P3-8 `services/auth.ts` muerto, P3-1 invitación pendiente bloquea negocio
propio, P3-11 onboarding de una sola oportunidad, «olvidé mi contraseña» dentro del portal.

---

## 16. Decisiones del owner

1. **Enumeración en el alta** (2A P3-5, sin cambio en 2D): si GoTrue responde `user_already_exists`, la
   UI dice «Este email ya tiene una cuenta». 2A lo midió en local (422); en producción no se re-verificó
   (la memoria histórica decía 200 sin correo). El mensaje sólo aparece donde GoTrue ya lo revela en la
   respuesta HTTP. ¿Se mantiene o se neutraliza?
2. **Marca de la plantilla de alta para el portal** (H2): ¿«TechRepair Pro» también para Clic Mayorista?
3. **Copy de la plantilla de alta en 2E**: producción ya usa `token_hash`; la versionada agrega soporte,
   advertencia y copy. ¿Se pega también (recomendado) o sólo recovery?
4. Confirmar que la casilla `CONTACTO_SOPORTE` se monitorea (ya pedido en 2C): ahora aparece en más
   pantallas y en los dos correos.
5. **Leaked Password Protection**: confirmar en el Dashboard que el toggle está disponible para el plan
   del proyecto antes de 2E (no verificado en 2D: sin acceso al Dashboard). Si no lo está, el frontend
   igual queda listo y el paso 6 se omite.

---

## 17. PRE-BETA-2E exact rollout order (NO ejecutado)

**Precondiciones:** PR de 2D mergeado y desplegado; owner con acceso al Dashboard; una ventana sin altas
reales; cuenta QA Gmail (y M365 con Safe Links si existe). Guardar **antes** el texto actual de cada
plantilla y cada valor que se cambie (rollback).

| # | Paso | Detalle exacto | Smoke inmediato | Rollback |
|---|---|---|---|---|
| 1 | Merge + deploy 2D | Merge del PR; esperar el deploy de Vercel. | — | revert del merge |
| 2 | Verificar versión productiva | `https://www.techrepairpro.app/version.json` **y** `https://clicmayorista.com.ar/version.json` → `commit` = SHA del merge. Sin esto, **no seguir**: los pasos 4–6 dependen del frontend nuevo. | abrir `/login?modo=registro` → pestaña «Crear cuenta», placeholder «Mínimo 8 caracteres»; `/login?error=x&error_description=prueba` → genérico | — |
| 3 | Redirect URLs exactas | **Agregar primero** (sin borrar nada): `https://www.techrepairpro.app/auth/callback`, `https://techrepairpro.app/auth/callback`, `https://clicmayorista.com.ar/auth/callback` (ya está), `https://www.clicmayorista.com.ar/auth/callback`. Guardar. **Después** quitar `https://www.techrepairpro.app/**`, `https://techrepairpro.app/**` y **`http://localhost:5173/**`**. Site URL queda `https://www.techrepairpro.app`. | recovery QA pedido desde `www` → el enlace apunta a `www…/auth/callback`; login con Google QA vuelve a `/auth/callback` | volver a agregar las entradas borradas |
| 4 | Recovery → `token_hash` | Authentication → Emails → **Reset password**: asunto `Restablecé tu contraseña — TechRepair Pro`, cuerpo = `supabase/templates/recovery.html` completo. (Opcional, decisión §16.3: **Confirm signup** = `confirmation.html`, asunto `Confirmá tu correo — TechRepair Pro`.) | Recovery QA: el enlace es `https://www.techrepairpro.app/auth/callback?token_hash=…&type=recovery` (sin `/auth/v1/verify`, sin dominio de tracking); formulario; cambiar contraseña; login con la vieja falla, con la nueva entra; reabrir el mismo enlace → «El enlace ya no es válido». Si hay M365: el click **después** del escaneo de Safe Links funciona. | pegar el texto guardado (el frontend soporta los dos formatos: rollback sin deploy) |
| 5 | Password minimum → 8 | Authentication → Providers → Email → Minimum password length = **8**. Requisitos: ninguno. **«Require current password when updating» queda OFF** (recovery lo necesita). | alta QA con 7 caracteres: la UI la frena antes del servidor; alta con 8: OK; **login de una cuenta existente con contraseña de 6–7: sigue entrando** | volver a 6 |
| 6 | Leaked Password Protection → ON | Authentication → Providers → Email (o Attack Protection) → Leaked password protection ON (si el plan lo permite, §16.5). | alta QA con una contraseña conocida filtrada (p. ej. `password123`): la UI muestra «Esta contraseña no es segura. Elegí otra que no hayas usado en otros servicios.»; recovery con la misma → mismo copy en el formulario; el advisor `auth_leaked_password_protection` desaparece | OFF |
| 7 | Security notifications | Authentication → Emails → notificaciones: **Password changed** y **Email changed** ON (copy en español opcional). | al terminar un recovery QA llega «contraseña cambiada» | OFF |
| 8 | Smokes productivos completos | Con cuentas QA (nunca clientes): alta + confirmación en otra pestaña; link de alta reusado (no cae en recovery); reenvío + 429; login sin confirmar + reenvío; recovery completo; Google nuevo y existente; invitación a un QA; **portal** `clicmayorista.com.ar`: alta, login sin confirmar → reenvío, confirmación en el mismo origen; perfil desactivado (si hay un QA inactivo); Resend → Emails: `delivered`, sin bounces nuevos; Logs → Auth: sin 500 en `/signup`, `/recover`, `/resend`, `/verify`. | — | por paso |

Dependencias que justifican el orden: 2 antes de 4–6 (el frontend nuevo tiene que estar servido para
que el usuario nunca vea el texto crudo de GoTrue ni un recovery mal clasificado); 3 antes de 4 (con
`token_hash`, un `redirect_to` rechazado degrada a la raíz — 2D lo cubre con el fallback, pero es mejor no
depender de él); 5 antes de 6 (primero la regla determinista, después la de HIBP); 7 al final (no
cambia ningún flujo). Los correos de recovery `ConfirmationURL` enviados antes del paso 4 siguen
funcionando hasta vencer (§12.2).

---

## 18. Riesgos residuales

| # | Riesgo | Tratamiento |
|---|---|---|
| 1 | GoTrue local v2.192 vs prod v2.197: formas de error y plantillas medidas en local | los clasificadores aceptan código **y** mensaje; smoke de 2E paso por paso |
| 2 | Un typo al pegar la plantilla en el Dashboard rompe todas las confirmaciones o recoveries | pegar el archivo completo; smoke inmediato; rollback sin deploy |
| 3 | `otp_expired` legacy abierto en otro dispositivo cae en la pantalla neutra (no en «recovery vencido») | es el comportamiento correcto sin evidencia; la pantalla ofrece «¿Olvidaste tu contraseña?»; desaparece cuando todos los recoveries sean `token_hash` |
| 4 | La marca de pedido de recovery dura 24 h: un alta legacy vencida abierta en ese navegador en esa ventana se nombraría «recovery vencido» | producción ya confirma altas con `token_hash` (errores con `type`); impacto: copy, ninguna capacidad |
| 5 | Enumeración en el alta (§16.1) y en `/auth/v1/recover` (infraestructura, Lote B) | decisión del owner / aceptado |
| 6 | H1: los tests `.ts` de `tests/unit` no corren en CI | lote aparte |
| 7 | H3: portal fuera de la allowlist → sesión en el origen equivocado | mantener la entrada exacta del portal en 2E |
| 8 | Bounce rate de Resend (2C) sensible a smokes contra casillas sin MX | smokes sólo con casillas reales |

## 19. Rollback de 2D

Frontend puro + config local + tests: **revert del merge**. Sin migraciones, sin cambios de producción.
El frontend de 2D funciona con la configuración productiva actual (recovery `ConfirmationURL`, mínimo 6,
HIBP OFF) y con la de 2E: el orden «deploy primero, config después» es seguro.
