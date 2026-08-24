# P0-P4 + P0-P5 — Routing / recovery y onboarding persistente

**Estado: EN PRODUCCIÓN — 2026-08-24. Falta únicamente el smoke humano.**

- PR: https://github.com/molinajonyy-hub/TechRepair-Pro/pull/69 — **MERGED**
- Merge commit: **`17ad45f`** (2026-08-24 19:55:24Z)
- Vercel: `/version.json` → `{"commit":"17ad45f","buildTime":"2026-08-24T19:55:40Z"}`
- DB: **233 → 234**, head `20260825120000`, 10 postcondiciones OK
- Orden: **DB primero** (RPC aditivas), frontend después
- La migración tocó **0 filas de datos**

---

## 1. Baseline

`main` @ `43dc028`, working tree limpio, local 233 = prod 233.

### Lo que había, medido

| | |
|---|---|
| businesses | 26 · con rubro **1** · con logo **2** · `onboarding_completed` 16 |
| `business_settings` | 8 filas → **18 de 26 negocios sin fila** |
| profiles | 18 · **11 con `user_id IS NULL`** |
| `storage.objects` en `business-assets` | 1 |
| `authenticated` sobre `businesses` | **sólo SELECT** |
| `authenticated` sobre `business_settings` | SELECT/INSERT/UPDATE/DELETE |

Se confirmó además que el smoke humano de P0-P2 pasó: auth users 17→18, profiles
17→18, **businesses 26→26**, trials 6→6, 1 invitación aceptada, 0 huérfanos.

---

## 2. Máquina de estados final (P0-P4)

```
AUTH_LOADING                    ── esperando sesión            → nadie redirige
UNAUTHENTICATED                                                → /login
EMAIL_UNCONFIRMED                                              → /verificar-email
AUTHENTICATED_PROFILE_LOADING   ── esperando perfil            → nadie redirige
AUTHENTICATED_WITH_BUSINESS                                    → producto
AUTHENTICATED_WITHOUT_BUSINESS  ── no_profile confirmado       → /no-business (alta)
AUTH_ERROR                      ── no pudimos averiguarlo      → /no-business (reintentar)
```

`authState` es **derivado**, no un `useState` paralelo: no puede desincronizarse
de los datos que resume. Se agregan `profileResolved` (una carga terminó para
esta sesión) y `profileErrorKind` (`none` / `no_profile` / `link_failed` /
`transient` / `inactive`).

### Causa raíz P0-P4

`profile === null` significaba **dos cosas incompatibles**: «todavía no cargó» y
«no existe». La condición de espera miraba `profileLoading`, que arranca en
`false` **antes** del primer intento, así que existía una ventana de render en la
que un owner con negocio era indistinguible de uno sin negocio.

Y `NoBusiness.tsx` tenía arriba de todo un `useEffect` que redirigía **sin
condiciones** (con negocio → `/dashboard`, sin negocio → `/onboarding`): toda la
UI de recuperación de abajo era **código muerto que nadie vio nunca**, y
cualquiera sin negocio terminaba en el wizard de owner — incluido un invitado.

---

## 3. Causa raíz de la persistencia (P0-P5) — dos, no una

El wizard hacía seis `supabase.from('businesses').update(...)` sueltos:

1. **42501** — `authenticated` no tiene GRANT de UPDATE sobre `businesses`.
   Existe una policy `businesses_update` correcta, pero es **código muerto**:
   GRANT y RLS son capas distintas y PostgreSQL corta en la primera.
2. **42703** — `condicion_fiscal`, `cuit` y `payment_methods_enabled` **no
   existen** en `businesses`. Los fiscales viven en `business_settings`.

Invisible porque **`supabase.from().update()` no lanza**: devuelve
`{ data, error }`, y el wizard hacía `await ...update(...)` sin mirar `error`. El
`try/catch` no atrapaba nada y el paso avanzaba igual.

---

## 4. Causa raíz del logo (Storage RLS)

Las tres policies de escritura sobre `business-assets` hacían:

```sql
auth.uid() IN (SELECT profiles.user_id FROM profiles
                WHERE COALESCE(profiles.user_id, profiles.id) = auth.uid())
```

Filtran con `COALESCE` pero **proyectan la columna cruda `user_id`**.
`provision_my_business` crea el perfil con `id = auth.uid()` y `user_id` NULL →
la subconsulta devuelve NULL y `auth.uid() IN (NULL)` es **NULL**, no true.

