# PRE-BETA-2A — DISCOVERY / AUTH & ONBOARDING CONTRACT

**Fecha:** 2026-09-27 · **Tipo:** discovery read-only · **Estado:** STOP — pendiente de revisión.

| Dato | Valor |
|---|---|
| Base canónica | `origin/main` = **`da5c58faeb33448b27834c887d315ae386535f36`** (Merge PR #152). Igual a la referencia del brief: `main` no avanzó. |
| Frontend servido en producción | `da5c58f` (`/version.json` de `www.techrepairpro.app` y de `clicmayorista.com.ar`, build 2026-09-27 21:45 UTC) |
| DB productiva | 281 migraciones, head `20261010120000` = repo (281 archivos, mismo head) |
| GoTrue productivo | **v2.197.0** (`/auth/v1/health`) |
| GoTrue local usado en las pruebas | v2.192.0 (imagen que fija la CLI 2.109.1). **Las mediciones locales pueden diferir de prod por versión.** |
| CI de `da5c58f` | run `36352881157`, 12/12 jobs verdes; el job E2E corrió **23/23 tests de auth** (email-verification 7, p0p2-invitations 6, p0p4p5 5, password-recovery 5) contra GoTrue + Mailpit reales |

Nada de producción se modificó. No se activó/desactivó Confirm Email, no se tocaron URLs, SMTP,
plantillas, Google, secrets, DNS ni Edge Functions; no hubo migraciones ni `db push`; no se creó,
borró ni autenticó ningún usuario productivo. Las consultas a prod fueron `SELECT` de catálogo y
**agregados sin PII**, más `GET /auth/v1/settings` (endpoint público) con la publishable key del
bundle servido, extraída y usada sin imprimirla. `SUPABASE_ACCESS_TOKEN`: no se usó (el brief sólo
autoriza comprobar su presencia); por eso SMTP/plantillas/URL config quedan como **MANUAL CHECK**.

### Leyenda de evidencia

| Marca | Significado |
|---|---|
| **[C]** | CONFIRMADO POR CÓDIGO (`da5c58f`) |
| **[T]** | CONFIRMADO POR TEST (CI de `da5c58f` y/o corrida local de hoy) |
| **[P]** | CONFIRMADO EN PRODUCCIÓN READ-ONLY |
| **[L]** | CONFIRMADO EN LOCAL DINÁMICO (stack aislado `prebeta2a`, GoTrue + Mailpit reales, navegador real) |
| **[M]** | NO VERIFICABLE / MANUAL CHECK REQUIRED |

La documentación histórica (`docs/email-verification-p0.md`, `docs/beta-gate-1/…`, memoria) se usó
como pista, **nunca** como prueba. Donde contradice al código, gana el código y se dice.

---

## 1. Resumen ejecutivo

**El contrato de provisioning es sólido y está verificado en producción.** No hay triggers en
`auth.users`; `provision_my_business()` es la única función que inserta en `businesses`; su cuerpo en
prod es byte-idéntico al repo; confirmar un correo no crea nada; el alta es una acción explícita,
idempotente y serializada. Recovery (BETA-GATE-1 · Lote B) sigue presente, sin regresión, y pasa en
CI y en local contra GoTrue real.

**Lo que bloquea la beta no es código de provisioning: es configuración no verificada y una
credencial pública.**

| # | Bloqueante | Sev. | Evidencia | Acción |
|---|---|---|---|---|
| **BLK-1** | **Cuenta demo del portal con contraseña pública.** `PortalLogin.tsx` hardcodea `demo@clicmayorista.com` / su contraseña (repo **público**, commit `47cf241`). En prod el usuario **existe, está confirmado, tiene contraseña, es cliente mayorista APROBADO del negocio real de Clic y además es OWNER de otro tenant** (suspendido). Las dos migraciones que lo sembraron (`seed_demo_portal_user`, `fix_demo_user_password_cost`) contienen ese literal en `schema_migrations.statements`. Último login: 2026-09-15. | P0 seguridad | [C][P]. **No verifiqué si la contraseña sigue vigente**: comprobarlo es probar la credencial y está prohibido. No hay rastro de rotación. [M] | Owner: rotar la contraseña o banear el usuario desde el Dashboard. Código: quitar las constantes demo (2B). |
| **BLK-2** | **SMTP productivo desconocido.** Si prod usa el SMTP incorporado de Supabase, los correos sólo llegan a direcciones del equipo de la organización y con cupo muy bajo: los beta testers no recibirían ni la confirmación ni el recovery. | P0 config | [M]. Señal indirecta: desde el 2026-08-23 las 6 altas por email se confirmaron en 12–32 s, compatible con entrega OK… o con que eran todas direcciones del equipo. No se puede distinguir en read-only. | Verificar (§6). Si es el incorporado: PRE-BETA-2C (Resend) antes de invitar a nadie. |
| **BLK-3** | **Contrato de plantillas no verificado, y el código depende de él.** `passwordRecovery.ts` asume que la plantilla *Confirm signup* usa `token_hash`. Si prod sigue con `{{ .ConfirmationURL }}`, **un link de alta usado dos veces o pre-abierto por un escáner de correo cae en `/reset-password` «El enlace ya no es válido… restablecer la contraseña»** (medido, §5.1), y los tokens quedan detrás del botón «atrás». La plantilla de *Reset password* usa `{{ .ConfirmationURL }}` según Lote B: un escáner (p. ej. Safe Links) la consume y el usuario real ve «vencido». | P1 | [L] medido en navegador con las dos plantillas; plantilla real de prod [M] | Verificar; PRE-BETA-2D/2E migra signup **y** recovery a `token_hash`. |

**Implementado pero falta activar/configurar:** plantillas `token_hash` para recovery (el código ya lo
soporta, verificado en navegador), SMTP propio, *Leaked password protection* (hoy **OFF** [P] por
advisor `auth_leaked_password_protection`), largo mínimo de contraseña 8, notificaciones de
seguridad.

**Realmente roto (sin condición), no bloqueante:** texto arbitrario inyectable por
`?error_description=` en `/login` y `/auth/callback`; perfil desactivado ve «problema de conexión»;
portal: login sin confirmar dice «contraseña incorrecta» y el bundle loguea el email; invitación
pendiente impide crear negocio propio; el CTA de la landing abre la pestaña de login (no la de
registro). Detalle en §9.

---

## 2. Producción vs repo/local

| Aspecto | Producción | Repo / local | Evidencia |
|---|---|---|---|
| Frontend servido | `da5c58f` (app y portal, mismo bundle de 130 chunks) | `da5c58f` | [P] |
| Migraciones | 281, head `20261010120000` | 281, mismo head; replay limpio con CLI 2.109.1 OK | [P][L] |
| Triggers en `auth.users` | **ninguno** | ninguno | [P][L][T] |
| `provision_my_business`, `accept/create/cancel_business_invitation`, `get_my_profile`, `link_profile_to_auth_user` | cuerpos **idénticos** al repo (md5 de `prosrc`; 5 de 6 sólo difieren en CRLF, normalizado = igual) | — | [P] |
| Funciones que insertan en `businesses` | sólo `provision_my_business` | ídem | [P] |
| Funciones que insertan en `profiles` | `provision_my_business`, `accept_business_invitation` | ídem | [P] |
| DML directo de `anon`/`authenticated` sobre `profiles`/`businesses`/`business_invitations` | ninguno | ídem | [P] |
| Trial | `businesses.subscription_status DEFAULT 'trialing'`, `trial_ends_at DEFAULT now()+14d` → nace con el negocio, no con el signup | ídem | [P][L] |
| Confirm Email | **ON** (`mailer_autoconfirm=false`) | ON (`enable_confirmations=true`) | [P][C] |
| Signup habilitado | sí (`disable_signup=false`) | sí | [P] |
| Proveedores | email ✅, **google ✅**, phone ❌, anónimos ❌, SAML ❌ | email ✅, google ❌ (no se puede probar local) | [P][C] |
| GoTrue | v2.197.0 | v2.192.0 | [P][L] |
| `flowType` del cliente | implícito (default de supabase-js; hay un test que falla si aparece `flowType`) | ídem | [C][T] |
| Expiración OTP / links | ≤ 1 h (el advisor `auth_otp_long_expiry` **no** aparece) | 3600 s | [P] indirecto |
| Leaked password protection | **OFF** (advisor WARN) | n/a | [P] |
| Site URL | ? | `http://localhost:5174` | [M] |
| Redirect URLs | ? (la doc histórica pide 3) | lista local exacta | [M] |
| Plantillas | ? (doc: signup = `token_hash`, recovery = `ConfirmationURL`) | **por defecto** (sin `[auth.email.template.*]`) | [M] |
| SMTP | ? | Mailpit (`[inbucket]`, deprecado) | [M][L] |
| Rate limit de correos / intervalo mínimo | ? | `email_sent=2` (sólo aplica con SMTP), `max_frequency=1s` | [M] |
| Largo mínimo / requisitos de contraseña | ? | 6 / ninguno | [M][C] |
| Secure email change / secure password change | ? | `double_confirm_changes=true` / `false` | [M] |
| Google Cloud Console (redirect URI autorizado) | ? | — | [M] |

**Datos agregados de prod [P]** (sin PII): 25 auth users, 25 confirmados, **0 sin confirmar**;
identidades: 16 sólo email, 8 sólo Google (sin contraseña), 1 email+Google. 24 profiles
(18 con `user_id NULL` = legado, resuelven por `COALESCE(user_id,id)`; 0 huérfanos sin auth user).
32 negocios: 9 sin miembros (preexistentes), 15 «Mi Negocio», 10 con onboarding incompleto,
estados `active` 9 / `suspended` 23. Invitaciones: 1 (aceptada). Mayoristas: 2.
Desde 2026-08-23: 10 altas (6 email, 4 Google), todas confirmadas; 9 negocios creados por el camino
canónico. **1 usuario Google (2026-09-07) confirmado y sin negocio**: quedó en «Creá tu taller» y no
volvió — la única señal real de abandono del funnel. **1 owner con 2 negocios.**

---

## 3. Estado de los 20 flujos

`ss` = sessionStorage, `ls` = localStorage. «Ruta final» es la que ve el usuario, no la intermedia.

| # | Flujo | Sesión · `email_confirmed_at` | Profile · Business | Ruta final | Storage temporal | Autoridad (RPC/trigger) | Riesgo de duplicación | Error visible | Evidencia · tests |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Email/password, **Confirm OFF** | sesión inmediata · seteado por autoconfirm | ninguno hasta el click | `/no-business` («Creá tu taller») → `/onboarding` | — | `provision_my_business` | nulo (lock + idempotencia) | mensaje crudo de GoTrue en errores no mapeados del registro | [C] · `wholesaleEmailConfirmation` (rama Confirm OFF). No aplica a prod hoy. |
| 2 | Email/password, **Confirm ON** | `session: null` · NULL | 0 / 0 | `/verificar-email` | `ss.trp_pending_confirmation_email` (sólo email), `ss.post_login_redirect` | ninguna | nulo: no se crea nada | — | [L] S1/S1b · [T] E2E ev#1, ev#2 |
| 3 | Registrado sin confirmar | **sin sesión posible**: login → 400 `email_not_confirmed` | 0 / 0 | `/verificar-email` en la misma pestaña; en otra pestaña/dispositivo → `/login` | `ss.trp_pending_confirmation_email` (por pestaña) | ninguna | nulo | «Tu cuenta todavía no está confirmada…» + reenvío | [L] L1 · [T] E2E ev#3, comp. A–A5 |
| 4 | Confirmación correcta | sesión nueva · NOT NULL | 0 / 0 (confirmar **no** provisiona) | `/dashboard` → guard → **`/no-business`**. La pestaña original de `/verificar-email` avanza sola. | se consume `post_login_redirect`; si no hay, `ls.trp_pending_invite` | GoTrue `/verify` | nulo | — | [L] B2/B3 (`token_hash`), D1 (`ConfirmationURL`) · [T] E2E ev#4 (con confirmación por admin API, no por link) |
| 5 | Link vencido / usado / malformado | depende | sin cambios | **`token_hash`:** con sesión confirmada → sigue; con sesión sin confirmar → `/verificar-email?estado=LINK_EXPIRED_OR_INVALID`; sin sesión → `/login?motivo=link_invalido`. **`ConfirmationURL`:** `#error_code=otp_expired` sin `type` → **`/reset-password` «El enlace ya no es válido» (copy de recovery)** | — | GoTrue `/verify` (403 `otp_expired`) | nulo | **incorrecto con plantilla por defecto** (§5.1) | [L] B4, C1, C3, E1, D3 · [T] comp. J, K, «type desconocido» |
| 6 | Reenvío | sin sesión alcanza | — | se queda en la pantalla | cooldown 60 s en UI | `auth.resend(type:'signup')` con `emailRedirectTo` canónico | nulo | 429 → estado propio «esperá unos minutos» | [L] R1–R3: el reenvío **invalida el link anterior** (C1) · [T] comp. E, F |
| 7 | Login con correo sin confirmar | 400 `email_not_confirmed` | — | `/login` con alerta + «Reenviar correo» | — | GoTrue | — | mensaje correcto, no «contraseña incorrecta» | [L] L1 · [T] E2E ev#3 |
| 8 | Login normal | sesión · NOT NULL | carga `get_my_profile` (cache en `ls`) | destino saneado (`?redirectTo` / `post_login_redirect`) o `/dashboard` | `ls` cache de perfil | `get_my_profile` | — | «Email o contraseña incorrectos», 429 mapeado | [C][T] |
| 9 | Google, usuario nuevo | sesión (implícito, `#access_token`) · NOT NULL desde el INSERT | 0 / 0 | `/no-business` → `/onboarding` | `ss.post_login_redirect` (misma pestaña: sirve) | `provision_my_business` (sin rama por proveedor) | nulo | errores de OAuth por `?error_description` (ver §9 P2-1) | [C] · [P] 4 owners Google creados así; **1 abandonado en `/no-business`** · [T] comp. D. No reproducible localmente. |
| 10 | Google, usuario existente | sesión · NOT NULL | resuelve por identidad | `/dashboard` | — | GoTrue vincula la identidad al mismo `auth.users` cuando el email coincide | nulo | — | [P] 1 usuario email+Google en la misma fila. Caso «email+password **sin confirmar** y luego Google con el mismo email»: **[M]**, no medido. |
| 11 | Google-only define contraseña | vía recovery | intacto | `/reset-password` → `/dashboard` | marca de recovery | `updateUser({password})` | — | — | [T] E2E recovery#5 (conserva identidad Google). No existe «definir contraseña» dentro de la app: sólo por «olvidé mi contraseña». [P] 8 usuarios Google-only. |
| 12 | Forgot password | sin sesión | — | mensaje neutro siempre | — | `resetPasswordForEmail(redirectTo:/auth/callback)` | — | sólo la red se reporta como error | [L] RC1–RC3 · [T] E2E rec#2, comp. L1–L4 |
| 13 | Recovery correcto | sesión de recovery | intacto | `/reset-password` (formulario) → «Contraseña actualizada» → `/dashboard` | `ss.techrepair.auth.password-recovery` = `{userId, at}` TTL 1 h, **sin tokens** | fragmento: `captureRecoveryAtBoot` + `setSession`; `token_hash`: `verifyOtp` | — | errores de `updateUser` mapeados | [L] RC5 (fragmento), **B6–B7 (`token_hash`, navegador: contraseña nueva 200, vieja 400)** · [T] E2E rec#1 |
| 14 | Recovery usado / vencido | sin sesión nueva | — | `/reset-password` estado `invalido:vencido` + «Pedir un enlace nuevo» | — | GoTrue 403/303 `otp_expired` | — | correcto | [L] RC6, T7, T9, B8, D4 · [T] E2E rec#4 |
| 15 | Recovery para email inexistente | — | — | mismo mensaje neutro | — | GoTrue 200 `{}` | — | la UI no enumera; el **endpoint** sí (existente repetido → 429, inexistente → 200) | [L] RC2/RC3 · [T] E2E rec#2. Riesgo residual de infraestructura, ya aceptado en Lote B. |
| 16 | Autenticado sin profile | sesión · NOT NULL | `get_my_profile` 0 filas → `link_profile_to_auth_user` repara un huérfano por email (candidato único, `user_id NULL`) | vinculado → producto; nada que vincular → `/no-business` (crear); vínculo ambiguo (`TRLNK`) → `/no-business` modo **reintentar, sin crear** | — | `get_my_profile`, `link_profile_to_auth_user`, `provision_my_business` | no compiten: el link corre **antes** de ofrecer el alta, y `provision` detecta el perfil reparado por `COALESCE(user_id,id)` | — | [C] · [L] P0 · [T] comp. `authProfileLinking` A–F2 · [P] 0 huérfanos |
| 17 | Profile sin business | **imposible por esquema** (`profiles.business_id` NOT NULL + FK; `provision` falla con `INCONSISTENT_PROFILE` si lo viera). Caso real equivalente: **perfil desactivado** (`is_active=false`) | profile inactivo | `/no-business` en modo AUTH_ERROR: **«No pudimos cargar tu negocio. Puede ser un problema de conexión»** + Reintentar (loop) | — | — | nulo (no ofrece crear) | **copy engañoso** (§9 P2-2) | [C] |
| 18 | Usuario con invitación pendiente (ya registrado) | sesión · NOT NULL | inserta profile `id=auth.uid()` en el negocio invitador | `/accept-invite` → «Invitación aceptada» → `/dashboard` | `ls.trp_pending_invite` (TTL 30 min, se consume) | `accept_business_invitation` (email del actor server-side, `FOR UPDATE`, rol re-validado) | nulo; owner de otro negocio → `ALREADY_MEMBER_OF_ANOTHER_BUSINESS` (fail-closed) | mensajes semánticos | [T] E2E p0p2 #1–#6, comp. `invitationsLifecycle` · [P] cuerpos idénticos |
| 19 | Invitado nuevo que tiene que registrarse | registro → sin sesión → confirma en **otra pestaña** | profile `tech` en el negocio invitador, **0 negocios propios** | `/accept-invite` → `/dashboard` | `ss.post_login_redirect` (se pierde en la pestaña nueva) + `ls.trp_pending_invite` (la rescata) | `accept_business_invitation`; `provision` bloquea con `INVITATION_PENDING` | nulo | pasados 30 min el token local vence → `/no-business` con «Tenés una invitación pendiente», que manda a `/accept-invite` **sin token** (hay que reabrir el link) | **[L] B9–B11 (navegador, correo real, `token_hash`)** · [T] E2E p0p2 #6 (sólo el rodeo por login) |
| 20 | Portal mayorista (signup/login) | signup sin sesión → confirma en `clicmayorista.com.ar/auth/callback` | **ningún tenant SaaS**; fila `wholesale_customers` `approved=false` al volver con sesión confirmada | `/` del portal → pendiente de aprobación | metadata namespaced `wholesale_registration` (slug, nunca `business_id`) | `completePendingWholesaleRegistration` + GRANT por columna + policy `wc_own_insert` | nulo (duplicado → 23505 tolerado) | **login sin confirmar → «Email o contraseña incorrectos»**, sin reenvío; sin «olvidé mi contraseña» en el portal | [C] · [P] 0 usuarios con metadata mayorista y profile · [T] comp. `wholesaleEmailConfirmation` (13), E2E ev#4c |

### Logout / session restore

- `signOut()` limpia cache de perfil, `post_login_redirect`, correo pendiente y token de invitación;
  la marca de recovery se borra con `SIGNED_OUT`. [C][T]
- `signOut()` sin `scope` usa el default de `@supabase/auth-js` (`{ scope: 'global' }`, verificado en
  `node_modules`): cerrar sesión en el celular del técnico cierra también el mostrador si comparten
  cuenta. [C] Decisión de producto, no bug.
- Arranque: `getSession()` + `onAuthStateChange`; `TOKEN_REFRESHED` no desmonta la pantalla; offline
  no vence la sesión. [T] `mobileSession1a` (20 tests).

---

## 4. Provisioning — autoridad actual

Contrato **vigente** (desde 2026-08-24, verificado hoy en el catálogo de prod):

```
INSERT auth.users           -> nada          (no hay triggers en auth.users)        [P][L][T]
UPDATE email_confirmed_at   -> nada                                                  [P][L][T]
provision_my_business()     -> businesses + profiles(owner) + trial por DEFAULT      [P][L]
accept_business_invitation  -> profiles(rol invitado) en un negocio EXISTENTE        [P][L][T]
```

Respuestas a las preguntas del brief:

| Pregunta | Respuesta |
|---|---|
| ¿Un signup sin confirmar NO crea tenant? | **Verdadero.** [L] S1b (0 profiles, 0 businesses) · [P] no hay trigger · [T] E2E ev#2, SQL `provisioning_decoupled_from_auth` A. |
| ¿La transición `email_confirmed_at NULL → NOT NULL` provisiona exactamente una vez? | **La premisa es histórica.** Hoy confirmar **no provisiona nada** (C4: confirmado, 0/0). Eso lo hacía el trigger `on_auth_user_email_confirmed`, retirado en `20260823180000`. El tenant se crea **una vez** por acción explícita: `pg_advisory_xact_lock` por usuario + devolución del perfil existente (`ALREADY_PROVISIONED`). [L] P1/P2 · guard `provisioning-concurrency`. |
| ¿Google entra por el mismo contrato? | **Sí.** La única señal es `email_confirmed_at` leído server-side; no hay rama por proveedor en DB ni en frontend. [C] · [T] `canonicalProvisioning` «Google y email convergen» · [P] 4 owners Google provisionados igual. |
| ¿Reintentos idempotentes? | **Sí.** [L] P2 (`created:false`, mismo negocio, el nombre del reintento se ignora). |
| ¿El portal mayorista no recibe un business accidental? | **Sí para altas nuevas.** El portal no llama a `provision`. [P] 0 usuarios con metadata mayorista tienen profile. La excepción es la **cuenta demo** (BLK-1), sembrada en mayo por el trigger viejo. |
| ¿Las invitaciones no crean un segundo tenant? | **Sí.** `accept` sólo inserta un profile; `provision` falla con `INVITATION_PENDING` mientras haya una vigente para ese correo. [L] B11b (0 negocios propios) · [T] E2E p0p2 #1. |
| ¿`link_profile_to_auth_user` o un recovery de owner compiten con el provisioning? | **No.** El link sólo toma perfiles con `user_id IS NULL`, email igual y candidato único, y corre antes de ofrecer el alta. Un vínculo ambiguo es AUTH_ERROR, que **nunca** ofrece crear. `bootstrap_owner_profile` y `handle_new_user` ya no existen. [C][P] |
| Trial / subscription | Nace con el negocio (DEFAULT de columna), no con el signup ni la confirmación. [P][L] P3 `trialing`. |

---

## 5. Onboarding real

| Pregunta | Respuesta |
|---|---|
| ¿Dónde termina hoy un owner nuevo confirmado? | **`/no-business`** («Creá tu taller»). No en `/onboarding` ni en `/dashboard`. [L] B2 · [T] E2E ev#4 |
| ¿Quién crea el business, y cuándo? | El usuario, con un click explícito en `/no-business` → `provisioningService.provisionMyBusiness(nombre)` → `provision_my_business`. Después de confirmar. Es el **único** llamador productivo. [C][T] |
| ¿`provision_my_business()` sigue siendo la autoridad? | Sí. [P] |
| ¿`Onboarding.tsx` es parte del signup normal? | **A medias.** Se llega sólo justo después de crear el negocio (`NoBusiness` navega a `/onboarding`). No hay guard que devuelva al wizard a quien lo dejó incompleto: si cierra la pestaña, el próximo login va a `/dashboard` y el wizard no vuelve a aparecer salvo escribiendo la URL. [C] · [P] 10 negocios con onboarding incompleto. |
| Campos obligatorios | **Nombre y rubro** (paso 1). El servidor valida sobre lo persistido al completar (`ONBOARDING_INCOMPLETE`, SQLSTATE `TRONB`). Logo, contacto y fiscal son opcionales. [C] |
| ¿Se puede recargar/cerrar y continuar? | Recargar: sí, retoma en el primer paso pendiente con datos de la DB. [T] E2E p0p4p5 #2. Cerrar y volver otro día: sólo escribiendo `/onboarding` (ver arriba). |
| ¿Email y Google terminan igual? | Sí: mismo estado (`AUTHENTICATED_WITHOUT_BUSINESS` → `/no-business`). [C][P] |
| ¿Una invitación evita el onboarding de owner? | Sí. [L] B11 · [T] E2E p0p4p5 #3 |

**Dead-ends, flashes y loops detectados**

1. **Saltos intermedios:** `/verificar-email` y `/auth/callback` navegan a `/dashboard` y el guard
   rebota a `/no-business` (spinner breve). Cosmético. [C][L]
2. **Link de alta consumido con plantilla por defecto → pantalla de recovery** (§5.1). [L]
3. **Perfil desactivado → «problema de conexión» + Reintentar para siempre.** [C]
4. **Invitación pendiente bloquea el negocio propio:** «No es para mí, quiero crear mi propio negocio»
   termina en el error `INVITATION_PENDING` hasta que la invitación venza (7 días) o la cancelen. [C]
5. **CTA de la landing:** «Probar gratis» → `/onboarding` → sin sesión → `/login` en la pestaña
   **Iniciar sesión** (no Crear cuenta) y se pierde `?plan=`. Fricción de adquisición. [C]
6. **Timeout de `/auth/callback`:** 15 s sin resolver → `/login` sin mensaje. [C]
7. No se encontraron loops de redirección: `ProtectedRoute`, `RequireEmailConfirmed`, `NoBusiness`,
   `Onboarding` y `VerifyEmail` deciden por el mismo `authState` / `emailConfirmed`. [C][T]

### 5.1 Hallazgo medido: la clasificación de `otp_expired` asume la plantilla `token_hash`

`parseRecoveryFragment` trata cualquier `#error_code=otp_expired` en `/auth/callback` como recovery,
porque «la confirmación de alta usa `token_hash`». Eso sólo es cierto si la plantilla productiva de
*Confirm signup* es la de `token_hash`. Con la plantilla por defecto, medido en navegador contra
GoTrue real:

| Caso | Resultado |
|---|---|
| D1 · link de alta `ConfirmationURL`, primer click | OK → `/no-business`, pero **`/auth/callback#access_token,refresh_token,…` queda detrás de «atrás»** |
| C1/C3/E1 · link de alta anterior al reenvío / usado / vencido | GoTrue 303 → `/auth/callback#error=access_denied&error_code=otp_expired` (sin `type`) |
| D2+D3 · escáner hace `GET` (sin JS) y después el usuario hace click | el escáner **confirma la cuenta**; el usuario aterriza en **`/reset-password` · «El enlace ya no es válido» · «Cada enlace para restablecer la contraseña sirve una sola vez»** |
| D4 · recovery `ConfirmationURL` pre-visitado por escáner | `invalido:vencido`: el usuario real no puede recuperar la cuenta con ese correo |
| B2/B4/B6/B8 · mismas pruebas con plantillas `token_hash` | correctas: el escáner no toca GoTrue (el link apunta a la app, el `POST /verify` lo hace el JS), sin tokens en la URL ni en el historial, pantallas correctas |

El mismo mecanismo (fragmento con tokens que supabase-js limpia con `location.hash = ''`) aplica al
login con **Google** (implícito): por código, el `#access_token`/`provider_token` queda en el historial.
No se pudo medir con Google real. [C]

---

## 6. Auth redirects

**Consumidores de redirect hacia GoTrue** — todos pasan por `src/lib/authRedirect.ts` [C], con guard
`guard:auth-redirect` verde [T]:

| Sitio | Llamada | Destino |
|---|---|---|
| `AuthContext.signUp` | `auth.signUp` | `getAuthCallbackUrl()` |
| `AuthContext.resendConfirmation` | `auth.resend` | `getAuthCallbackUrl()` |
| `AuthContext.signInWithGoogle` | `auth.signInWithOAuth` | `getAuthCallbackUrl()` |
| `Login` (olvidé mi contraseña) | `auth.resetPasswordForEmail` | `getAuthCallbackUrl()` |
| `portalService.registerCustomer` | `auth.signUp` | `getAuthCallbackUrl()` |
| `services/auth.ts` | `signUp` / `resetPasswordForEmail` | callback / **`getResetPasswordUrl()`** — **sin consumidores** (código muerto; su `/reset-password` no está en la allowlist) |

**Construcciones de URL fuera del helper** [C] — ninguna es un redirect de GoTrue, pero se listan:

| Archivo | Uso | Veredicto |
|---|---|---|
| `UsersManagement.tsx:296,329,480` | link de invitación con `window.location.origin` | **Mover a `getAppBaseUrl()`** (2D): en un preview de Vercel genera links al preview. |
| `subscriptionService.ts:136` | `back_url` de Mercado Pago | Fuera de alcance (billing). |
| `MiGuitaBridge.tsx`, `PersonalSettings.tsx`, `Mayorista.tsx:1263`, `PortalRouter.tsx:25` | atajos, display, detección de host | Justificado: no salen hacia auth. |
| `MiGuitaBridge.tsx:7` | fallback `https://techrepairpro.app/personal` (apex, no `www`) | Menor: un salto 307 extra. |

**Hosts que el código actual puede emitir** [C]: origen actual si está en
{`www.techrepairpro.app`, `techrepairpro.app`, `clicmayorista.com.ar`, `www.clicmayorista.com.ar`}
o es localhost; si no, `VITE_APP_URL` si está permitido; si no, `https://www.techrepairpro.app`.
Medido hoy [P]: `techrepairpro.app/auth/callback` → 307 `www`; `www.clicmayorista.com.ar` → 307 apex;
`www.techrepairpro.app` y `clicmayorista.com.ar` → 200. Un preview de Vercel cae al canónico `www`.

**Allowlist productiva requerida** (sin comodines):

| Campo | Valor recomendado |
|---|---|
| **Site URL** | `https://www.techrepairpro.app` — medido [L] X1/X2: con un `redirect_to` no permitido, GoTrue cae a la **raíz** del Site URL. Con plantillas `token_hash`, eso deja el token en `/` donde nadie lo procesa (ver 2D-3). |
| **Redirect URLs** | `https://www.techrepairpro.app/auth/callback` (obligatorio) · `https://clicmayorista.com.ar/auth/callback` (obligatorio, portal) · `https://techrepairpro.app/auth/callback` (defensivo) · `https://www.clicmayorista.com.ar/auth/callback` (defensivo). **Nada de `localhost` ni comodines en prod.** |
| **OAuth callback** (Google Cloud Console → Authorized redirect URIs) | `https://<project-ref>.supabase.co/auth/v1/callback` — es el callback de GoTrue, no de la app. [M] |
| **Email callback** (confirmación) | `/auth/callback` del origen permitido (`{{ .RedirectTo }}`) |
| **Recovery callback** | el mismo `/auth/callback` (hoy fragmento; propuesto `token_hash`) |

**Open redirect y sanitización:** `sanitizeInternalPath` cubre `?redirectTo=` y `post_login_redirect`
(rechaza absolutas, `//`, `/\`, backslashes, control chars, `%2f%2f` decodificado y rutas de auth) —
[T] unit `authRedirect` + comp. M/M2. **Falla aparte (no es open redirect):** `/login` y
`/auth/callback` pintan `?error_description=` tal cual → texto arbitrario en una alerta del dominio
oficial (§9 P2-1).

---

## 7. Plantillas de correo

| Plantilla | Uso real hoy | Mecanismo recomendado | Por qué |
|---|---|---|---|
| **Confirm signup** | sí | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup` | Es lo que el código asume (§5.1). Cross-device, sin tokens en la URL, inmune a escáneres. `type=email` también funciona con `verifyOtp` [L] T5. |
| **Reset password** | sí | **migrar a** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` | `AuthCallback` ya lo soporta: [L] B5–B8 en navegador (formulario, contraseña nueva 200 / vieja 400, link usado → `vencido`). Elimina la pre-visita de escáneres y los tokens en fragmento. La captura de fragmento de Lote B se conserva para los correos viejos en vuelo → **cambio sin ventana**. |
| **Invite user** | **no** (las invitaciones son tokens propios compartidos por link; no se llama a `inviteUserByEmail`) | dejar, con copy en español; **no usar «Invite user» del Dashboard** | Con la plantilla por defecto el invitado entraría por el camino implícito con sesión pero **sin contraseña y sin negocio** (terminaría en «Creá tu taller», no en el negocio que lo invitó). Con `token_hash`, `AuthCallback` no acepta `type=invite` → «link inválido». [C] |
| **Change email address** | **no** hay UI (`updateUser({email})` no existe) | dejar por defecto; exigir *Secure email change* ON [M] | Un usuario igual puede llamar al endpoint con su sesión; `provision`/`accept` leen el email server-side al momento de la llamada. |
| **Magic link / OTP** | **no** (`signInWithOtp` no existe) | dejar por defecto, con copy en español | El proveedor email los habilita igual; el `ConfirmationURL` por defecto funciona por el camino implícito. |
| **Reauthentication** | no | — | `secure_password_change` [M] |
| **Notificaciones de seguridad** (contraseña/email cambiado, identidad vinculada) | [M] | **activar** «contraseña cambiada» y «email cambiado» con SMTP propio | Detección temprana de toma de cuenta. |

**Recomendación:** sí, PRE-BETA-2 debe migrar **también Recovery** a `token_hash`. Condiciones: SMTP
propio con **tracking de links OFF**, allowlist exacta (si no, `.RedirectTo` degrada a la raíz del
Site URL), y el fix de clasificación de 2D-1 desplegado antes. **No cambiar plantillas en este lote.**

**Tests necesarios para el cambio:** E2E con plantillas `token_hash` en el `config.toml` local
(signup y recovery reales por correo), «escáner hace GET y después click», «link de alta usado no cae
en recovery», e invitación con confirmación en otra pestaña (lo que se midió a mano en B/D).

---

## 8. SMTP

### 8.1 Estado productivo — MANUAL CHECK REQUIRED

No se puede leer con las credenciales permitidas. Ruta en el Dashboard del proyecto productivo:

1. **Authentication → Emails → SMTP Settings** (en UIs anteriores: *Project Settings → Authentication
   → SMTP Settings*): «Enable Custom SMTP», **sender email**, **sender name**, **host**, **port**,
   **username**. **No copiar el password.**
2. **Authentication → Rate Limits**: «Rate limit for sending emails» (por hora).
3. **Authentication → Emails → Templates**: pegar en el informe el **texto** de *Confirm signup* y
   *Reset password* (no contiene secretos).
4. **Authentication → URL Configuration**: Site URL y Redirect URLs.
5. **Authentication → Sign In / Providers → Email**: Confirm email, Secure email change, Secure
   password change, largo mínimo y requisitos de contraseña, intervalo mínimo entre correos,
   expiración del OTP; **Leaked password protection** (hoy OFF según advisor).
6. **Google Cloud Console → Credentials → OAuth client**: redirect URIs autorizados.

Si Custom SMTP está **apagado** → BLK-2 confirmado: el SMTP incorporado sólo entrega a miembros del
equipo y con cupo mínimo. **No usar Gmail personal como SMTP productivo.**

### 8.2 Arquitectura objetivo (PRE-BETA-2C)

`Supabase Auth → Custom SMTP → Resend → dominio propio`

| Ítem | Propuesta |
|---|---|
| Dominio emisor | **subdominio dedicado** `mail.techrepairpro.app` (aísla la reputación del dominio raíz y no toca el MX de la casilla humana) |
| Sender | `TechRepair Pro <no-reply@mail.techrepairpro.app>`; Reply-To a una casilla de soporte real |
| SMTP en Supabase | host `smtp.resend.com`, puerto 465 (TLS) o 587 (STARTTLS), usuario `resend`, password = API key de Resend **con permiso sólo de envío y sólo para ese dominio**. Se carga en el Dashboard; nunca en el repo. |
| SPF / return-path | los registros que indique Resend al verificar el dominio (hoy: MX + TXT SPF en un subdominio de rebote tipo `send.mail…`). Copiarlos de la UI de Resend, no de esta tabla. |
| DKIM | el TXT `resend._domainkey…` que genera Resend |
| DMARC | `_dmarc.techrepairpro.app` → `v=DMARC1; p=none; rua=mailto:<casilla-reportes>; adkim=r; aspf=r` durante la beta; pasar a `p=quarantine` tras 2–4 semanas de reportes limpios |
| Tracking | **clicks y aperturas OFF** en Resend: el tracking reescribe los links y agrega un salto que rompe o expone los tokens |
| Rate limits beta | correos de Auth: ~100/h (holgado para decenas de testers, bajo como freno de abuso); intervalo mínimo por usuario 60 s (coincide con el cooldown de la UI); dejar `sign_in_sign_ups` / `token_verifications` en default. CAPTCHA (Turnstile) queda como mejora posterior. |
| Branding | plantillas en español, sin imágenes remotas, texto plano alternativo |

### 8.3 Prueba de deliverability (con cuentas QA, nunca clientes)

1. Verificar el dominio en Resend (SPF/DKIM verdes) y esperar propagación.
2. Signup + reenvío + recovery hacia una lista semilla: Gmail, Outlook/Hotmail, Yahoo, iCloud y una
   casilla **Microsoft 365 con Defender/Safe Links** (el caso de escáner).
3. En cada correo: `Authentication-Results` con SPF/DKIM/DMARC = pass, bandeja (no spam), latencia,
   link funcional; en M365, que el click **después** del escaneo siga funcionando (valida `token_hash`).
4. Puntaje ≥ 9/10 en un verificador tipo mail-tester.
5. Probar el 429 (dos pedidos seguidos) y que la UI siga neutra.
6. Rollback listo: apagar Custom SMTP vuelve al incorporado (sólo sirve para el equipo).

---

## 9. Recovery — revalidación de BETA-GATE-1 · Lote B

Todo presente en `da5c58f` y en el bundle servido (marcadores `techrepair.auth.password-recovery`,
`token_hash`, sin `flowType:"pkce"`). [C][P][T]

| Punto | Resultado |
|---|---|
| Fragmento/tokens retirados de la URL (recovery) | Sí: `replaceState` antes de `createClient`. [T] E2E rec#1 · [L] B6 (`token_in_url:false`) |
| Tokens en logs o sessionStorage manual | No: la marca es `{userId, at}`; [L] B7c sessionStorage vacío tras terminar y sin JWT · [T] unit «no loguea» |
| Marca asociada al mismo usuario | Sí [T] comp. R4 |
| TTL | 1 h (`RECOVERY_MARKER_TTL_MS`) [C] |
| Entrada directa a `/reset-password` | `invalido:sin_sesion`; con sesión normal tampoco hay formulario [T] E2E rec#3 |
| Link usado / vencido | `invalido:vencido` [T][L] |
| Usuario Google-only | puede definir contraseña y conserva la identidad [T] E2E rec#5 |
| Anti-enumeración de la UI | mensaje neutro para inexistente y 429 [T][L] |
| Doble submit | ref + botón deshabilitado, un solo `updateUser` [T] comp. R10 |
| Límite bcrypt | 72 **bytes** UTF-8 validados en reset [T] unit/comp. — **el registro no lo valida** (§10 P3-4) |
| Session handling | éxito → `/dashboard` con sesión, `/login` sin sesión; `SIGNED_OUT` borra la marca [T] |

**Qué depende todavía de config productiva:** que `https://www.techrepairpro.app/auth/callback` esté en
la allowlist [M]; el texto de la plantilla [M]; que el SMTP entregue [M]; el rate limit [M].

---

## 10. Deuda y fallas no bloqueantes

| ID | Hallazgo | Sev. | Evidencia | Etapa |
|---|---|---|---|---|
| P2-1 | `Login.tsx` y `AuthCallback.tsx` muestran `?error_description=` crudo: cualquiera puede armar `https://www.techrepairpro.app/login?error=x&error_description=<texto>` y el dominio oficial lo muestra como alerta (phishing por inyección de contenido; React escapa, no hay XSS). | P2 | [C] | 2D |
| P2-2 | Perfil desactivado → pantalla de «problema de conexión» + Reintentar en loop (`profileErrorKind='inactive'` cae en AUTH_ERROR y `NoBusiness` no usa `profileError`). | P2 | [C] | 2D |
| P2-3 | Portal: login de usuario sin confirmar → «Email o contraseña incorrectos», sin reenvío; sin «olvidé mi contraseña» en el dominio del portal. | P2 | [C] | 2D (o post-beta si el portal queda fuera de la beta) |
| P2-4 | `.RedirectTo` fuera de allowlist degrada a la raíz del Site URL; con `token_hash` el token quedaría en `/` sin procesar. | P2 | [L] X1/X2 | 2D (fallback: `/` con `token_hash` → reenviar a `/auth/callback`) |
| P3-1 | Invitación pendiente bloquea crear negocio propio («No es para mí…» termina en error). | P3 | [C] | post-beta |
| P3-2 | CTA de la landing abre la pestaña de login y pierde `?plan=`. | P3 | [C] | 2D |
| P3-3 | `loginCustomer` hace `console.log` del email y del auth user id en producción (está en el bundle servido). | P3 | [C][P] | 2B |
| P3-4 | Contraseña: registro y portal aceptan 6 caracteres; reset exige 8 y ≤ 72 bytes. Alinear en UI y en la config de prod (8). | P3 | [C] · prod [M] | 2D/2E |
| P3-5 | Registro de un email ya confirmado: GoTrue local responde **422 `user_already_exists`** y la UI dice «Este email ya tiene una cuenta» (enumeración por registro). La memoria dice que prod respondía 200 sin correo; no re-verificado. | P3 | [L] E3 · prod [M] | aceptar o decidir |
| P3-6 | `wc_own_insert` no restringe `business_id` a negocios con portal: un usuario autenticado puede dejar una solicitud `approved=false` en cualquier negocio. | P3 | [P] policy | post-beta |
| P3-7 | Links de invitación con `window.location.origin`. | P3 | [C] | 2D |
| P3-8 | `services/auth.ts` sin consumidores, con un redirect a `/reset-password` fuera de la allowlist. | P3 | [C] | 2D (borrar) |
| P3-9 | Comentario de `AuthCallback` habla de «OAuth PKCE `?code=`»; el cliente es implícito (Google vuelve por fragmento). | P4 | [C] | 2D |
| P3-10 | El registro muestra el mensaje crudo de GoTrue en errores no mapeados (inglés). | P4 | [C] | 2D |
| P3-11 | Wizard de onboarding de una sola oportunidad (no hay reentrada si se abandona). | P3 | [C][P] 10 incompletos | post-beta / FIRST-STEPS |
| P3-12 | `[inbucket]` deprecado (§12). | P4 | [L] | 2D |

---

## 11. Matriz final de tests (beta)

Nivel: U = unit (`node --test`), C = componente (vitest, Supabase mockeado), S = SQL, E = E2E Playwright
contra GoTrue + Mailpit locales reales (CI job «E2E Smoke Tests»). «Admin-confirm» = el test confirma
con la admin API en vez de hacer click en el correo.

| Área | Caso | Test actual | Nivel | Sim. / real | ¿Alcanza? | Falta |
|---|---|---|---|---|---|---|
| EMAIL SIGNUP | signup → `/verificar-email` sin sesión | E2E ev#1; C A–A5 | E, C | real | sí | — |
| | sin confirmar no provisiona | E2E ev#2; S `provisioning_decoupled_from_auth` A | E, S | real | sí | — |
| | registro repetido / email existente | — | — | — | **no** | C: mapeo de 422 y del 200 ofuscado |
| EMAIL CONFIRMATION | click real en el correo → sesión → `/no-business` | E2E ev#4 (**admin-confirm**) | E | parcial | **no** | **E: click real con plantilla `token_hash` en otra pestaña** (medido a mano: B2) |
| | link usado / vencido / pre-visitado | C J, K (mock) | C | simulado | **no** | **E: usado y «escáner»; y que un link de alta nunca termine en recovery** (hoy fallaría con plantilla por defecto: D3) |
| | reenvío invalida el anterior | C E/F (mock) | C | simulado | parcial | E: reenvío real + link viejo → pantalla correcta |
| LOGIN | sin confirmar → mensaje + reenvío | E2E ev#3 | E | real | sí | — |
| | normal / `redirectTo` saneado | U `authRedirect`; C M/M2 | U, C | simulado | sí | — |
| | `error_description` no se pinta crudo | — | — | — | **no** | C (tras el fix P2-1) |
| GOOGLE AUTH | Google llega confirmado, no ve verificación | C D; C `canonicalProvisioning` | C | simulado | aceptable | smoke humano en prod con cuenta QA de Google (no automatizable localmente) |
| | Google-only define contraseña | E2E rec#5 | E | real (identidad sembrada) | sí | — |
| PASSWORD RECOVERY | recovery fragmento completo, sin tokens en URL | E2E rec#1 | E | real | sí | — |
| | recovery `token_hash` | C A1/A2 (mock) | C | simulado | **no** | **E con plantilla candidata** (medido a mano: B5–B8) |
| | anti-enumeración, entrada directa, links rotos | E2E rec#2–#4; C R1–R16, L1–L5; U 25 | E, C, U | real | sí | — |
| INVITATIONS | aceptar, email ajeno, owner de otro negocio, idempotencia, token tras login | E2E p0p2 #1–#6; S `p0p2_business_invitations`; C 24 | E, S, C | real | sí | **E: invitado nuevo → registro → confirmación por correo en otra pestaña** (medido a mano: B9–B11) |
| ONBOARDING | owner nuevo → `/no-business` → onboarding → dashboard, 1 negocio | E2E ev#4b, p0p4p5 #1 | E | real | sí | — |
| | recarga conserva; invitado no pasa; AUTH_ERROR no crea | E2E p0p4p5 #2, #3, #5; C 21 | E, C | real | sí | C: perfil inactivo (tras P2-2) |
| | concurrencia / idempotencia del alta | guard `provisioning-concurrency`; S `canonical_owner_provisioning` | S | real | sí | — |
| PORTAL MAYORISTA | alta diferida, slug, sin tenant SaaS | C `wholesaleEmailConfirmation` (13); E2E ev#4c | C, E | mixto | aceptable | C: login sin confirmar (tras P2-3); smoke humano en `clicmayorista.com.ar` |
| LOGOUT / SESSION RESTORE | limpieza de estado, offline no vence sesión | C `mobileSession1a` (20); C `emailVerification` | C | simulado | aceptable | — |

**Corrido hoy** [T]: unit auth 58/58; vitest 8 suites de auth 149/149; guards `auth-redirect`,
`onboarding-canonical`, `provisioning-authority`, `mobile-session-1a` (normal + self-test) 8/8.
CI `da5c58f`: E2E 23/23 de auth (183 passed, 1 flaky ajeno).

---

## 12. Supabase local: `[inbucket]` → `[local_smtp]`

- La CLI 2.109.1 (la que fija CI) avisa `WARN: config section [inbucket] is deprecated. Please use
  [local_smtp] instead.` [L] y un `supabase init` fresco genera `[local_smtp]` con **las mismas
  claves** (`enabled`, `port`, `smtp_port`, `pop3_port`, `admin_email`, `sender_name`). [L]
- El contenedor sigue llamándose `supabase_inbucket_<project>` y la API es Mailpit. [L]
- **Impacto:** `tests/e2e/m7/password-recovery.spec.ts:37` parsea `^\[inbucket\]` para sacar el puerto;
  renombrar la sección sin tocar el spec rompe los 5 tests de recovery (tira «config.toml no declara
  [inbucket] port»). Además comentarios en `config.toml`, `ci-local.mjs` y specs.
- **Propuesta (2D, no ahora):** renombrar la sección, hacer que el spec acepte las dos
  (`/^\[(local_smtp|inbucket)\]/m`), y verificar la CLI de cada máquina de desarrollo (una CLI vieja
  podría no conocer `[local_smtp]`). En el mismo PR: agregar al `config.toml` local las plantillas
  `token_hash` como archivos versionados (`supabase/templates/*.html`) — así el stack local reproduce
  el contrato productivo y el E2E puede hacer click en el correo real.

---

## 13. Plan PRE-BETA-2B / 2C / 2D / 2E

| Etapa | Contenido | Riesgo | Rollback |
|---|---|---|---|
| **2B · Contención + auditoría de config** (prod primero, casi sin código) | (1) Owner: rotar contraseña o banear la cuenta demo del portal (BLK-1). (2) PR chico: quitar `DEMO_EMAIL/DEMO_PASSWORD` de `PortalLogin.tsx` y los `console.log` de `loginCustomer` (logger). (3) Owner completa la tabla de §8.1 (valores sin secretos + texto de plantillas) y se anexa a este informe. | Bajo. Banear al demo puede cortar una demo comercial en curso. | Desbanear / nueva contraseña. Revert del PR. |
| **2C · SMTP propio (Resend)** (sólo config) | Dominio `mail.techrepairpro.app` verificado (SPF/DKIM/DMARC `p=none`), tracking OFF, Custom SMTP en Supabase, rate limits de §8.2, deliverability de §8.3 con cuentas QA. | Medio: un DNS mal cargado manda a spam o bloquea el envío; mientras tanto el signup devuelve 500 si el SMTP falla (medido en CI: sin mailer, signup 500). Hacerlo en horario sin signups. | Apagar Custom SMTP (vuelve al incorporado). DNS: los registros nuevos no afectan al dominio raíz. |
| **2D · Contrato de links en el repo** (código + config local + tests; prod de Auth intacta) | (1) Clasificación de `otp_expired` sin `type`: no asumir recovery (copy neutro «el enlace venció o ya se usó», con salidas a login y a pedir otro). (2) P2-1 `error_description` → enum de mensajes. (3) `/` con `token_hash` → reenviar a `/auth/callback` (P2-4). (4) Links de invitación por `getAppBaseUrl()`; borrar `services/auth.ts`. (5) Contraseña mínima 8 y ≤ 72 bytes en registro y portal. (6) Copy de perfil inactivo. (7) Portal: mapear `email_not_confirmed` + reenvío. (8) CTA de landing → pestaña de registro + `?plan`. (9) `[local_smtp]` + plantillas `token_hash` versionadas en `config.toml` local. (10) E2E nuevos de §11 (click real, usado, escáner, recovery `token_hash`, invitación cross-tab). **Desplegar frontend antes de 2E**: es compatible con las dos plantillas. | Bajo-medio: toca `AuthCallback`/`passwordRecovery`, rutas críticas; lo cubre E2E real. | Revert del merge (frontend puro; sin migraciones). |
| **2E · Rollout de config Auth productiva + smoke** | Con 2C y 2D en prod: pegar plantillas `token_hash` (signup y recovery; resto con copy en español), confirmar Site URL/Redirect URLs de §6, largo mínimo 8, Leaked password protection ON, notificaciones de seguridad, Secure email change ON. Smoke humano con cuentas QA en Gmail y M365: signup, doble click, escáner, reenvío, recovery, invitación, Google, portal. Recién entonces invitar beta testers. | Medio: un typo en la plantilla rompe **todas** las confirmaciones. Mitigación: probar primero con una cuenta QA inmediatamente después de pegar cada plantilla. | Guardar el texto anterior de cada plantilla en 2B y restaurarlo; el frontend de 2D soporta ambos formatos, así que el rollback no requiere deploy. |

**Orden estricto:** 2B → 2C → 2D (deploy) → 2E. 2C y 2D pueden avanzar en paralelo; 2E necesita las dos.

---

## 14. Anexo — reproducción local (stack aislado)

- Worktree `claude/pre-beta-2a-auth-discovery` sobre `da5c58f`. `config.toml` modificado **sólo
  temporalmente**: `project_id = "prebeta2a"`, puertos 5432x, redirects de `:5184`. Arranque mínimo:
  `supabase start -x studio,imgproxy,storage-api,edge-runtime,logflare,vector,postgres-meta,supavisor,realtime`
  (db + GoTrue + Kong + PostgREST + Mailpit). App: Vite en `:5184` con un `.env.pb2a.local` temporal.
- Fase 1: plantillas por defecto (S*, L1, R*, C*, P*, E*, X*, RC*, D*). Fase 2: plantillas candidatas
  `token_hash` en `supabase/templates/` temporales (T*, B*).
- Usuarios QA efímeros `qa-pb2a-*@example.test`, borrados al final (0 restantes). Los scripts de
  sonda quedaron en el scratchpad de la sesión, fuera del repo.
- Al terminar: `supabase stop --project-id prebeta2a --no-backup` (0 contenedores, 0 volúmenes),
  `config.toml` restaurado con `git checkout`, archivos temporales borrados. Los stacks de otras
  sesiones (`techrepair-vite`, `techrepair-mobile2a-expand`) no se tocaron. Disco C: sin cambios.
