# PRE-BETA-2B — Contención de credenciales + Auth Production Inventory

**Fecha:** 2026-09-27/28 · **Estado:** STOP — esperando la acción manual y los datos del Dashboard
del owner (§B.8). **No** se configuró SMTP/Resend, **no** se tocaron plantillas, URLs, DNS ni
Confirm Email, y **no** se desplegó nada.

| Dato | Valor |
|---|---|
| Base | `origin/main` = `da5c58faeb33448b27834c887d315ae386535f36` (sin cambios desde el cierre de 2A: 0 commits nuevos, nada que comparar en Auth/portal/login/signup/recovery/onboarding/config/provisioning) |
| Rama | `claude/pre-beta-2b-auth-inventory` (local, sin push) |
| Commits | `38d02a4` docs 2A (sólo el informe) · `cf930a8` fix credencial demo + guard + tests · este informe |
| Informe previo | `docs/pre-beta-2/pre-beta-2a-discovery.md` |

### Etiquetas

| Etiqueta | Significado |
|---|---|
| **CONFIRMADO EN DASHBOARD** | valor leído en el Dashboard de Supabase por el owner — **todavía ninguno** (§B.8) |
| **CONFIRMADO EN PROD** | medido read-only contra producción (endpoints públicos de GoTrue, catálogo/agregados SQL, DNS público) |
| **CONFIRMADO POR CÓDIGO** | `da5c58f` + los commits de esta rama |
| **CONFIRMADO POR TEST** | corrido en esta rama (§H) o en el CI de `da5c58f` |
| **MANUAL ACTION PENDING** | requiere al owner (Dashboard o decisión) |

La contraseña demo **no** aparece en este documento, en los commits nuevos (mensajes), en el guard,
en los tests ni en logs. Ver §A.6 para las dos excepciones inevitables y cómo se trataron.

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
| Código fuente (repo **público**) | expuesto desde `47cf241` hasta `cf930a8`. **Queda en la historia de git** (la decisión vigente del owner, Lote D, es no reescribir historia) → la credencial se trata como **comprometida**. |
| Bundle servido | el literal **no** estaba en el bundle productivo (el bloque `DEV` se elimina en el build): verificado en 2A sobre lo servido y hoy sobre un build de esta rama. |
| DB productiva | `supabase_migrations.schema_migrations.statements` de esas dos migraciones contiene el literal. Ese esquema no está expuesto por la API (sólo `public` y `graphql_public`); lo leen roles de administración. |

### A.3 Superficie en producción (read-only, sin hashes ni tokens) — CONFIRMADO EN PROD

| Aspecto | Valor |
|---|---|
| Cuenta | `demo@clicmayorista.com` (el email ya era público en el código; 1 sola cuenta) |
| Identidades | sólo `email`; confirmada; contraseña seteada; sin MFA; no SSO; no anónima |
| Estado | **no baneada** (`banned_until` NULL), no borrada |
| Sesiones | **0 sesiones y 0 refresh tokens activos** |
| Último sign-in de Auth | 2026-09-15 14:02 UTC (no se puede saber desde dónde: los logs de Auth retienen 1 día) |
| Portal mayorista | 1 fila en el negocio **real de Clic** (portal activo): **aprobada, no suspendida**, último login de portal 2026-08-24, **0 pedidos** |
| Membresía SaaS | **owner** activo de un tenant «Mi Negocio» **suspendido**, sin otros miembros, que **contiene datos** (11 órdenes, 17 clientes, 11 productos, 3 comprobantes). El contenido no se inspeccionó. |
| Otras cuentas con «demo» en el email | 3, no relacionadas con esta credencial (probablemente las de la vieja `create-demo-users`, retirada en P0-S0). Fuera de alcance; ver §A.7. |

### A.4 Acción manual del owner — MANUAL ACTION PENDING

Preferencia de seguridad del brief: **ban/desactivar > rotar y conservar**. La cuenta es una demo
histórica sin pedidos y con el tenant suspendido → **recomendación: BANEAR**. No borrar nada.

**Opción recomendada — banear (reversible):**

1. Dashboard de Supabase → proyecto **techrepair-pro** → **Authentication → Users**.
2. Buscar `demo@clicmayorista.com` y abrir el usuario.
3. **Ban user** → la duración más larga que ofrezca el panel (en la API equivale a `876000h`) →
   confirmar. Si el panel no lo ofrece, el owner puede correr en el SQL Editor:
   `update auth.users set banned_until = now() + interval '100 years' where email = 'demo@clicmayorista.com';`
   (fecha lejana y no `'infinity'`: no está garantizado que GoTrue parsee ese valor especial).