**MEDIDO: 11 de 18 perfiles tienen `user_id IS NULL` → el 61% de los usuarios no
podía subir su logo.** Los 7 que sí podían son perfiles viejos con la columna
poblada; por eso «desde Configuración funciona» según quién probara. Es un bug
**latente** que P0-P1 destapó al cambiar cómo se crean los perfiles.

**Segundo defecto, independiente**: la policy era **ciega al tenant** — sólo
preguntaba «¿este actor tiene algún perfil?». Como el path lo arma el cliente, un
usuario del negocio A podía sobrescribir el logo del B.

---

## 5. Arquitectura final

**Path**: `business-logos/<business_id>/logo-<ts>.<ext>` — el id es una
**carpeta**, que `storage.foldername()` sí lee, así que la pertenencia se valida
server-side contra `current_user_business_id()`. Antes iba en el **nombre** del
archivo, invisible para cualquier policy.

**No se relaja nada, se cierra**: antes alcanzaba con tener un perfil cualquiera;
ahora hay que ser owner/admin **del negocio dueño de la carpeta**. La lectura
pública no se toca — el logo ya subido y los comprobantes impresos siguen
resolviendo. No se migran archivos.

**RPC** (migración `20260825120000`):

| | |
|---|---|
| `get_my_business_onboarding()` | precarga y reanudación |
| `update_my_business_onboarding(...)` | escritura con **allowlist de columnas** |

**No se repone el GRANT de UPDATE**: la policy filtra por FILA, no por COLUMNA,
así que dejaría al cliente tocar `owner_user_id` o `subscription_*`. La RPC
deriva el negocio de `auth.uid()` y **no acepta `business_id`** — el cross-tenant
es imposible por construcción. `NULL` = «no tocar» (guardado por pasos). Los
fiscales van por **UPSERT** a `business_settings`: 18 de 26 negocios no tienen
fila y un `UPDATE` suelto tocaba 0 filas sin error.

`onboarding_completed` se marca validando lo **realmente persistido**, no los
parámetros de la llamada; el retry no pisa la fecha original.

### Inventario de campos

| Paso | Campo | Destino real |
|---|---|---|
| 1 | nombre, rubro | `businesses.name`, `businesses.rubro` |
| 2 | logo | Storage + `businesses.logo_url` + `business_settings.logo_url` |
| 3 | WhatsApp, ciudad | `businesses.wholesale_whatsapp`, `businesses.ciudad` |
| 4 | CUIT, condición fiscal | `business_settings.cuit`, `business_settings.condicion_iva` |
| 5 | métodos de pago | **no persiste** — ver handoffs |
| 6 | completar | `onboarding_completed` + `_at` |

---

## 6. Una race real que encontró el E2E

`loadProfile` deduplica requests. Bien para dos cargas de la misma verdad, **bug**
cuando el perfil acaba de cambiar: `refreshProfile()` después de aceptar una
invitación se colgaba de la request que arrancó **antes** del accept y resolvía
con «sin negocio», así que el usuario rebotaba a `/no-business` con la membresía
ya creada en la base.

Se cierra con una **generación** de carga: `refreshProfile` la incrementa y
arranca una nueva; las respuestas viejas se descartan en vez de pisar el estado,
y el `finally` también queda guardado. Aplica a los tres puntos donde el perfil
muta y se refresca enseguida: aceptar invitación, crear el negocio, terminar el
onboarding.

---

## 7. Tests

| Gate | Resultado |
|---|---|
| `tsc --noEmit` · `lint:errors` · `build` | 0 · 0 · OK |
| unit | **1032 / 1032** |
| components | **459 / 459** (21 nuevos) |
| SQL P0-P5 | **16 / 16** |
| E2E `m7-local` | **91 / 91** (5 nuevos) |
| guard `provisioning-authority` | pass |
| CI en el PR | TS+Lint+Build ✅ · E2E ✅ · Vercel ✅ |

### Pruebas negativas — 4/4 gates demostrados

`node scripts/p0p4p5-negative-gates.mjs`:

