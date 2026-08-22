# EMAIL VERIFICATION P0 — provisioning diferido hasta confirmar el correo

Rama: `feat/email-verification-p0` · Migración: `20260823120000` (DB 229 → 230)

> **Confirm Email sigue APAGADO en producción.** Nada de este lote lo activa.
> El switch lo prende el owner a mano, desde el panel de Auth, **después** del
> deploy de frontend + DB y de las validaciones.

---

## 1. Causa raíz

`handle_new_user()` creaba **siempre** un `business` + un `profile` en el
`AFTER INSERT` sobre `auth.users`. Con «Confirm Email» apagado eso era
correcto: todo INSERT nacía ya confirmado.

Al activar Confirm Email, ese mismo trigger provisiona un negocio completo
—con su trial de 14 días— para **cada dirección de correo tipeada en el
formulario de registro**, confirmada o no. Un usuario no operativo, que quizá
nunca confirme, ya consumió un tenant.

Dos defectos colaterales que salieron en el discovery:

- **El trigger `on_auth_user_created` nunca estuvo formalizado en migrations.**
  Existía sólo en producción (verificado por catálogo). Un `db reset` local
  producía un stack **sin provisioning**, así que local y prod estaban
  divergentes.
- **El login mapeaba `email not confirmed` a «Email o contraseña
  incorrectos».** Con Confirm Email ON ese pasa a ser el error más frecuente
  del login, y mandaba al usuario a revisar una contraseña que estaba bien.

---

## 2. Contrato anterior → nuevo

| Caso | Antes | Ahora |
|---|---|---|
| INSERT con `email_confirmed_at` NOT NULL (Google OAuth, admin API) | provisiona | **provisiona igual** (sin cambios) |
| INSERT con `email_confirmed_at` NULL (email+password, Confirm ON) | provisiona | **no crea nada** |
| UPDATE `email_confirmed_at` NULL → NOT NULL | no hacía nada | **provisiona** |
| Re-disparo / reescritura del timestamp | N/A | **no duplica** (guard idempotente) |
| Usuarios ya confirmados | — | **intactos**, sin backfill |

La señal canónica es `email_confirmed_at`, **provider-agnostic**. No hay
—ni debe haber— ninguna rama `provider === 'google'`: Google llega confirmado
vía GoTrue y entra por el mismo camino que un usuario de email que ya confirmó.

---

## 3. Provisioning y triggers

Una **sola** función `SECURITY DEFINER` (`handle_new_user`, la que ya existía)
y **dos triggers** que la comparten:

```
on_auth_user_created          AFTER INSERT ON auth.users
on_auth_user_email_confirmed  AFTER UPDATE OF email_confirmed_at ON auth.users
                              WHEN (OLD.email_confirmed_at IS NULL
                                AND NEW.email_confirmed_at IS NOT NULL)
```

**No se introdujo ninguna función SECDEF nueva.** `NEW` tiene la misma forma en
INSERT y en UPDATE, así que la misma función sirve para los dos caminos y la
superficie privilegiada no crece. Una postcondición de la migración verifica
que ambos triggers apunten al mismo `tgfoid`.

El guard de idempotencia mira `profiles.id` **y** `profiles.user_id`: las dos
son identidades válidas de un perfil (`handle_new_user` escribe `id`,
`link_profile_to_auth_user` de la migración `20260822160000` escribe
`user_id`). Mirar sólo una crearía un business duplicado para un usuario cuyo
perfil fue reparado por el link.

---

## 4. URL canónica y open redirect

`src/lib/authRedirect.ts` es ahora la única fuente de redirects de auth.

**El origen se preserva dentro de una allowlist cerrada**, no se fuerza un
dominio fijo. La razón es concreta: la sesión de Supabase vive en el
`localStorage` del **origen**. Si un cliente del portal mayorista se registra en
`clicmayorista.com.ar` y el enlace de confirmación lo manda a
`techrepairpro.app`, la sesión queda del lado equivocado y el alta mayorista no
puede completarse nunca.

Por eso `/auth/callback` también se montó en el dominio del portal (App.tsx),
**antes** del catch-all que lo estaba tragando.

`sanitizeInternalPath()` cubre el `?redirectTo=` del login. Rechaza: URLs
absolutas, `//host`, `/\host`, cualquier backslash, control chars y whitespace,
`%2f%2f` (se re-chequea sobre el valor decodificado), escapes mal formados, y
las propias rutas de auth (que producirían un loop post-login).

---

## 4bis. Hallazgo medido: GoTrue y el login sin confirmar

Probado contra el GoTrue local:

```
enable_confirmations = false
admin.createUser({ email_confirm: false })   -> email_confirmed_at NULL
signInWithPassword(...)                      -> 400 "Email not confirmed"
```

**`enable_confirmations` gobierna el SIGNUP (lo auto-confirma), no el password
grant.** GoTrue rechaza el login de un usuario sin confirmar en los dos casos.

Consecuencias, que dieron forma al diseño:

1. **Con Confirm Email ON, un usuario sin confirmar NO PUEDE obtener sesión por
   login.** Así que el guard de `ProtectedRoute` es *defensa en profundidad*
   —cubre sesiones anteriores al switch y bordes de OAuth— y no la única
   barrera. Se mantiene igual: §12 lo pide y el costo es nulo.