4. **No** borrar el usuario, su tenant «Mi Negocio», ni su fila de `wholesale_customers`
   (trazabilidad y datos).
5. Opcional, decisión de Clic (defensa en profundidad): en Mayorista → Clientes, **suspender** al
   cliente demo. El login del portal ya rechaza suspendidos.
6. Avisar para verificar read-only: `banned_until` seteado, 0 sesiones, 0 refresh tokens.

Efecto: GoTrue rechaza el login y el refresh de un usuario baneado. Hoy no hay sesiones vivas, así
que no queda ningún token vigente que esperar a que venza.

**Sólo si la cuenta todavía cumple una función legítima — rotar y conservar:** generar una contraseña
nueva en un gestor de contraseñas (nunca en el repo ni en el chat) y setearla por la Admin API
(`updateUserById`); verificar 0 sesiones (hoy ya es 0). Si esa misma contraseña se reutilizó en
cualquier otro lugar, cambiarla también: está en un repo público.

### A.5 Fix en el repo — CONFIRMADO POR CÓDIGO (`cf930a8`)

- `PortalLogin.tsx`: eliminadas las constantes demo, `handleDemo`, el estado `demoLoading`, el
  bloque «Modo Dev / Ingresar como demo» y el icono que sólo usaba ese bloque. El único camino es el
  formulario con lo que tipea el usuario (`doLogin(email, password)`). −48/+2 líneas, sin CRLF.
- Sin reemplazo por otra credencial ni por un texto de ayuda: no hace falta.
- **Bundle**: build de producción de esta rama → 133 archivos revisados, **0** con el literal viejo
  (comparado en memoria contra la versión de `da5c58f`, sin imprimirlo), 0 con `demo@clicmayorista`,
  0 con los identificadores demo, 0 con el botón. **CONFIRMADO POR TEST**

### A.6 Guard permanente — `scripts/guards/no-hardcoded-credentials.mjs`

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
  revierte con un diccionario, así que publicarlo equivaldría a republicarla. La contención real es
  el ban.
- **Falsos positivos:** 0 sobre todo `src/` actual. El self-test incluye las formas reales del repo
  que parecían sospechosas (mapa de etiquetas de `DeviceLockCard`, `autoComplete`, claves de storage
  como `RECOVERY_MARKER_KEY`, `PASSWORD_MIN_LENGTH`, templates dinámicos).
- **Dónde corre:** `npm run guard:no-hardcoded-credentials[:self-test]`, agregado a la cadena
  `npm run guards` y como step propio del job `quality` de CI (junto con su test unitario).

**Pruebas y controles negativos — CONFIRMADO POR TEST**

| Prueba | Resultado |
|---|---|
| Self-test (22 casos: 10 positivos, 12 negativos, más «la salida no filtra el valor») | OK |
| `tests/unit/noHardcodedCredentials.test.ts` C1–C3: credencial sintética introducida a propósito en un árbol temporal → el **CLI real** sale 1 y no imprime el valor; árbol limpio → 0 | 5/5 |
| `tests/components/portalLoginNoDemo.test.tsx` B1–B5: con `DEV = true`, sin atajo demo ni cuenta; el login manda exactamente lo tipeado + el negocio del portal; aprobado → catálogo, pendiente → pendiente, suspendido → suspendido; error visible; bloqueado mientras carga | 5/5 |
| **Control negativo con el `PortalLogin` original** (repuesto temporalmente desde `HEAD~1`): guard → exit 1 con 6 hallazgos (R1, R2 ×4, R4) sin imprimir el valor; componente B1 → **falla**; unit C4/C5 → **fallan**. Restaurado → todo verde, árbol limpio. | OK |

### A.7 Riesgo residual

| Riesgo | Tratamiento |
|---|---|
| La contraseña sigue en la historia pública de git y en `schema_migrations.statements` de prod | Irreversible sin reescribir historia (descartado por el owner). Mitigación = ban/rotación (§A.4). |
| La cuenta sigue activa hasta que el owner actúe | **BLK-1 queda OPEN** hasta verificar el ban. |
| El diff del commit `cf930a8`, como cualquier diff de borrado, muestra la línea eliminada | Inevitable; el valor ya estaba en la historia pública desde `47cf241`. El mensaje del commit no lo contiene. |
| Durante esta sesión, una lectura de `PortalLogin.tsx` mostró la línea en la salida interna de la herramienta | No se copió a ningún archivo, commit, log ni al informe. Después se trabajó sólo con scripts por patrón que no repiten el valor. |
| Otras 3 cuentas con «demo» en el email | Sus contraseñas no aparecen en el repo. Revisar en un lote aparte si siguen haciendo falta. |
| `loginCustomer` hace `console.log` del email (P3-3 de 2A) | Fuera del alcance acotado de 2B por el brief; queda para 2D. |