| Mutación | Gate | Resultado |
|---|---|---|
| A · quitar el guard de hidratación | test de hidratación | ✅ falló como debía |
| B · aceptar `business_id` en la RPC | postcondición P2 | ✅ rechazó la migración |
| C · relajar el path de Storage | postcondición P8b | ✅ rechazó la migración |
| D · ignorar el error de persistencia | test «no avanza» | ✅ detectó que avanzó |

---

## 8. Tres trampas del proceso

**Un chequeo textual se dispara con su propia documentación.** Ya pasó en P0-P2 y
volvió a pasar acá: hay que quitar comentarios antes de buscar código.

**`git checkout --` descarta trabajo sin commitear.** El script de pruebas
negativas revirtió una reescritura completa de `ProtectedRoute.tsx` que todavía
no estaba commiteada. Ahora el script **aborta** si los archivos que muta están
sucios en git.

**Node 24 no puede `execFileSync` un `.cmd`.** `npx.cmd` falla con EINVAL (el
endurecimiento por CVE-2024-27980) y `npx` con ENOENT: el proceso muere **antes**
de correr nada y stdout queda vacío, así que el script reportaba «el gate no
detectó la mutación» cuando el test nunca corrió. Un **falso rojo** que en el caso
opuesto habría sido un falso verde. Se invoca el entrypoint `.mjs` con
`process.execPath`.

---

## 9. Producción

| | antes | después |
|---|---|---|
| auth users | 18 | **18** |
| profiles | 18 | **18** |
| businesses | 26 (6 `trialing`) | **26 (6)** |
| invitations | 2 | **2** |
| profiles huérfanos | 0 | **0** |
| businesses sin miembros | 9 | **9** |
| `business_settings` | 8 | **8** |
| objetos en `business-assets` | 1 | **1** |
| migraciones | 233 | **234** |

**Cero filas de datos tocadas.**

Postcondiciones verificadas en prod: las 2 RPC existen · ninguna acepta
`business_id` · SECDEF + `search_path` endurecido · PUBLIC/anon sin EXECUTE ·
`authenticated` con EXECUTE · **0** grants de DML de cliente sobre
`profiles`/`businesses` · 3 policies nuevas tenant-scoped · 0 policies viejas ·
lectura pública intacta · `provision_my_business` intacta con
`INVITATION_PENDING`.

### Bundle servido (121 chunks, verificado sobre el JS real)

`update_my_business_onboarding` con 8 parámetros y **sin `p_business_id`** ·
`get_my_business_onboarding` sin argumentos · `provision_my_business` con un solo
call site y sólo `p_business_name` · path `business-logos/<id>/logo-<ts>.<ext>` ·
el mensaje de RLS traducido a «No tenés permisos para cambiar el logo de este
negocio».

---

## 10. Smoke humano — pendiente, NO ejecutado

Usar un email owner **nuevo** (no reutilizar ni borrar usuarios existentes).

```
signup → confirmar por correo → /no-business → "Crear mi taller"
      → onboarding: nombre, rubro, logo, contacto, fiscal → completar
      → dashboard → logout → login → dashboard
```

**Deltas esperados**: `auth users +1` · `profiles +1` · `businesses +1` ·
`trialing +1` · `businesses sin miembros +0` · `profiles huérfanos +0`.

Verificar además: los campos del wizard **persistidos** en `businesses` y
`business_settings`, `onboarding_completed = true`, `logo_url` apuntando a
`business-logos/<business_id>/...`.

Y con el invitado de P0-P2 ya existente: logout → login → **dashboard**, sin
pasar por el onboarding de owner.

---

## 11. Contrato que cambia

Un usuario confirmado **sin** negocio ahora va a `/no-business` (alta explícita) y
no a `/onboarding`. Se actualizaron los dos casos de `email-verification` que
aseveraban lo viejo.

---

## 12. Handoffs (fuera de alcance, registrados)

- **Métodos de pago del wizard**: el modelo canónico es `payment_method_buttons`
  (POS), con otros códigos y semántica de fees e integraciones. El paso deja de
  prometer que guarda; mapearlo es un lote de POS.
- ARCA autoservicio / CSR / Vault · Mayorista Clic (tabs y stats) · cron de
  expiración de invitaciones · envío automático del email de invitación ·
  `PermissionsMatrix` del modal de invitación · cleanup de los 9 businesses sin
  miembros, `owner_user_id` NULL históricos y los 16 «Mi Negocio».
