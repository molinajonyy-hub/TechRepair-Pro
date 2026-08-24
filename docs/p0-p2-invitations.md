# P0-P2 — Invitations / alta segura de miembros

**Estado: B — código correcto y CI verde; falta el merge, el `db push` y el smoke humano.**
El merge a `main` y la migración a producción quedaron **sin ejecutar** (bloqueados por el
clasificador de permisos de la sesión). Producción está **intacta**: 232 migraciones, las mismas
que antes de empezar.

- Rama: `fix/p0-p2-invitations-lifecycle`
- PR: https://github.com/molinajonyy-hub/TechRepair-Pro/pull/68
- Commits: `8823fa1` (DB), `ba96881` (frontend)

---

## 1. Baseline

### Estado de partida

| Qué | Valor |
|---|---|
| Branch / HEAD | `main` @ `27ce86c`, working tree limpio, `origin/main` idéntico |
| Migraciones local / prod | 232 / 232, ambas en `20260823180000` — **en sync** |
| `pgcrypto` | instalado en el schema **`extensions`** |
| `gen_random_bytes(integer)` | existe **sólo** en `extensions` |
| `gen_random_uuid()` | existe en `pg_catalog` (por eso ésa sí resolvía) |

### Invitaciones históricas en producción

Revalidado, no asumido:

```
total 0 · pending 0 · accepted 0 · cancelled 0 · expired 0
pending vencidas 0 · duplicados pending por (business_id, email) 0
```

**0 filas.** La migración no toca ningún dato existente. No hizo falta detenerse a reportar counts
antes de instalar la nueva invariante.

### Catálogo real encontrado

| Objeto | Firma | `search_path` |
|---|---|---|
| `create_business_invitation` | `(text, text)` → `business_invitations` | `public, pg_temp` |
| `create_business_invitation` | `(text, text, uuid)` → `text` | `public, pg_temp` |
| `accept_business_invitation` | `(text)` → `uuid` | `public, pg_temp` |
| `cancel_business_invitation` | `(uuid)` → `business_invitations` | `public, pg_temp` |
| `expire_old_invitations` | `()` → `integer` | `public, pg_temp` |

`business_invitations`: RLS activo; `authenticated` con **sólo SELECT**; CHECK de status =
`pending / accepted / cancelled / expired`; CHECK de role admite los 7 roles **incluido `owner`**;
`token` UNIQUE; sin índice de unicidad sobre pending.

`profiles.id` → **FK a `auth.users(id)`** con `DEFAULT gen_random_uuid()`.

Dependencias verificadas antes de retirar la firma legacy: 0 funciones, 0 vistas, 0 triggers,
0 policies, 0 cron jobs. Único caller: el frontend.

### Causa exacta del `gen_random_bytes`

`pgcrypto` vive en `extensions`. Las dos RPC de creación corren con `search_path = public, pg_temp`,
que **no incluye `extensions`**, y llamaban a `gen_random_bytes(24)` sin calificar el schema.
`encode()` sí resolvía porque es de `pg_catalog`, que siempre está implícito — por eso el error
señalaba únicamente a `gen_random_bytes`.

Se arregla **calificando el schema**, no ampliando el `search_path`: meter `extensions` en el path
de una `SECURITY DEFINER` reabriría la superficie que cerró el lote 7C.1. El token sigue siendo
criptográfico (32 bytes → 64 hex); no se degradó a `random()`, timestamp ni hash previsible.

---

## 2. Los 5 bugs, todos medidos contra producción

| # | Bug | Efecto real |
|---|---|---|
| 1 | `gen_random_bytes` sin calificar | **El P0 reportado.** Ninguna invitación se podía emitir |
| 2 | `accept` leía el email del actor y **nunca lo comparaba** con el de la invitación | Cualquier usuario autenticado con el token entraba al negocio |
| 3 | `INSERT INTO profiles(user_id, ...)` omitiendo `id` (FK a `auth.users`, default aleatorio) | **23503 garantizado**: ningún invitado sin perfil podía aceptar, nunca |
| 4 | La rama "ya tiene perfil" movía `business_id` y pisaba `role` sin comparar nada | Un owner del Taller A que abriera una invitación del Taller B **perdía su negocio** y bajaba de rango |
| 5 | Sin barreras de concurrencia (`IF EXISTS` suelto; sin lock al aceptar) | Doble click → N pending; doble aceptación → doble escritura |

Los bugs 1 y 3 juntos significan que **el camino de invitación estaba completamente muerto en
producción**: no se podían emitir, y si se hubiera emitido una, no se podía aceptar.

---

## 3. DB — migración `20260824120000`

Una sola migración, todo dentro de `BEGIN … COMMIT` (las migraciones de Supabase corren en
**autocommit**: sin transacción explícita, una postcondición que falla no revierte nada). Verificado:
un fallo intermedio dejó el esquema intacto.