---

## B. Production Auth Inventory

Lo que se pudo medir sin credenciales privilegiadas está marcado **CONFIRMADO EN PROD**. `SUPABASE_ACCESS_TOKEN`: **no presente** (ni variable de entorno ni archivo de la CLI; sólo se comprobó la presencia), así que la Management API no está disponible y el resto requiere el Dashboard.

### B.1 General / URL Configuration

| Campo | Valor | Etiqueta |
|---|---|---|
| **Site URL** | desconocido. Indicio: con un `redirect_to` no permitido GoTrue cae a la Site URL, y `auth.flow_state` registró una vez `https://www.techrepairpro.app` como `referrer` (2026-06-13), compatible con Site URL = `https://www.techrepairpro.app` | **MANUAL ACTION PENDING** |
| **Redirect URLs** | lista desconocida; evidencia abajo | **MANUAL ACTION PENDING** |

**Evidencia de allowlist** — `auth.flow_state.referrer` guarda, por cada click en «Continuar con
Google», el destino ya validado por GoTrue (el pedido o, si no estaba permitido, la Site URL).
Agregado read-only, sin datos de usuario — **CONFIRMADO EN PROD**:

| `referrer` validado | Veces | Última vez | Lectura |
|---|---|---|---|
| `https://www.techrepairpro.app/auth/callback` | 15 | **2026-09-28** (sonda de 2B) | permitido **hoy** |
| `http://localhost:5173/auth/callback` | 1 | 2026-07-01 | **localhost estuvo permitido en prod** |
| `https://www.techrepairpro.app` | 1 | 2026-06-13 | raíz (explícita o fallback a Site URL) |
| `https://tech-repair-pro-…vercel.app/auth/callback` y raíz | 5 | 2026-05-07 | previews de Vercel permitidos en abril–mayo |
| `https://techrepairpro-nine.vercel.app/login`, `http://localhost:5173/login` | 3 | 2026-04-16 | ídem, época anterior |

**Clasificación contra el contrato de `src/lib/authRedirect.ts`** (clasificación objetivo; el estado
actual de cada entrada lo confirma el owner):

| URL | Emitida por el código actual | Clasificación si está en la allowlist | Si falta |
|---|---|---|---|
| `https://www.techrepairpro.app/auth/callback` | sí (el origen real de la app) | **OK** — confirmado permitido hoy | rompería signup, recovery y Google |
| `https://clicmayorista.com.ar/auth/callback` | sí (alta del portal) | **OK** | **FALTA**: la confirmación mayorista caería en la raíz de la Site URL, en el origen equivocado |
| `https://techrepairpro.app/auth/callback` | sólo si el JS corriera en el apex (hoy 307 → `www`) | **SOBRA PERO ES SEGURO** (defensivo) | no rompe nada hoy |
| `https://www.clicmayorista.com.ar/auth/callback` | ídem (307 → apex) | **SOBRA PERO ES SEGURO** | no rompe nada hoy |
| `https://www.techrepairpro.app` (raíz) | no | **SOBRA PERO ES SEGURO** (el host de la Site URL ya está permitido) | — |
| `https://www.techrepairpro.app/reset-password` | sólo `services/auth.ts`, sin consumidores | **SOBRA PERO ES SEGURO** | — |
| `http://localhost:*` / `http://127.0.0.1:*` | sólo en desarrollo, contra el stack local | **RIESGOSO en prod**: cualquier proceso en `localhost` de la víctima recibe los tokens | — |
| `https://*.vercel.app/**`, previews | no (el helper cae al canónico `www`) | **RIESGOSO**: cualquier deploy de Vercel, incluso ajeno, podría calzar un patrón amplio | — |
| cualquier comodín (`**`) | no | **RIESGOSO** | — |

Regla de GoTrue a tener en cuenta (según su implementación de validación de redirects; **no medido
acá**): una URL con **el mismo hostname que la Site URL** se acepta aunque no esté en la lista. Por
eso la Site URL tiene que ser un host propio y exacto.

### B.2 Email Auth

