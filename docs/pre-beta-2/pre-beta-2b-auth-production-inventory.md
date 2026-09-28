# PRE-BETA-2B — Contención de credenciales + Auth Production Inventory

**Fecha:** 2026-09-27/28 · **Estado:** **CLOSED** (condición de cierre cumplida, §C). El PR
[molinajonyy-hub/TechRepair-Pro#153](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/153) sigue
en **DRAFT — NO MERGE** hasta la revisión del owner. **No** se configuró SMTP/Resend, **no** se tocaron
plantillas, URLs, DNS, Google ni Confirm Email, y **no** se desplegó nada.

| Dato | Valor |
|---|---|
| Base | `origin/main` = `da5c58faeb33448b27834c887d315ae386535f36` (sin commits nuevos desde el cierre de 2A: nada que comparar en Auth/portal/login/signup/recovery/onboarding/config/provisioning) |
| Rama | `claude/pre-beta-2b-auth-inventory` |
| Commits | `38d02a4` docs 2A (sólo el informe) · `cf930a8` fix credencial demo + guard + tests · `737e576` primera versión de este informe · fix del step de CI (§H.2) · esta actualización |
| Informe previo | `docs/pre-beta-2/pre-beta-2a-discovery.md` |

### Etiquetas

| Etiqueta | Significado |
|---|---|
| **CONFIRMADO EN DASHBOARD** | valor del Dashboard de Supabase / panel de Resend **reportado por el owner** el 2026-09-28 (no lo leí yo) |
| **CONFIRMADO EN PROD** | medido read-only contra producción (endpoints públicos de GoTrue, catálogo/agregados SQL, DNS público) |
| **CONFIRMADO POR CÓDIGO** | `da5c58f` + los commits de esta rama |
| **CONFIRMADO POR TEST** | corrido en esta rama (§H) o en el CI de `da5c58f` |
| **MANUAL ACTION PENDING** | requiere al owner |

La contraseña demo **no** aparece en este documento, en los mensajes de commit, en el guard, en los
tests ni en logs. Ver §A.7 para las dos excepciones inevitables y cómo se trataron.

---

## A. Contención BLK-1

### A.1 Causa

`src/portal/pages/PortalLogin.tsx` (commit `47cf241`, 2026-05-08, «usuario demo + botón 'Ingresar
como demo' en dev») declaraba `DEMO_EMAIL` y `DEMO_PASSWORD` como literales y un botón «Ingresar como
demo» visible sólo con `import.meta.env.DEV`. La misma cuenta se sembró en producción con las
migraciones remotas `seed_demo_portal_user` y `fix_demo_user_password_cost`. **CONFIRMADO POR CÓDIGO /
EN PROD**

### A.2 Exposición

| Canal | Estado |
|---|---|
| Código fuente (repo **público**) | expuesto desde `47cf241`. Sale de `main` con el merge de #153. **Queda en la historia de git** (la decisión vigente del owner, Lote D, es no reescribir historia) → la credencial se trata como **quemada**. |
| Bundle servido | el literal **no** estaba en el bundle productivo (el bloque `DEV` se elimina en el build): verificado en 2A sobre lo servido y en esta rama sobre un build de producción. |
| DB productiva | `supabase_migrations.schema_migrations.statements` de esas dos migraciones contiene el literal. Ese esquema no está expuesto por la API; lo leen roles de administración. |

### A.3 Superficie en producción antes de la contención — CONFIRMADO EN PROD

| Aspecto | Valor (2026-09-27) |
|---|---|
| Cuenta | `demo@clicmayorista.com` (email ya público en el código; 1 sola cuenta) |
| Identidades | sólo `email`; confirmada; contraseña seteada; sin MFA; no SSO; no anónima |
| Sesiones | 0 sesiones y 0 refresh tokens activos |
| Último sign-in de Auth | 2026-09-15 14:02 UTC (origen desconocido: los logs de Auth retienen 1 día) |
| Portal mayorista | 1 fila en el negocio **real de Clic**: aprobada, no suspendida, último login de portal 2026-08-24, 0 pedidos |
| Membresía SaaS | owner activo de un tenant «Mi Negocio» **suspendido**, sin otros miembros, **con datos** (11 órdenes, 17 clientes, 11 productos, 3 comprobantes; contenido no inspeccionado) |
| Otras cuentas con «demo» en el email | 3, no relacionadas con esta credencial (§A.8) |

### A.4 Acción manual del owner — **REALIZADA**

El owner baneó la cuenta desde **Authentication → Users → Ban user** con la duración máxima que
ofrece el panel. Nada se borró.

### A.5 Verificación read-only del ban — CONFIRMADO EN PROD (2026-09-28)

| Chequeo | Resultado |
|---|---|
| `banned_until` | **2027-09-28 10:25:23 UTC** (seteado 2026-09-28 10:25:23 UTC) → **ban vigente** |
| Sesiones | **0** |
| Refresh tokens (total / no revocados) | **0 / 0** |
| Usuario borrado | no (`deleted_at` NULL) |
| Profile owner, fila mayorista, tenant y sus datos | intactos (11 órdenes, 17 clientes) |
| Último sign-in | sin cambios (2026-09-15): no hubo logins nuevos |

GoTrue rechaza el login y el refresh de un usuario con `banned_until` en el futuro, y no queda ningún
token vigente. La fila mayorista sigue `approved`/no suspendida (el paso opcional de suspenderla no
se hizo); no es explotable mientras el ban esté vigente, porque el login del portal pasa primero por
GoTrue.

**Residual con fecha — MANUAL ACTION PENDING (no urgente):** la «duración máxima» del panel resultó
ser **1 año**, no los ~100 años de la API. **El ban vence el 2027-09-28** y, como la contraseña está
en la historia pública, la cuenta volvería a ser usable. Antes de esa fecha, el owner elige una:

- extender el ban: `update auth.users set banned_until = now() + interval '100 years' where email = 'demo@clicmayorista.com';` (SQL Editor);
- o, además, cambiar la contraseña por una aleatoria que nadie conozca (Admin API `updateUserById`);
- o dar de baja la cuenta cuando se decida qué hacer con los datos del tenant «Mi Negocio».

### A.6 Fix en el repo — CONFIRMADO POR CÓDIGO (`cf930a8`)

- `PortalLogin.tsx`: eliminadas las constantes demo, `handleDemo`, el estado `demoLoading`, el
  bloque «Modo Dev / Ingresar como demo» y el icono que sólo usaba ese bloque. El único camino es el
  formulario con lo que tipea el usuario (`doLogin(email, password)`). −48/+2 líneas, sin CRLF.
- Sin reemplazo por otra credencial ni texto de ayuda.
- **Bundle**: build de producción de esta rama → 133 archivos revisados, **0** con el literal viejo
  (comparado en memoria contra la versión de `da5c58f`, sin imprimirlo), 0 con `demo@clicmayorista`,
  0 con los identificadores demo, 0 con el botón. **CONFIRMADO POR TEST**

### A.7 Guard permanente — `scripts/guards/no-hardcoded-credentials.mjs`

**Alcance:** `src/**/*.{ts,tsx}`, el bundle del navegador. Tests y scripts quedan fuera a propósito:
usan contraseñas de usuarios QA efímeros del stack local.

| Regla | Detecta |
|---|---|
| R1 `declaracion-credencial` | `const/let/var` con nombre de credencial (`password`, `secret`, `apiKey`, `accessToken`, `privateKey`, `clientSecret`, …) inicializada con un literal no vacío. Excluye nombres descriptivos (`*_KEY` de storage, `*_LENGTH`, `*_LABEL`, …) salvo que el nombre sea en sí una credencial (`API_KEY`, `SECRET_KEY`). |
| R2 `identificador-demo` | `DEMO_PASSWORD`, `demoEmail`, `DEFAULT_PASSWORD`, `testPassword`, `fallbackToken`, … |
| R3 `literal-en-login` | `signInWithPassword`, `signUp`, `updateUser`, `loginCustomer`, `doLogin`, `signIn`, `registerCustomer`, `resetPasswordForEmail` que reciben contraseña o email como literal (en objeto o posicional). |
| R4 `cuenta-demo` | cualquier `demo@…` en `src/`, incluso en comentarios. |

- **Nunca imprime el valor**: sólo archivo, línea, regla e identificador (lo verifica el self-test).
- **Sin regla por hash del valor conocido**, a propósito: el SHA-256 de una contraseña corta se
  revierte con un diccionario, así que publicarlo equivaldría a republicarla.
- **Falsos positivos:** 0 sobre todo `src/` actual. El self-test incluye las formas reales del repo
  que parecían sospechosas (mapa de etiquetas de `DeviceLockCard`, `autoComplete`, claves de storage
  como `RECOVERY_MARKER_KEY`, `PASSWORD_MIN_LENGTH`, templates dinámicos).
- **Dónde corre:** `npm run guard:no-hardcoded-credentials[:self-test]`, en la cadena `npm run guards`
  y como step propio del job `quality` de CI (self-test + guard + test de componente de `PortalLogin`).

**Pruebas y controles negativos — CONFIRMADO POR TEST**

| Prueba | Resultado |
|---|---|
| Self-test: 22 casos en memoria (10 positivos, 12 negativos, «la salida no filtra el valor») + **control negativo por el CLI real** (árbol temporal con una credencial sintética → exit 1 sin filtrarla; árbol limpio → exit 0) | OK |
| `tests/unit/noHardcodedCredentials.test.ts` C1–C5 (mismos controles por archivo, `src/` real limpio, `PortalLogin` sin rama `DEV`) — corre con `npm run test:unit` | 5/5 |
| `tests/components/portalLoginNoDemo.test.tsx` B1–B5: con `DEV = true`, sin atajo demo ni cuenta; el login manda exactamente lo tipeado + el negocio del portal; aprobado → catálogo, pendiente → pendiente, suspendido → suspendido; error visible; bloqueado mientras carga | 5/5 |
| **Control negativo con el `PortalLogin` original** (repuesto temporalmente desde `HEAD~1`): guard → exit 1 con 6 hallazgos (R1, R2 ×4, R4) sin imprimir el valor; componente B1 → **falla**; unit C4/C5 → **fallan**. Restaurado → todo verde. | OK |

### A.8 Riesgo residual

| Riesgo | Tratamiento |
|---|---|
| El ban vence el **2027-09-28** | §A.5: extender o rotar antes de esa fecha. |
| La contraseña sigue en la historia pública de git y en `schema_migrations.statements` de prod | Irreversible sin reescribir historia (descartado por el owner). Mitigado por el ban. |
| El diff de `cf930a8`, como cualquier diff de borrado, muestra la línea eliminada | Inevitable; el valor ya estaba en la historia pública desde `47cf241`. El mensaje del commit no lo contiene. |
| Durante la sesión de 2B, una lectura de `PortalLogin.tsx` mostró la línea en la salida interna de la herramienta | No se copió a ningún archivo, commit, log ni informe; después se trabajó con scripts por patrón que no repiten el valor. |
| Otras 3 cuentas con «demo» en el email | Sus contraseñas no aparecen en el repo. Revisar en un lote aparte si siguen haciendo falta. |
| `loginCustomer` hace `console.log` del email (P3-3 de 2A) | Fuera del alcance acotado de 2B; queda para 2D. |

---

## B. Production Auth Inventory

`SUPABASE_ACCESS_TOKEN`: **no presente** (ni variable de entorno ni archivo de la CLI; sólo se
comprobó la presencia). Los valores del Dashboard los reportó el owner; donde había medición propia
se cruzaron y **coinciden en todos los casos**.

### B.1 General / URL Configuration

| Campo | Valor | Etiqueta |
|---|---|---|
| **Site URL** | `https://www.techrepairpro.app` | CONFIRMADO EN DASHBOARD (coincide con el indicio de `auth.flow_state`) |
| **Redirect URLs** | `https://www.techrepairpro.app/**` · `https://techrepairpro.app/**` · `http://localhost:5173/**` · `https://clicmayorista.com.ar/auth/callback` | CONFIRMADO EN DASHBOARD |

**Clasificación contra el contrato de `src/lib/authRedirect.ts`:**

| Entrada | Emitida por el código | Clasificación | Por qué |
|---|---|---|---|
| `https://www.techrepairpro.app/**` | sí (`/auth/callback` en el origen real de la app) | **OK** | Cubre el callback emitido. Es un comodín de path pero dentro del host propio, que además es el de la Site URL. Confirmado en uso: `auth.flow_state` registra `www…/auth/callback` como destino validado. |
| `https://clicmayorista.com.ar/auth/callback` | sí (alta del portal) | **OK** | Exacta. |
| `https://techrepairpro.app/**` | sólo si el JS corriera en el apex (hoy 307 → `www`) | **SOBRA PERO ES SEGURO** | Host propio. |
| `http://localhost:5173/**` | sólo en desarrollo, que apunta al stack local | **RIESGOSO** | Un link de auth productivo (OAuth o recovery pedido con ese `redirect_to`) entregaría los tokens a cualquier proceso que escuche en el `:5173` de la víctima. Explica el `referrer` `localhost:5173` visto en `auth.flow_state` (2026-07-01). |
| `https://www.clicmayorista.com.ar/auth/callback` | sólo si el JS corriera en `www` (hoy 307 → apex) | **FALTA** — defensiva, **no bloqueante** | Hoy nadie llega a emitirla. |
| previews de Vercel / comodines ajenos | no | — | Ya **no** están (las del historial de `flow_state` son de abril–mayo). |

### B.2 Email Auth

| Setting | Valor | Etiqueta | Contrato del frontend |
|---|---|---|---|
| Email provider | ON | CONFIRMADO EN DASHBOARD + PROD | requerido |
| Allow new users to sign up | ON (`disable_signup=false`) | CONFIRMADO EN PROD | requerido |
| Confirm email | ON (`mailer_autoconfirm=false`) | CONFIRMADO EN PROD | requerido (`/verificar-email`, `RequireEmailConfirmed`) |
| Secure email change | **ON** | CONFIRMADO EN DASHBOARD | no hay UI de cambio de email → correcto |
| Secure password change | **OFF** | CONFIRMADO EN DASHBOARD | no hay UI de reautenticación → correcto |
| Require current password when updating | **OFF** | CONFIRMADO EN DASHBOARD | **tiene que quedar OFF**: recovery llama `updateUser({ password })` sin la contraseña actual (`src/pages/ResetPassword.tsx:139`, CONFIRMADO POR CÓDIGO) |
| Password minimum length | **6** | CONFIRMADO EN DASHBOARD | coincide con registro y portal (6); reset exige 8 y ≤ 72 bytes (más estricto, compatible) |
| Password requirements | ninguno | CONFIRMADO EN DASHBOARD | la UI no los comunica → correcto hoy |
| Leaked password protection | **OFF** | CONFIRMADO EN DASHBOARD + PROD (advisor) | reset mapea `weak_password`; el registro no |
| OTP expiry | **3600 s** | CONFIRMADO EN DASHBOARD (coincide con el advisor) | la UI no promete una duración |
| OTP length | **8** | CONFIRMADO EN DASHBOARD | irrelevante: la app usa links, no códigos (el `config.toml` local tiene 6; divergencia inocua) |
| Intervalo mínimo por usuario | **60 s** | CONFIRMADO EN DASHBOARD | coincide con el cooldown de 60 s de la UI |
| Rate limit de correos | **30/h** | CONFIRMADO EN DASHBOARD | 429 mapeado a estado propio |
| Anonymous sign-ins / Phone / SAML | OFF | CONFIRMADO EN PROD | — |
| GoTrue | v2.197.0 | CONFIRMADO EN PROD | local usa v2.192.0 |

### B.3 SMTP

| Campo | Valor | Etiqueta |
|---|---|---|
| Custom SMTP | **ON — Resend** | CONFIRMADO EN DASHBOARD |
| Host / puerto | `smtp.resend.com` / `465` | CONFIRMADO EN DASHBOARD |
| Username | `resend` (no es secreto) | CONFIRMADO EN DASHBOARD |
| Password | **configurada: SÍ** (valor no revelado ni pedido) | CONFIRMADO EN DASHBOARD |
| Sender | `TechRepair Pro <no-reply@techrepairpro.app>` | CONFIRMADO EN DASHBOARD |
| Dominio en Resend | `techrepairpro.app` **Verified**, región São Paulo `sa-east-1` | CONFIRMADO EN DASHBOARD; coincide con el DNS público (`send.techrepairpro.app` MX `feedback-smtp.sa-east-1.amazonses.com` + SPF, DKIM `resend._domainkey`, `_dmarc p=none`, DNS en Vercel, sin MX en la raíz) — CONFIRMADO EN PROD |
| Tracking en Resend | «tracking metrics no configurado» | CONFIRMADO EN DASHBOARD. Lectura: no hay click/open tracking que reescriba links; confirmar los toggles explícitamente en 2C. |
| Plan de Resend | **Transactional Free, 3000 correos/mes** | CONFIRMADO EN DASHBOARD |
| Entrega observada | correos reales de **Reset Password** con estado **Delivered** a Gmail | CONFIRMADO EN DASHBOARD (panel de Resend) |

**Conclusión: producción usa Custom SMTP (opción B), no el SMTP incorporado de Supabase.** El riesgo de
2A («los correos sólo llegan al equipo») **no aplica**.

### B.4 Email templates

| Plantilla | Link en producción | Etiqueta | Contrato del código |
|---|---|---|---|
| **Confirm signup** | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup` | CONFIRMADO EN DASHBOARD | **coincide** con lo que espera `AuthCallback` |
| **Reset password** | `{{ .ConfirmationURL }}` | CONFIRMADO EN DASHBOARD | funciona (captura de fragmento de Lote B), pero es un GET de un solo uso |
| Invite user | `{{ .ConfirmationURL }}` | CONFIRMADO EN DASHBOARD | no se usa |
| Magic link | `{{ .ConfirmationURL }}` | CONFIRMADO EN DASHBOARD | no se usa |
| Change email | `{{ .ConfirmationURL }}` | CONFIRMADO EN DASHBOARD | no hay UI |
| Reauthentication | `{{ .Token }}` | CONFIRMADO EN DASHBOARD | no se usa |
| Notificaciones de seguridad | **todas OFF** | CONFIRMADO EN DASHBOARD | ninguna requerida hoy |

Consecuencias, cruzadas con las mediciones de 2A (§5.1):

- **Alta:** como la plantilla ya es `token_hash`, el defecto medido en 2A (link de alta usado o
  pre-abierto → pantalla de recovery; tokens en el historial) **no afecta a las altas de
  producción**: un link de alta usado o vencido pasa por `verifyOtp` y termina en
  `/verificar-email` o en `/login?motivo=link_invalido`. Los escáneres no consumen el token.
- **Recovery:** sigue en `{{ .ConfirmationURL }}`. Funciona (entregas reales a Gmail), pero un
  escáner que pre-abra el link (el caso típico es Microsoft Safe Links/Defender) lo consume y el
  usuario ve «El enlace ya no es válido» (medido en 2A, D4). Los tokens viajan en el fragmento; Lote B
  los saca de la URL antes de crear el cliente.
- **Invite / Magic link / Change email:** no los dispara la UI. Si alguno se usara y su link venciera,
  el error `otp_expired` sin `type` caería en la pantalla de recovery (la misma mala clasificación);
  impacto bajo, lo corrige 2D.

### B.5 Google Auth

| Campo | Valor | Etiqueta |
|---|---|---|
| Provider | ON | CONFIRMADO EN DASHBOARD + PROD |
| Skip nonce checks | OFF | CONFIRMADO EN DASHBOARD. Sólo aplica a `signInWithIdToken`, que el código no usa. |
| Allow users without email | OFF | CONFIRMADO EN DASHBOARD. Correcto: el provisioning exige email. |
| Client ID / secret | configurados (no leídos ni impresos) | CONFIRMADO EN DASHBOARD |
| Callback de Supabase en Google Cloud | configurado | CONFIRMADO EN DASHBOARD |
| Flujo del cliente | implícito, `redirectTo = getAuthCallbackUrl()`, `prompt=select_account`, `access_type=offline` | CONFIRMADO POR CÓDIGO |

### B.6 Efecto de esta medición sobre producción

Todas las consultas fueron `SELECT` de catálogo/agregados, `GET` públicos y DNS, **con una excepción
documentada**: para medir la allowlist se hizo **un** `GET /auth/v1/authorize?provider=google` (lo
mismo que el botón «Continuar con Google»). En GoTrue v2.197 eso guarda el estado OAuth en
`auth.flow_state` también en flujo implícito: quedó **1 fila** (2026-09-28 01:10:47 UTC, sin
completar), indistinguible de un click abandonado. La sonda se cortó ahí y la fila no se borró.

---

## C. Blockers al cierre de 2B

| Blocker | Estado | Evidencia | Qué lo cierra / qué queda |
|---|---|---|---|
| **BLK-1** credencial demo | **CLOSED** | Ban vigente verificado read-only; 0 sesiones; 0 refresh tokens; credencial fuera del código en #153 y guard en CI | Residual con fecha: el ban vence el **2027-09-28** (§A.5). El fix de repo llega a `main` con el merge de #153. |
| **BLK-2** SMTP | **IDENTIFIED** — Custom SMTP con Resend, dominio verificado, entregas reales Delivered. **Deja de ser bloqueante de entrega.** | §B.3 | Se **cierra en 2C** con el endurecimiento: cupo/plan, tracking explícitamente OFF, alcance de la API key, Reply-To y entregabilidad fuera de Gmail (§F). |
| **BLK-3** plantillas | **IDENTIFIED** — **acotado a Recovery**. La plantilla de alta ya es `token_hash` y cumple el contrato; recovery sigue en `{{ .ConfirmationURL }}` (consumible por escáneres). | §B.4 | Se **cierra con 2D** (clasificación de `otp_expired` sin `type`, desplegado primero) **+ 2E** (plantilla de recovery a `token_hash`). |

**PRE-BETA-2B: CLOSED.** Cumple la condición de cierre del brief: informe de 2A preservado, credencial
fuera del bundle y del código, guard permanente en CI, contención manual completada y verificada,
configuración real de Auth documentada, SMTP y plantillas identificados, target definido y gates en
verde (§H). Queda la revisión y el merge de #153.

---

## D. Target config para PRE-BETA-2E

| Setting | Actual (CONFIRMADO) | Objetivo | Cambia en |
|---|---|---|---|
| Site URL | `https://www.techrepairpro.app` | igual | — |
| Redirect URLs | `https://www.techrepairpro.app/**`, `https://techrepairpro.app/**`, `http://localhost:5173/**`, `https://clicmayorista.com.ar/auth/callback` | exactas: `https://www.techrepairpro.app/auth/callback`, `https://clicmayorista.com.ar/auth/callback`, `https://techrepairpro.app/auth/callback`, `https://www.clicmayorista.com.ar/auth/callback`. **Quitar `localhost:5173/**`**; reemplazar los `/**` por callbacks exactos. | 2E |
| Allow new signups / Confirm Email | ON / ON | igual | — (no se toca) |
| Custom SMTP | ON, Resend, `smtp.resend.com:465`, usuario `resend` | igual | 2C (sólo verificar/endurecer) |
| Sender | `TechRepair Pro <no-reply@techrepairpro.app>` | igual | — |
| Reply-To | ninguno (no hay MX en la raíz) | casilla de soporte real, o aceptar explícitamente que no se responde | 2C (decisión) |
| Rate limit de correos | 30/h | ≤ cupo real del plan de Resend (ver §F) | 2C |
| Intervalo mínimo por usuario | 60 s | igual | — |
| OTP expiry / length | 3600 s / 8 | igual | — |
| Secure email change | ON | igual | — |
| Secure password change | OFF | igual | — |
| Require current password when updating | OFF | **igual (obligatorio para recovery)** | — |
| Password minimum length | 6 | **8**, **después** de que 2D suba la validación de registro y portal a 8 | 2D → 2E |
| Password requirements | ninguno | igual en beta | — |
| Leaked password protection | OFF | ON, **después** de que 2D mapee `weak_password` en el registro | 2D → 2E |
| Confirm signup template | `token_hash` + `RedirectTo` + `type=signup` | igual (copy en español opcional) | — |
| Recovery template | `{{ .ConfirmationURL }}` | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` | 2E (tras deploy de 2D) |
| Invite / Magic link / Change email | `{{ .ConfirmationURL }}` | igual (no se usan; copy en español opcional) | — |
| Reauthentication | `{{ .Token }}` | igual | — |
| Notificaciones de seguridad | todas OFF | ON: contraseña cambiada, email cambiado | 2E |
| Google | ON · skip nonce OFF · sin email OFF | igual | — |
| Anonymous / Phone / SAML | OFF | igual | — |
| Cuenta demo del portal | baneada hasta 2027-09-28 | ban extendido o contraseña aleatoria | owner, antes de 2027-09-28 |

---

## E. Target de templates

**Confirm signup — ya cumple el objetivo.** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`
aterriza en `/auth/callback` del origen permitido. Condición que se mantiene: el `redirect_to` tiene
que estar en la allowlist; si no, `.RedirectTo` degrada a la raíz de la Site URL y el `token_hash`
queda en `/`, donde hoy nada lo procesa (2D agrega el reenvío `/` → `/auth/callback`).

**Recovery → `token_hash`.** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.
El código actual lo procesa — **CONFIRMADO POR CÓDIGO**:

| Paso | Dónde |
|---|---|
| `recovery` está en la lista cerrada de tipos aceptados | `src/pages/AuthCallback.tsx:39` (`TIPOS_OTP`) |
| la query con el token se borra del historial antes de verificar | `AuthCallback.tsx:123` (`replaceState`) |
| `verifyOtp({ token_hash, type })` | `AuthCallback.tsx:125` |
| éxito → marca de recovery para ese usuario; fallo → «enlace vencido»; siempre a `/reset-password` | `AuthCallback.tsx:135-141` → `markRecoverySession` / `markRecoveryLinkRejected` (`src/lib/passwordRecovery.ts:149,256`) |
| el evento `PASSWORD_RECOVERY` de `verifyOtp` también marca | `passwordRecovery.ts:313-317` |
| el formulario exige sesión + marca del mismo usuario | `src/pages/ResetPassword.tsx:103` (`hasRecoverySession`) |
| el cambio de contraseña no pide la actual (por eso «Require current password» queda OFF) | `ResetPassword.tsx:139` |

Y por test: componente `passwordRecovery` A1/A2 (CONFIRMADO POR TEST) + navegador real contra GoTrue
en 2A (B5–B8). La captura del fragmento de Lote B se mantiene: los correos de recovery ya enviados con
`ConfirmationURL` siguen funcionando durante el cambio.

**Invite user — sin cambio.** El producto invita con un token propio (`create_business_invitation`) y
un link a `/accept-invite`. «Invite user» del Dashboard no debe usarse: el invitado entraría sin
contraseña y sin negocio.

**Change email — sin cambio.** No hay UI; Secure email change ya está ON. El default funciona por el
camino implícito; su `otp_expired` sufre la misma mala clasificación que corrige 2D.

**Magic link — sin cambio.** La app no usa `signInWithOtp`; el default funciona por el camino
implícito. Pasarlo a `token_hash` exigiría agregar `magiclink` a `TIPOS_OTP` sin beneficio hoy.

**Notificaciones de seguridad:** sólo informan (sin links de un solo uso). Activar «contraseña
cambiada» y «email cambiado» en 2E.

---

## F. Plan para PRE-BETA-2C (Resend) — sin configurarlo

> **Resultado de 2C:** ver `docs/pre-beta-2/pre-beta-2c-email-hardening.md`.

La arquitectura objetivo **ya está en producción**: Supabase Auth → Custom SMTP → Resend →
`techrepairpro.app` verificado. Se descarta el subdominio `mail.` que proponía 2A: el dominio raíz
ya está verificado y no tiene MX ni otro emisor cuya reputación proteger. **No hay DNS que crear.**
2C pasa a ser **verificación y endurecimiento**:

| # | Ítem | Estado | Acción en 2C |
|---|---|---|---|
| 1 | **Cupo del plan** | Free: 3000/mes; el plan gratuito de Resend tiene además un tope diario (su pricing público lo fija en 100/día; confirmarlo en el panel). Supabase permite 30/h (hasta 720/día). | Si el cupo se agota, el envío falla y con Confirm Email ON el **signup devuelve 500** (medición documentada en `scripts/e2e/ci-local.mjs`). Decidir: pasar a un plan pago antes de abrir la beta, o bajar el rate limit y monitorear el consumo. |
| 2 | **Tracking** | «no configurado» | Verificar que click tracking y open tracking estén **OFF** para `techrepairpro.app`: el click tracking reescribe los links de confirmación/recovery. |
| 3 | **API key del SMTP** | configurada, alcance desconocido | Confirmar que sea una key con permiso **sólo de envío** y restringida a `techrepairpro.app`; si es full access, rotarla por una restringida (se carga sólo en el Dashboard). |
| 4 | **Reply-To** | ninguno; no hay MX en la raíz | Definir la casilla de soporte, o dejar explícito que `no-reply` no recibe respuestas. |
| 5 | **DMARC** | `p=none` sin `rua` | Opcional: agregar `rua=mailto:<casilla>`; pasar a `p=quarantine` sólo tras 2–4 semanas de reportes limpios. |
| 6 | **Entregabilidad** | sólo Gmail observado | Lista semilla con cuentas QA: Gmail, Outlook/Hotmail, Yahoo, iCloud y **M365 con Safe Links**; `Authentication-Results` pass, bandeja, latencia, puntaje ≥ 9/10, 429 neutro. En M365 se mide el impacto real de recovery con `ConfirmationURL` antes de 2E. |
| 7 | **Sender name para el portal** | los correos del portal de Clic salen como «TechRepair Pro» | Decisión de producto (no bloqueante). |

---

## G. `[inbucket]` → `[local_smtp]` (sin cambios en esta rama)

- **CLI instalada:** 2.109.1, la misma que fija CI. Arranca con el WARN de sección deprecada, y
  `supabase init` genera `[local_smtp]` con **las mismas claves**: `enabled`, `port`, `smtp_port`,
  `pop3_port`, `admin_email`, `sender_name`. El contenedor sigue siendo Mailpit
  (`supabase_inbucket_<project>`), mismo puerto y misma API `/api/v1/...`. Medido en 2A.
- **Por qué rompe el E2E:** `tests/e2e/m7/password-recovery.spec.ts:35-40` (`mailpitBase()`) hace
  `toml.split(/^\[inbucket\]\s*$/m)[1]` sobre `supabase/config.toml` para sacar el `port`; si la sección
  se renombra, tira «supabase/config.toml no declara [inbucket] port» → fallan los 5 tests de recovery.
- **Cambio preparado para 2D (o un lote técnico chico):** renombrar la sección y en el mismo PR
  cambiar la regex a `/^\[(?:local_smtp|inbucket)\]\s*$/m`, más los comentarios de `config.toml`,
  `ci-local.mjs` y los specs. Verificar antes la CLI de cada máquina de desarrollo. Mientras tanto el
  WARN es inocuo.

---

## H. Gates — CONFIRMADO POR TEST

### H.1 Gates finales (2026-09-28, sobre la rama con el fix de CI)

| Gate | Resultado |
|---|---|
| `guard:no-hardcoded-credentials` + self-test (22 casos + control negativo por CLI) | OK / OK |
| `npm run test:unit` completo (incluye `noHardcodedCredentials` 5/5) | **1178/1178** |
| vitest `portalLoginNoDemo` + 9 suites de auth/portal (`wholesaleEmailConfirmation`, `emailVerification`, `passwordRecovery`, `routingRecoveryOnboarding`, `authProfileLinking`, `canonicalProvisioning`, `invitationsLifecycle`, `mobileSession1a`, `g2c1WholesaleOrderStatus`) | **164/164** |
| `npm run test:components -- tests/components/portalLoginNoDemo.test.tsx` (la invocación exacta del step de CI) | 5/5 |
| `tsc --noEmit` | 0 errores |
| ESLint `src --quiet` | 0 errores |
| guards `auth-redirect`, `onboarding-canonical`, `provisioning-authority`, `mobile-session-1a`, `no-real-data` (normal + self-test) | **10/10** |
| `vite build` de producción + escaneo del bundle | OK; 0/133 archivos con la credencial, el email, los identificadores o el botón demo |
| Controles negativos con el `PortalLogin` original | guard, componente y unit **fallan**, como deben |

No se corrió E2E: el cambio sólo quita una rama `DEV` y agrega un guard; el login del portal queda
cubierto por el test de componente. El resultado de CI de la corrida con el fix se ve en el PR #153.

### H.2 Incidencia de CI corregida

La primera corrida de CI de #153 falló en el step nuevo: invocaba `node --test` sobre un test `.ts` y
el job `quality` usa **Node 20**, que no ejecuta TypeScript (`ERR_UNKNOWN_FILE_EXTENSION`). El guard y
su self-test habían pasado. Corrección, sin cambiar la versión de Node del job: el control negativo por
archivo (CLI real) pasó al `--self-test` del guard (`.mjs`), y el step corre además el test de
componente de `PortalLogin` con vitest, como los demás steps de ese job. El test `.ts` sigue en
`npm run test:unit`. El step también quedó reubicado antes del comentario de P0-P1, que había quedado
separado de su step.

---

## I. Próximo lote — inputs exactos que necesita PRE-BETA-2C

1. **Plan de Resend:** confirmar el tope diario del plan Free en el panel y decidir si se pasa a un
   plan pago antes de invitar beta testers (o qué rate limit usar si se queda en Free).
2. **Tracking:** captura o confirmación de que click/open tracking están OFF para `techrepairpro.app`.
3. **API key del SMTP:** qué permisos tiene (full access vs sending access) y a qué dominio está
   restringida. Si hay que rotarla, la crea el owner y la pega **sólo** en el Dashboard.
4. **Reply-To:** casilla de soporte a usar, o decisión explícita de no tener respuestas.
5. **DMARC `rua`** (opcional): casilla para reportes.
6. **Lista semilla de cuentas QA** (Gmail, Outlook/Hotmail, Yahoo, iCloud, M365 con Safe Links) y una
   ventana horaria sin signups reales.
7. Decisión sobre el sender name de los correos del portal de Clic (opcional).

## J. Deuda anotada, fuera de 2B

Extender el ban demo antes del 2027-09-28; `console.log` del email en `loginCustomer`; mensajes crudos
de GoTrue en el registro; `services/auth.ts` muerto; las 3 cuentas «demo» adicionales; y todo lo de 2A
§10. Nada de eso entra en esta rama.