**`create_business_invitation(p_email, p_role)`** — canónica
- No recibe `business_id`: lo deriva de `auth.uid()` con la identidad canónica `COALESCE(user_id, id)`.
- Allowlist cerrada de roles → `owner` es **imposible** por invitación (el CHECK de la tabla no
  alcanza como gate: admite `owner`).
- Email normalizado `lower(btrim(...))`, con validación de forma.
- Actor debe ser miembro **activo** y `owner`/`admin`.
- `pg_advisory_xact_lock(business, email)` + índice único parcial
  `(business_id, lower(btrim(email))) WHERE status = 'pending'`.
- Expira las pending vencidas de ese `(business, email)` antes de emitir — si no, una vencida
  ocuparía el slot único para siempre.
- Idempotente: si hay una pending viva devuelve **ésa**, con el **mismo token** (un retry no rota un
  token que el usuario quizá ya recibió).

**`accept_business_invitation(p_token)` → `jsonb`**
- Único dato del cliente: el token. Identidad, correo, negocio y rol salen del servidor.
- `email_confirmed_at` fail-closed (misma señal provider-agnostic que `provision_my_business`).
- `SELECT … FOR UPDATE` sobre la invitación, **sin** filtrar por status, para distinguir
  not-found / cancelled / expired en vez de colapsarlos.
- Comparación de email **antes** de revelar el estado: si no, los distintos errores serían un
  oráculo para un tercero con un token ajeno.
- `profiles.id = auth.uid()` **explícito**.
- Miembro del mismo business → no-op idempotente, **sin tocar `role`**.
- Miembro de otro business → `ALREADY_MEMBER_OF_ANOTHER_BUSINESS`, fail-closed.
- Rol revalidado contra la allowlist (una fila histórica podría traer `owner`).
- Alta + transición `pending → accepted` en la **misma transacción**.

**`cancel_business_invitation(p_invitation_id)`**
- Estado `cancelled` (el del CHECK). Se corrigió el caller, **no** el CHECK.
- Sólo `pending`; retry sobre una ya cancelada devuelve la fila; scope de tenant en el `WHERE`.

**API legacy retirada**: `create_business_invitation(text, text, uuid)`. Queda **una** API canónica.

**ACL**: `PUBLIC` revocado en cada (re)creación (EXECUTE a PUBLIC es el default de PG),
`authenticated` con EXECUTE, `anon` sin nada. `search_path = pg_catalog, public, pg_temp` con
`pg_temp` **al final** y explícito.

**12 postcondiciones**, entre ellas: las 3 RPC existen, la legacy no, `accept` devuelve `jsonb`,
ninguna RPC llama a `gen_random_bytes` sin calificar, ninguna inserta en `businesses`, ACL cerrada,
`authenticated`/`anon` sin DML estructural, y `provision_my_business` conserva su defensa
`INVITATION_PENDING`.

---

## 4. Frontend

| Archivo | Cambio |
|---|---|
| `src/services/invitationsService.ts` | **nuevo** — única fuente. Traduce cada SQLSTATE a mensaje de producto mirando `code` **y** `message` |
| `src/lib/pendingInvite.ts` | **nuevo** — preservación del token (localStorage, TTL 30 min, se consume al usarse) |
| `src/pages/AcceptInvite.tsx` | reescrita |
| `src/services/usersService.ts` | se retiran las 4 funciones de invitaciones |
| `src/pages/UsersManagement.tsx` | `showToast` en vez de `window.alert`; cancel por RPC |
| `src/pages/Login.tsx` | +1 línea: preserva el destino a través del signup |
| `src/pages/AuthCallback.tsx` | fallback a `/accept-invite` si hay token guardado |
| `src/contexts/AuthContext.tsx` | limpia el token en el logout |

**Preservación del token.** Se reusa el mecanismo que **ya tenía la app** (`?redirectTo=` +
`sanitizeInternalPath`), que cubre login y OAuth. `pendingInvite.ts` cubre el único hueco que ese
mecanismo no puede cubrir: `post_login_redirect` vive en `sessionStorage`, que es **por pestaña**, y
el enlace de confirmación de correo se abre casi siempre en una pestaña nueva. Guarda **sólo** el
token, con TTL corto, se consume al primer uso y se limpia en el logout.

**Errores.** `InvitationError.message` **ya es** el texto que ve el usuario, así que ningún caller
puede filtrar un SQLSTATE por accidente. El P0 se veía literalmente como
`function gen_random_bytes(integer) does not exist` dentro de un `alert()`.

**La lista de pendientes filtra también las vencidas**: `expire_old_invitations()` existe pero
**no está agendada en cron** (los 3 jobs activos son `expire_trials`, `enforce_grace_period`,
`apply_whatsapp_logs_retention`), así que una pending vencida figuraba como utilizable cuando el
accept ya la rechaza.

---

## 5. Tests

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | **0** |
| `lint:errors` | **0** |
| `build` | OK |
| unit (`node --test`) | **1032 / 1032** |
| components (vitest) | **438 / 438** — 24 nuevos |
| SQL (`npm run test:sql:p0p2`) | **31 / 31** |
| E2E `m7-local` | **86 / 86** — 6 nuevos |
| guard `provisioning-authority` | pass |
| CI en el PR | TypeScript+Lint+Build ✅ · E2E ✅ · Vercel ✅ |