| Setting | Valor | Etiqueta | Contrato del frontend |
|---|---|---|---|
| Allow new users to sign up | **ON** (`disable_signup=false`) | CONFIRMADO EN PROD (`/auth/v1/settings`, 2026-09-28) | requerido |
| Confirm email | **ON** (`mailer_autoconfirm=false`) | CONFIRMADO EN PROD | requerido (`/verificar-email`, `RequireEmailConfirmed`) |
| Secure email change (doble confirmación) | ? | MANUAL ACTION PENDING | no hay UI de cambio de email → ON recomendado |
| Secure password change | ? | MANUAL ACTION PENDING | no hay UI de reautenticación |
| Password minimum length | ? | MANUAL ACTION PENDING | registro y portal validan **6**; reset valida **8** y ≤ 72 bytes. Si prod exige > 6, el registro muestra el error crudo de GoTrue. |
| Password requirements | ? | MANUAL ACTION PENDING | la UI no los comunica |
| Leaked password protection | **OFF** (advisor `auth_leaked_password_protection`) | CONFIRMADO EN PROD | reset mapea `weak_password`; el registro no |
| OTP / link expiry | **≤ 3600 s** (el advisor `auth_otp_long_expiry` no aparece) | CONFIRMADO EN PROD (indirecto); valor exacto MANUAL | la UI no promete una duración |
| OTP length | ? | MANUAL ACTION PENDING | irrelevante: la app usa links, no códigos |
| Intervalo mínimo entre correos (resend/recover) | ? | MANUAL ACTION PENDING | la UI aplica 60 s de cooldown |
| Rate limit de correos (por hora) | ? | MANUAL ACTION PENDING | 429 mapeado a estado propio |
| Anonymous sign-ins | **OFF** | CONFIRMADO EN PROD | — |
| Phone / SAML / otros OAuth | **OFF** | CONFIRMADO EN PROD | — |
| GoTrue | **v2.197.0** | CONFIRMADO EN PROD | local usa v2.192.0 |

### B.3 SMTP — MANUAL ACTION PENDING (resuelve BLK-2)

| Campo | Valor |
|---|---|
| Custom SMTP ON/OFF | ? |
| Proveedor / host / puerto | ? |
| Username | ? (si es `resend`, no es secreto) |
| Sender address / sender name | ? |
| Password | se reporta sólo `configurado: SÍ/NO`, **nunca** el valor |

**Indicio fuerte, NO confirmación — CONFIRMADO EN PROD (DNS público):**

| Registro | Valor |
|---|---|
| NS `techrepairpro.app` | `ns1/ns2.vercel-dns.com` (DNS en Vercel) |
| MX `techrepairpro.app` | **ninguno** (no hay casilla humana en el dominio) |
| MX `send.techrepairpro.app` | `feedback-smtp.sa-east-1.amazonses.com` (pref 10) — return-path de **Resend, región São Paulo** |
| TXT `send.techrepairpro.app` | `v=spf1 include:amazonses.com ~all` |
| TXT `resend._domainkey.techrepairpro.app` | clave pública DKIM de Resend |
| TXT `_dmarc.techrepairpro.app` | `v=DMARC1; p=none` (sin `rua`) |
| `mail.techrepairpro.app` | resuelve A a IPs de Vercel (probable comodín del dominio); sin MX/TXT propios |

El código no llama a Resend desde ningún lado (ni `src/` ni Edge Functions), así que esos registros
existen para un envío configurado fuera del repo: lo más probable es **Custom SMTP de Supabase con
Resend sobre el dominio raíz**. Si el Dashboard lo confirma, **BLK-2 pasa de «bloqueante» a
«verificar y endurecer»** (§F).

### B.4 Email templates — MANUAL ACTION PENDING (resuelve BLK-3)

Para cada plantilla, el owner reporta **sólo qué variable arma el link** (no hace falta pegar el HTML
entero):

| Plantilla | Qué buscar en el cuerpo | Contrato que espera el código |
|---|---|---|
| Confirm signup | `{{ .ConfirmationURL }}` · `{{ .TokenHash }}` · `{{ .RedirectTo }}` · `{{ .SiteURL }}` | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup` |
| Reset password | ídem | hoy funciona con `{{ .ConfirmationURL }}`; objetivo `token_hash` (§E) |
| Invite user | ídem | no se usa |
| Magic link | ídem | no se usa |
| Change email address | ídem | no se usa |
| Reauthentication | `{{ .Token }}` | no se usa |
| Notificaciones de seguridad (password/email cambiado, identidad vinculada/desvinculada, MFA) | habilitadas SÍ/NO | ninguna requerida hoy |

### B.5 Google Auth

| Campo | Valor | Etiqueta |
|---|---|---|
| Provider | **ON** | CONFIRMADO EN PROD (`/auth/v1/settings`) |
| Flujo del cliente | implícito, `redirectTo = getAuthCallbackUrl()`, `prompt=select_account`, `access_type=offline` | CONFIRMADO POR CÓDIGO |
| Callback OAuth (Google Cloud Console → Authorized redirect URIs) | `https://<project-ref>.supabase.co/auth/v1/callback` | contrato estándar; valor cargado **MANUAL ACTION PENDING** |
| Skip nonce check | ? | MANUAL ACTION PENDING. Irrelevante para este producto: sólo aplica a `signInWithIdToken`, que el código no usa (CONFIRMADO POR CÓDIGO). Objetivo: dejarlo como esté (OFF por defecto). |
| Client ID / secret | no se leyeron ni se imprimen | — |

