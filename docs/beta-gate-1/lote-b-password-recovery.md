# BETA-GATE-1 · Lote B — Recuperación de contraseña

**Base:** `origin/main` `74bde4f` (Merge PR #137, Lote A).
**Alcance:** sólo frontend. Sin migraciones, sin cambios en la config de Auth, sin cambios en las plantillas de
correo y sin cambiar el `redirectTo`.

## 1. Causa raíz (medida, no supuesta)

El brief y la memoria hablaban de un "link PKCE". **No es PKCE.** El cliente de Supabase no configura `flowType`
y el default de `@supabase/supabase-js` 2.103 es **`implicit`**.

Medido contra GoTrue v2.192 del stack local:

| Paso | Lo que devuelve GoTrue |
|---|---|
| `POST /recover` con un email existente | `200` y manda el correo "Reset your password" |
| `POST /recover` con un email **inexistente** | `200 {}`, sin correo |
| `POST /recover` con el **mismo** email existente otra vez | **`429 over_email_send_rate_limit`** |
| Link del correo | `/auth/v1/verify?token=…&type=recovery&redirect_to=<origen>/auth/callback` |
| `GET` al link (primera vez) | `303 → /auth/callback#access_token=…&refresh_token=…&type=recovery` |
| `GET` al link (ya usado) | `303 → /auth/callback#error=access_denied&error_code=otp_expired&…` |

Con eso, el flujo anterior era:

1. supabase-js procesaba el fragmento por su cuenta: guardaba la sesión y emitía `PASSWORD_RECOVERY` en un
   `setTimeout`. **Nadie escuchaba ese evento.**
2. `AuthCallback` sólo lee `window.location.search`. Sin `token_hash` tomaba la rama OAuth y, al resolver la
   sesión, navegaba a `/dashboard` (o `/no-business` si el usuario no tiene negocio): **logueado y sin formulario**.
3. `ResetPassword` esperaba `sessionStorage['is_password_recovery']`, **que ningún archivo escribía**.
4. Un link usado caía en `/login` sin ningún mensaje.
5. La UI mostraba "Enviamos un enlace a {email}" y, si GoTrue fallaba, el texto crudo del servidor. Al mostrar
   el 429 de un pedido repetido, **la pantalla revelaba que la cuenta existía**.

**Control negativo (E2E real):** con `src/lib/supabase.ts` vuelto a la versión de `main`, el spec falla
exactamente así:

```
Expected pattern: /\/reset-password$/
Received string:  "http://localhost:5184/no-business"
  - unexpected value "http://localhost:5184/auth/callback#"
```

## 2. Flujo nuevo

```
Login → «¿Olvidaste tu contraseña?» → email
  → «Si existe una cuenta asociada a ese correo, te enviamos instrucciones.»   (siempre; sólo la red es error)
  → correo → link → GoTrue 303 → /auth/callback#access_token=…&type=recovery
  → src/lib/supabase.ts, ANTES de createClient:
       captureRecoveryAtBoot → el fragmento sale de la URL: replaceState('/reset-password') en la MISMA entrada
                               del historial; los tokens del fragmento quedan en memoria sólo durante el handoff
  → createClient (supabase-js ya no encuentra fragmento)
  → completeRecoveryHandoff → auth.setSession(tokens) instala una sesión NORMAL de Supabase (el cliente la persiste
                               con su storage habitual) → se borra la copia en memoria → marca {userId, at} en
                               sessionStorage (sin tokens)
  → /reset-password: formulario SÓLO con sesión vigente + marca del MISMO usuario
  → updateUser({ password }) → «Contraseña actualizada» → /dashboard (con sesión) o /login (sin sesión)
```

Decisiones:

- **El `redirectTo` no cambia** (`/auth/callback`). Esa URL exacta ya está probada contra la allowlist del
  panel de Supabase. Moverla a `/reset-password` exigía tocar la config de Auth en producción y arriesgaba caer
  al Site URL.
- **`setSession` en vez de dejar que supabase-js procese la URL.** supabase-js limpia el fragmento con
  `location.hash = ''`, que **agrega** una entrada al historial y deja la URL con tokens detrás del botón
  "atrás". `replaceState` antes de crear el cliente no deja ninguna. `setSession` es la API documentada para una
  sesión que llega por fuera de la URL.
- **La marca es por pestaña y sin secretos:** id de usuario + hora, TTL 1 h. Sirve para que un reload de
  `/reset-password` conserve el formulario y para que una sesión **normal** no lo vea.
- **Camino `token_hash`** (por si alguna vez la plantilla de recovery pasa a `{{ .TokenHash }}`): `AuthCallback`
  marca la sesión tras `verifyOtp` o, si el enlace no sirvió, deriva a "enlace vencido". Antes quedaba en
  "Verificando enlace…" para siempre.
- **Login en modo recuperar no redirige a un usuario autenticado.** Caso real: el mismo link abierto dos veces.
  La primera pestaña crea la sesión (compartida por `localStorage`) y la segunda ve "vencido". Su "Pedir un
  enlace nuevo" terminaba en el Dashboard.

## 3. Estados de `/reset-password`

`data-estado` en `reset-password-page`:

| Estado | Cuándo | Qué ve el usuario |
|---|---|---|
| `verificando` | los tokens del link se están validando (tope 20 s) | spinner |
| `formulario` | sesión + marca del mismo usuario | nueva contraseña + confirmación, mostrar/ocultar, validación |
| `invalido:vencido` | `otp_expired` (link usado o vencido), o `verifyOtp` rechazado | "El enlace ya no es válido" + "Pedir un enlace nuevo" |
| `invalido:invalido` | tokens rechazados por GoTrue, link malformado, sesión vencida al guardar | "No pudimos validar el enlace" |
| `invalido:sin_sesion` | entrar directo, o con una sesión normal | "Abrí el enlace desde tu correo" |
| `listo` | contraseña guardada | confirmación + redirección en 3 s |

Validación: mínimo 8 caracteres, no sólo espacios, máximo 72 **bytes UTF-8** (límite de bcrypt en GoTrue, que
trunca en silencio) y que las dos coincidan. Como el límite es en bytes y no en caracteres, el mensaje no da un
número: «Usá una contraseña más corta.» Errores de `updateUser` mapeados (`same_password`, `weak_password`, sesión,
429, red), **nunca el texto crudo del servidor**. Anti doble envío con ref + botón deshabilitado.

## 4. Seguridad de tokens, códigos y URL

- El fragmento con tokens se reemplaza **antes** de que corra cualquier código de auth, en la misma entrada del
  historial. E2E: la barra no tiene `#` ni `access_token`, y ninguna entrada detrás de "atrás" tampoco.
- Los tokens recibidos en el fragmento quedan en una variable del módulo **sólo durante el handoff**, y esa copia
  se borra antes de llamar a `setSession`.
- `auth.setSession()` instala una **sesión normal de Supabase**. El cliente la persiste con su storage habitual
  (`persistSession: true`), exactamente igual que después de cualquier login. Este lote no cambia ese
  comportamiento.
- Nosotros **nunca** persistimos a mano los tokens del fragmento, ni en `sessionStorage` ni en ningún otro
  lado, y nunca los logueamos. La marca en `sessionStorage` sólo tiene id de usuario + hora. E2E: el
  `access_token` real no aparece ni en `sessionStorage` ni en la consola del navegador.
- El módulo no loguea nada (test unitario que lo verifica) y no importa el cliente.
- **La UI no revela existencia de cuenta:** email inexistente, rate limit (429) y cualquier error de Auth que no
  sea de red muestran el mismo mensaje neutro. Sólo un fallo de red se informa como error.
- **Alcance de lo anterior:** la UI no revela existencia de cuenta. El comportamiento observable del endpoint
  Auth directo y sus rate limits pertenece a Supabase/GoTrue y queda como riesgo residual de infraestructura.
  (MEDIDO: `POST /auth/v1/recover` repetido para un email existente responde 429 y para uno inexistente 200;
  quien llame al endpoint directo, sin la UI, puede observar esa diferencia.) Este PR no agrega proxy, Edge
  Function, CAPTCHA, migraciones ni cambios de Auth.
- Analytics (GA4/Clarity) sólo se inicializa en `/landing` y `/onboarding`, así que no ve estas URLs. El logger
  no tiene sink remoto.

## 5. Usuarios Google-only

- El OAuth implícito (`#access_token=…` **sin** `type=recovery`) no se intercepta. Test unitario con
  `provider_token`.
- E2E real: un usuario **sin contraseña, con identidad `google` y sin identidad `email`** puede pedir el enlace,
  definir una contraseña, conserva la identidad de Google (`auth.identities` y `providers`) y, desde entonces,
  también entra con email + contraseña (password grant = 200).

## 6. Fuera de alcance, anotado

- El dominio del portal mayorista no monta `/reset-password` ni ofrece "olvidé mi contraseña". Ahí no se
  intercepta nada: el comportamiento previo queda intacto.
- Si algún día se activa `flowType: 'pkce'`, el link volvería con `?code=` y este lote no lo cubre. Un test
  unitario falla si aparece `flowType` en `src/lib/supabase.ts`, para forzar la revisión.
- No se revocan las otras sesiones del usuario al cambiar la contraseña (`signOut({ scope: 'others' })`). En un
  taller es habitual tener la misma cuenta abierta en el mostrador; es una decisión de producto.
- La plantilla de recovery usa `{{ .ConfirmationURL }}`, que se consume con un `GET`: un escáner de correo que
  pre-visite el link lo invalida. Pasarla a `token_hash` lo evitaría, pero es un cambio de config de Auth y no
  hace falta para que el flujo funcione.
- Enumeración contra el endpoint Auth directo (`/auth/v1/recover`) y sus rate limits: riesgo residual de
  infraestructura de Supabase/GoTrue (ver §4). Sin proxy, Edge Function ni CAPTCHA en este lote.

Todo lo de esta sección son decisiones separadas y no bloquean el lote.

## 7. Validación

| Gate | Resultado |
|---|---|
| `node --test tests/unit/passwordRecovery.test.ts` | **25/25** |
| `npm run test:unit` (suite completa) | **1155/1155** |
| `tests/components/passwordRecovery.test.tsx` | **24/24** |
| Suites de auth existentes (emailVerification, authProfileLinking, invitationsLifecycle, routingRecoveryOnboarding, wholesaleEmailConfirmation, canonicalProvisioning, mobileSession1a, edgeCorsClientContract) | **151/151** junto con el nuevo |
| Vitest completo | 1237/1238; la única falla (`orderIntakeMobile`, scanner de cámara) pasa 8/8 aislada: flake por carga de la máquina |
| `tsc --noEmit` | 0 errores |
| ESLint `--quiet` (repo) | 0 errores |
| guards `auth-redirect`, `mobile-session-1a`, `edge-cors-contract`, `pwa-install`, `onboarding-canonical`, `first-steps` | OK |
| **E2E real** `tests/e2e/m7/password-recovery.spec.ts` (GoTrue + Mailpit locales) | **5/5** |
| E2E `password-recovery` + `email-verification` + `p0p2-invitations` + `p0p4p5-routing-onboarding` | **23/23** |
| Control negativo (supabase.ts de `main`) | falla: `/auth/callback#` → `/no-business` |

El E2E corrió contra un stack Supabase **aislado** (`project_id` propio, puertos 543xx, preview en 5184), para
no pisar otros stacks locales. Ese cambio de `config.toml` fue temporal y no forma parte del PR.

## 8. Rollout y rollback

- **Rollout:** merge → Vercel despliega el frontend. No hay Edge Functions, migraciones, secrets ni config de
  Auth que tocar.
- **Smoke humano en producción:** con una cuenta QA (nunca Clic):
  1. pedir el enlace;
  2. abrirlo y confirmar que aparece "Nueva contraseña" y que la barra no tiene `#`;
  3. guardar y entrar con la nueva contraseña;
  4. abrir el mismo enlace otra vez y ver "El enlace ya no es válido".
- **Rollback:** revertir el merge commit. El frontend anterior vuelve al comportamiento previo (roto pero
  inocuo): no hay estado persistido que migrar. La marca en `sessionStorage` es por pestaña y se ignora.
- **Impacto en Clic:** ninguno sobre datos, fiscalidad ni caja. El único cambio visible para un usuario logueado
  es que `/login?modo=recuperar` ya no lo redirige.