2. **El estado principal de `/verificar-email` es SIN SESIÓN.** `signUp`
   devuelve `session: null`, así que `user` es `null`. La primera versión de la
   pantalla exigía sesión y rebotaba a `/login`: habría dejado al usuario recién
   registrado sin forma de reenviarse el correo. Se corrigió guardando el email
   pendiente en `sessionStorage` (`trp_pending_confirmation_email`) — sólo el
   email, nunca un token — y se cubrió con los tests A2–A5.

3. **El camino visible del "usuario que no confirmó" es el LOGIN**, no el guard.
   Por eso el mapeo de errores de `Login.tsx` es parte central del lote y no un
   detalle: es la pantalla donde ese usuario va a terminar.

4. **El stack local necesita `enable_confirmations = true`** para poder recorrer
   el flujo. Se encendió en `supabase/config.toml` (local únicamente; la config
   de Auth de producción vive en el panel). No rompe la suite existente: los
   usuarios sembrados se crean con `email_confirm: true` y ningún spec hace
   signup por UI — verificado corriendo la suite `m7-local` completa.

---

## 5. Fuera de alcance — DOCUMENTADO, NO CORREGIDO

Todo lo de abajo se detectó durante el discovery y **no se toca en este PR**.

1. **Wizard de onboarding salteado.** `/onboarding` existe y ahora está
   protegido, pero el flujo real sigue derivando a `/no-business`.
2. **`bootstrap_owner_profile` muerto.** Sin llamadores.
3. **Rama ELSE rota de `accept_business_invitation`.**
4. **5 businesses huérfanos** (22 businesses vs 17 profiles en prod). Esta
   migración **no los limpia**. Nota: parte de ellos vienen de que
   `handle_new_user` también provisiona un negocio para los signups del portal
   mayorista, que no lo necesitan.
5. **12/14 negocios llamados «Mi Negocio»** — es el default de
   `handle_new_user` cuando el signup no manda `business_name`. Los registros
   mayoristas caen ahí (y siguen cayendo: la metadata nueva va namespaced
   justamente para **no** alterar ese comportamiento en este lote).
6. **Cleanup de trials.**
7. **ACL de `current_business_id`.**
8. **ARCA onboarding.**
9. **Reset de contraseña con doble entrada.** `Login.tsx` manda
   `resetPasswordForEmail` a `/auth/callback` mientras `services/auth.ts` usa
   `/reset-password`. El callback ahora enruta un `type=recovery` con
   `token_hash` a `/reset-password`, pero el camino PKCE (`?code=`) sigue
   cayendo en el dashboard como antes. No se cambió.

---

## 6. Verificación ejecutada

| Gate | Resultado |
|---|---|
| `supabase db reset` (230 migraciones) | OK |
| `tests/sql/email_verification_provisioning.test.sql` (A–J + extra) | OK, termina en ROLLBACK |
| Postcondiciones estructurales de la migración | 6/6 |
| `tests/unit` (`node --test`) | 1030/1030 |
| `tests/components` (vitest) | 395/395 |
| `npx tsc --noEmit` | 0 errores |
| `npm run lint:errors` | 0 |
| `npx vite build` | OK |
| `npm run guards` | OK (exit 0) |
| E2E `tests/e2e/m7/email-verification.spec.ts` | 5/5 con Confirm Email ON |

### Anti-falso-verde — cada fix se rompió a propósito

| Se rompió | Gate que lo cazó |
|---|---|
| Provisioning inmediato reintroducido en `handle_new_user` | SQL: `A: se creo un profile para un usuario SIN confirmar (n=1)` |
| Guard de `emailConfirmed` sacado de `ProtectedRoute` | 4 tests, incluido el bypass por URL |
| Callback vuelto a PKCE-only | 3 tests de `token_hash` |
| Mayorista vuelto a INSERT inmediato | test O, con estado no autenticado |
| `/verificar-email` volvió a exigir sesión | 3 tests (A2, A3, A5) |

Todos revertidos y re-verificados en verde.

### Un falso negativo que se descartó

El primer intento de E2E reusaba el `storageState` del owner y le ponía
`email_confirmed_at = NULL` por SQL. El guard no reaccionaba — y **está bien
que no reaccione**: el cliente lee ese campo de la sesión guardada, no de la
base. Además «des-confirmar» no existe en el producto. El spec se rehízo sobre
un usuario que **nace** sin confirmar y una sesión real obtenida por la UI.

### Counts read-only de producción (pre-deploy)

```
auth.users total ........ 17
confirmados ............. 17
sin confirmar ............ 0
profiles ................ 17
businesses .............. 22   (5 huérfanos, fuera de alcance)
wholesale_customers ...... 1
confirmados sin profile .. 0   (postcondición 6 pasaría en prod)
```

Ningún usuario existente queda bloqueado.

---

## 7. Orden de deploy

1. **Frontend primero** (Vercel auto-deploya en el merge). El bundle nuevo
   tolera el contrato viejo de la DB: sin el trigger de confirmación,
   `emailConfirmed` es `true` para todos los usuarios actuales y nada cambia.
2. **`npx supabase db push`** — mergear NO aplica migraciones.
3. Validar: login normal, Google OAuth, portal mayorista.
4. **Recién entonces**, y a mano, el owner activa Confirm Email en el panel de
   Auth.

Antes de activar el switch, agregar a la allowlist de Redirect URLs del panel:
`https://techrepairpro.app/auth/callback` y
`https://clicmayorista.com.ar/auth/callback`.