### B.6 Efecto de esta medición sobre producción

Todas las consultas fueron `SELECT` de catálogo/agregados y `GET` públicos, **con una excepción que
se documenta**: para medir la allowlist se hizo **un** `GET /auth/v1/authorize?provider=google`
(lo mismo que hace el botón «Continuar con Google»). En GoTrue v2.197 eso guarda el estado OAuth en
`auth.flow_state` también en flujo implícito, así que quedó **1 fila** (2026-09-28 01:10:47 UTC,
`referrer = https://www.techrepairpro.app/auth/callback`, sin completar), indistinguible de un click
abandonado; hay 25 filas así en total. La sonda se cortó ahí (no se repitió con otros candidatos) y
la fila no se borró, para no escribir en `auth`.

### B.7 Resumen de lo que falta del Dashboard

Site URL · Redirect URLs · Custom SMTP (host, puerto, usuario, sender) · plantillas (6) ·
notificaciones de seguridad · largo mínimo y requisitos de contraseña · secure email/password change ·
intervalo mínimo y rate limit de correos · OTP expiry/length exactos · skip nonce · redirect URIs en
Google Cloud Console.

### B.8 Formulario para el owner (copiar, completar, devolver) — sin secretos

```
URL CONFIGURATION (Authentication → URL Configuration)
  Site URL: ______________________
  Redirect URLs (una por línea, exactas):
    ______________________

SMTP (Authentication → Emails → SMTP Settings)
  Enable Custom SMTP: SÍ / NO
  Host: __________  Port: _____  Username: __________
  Password configurada: SÍ / NO      (NO pegar el valor)
  Sender email: __________________  Sender name: __________________

RATE LIMITS (Authentication → Rate Limits)
  Emails por hora: _____   (anotar también los demás si están a la vista)

EMAIL PROVIDER (Authentication → Sign In / Providers → Email)
  Confirm email: ON / OFF    Secure email change: ON / OFF    Secure password change: ON / OFF
  Minimum password length: ___   Password requirements: __________
  Leaked password protection: ON / OFF
  Email OTP expiration (s): _____   Email OTP length: ___   Min interval entre correos (s): _____

TEMPLATES (Authentication → Emails → Templates) — qué variable arma el link:
  Confirm signup: ConfirmationURL / TokenHash+RedirectTo / TokenHash+SiteURL / otro: ______
  Reset password: ConfirmationURL / TokenHash+RedirectTo / TokenHash+SiteURL / otro: ______
  Invite user: __________  Magic link: __________  Change email: __________
  Notificaciones de seguridad habilitadas: __________

GOOGLE (Authentication → Sign In / Providers → Google)
  Enabled: ON / OFF   Skip nonce check: ON / OFF
  Google Cloud Console → Authorized redirect URIs: __________

RESEND (si hay cuenta)
  Dominio verificado: __________   Click tracking: ON / OFF   Open tracking: ON / OFF   Plan: ______

BLK-1
  Acción tomada sobre demo@clicmayorista.com: BANEADA / ROTADA / PENDIENTE   (hora aprox.: ____)
```

---

## C. Blockers al cierre de 2B

| Blocker | Estado | Qué falta para el próximo estado |
|---|---|---|
| **BLK-1** credencial demo | **OPEN** — la parte de repo está hecha (`cf930a8`, guard en CI); la cuenta de prod sigue activa | ban/rotación del owner (§A.4) + verificación read-only → CLOSED |
| **BLK-2** SMTP | **PENDIENTE DE IDENTIFICAR** — el DNS sugiere Resend en el dominio raíz; falta el Dashboard | §B.8 → IDENTIFIED. Se **cierra** recién en 2C/2E con la config verificada y la prueba de entregabilidad. |
| **BLK-3** plantillas | **PENDIENTE DE IDENTIFICAR** | §B.8 → IDENTIFIED. Se **cierra** en 2D (fix de clasificación) + 2E (plantillas `token_hash`). |