Los 31 casos SQL cubren los 31 puntos del brief. El E2E recorre el camino real con navegador y
varios actores: alta completa, logout/login, token ajeno, owner de otro taller, retry, y el rodeo
por login.

### Pruebas negativas — 5/5 gates demostrados

`npm run test:p0p2:negative-gates` rompe a propósito cada invariante y verifica que el gate falle:

| Mutación | Gate | Resultado |
|---|---|---|
| A · comparación de email → `IF false` | test 17 | ✅ falló como debía |
| B · `accept` crea un business | postcondición P12 | ✅ rechazó la migración |
| B · idem, salteando postcondiciones | test 15 | ✅ detectó el business de más |
| C · `gen_random_bytes` sin calificar | postcondición P3 | ✅ rechazó la migración |
| C · idem, salteando postcondiciones | test del P0 | ✅ **reprodujo el error productivo exacto** |

Las mutaciones viven sólo dentro del contenedor local y se revierten solas; nada roto se commiteó.

---

## 6. Dos hallazgos del proceso

**Un chequeo textual sobre `pg_get_functiondef` se dispara con su propia documentación.**
La postcondición P3 falló en la primera corrida — no por un bug, sino porque la migración **cita el
mensaje de error productivo** (`function gen_random_bytes(integer) does not exist`) dentro de un
comentario, y el match lo contó como una llamada real. Mismo problema después en 3 aserciones
estructurales del test de componentes. La regla: **quitar los comentarios antes de buscar código**.

**`auth.admin.listUsers()` pagina (50 por página) y eso es una trampa silenciosa.**
La limpieza del E2E no encontraba usuarios que existían, así que no borraba nada, y el run siguiente
moría en el **setup** con `already been registered` — un rojo sin relación con el contrato. Se
reemplazó por una consulta SQL directa, y se agregó un `afterEach` incondicional para que la suite
sea re-ejecutable aunque un caso falle a la mitad.

---

## 7. Pendiente

1. **Merge del PR #68** → Vercel publica el frontend.
2. **`supabase db push`** → aplica `20260824120000`. **En ese orden.**
3. **Smoke humano** con un email nuevo.

### Por qué frontend primero

La migración **no** es compatible hacia atrás: retira la firma que llama el frontend desplegado hoy.
Al revés sí es seguro, y es además la regla ya medida del proyecto (Vercel deploya en el merge, el
`db push` es manual y posterior, ventana ~5 min).

Durante esa ventana el frontend nuevo habla con la DB vieja: `create` llama a la firma de 2
argumentos, que **ya existe** en producción, corre el código viejo y falla con el **mismo**
`gen_random_bytes` de hoy. No es una regresión — es la misma falla ya abierta, y el `db push` la
cierra. `cancel` ya funciona, el listado no cambia, y el parser del accept tolera ambas formas de
retorno a propósito.

### Counts de producción — antes

| | |
|---|---|
| auth users | 17 |
| profiles | 17 |
| businesses | 26 (6 `trialing`) |
| invitations | 0 |
| profiles huérfanos | 0 |
| migraciones | 232 |

Después del smoke se espera: **+1 auth user, +1 profile, +0 businesses, +0 trials**, invitación en
`accepted`, 0 huérfanos nuevos.

---

## 8. Invariantes

```
provision_my_business()
  = única autoridad creadora de businesses owner

accept_business_invitation()
  = incorpora un miembro a un business EXISTENTE
  = nunca crea businesses

usuario miembro de otro business
  = fail closed (ALREADY_MEMBER_OF_ANOTHER_BUSINESS)

email del actor != email invitado
  = fail closed (INVITATION_EMAIL_MISMATCH)
```

Las cuatro están aseveradas en SQL, en componentes y en E2E, y las tres primeras además por
postcondición de migración.

---

## 9. Handoffs (fuera de alcance, registrados)

- **Envío automático de emails de invitación**: sigue sin existir. El owner comparte el link a mano.
- **`expire_old_invitations()` sin agendar**: mitigado en la lectura y en el accept, pero el cron
  sigue sin existir. Un job diario cerraría el hueco de presentación.
- **`PermissionsMatrix` en el modal de invitación no persiste nada**: el bloque muerto que lo
  simulaba se retiró; la matriz sigue visible y sin efecto. El owner ajusta permisos después del
  alta. Es preexistente y toca el lote de permisos.
- **`current_business_id()` conserva `EXECUTE` a `PUBLIC`**: preexistente. Revocarlo requiere
  analizar las policies que lo usan (revocarle helpers a `anon` rompe policies con 42501).
- **Divergencia local/prod**: el trigger `on_auth_user_created` sólo existía en producción, así que
  el stack local no podía replicar `20260823150000`. Se creó un stub local para desbloquear el
  replay; **no** se tocó el repo ni producción.