No se declara nada cerrado sólo por conocer su estado.

---

## D. Target config para PRE-BETA-2E

«Actual» usa lo confirmado; `?` = pendiente del Dashboard (§B.8).

| Setting | Actual | Objetivo | Cambia en |
|---|---|---|---|
| Site URL | ? (indicio: `https://www.techrepairpro.app`) | `https://www.techrepairpro.app` | 2E (sólo si difiere) |
| Redirect URLs | ? (permitido hoy: `www…/auth/callback`; históricamente localhost y previews) | exactamente: `https://www.techrepairpro.app/auth/callback`, `https://clicmayorista.com.ar/auth/callback`, `https://techrepairpro.app/auth/callback`, `https://www.clicmayorista.com.ar/auth/callback`. **Sin** localhost, previews ni comodines. | 2E |
| Allow new signups | ON | ON | — |
| Confirm Email | ON | ON | — (no se toca) |
| Custom SMTP | ? (DNS: Resend en la raíz) | ON, Resend | 2C (verificar o configurar) |
| Sender | ? | `TechRepair Pro <no-reply@techrepairpro.app>` si el dominio raíz ya está verificado en Resend (ver §F) | 2C |
| Reply-To | ? | casilla de soporte real (hoy no hay MX en `techrepairpro.app`: definir cuál) | 2C |
| Rate limit de correos | ? | ~100/h, y nunca por encima del cupo diario del plan de Resend | 2C/2E |
| Intervalo mínimo entre correos | ? | 60 s (coincide con el cooldown de la UI) | 2E |
| OTP / link expiry | ≤ 3600 s | 3600 s | 2E (confirmar) |
| OTP length | ? | sin cambio (la app usa links) | — |
| Secure email change | ? | ON | 2E |
| Secure password change | ? | sin cambio (OFF recomendado mientras no haya UI de reautenticación) | — |
| Password minimum length | ? | **8** — **después** de que 2D suba la validación de la UI a 8 (si no, el registro muestra el error crudo) | 2D → 2E |
| Password requirements | ? | ninguno adicional en beta | — |
| Leaked password protection | OFF | ON — **después** de que 2D mapee `weak_password` en el registro | 2D → 2E |
| Confirm signup template | ? | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`, copy en español | 2E (tras deploy de 2D) |
| Recovery template | ? (doc Lote B: `ConfirmationURL`) | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` | 2E (tras deploy de 2D) |
| Invite / Magic link / Change email | ? | sin cambio de contrato; copy en español opcional (§E) | 2E (opcional) |
| Notificaciones de seguridad | ? | ON: contraseña cambiada, email cambiado | 2E |
| Google provider | ON | ON | — |
| Skip nonce check | ? | sin cambio (no aplica a este flujo) | — |
| Google Cloud Console redirect URI | ? | sólo `https://<project-ref>.supabase.co/auth/v1/callback` | 2E (verificar) |
| Anonymous / Phone / SAML | OFF | OFF | — |
| Cuenta demo del portal | activa | baneada | 2B (owner) |

---

## E. Target de templates

**Confirm signup → `token_hash`.** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup`.
El link aterriza en `/auth/callback` del origen permitido (`www` o el portal), no en GoTrue: un
escáner que lo pre-abre no consume nada. Condición: el `redirect_to` tiene que estar en la
allowlist; si no, `.RedirectTo` degrada a la raíz de la Site URL y el `token_hash` queda en `/`, donde
hoy nada lo procesa (2D agrega el reenvío `/` → `/auth/callback`).

**Recovery → `token_hash`.** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`.
Re-confirmado estáticamente que el código actual lo procesa — **CONFIRMADO POR CÓDIGO**:

| Paso | Dónde |
|---|---|
| `recovery` está en la lista cerrada de tipos aceptados | `src/pages/AuthCallback.tsx:39` (`TIPOS_OTP`) |
| la query con el token se borra del historial antes de verificar | `AuthCallback.tsx:123` (`replaceState`) |
| `verifyOtp({ token_hash, type })` | `AuthCallback.tsx:125` |
| éxito → marca de recovery para ese usuario; fallo → «enlace vencido»; y siempre a `/reset-password` | `AuthCallback.tsx:135-141` → `markRecoverySession` / `markRecoveryLinkRejected` (`src/lib/passwordRecovery.ts:149,256`) |
| el evento `PASSWORD_RECOVERY` de `verifyOtp` también marca | `passwordRecovery.ts:313-317` |
| el formulario exige sesión + marca del mismo usuario | `src/pages/ResetPassword.tsx:103` (`hasRecoverySession`) |

Y por test: componente `passwordRecovery` A1/A2 (**CONFIRMADO POR TEST**) + navegador real contra
GoTrue en 2A (B5–B8: formulario, contraseña nueva 200 / vieja 400, link usado → `vencido`). La
captura del fragmento de Lote B se mantiene, así que los correos viejos en vuelo siguen funcionando
durante el cambio.

**Invite user — sin cambio de contrato.** El producto no usa invitaciones de GoTrue: invita con un
token propio (`create_business_invitation`) y un link a `/accept-invite` que se copia desde Usuarios.
Si alguien usara «Invite user» del Dashboard, el invitado entraría sin contraseña y sin negocio; con
`token_hash`, `AuthCallback` ni siquiera acepta `type=invite`. Dejar la plantilla como está y
documentar «no usar».

**Change email address — sin cambio de contrato.** No hay UI de cambio de email. Con el default, el
link vuelve por fragmento (camino implícito) y funciona; su error `otp_expired` sufre la misma mala
clasificación que el alta (lo arregla 2D, no la plantilla). Exigir Secure email change ON.

**Magic link — sin cambio de contrato.** No hay `signInWithOtp` en la app, pero GoTrue igual permite
pedirlo por API para un usuario existente; el default funciona por el camino implícito. Copiarle el
patrón `token_hash` exigiría agregar `magiclink` a `TIPOS_OTP`: no aporta nada hoy.

**Notificaciones de seguridad:** sólo informan (sin links de un solo uso). Activar «contraseña
cambiada» y «email cambiado» en 2E.

---

## F. Plan para Resend (PRE-BETA-2C) — sin configurarlo

**Validación de la arquitectura de 2A:** 2A propuso un subdominio nuevo `mail.techrepairpro.app`. El
DNS muestra que **el dominio raíz `techrepairpro.app` ya tiene los registros de Resend** (return-path
`send.`, DKIM `resend._domainkey`, DMARC `p=none`) y que **no tiene MX** (no hay casilla humana ni
otro emisor cuya reputación proteger). Con eso:

- **Si el Dashboard confirma Custom SMTP → Resend sobre `techrepairpro.app`:** mantener el dominio
  raíz. Sender `TechRepair Pro <no-reply@techrepairpro.app>`. 2C pasa a ser **verificación y
  endurecimiento**, sin DNS nuevo. Un subdominio aparte sólo se justifica si el día de mañana se
  mandan correos de marketing: esos van a otro subdominio, no los de auth.
- **Si Custom SMTP está OFF o apunta a otro lado:** usar igual el dominio raíz ya preparado (verificar
  en Resend que figure «verified»); no crear `mail.` salvo que el owner prefiera aislar.

**Configuración SMTP objetivo en Supabase (2C):** host `smtp.resend.com`, puerto 465 (TLS) o 587
(STARTTLS), usuario `resend`, password = una API key de Resend **con permiso sólo de envío y
restringida a `techrepairpro.app`** (se carga sólo en el Dashboard), sender email/name de arriba.

**DNS a crear:** si el dominio raíz ya está verificado, **ninguno**. Sólo si se eligiera `mail.`:

| Tipo | Nombre | Valor |
|---|---|---|
| MX | `send.mail.techrepairpro.app` | `feedback-smtp.<región>.amazonses.com`, prioridad 10 (la región la asigna Resend; la raíz usa `sa-east-1`) |
| TXT (SPF del return-path) | `send.mail.techrepairpro.app` | `v=spf1 include:amazonses.com ~all` |
| TXT (DKIM) | `resend._domainkey.mail.techrepairpro.app` | la clave pública que muestre Resend |
| TXT (DMARC) | ya cubierto por `_dmarc.techrepairpro.app` (dominio organizacional) | — |

Copiar siempre los valores exactos del panel de Resend: esta tabla es el formato, no los valores.

**DMARC:** ya está `p=none` en la raíz (observación). Sugerencia opcional: agregar
`rua=mailto:<casilla-de-reportes>` para recibir los reportes; recién con 2–4 semanas limpias pasar a
`p=quarantine`. No tocar en 2C sin esa casilla definida.

**Tracking:** en Resend, **click tracking y open tracking OFF** para el dominio de auth: el click
tracking reescribe los links (agrega un redirect propio) y rompería o expondría los links de
confirmación/recovery. Verificarlo explícitamente en 2C.

**Cupo:** revisar el plan de Resend. El plan gratuito tiene un tope **diario** bajo; si se agota, el
envío falla y, con Confirm Email ON, **el signup devuelve 500** (medición documentada en
`scripts/e2e/ci-local.mjs`: sin mailer, signup 500). El rate limit horario de Supabase tiene que quedar por debajo del cupo real.

**Prueba de entregabilidad:** la de 2A §8.3 (Gmail, Outlook/Hotmail, Yahoo, iCloud, M365 con Safe
Links; `Authentication-Results` pass; bandeja; latencia; puntaje ≥ 9/10; 429 neutro), con cuentas QA.

---

## G. `[inbucket]` → `[local_smtp]` (sin cambios en esta rama)

- **CLI instalada:** 2.109.1, la misma que fija CI. Arranca con el WARN de sección deprecada, y
  `supabase init` genera `[local_smtp]` con las **mismas claves**: `enabled`, `port`, `smtp_port`,
  `pop3_port`, `admin_email`, `sender_name`. El contenedor sigue siendo Mailpit
  (`supabase_inbucket_<project>`), mismo puerto y misma API `/api/v1/...`. Medido en 2A.
- **Por qué rompe el E2E:** `tests/e2e/m7/password-recovery.spec.ts:35-40` (`mailpitBase()`) lee
  `supabase/config.toml` y hace `toml.split(/^\[inbucket\]\s*$/m)[1]` para sacar el `port` del bloque;
  si la sección se renombra, el split no encuentra nada y tira «supabase/config.toml no declara
  [inbucket] port» → fallan los 5 tests de recovery.
- **Cambio preparado para 2D (o un lote técnico chico):** renombrar la sección y en el mismo PR
  cambiar la regex a `/^\[(?:local_smtp|inbucket)\]\s*$/m`, actualizar los comentarios de
  `config.toml`, `ci-local.mjs` y los specs. Verificar antes la CLI de cada máquina de desarrollo.
  Mientras tanto el WARN es inocuo.

---

## H. Gates de esta rama — CONFIRMADO POR TEST

| Gate | Resultado |
|---|---|
| `guard:no-hardcoded-credentials` + self-test | OK (0 hallazgos; 22/22) |
| `node --test tests/unit/noHardcodedCredentials.test.ts` | 5/5 |
| `npm run test:unit` completo | **1178/1178** |
| vitest: `portalLoginNoDemo` + 9 suites de auth/portal (`wholesaleEmailConfirmation`, `emailVerification`, `passwordRecovery`, `routingRecoveryOnboarding`, `authProfileLinking`, `canonicalProvisioning`, `invitationsLifecycle`, `mobileSession1a`, `g2c1WholesaleOrderStatus`) | **164/164** |
| `tsc --noEmit` | 0 errores |
| ESLint `src` `--quiet` | 0 errores; `PortalLogin.tsx` sin warnings |
| guards existentes: `auth-redirect`, `onboarding-canonical`, `provisioning-authority`, `mobile-session-1a`, `no-real-data` (normal + self-test) | 10/10 |
| `vite build` de producción + escaneo del bundle | OK; 0/133 archivos con la credencial, el email, los identificadores o el botón demo |
| Controles negativos con el `PortalLogin` original | guard, componente y unit **fallan**, como deben |

No se corrió E2E: el cambio sólo quita una rama `DEV` y agrega un guard; el login del portal quedó
cubierto por el test de componente.

---

## I. Próximo lote — inputs exactos que necesita PRE-BETA-2C

1. **§B.8 completo**, sobre todo: Custom SMTP (ON/OFF, host, usuario, sender) y rate limit de correos.
2. **Resend:** acceso del owner a la cuenta; confirmar que `techrepairpro.app` figura verificado (región
   `sa-east-1`); plan contratado y su cupo diario/mensual; estado de click/open tracking.
3. **Decisión de sender:** `no-reply@techrepairpro.app` (recomendado) vs subdominio; sender name
   («TechRepair Pro»); **Reply-To** real (hoy no hay casilla en el dominio: definir cuál).
4. **Casilla para reportes DMARC** si se quiere `rua` (opcional).
5. **API key de Resend dedicada** (sólo envío, sólo ese dominio) creada por el owner y pegada **sólo**
   en el Dashboard de Supabase.
6. **Lista semilla de cuentas QA** (Gmail, Outlook/Hotmail, Yahoo, iCloud y una M365 con Safe Links) y
   una ventana horaria sin signups reales.
7. **BLK-1 resuelto** (ban verificado) antes de sumar tráfico nuevo.

## J. Deuda anotada, fuera de 2B

`console.log` del email en `loginCustomer`; mensajes crudos de GoTrue en el registro; `services/auth.ts`
muerto; las 3 cuentas «demo» adicionales; y todo lo de 2A §10. Nada de eso entra en esta rama.
