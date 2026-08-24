# P0-P6 — RBAC por capacidad, no sólo por tenant

**Estado: ✅ CERRADO Y ESTABLE EN PRODUCCIÓN — 2026-08-24.**
Smoke humano PASADO (tech: Caja desapareció; owner: Caja visible y funcional).
Backend cerrado en las tres capas: financieras (`20260826120000`), superficie de
caja (`ccc8eac`) y lectura directa de `cajas` (`20260827120000`).
DB final: **236**, head `20260827120000`.

- PR: https://github.com/molinajonyy-hub/TechRepair-Pro/pull/70 — **MERGED**
- Merge commit: **`3c9cf40`** (2026-08-24 21:30:48Z)
- Vercel: `/version.json` → `{"commit":"3c9cf40"}`
- DB: **234 → 235**, head `20260826120000`, 8 postcondiciones OK
- Orden: **DB primero** (el backend exponía los datos), frontend después
- **0 filas de datos tocadas**

---

## 1. Baseline

`main` @ `5fd1b25`, tree limpio, local 234 = prod 234.

Modelo de autorización que YA existía y se reutilizó:

| | |
|---|---|
| `src/config/permissions.ts` | 13 capacidades + defaults por rol |
| `profiles.permissions` (jsonb) | overrides por usuario |
| `usePermissions()` / `effectivePermissions()` | resolución (owner = todo) |
| `system_admins` | privilegio SaaS, server-side con RLS |
| `useSystemOwner()` | lo consulta |

**No se inventó un segundo sistema.** Se agregaron dos capacidades al existente.

---

## 2. Los dos bugs

### Sidebar — una sola línea

```js
if (!item.permission || !can(item.permission)) return !item.permission
```

Para cualquier item **sin** `permission` devolvía `true` de inmediato, así que
`planFeature` y `systemOwnerOnly` (las dos líneas siguientes) **nunca se
evaluaban**. `/admin/subscriptions` y `/admin/leads` declaran sólo
`systemOwnerOnly`; `/mi-guita` no declaraba nada. Ése es el incidente completo.

Las **rutas** `/admin/*` sí estaban protegidas por `ProtectedRouteBySystemOwner`,
así que SaaS Admin era una fuga visual, no de datos.

### Backend — la crítica, y la que no se veía

Todas las policies de lectura financiera filtraban **sólo** por negocio:

```sql
business_id = current_user_business_id()
```

```
tenant      ✓ cerrado
capability  ✗ abierto
```

Un tech podía leer toda la información financiera de *su* negocio llamando a
PostgREST directo desde DevTools. **Esconder la tarjeta no cerraba nada.**

`v_finance_pnl`, `v_finance_position` y `v_finance_product_margin` son
`security_invoker`, así que heredaban el mismo agujero.

---

## 3. Matriz de capacidades final

Se agregaron **dos** a las 13 existentes:

| capacidad | owner | admin | manager | tech | sales | cashier | viewer |
|---|---|---|---|---|---|---|---|
| `orders` | ✓ | ✓ | ✓ | **✓** | ✓ | ✓ | ✓ |
| `orders_change_status` | ✓ | ✓ | ✓ | **✓** | ✓ | ✗ | ✗ |
| `orders_view_financials` | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✗ |
| `finance` | ✓ | ✓ | ✗ | **✗** | ✗ | ✓ | ✗ |
| `comprobantes` | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✗ |
| `reports` | ✓ | ✓ | ✓ | **✗** | ✗ | ✓ | ✗ |
| `inventory_view_costs` | ✓ | ✓ | ✓ | **✗** | ✗ | ✗ | ✗ |
| `wholesale` *(nueva)* | ✓ | ✓ | ✓ | **✗** | ✓ | ✗ | ✗ |
| `personal_finance` *(nueva)* | **✗** | ✗ | ✗ | **✗** | ✗ | ✗ | ✗ |
| `users` / `settings_sensitive` | ✓ | ✓ | ✗ | **✗** | ✗ | ✗ | ✗ |

`personal_finance` es **`false` para los 7 roles, incluido owner**, y no es
configurable desde la matriz (`NON_CONFIGURABLE_PERMISSIONS`).

---

## 4. Backend

Migración `20260826120000`:

- **`current_user_can(key)`** — espejo server-side de `permissions.ts`: defaults
  por rol + overrides de `profiles.permissions`, fail-closed, identidad canónica
  `COALESCE(user_id, id) = auth.uid()`.
  Se eligió un helper y no `role IN (...)` en cada policy porque el repo **ya**
  tiene overrides por usuario: hardcodear roles crearía un segundo modelo que
  los ignora y las dos fuentes divergirían al primer cambio.
- `financial_movements` + `business_finance_entries`: SELECT = tenant **AND** `finance`.
- `comprobante_payments`: SELECT = tenant **AND** `comprobantes` — no `finance`,
  porque `sales` los necesita para operar el POS.

⚠️ `financial_movements` tenía **dos** policies PERMISSIVE de SELECT. Las
permissive se combinan con **OR**: agregar una tercera más estricta no habría
cerrado nada. Hubo que reemplazar las dos, y una postcondición ahora exige
exactamente **una** por tabla.

Las vistas heredan el gate por `security_invoker`; no se duplicó el chequeo.

**Escrituras intactas**: los INSERT a estas tablas ocurren por triggers dentro de
RPC SECURITY DEFINER, no desde el cliente, así que gatear el SELECT no rompe el POS.

---

## 5. Frontend

| Archivo | Cambio |
|---|---|
| `config/permissions.ts` | +`wholesale`, +`personal_finance`, +`CONFIGURABLE_PERMISSIONS` |
| `layout/Sidebar.tsx` | se elimina el return temprano; cada gate se evalúa |
| `auth/ProtectedRouteByPermission.tsx` | **nuevo** — guard de ruta por capacidad |
| `App.tsx` | guards en finance, caja, expenses, mayorista, users, settings, customers, inventory, comprobantes, reports |
| `auth/PersonalProtectedRoute.tsx` | Mi Guita: gate `system_admins`, no el plan |
| `pages/Dashboard.tsx` | tarjetas gateadas **y consultas omitidas** |
| `pages/UsersManagement.tsx` | la matriz sólo ofrece capacidades configurables |

**No se pide lo que no se puede mostrar**: `useFinancialDashboard(puedeVerFinanzas ? businessId : null)`
y el efecto de movimientos corta antes de consultar. Traer la ganancia para
esconder la tarjeta dejaría el dato en la respuesta HTTP, visible en Network.

---

## 6. Verificación

| Gate | Resultado |
|---|---|
| `tsc` · `lint:errors` · `build` | 0 · 0 · OK |
| unit | **1032 / 1032** |
| components | **483 / 483** (24 nuevos) |
| SQL P0-P6 | **8 / 8 grupos** |
| E2E `m7-local` | **91 / 91** |
| **Pruebas negativas** | **6 / 6 gates demostrados** |

### Prueba directa de lectura (como `authenticated`, RLS aplicada)

| actor | filas de `financial_movements` |
|---|---|
| tech | **0** |
| sales | **0** |
| owner / admin / cashier | 1 (las suyas) |
| tech con override explícito | 1 |
| owner de otro negocio | 1 (tenant intacto) |
| sin sesión | 0 |

### Pruebas negativas

| Mutación | Gate | Resultado |
|---|---|---|
| A · quitar el gate visual de Ganancia Real | component test | ✅ falló |
| B1 · dejar entrar a tech en la RLS | postcondición P3 | ✅ rechazó la migración |
| B2 · idem salteando postcondiciones | SQL security test | ✅ detectó que el tech leyó |
| C · permitir `/finance` sin capacidad | route test | ✅ falló |
| D · SaaS Admin a un owner normal | component test | ✅ falló |
| E · Mi Guita a un actor externo | component test | ✅ falló |

---

## 7. Prueba VIVA contra producción

Medida con `DO + RAISE` (la excepción revierte todo; no queda ninguna escritura):

```
TECH ACTIVO:  orders=t change_status=t | finance=f comprobantes=f customers=f
              inventory=f costs=f reports=f wholesale=f personal=f users=f
              movimientos visibles = 0

OWNER (Clic): orders=t finance=t comprobantes=t wholesale=t personal=f
              movimientos visibles = 347
```

El técnico **puede trabajar** (órdenes y cambio de estado) y no ve nada
sensible. El owner no perdió nada salvo Mi Guita, que nunca fue del tenant.

**Hallazgo**: el tech invitado en P0-P2 está hoy con `is_active = false`, así que
en producción hoy no tiene ninguna capacidad — correcto y fail-closed. Para el
smoke hay que **reactivarlo** desde Usuarios.

---

## 8. Producción — antes / después

| | antes | después |
|---|---|---|
| auth users / profiles / businesses | 18 / 18 / 26 | **18 / 18 / 26** |
| financial_movements | 377 | **377** |
| business_finance_entries | 584 | **584** |
| comprobante_payments | 351 | **351** |
| system_admins activos | 1 | **1** |
| policies SELECT con capacidad | 0 / 3 | **3 / 3** |
| DML de cliente sobre profiles/businesses | 0 | **0** |
| migraciones | 234 | **235** |

---

## 9. Smoke humano — pendiente, NO ejecutado

**A. Owner (Clic)** — dashboard completo, Ganancia Real / Cobrado en caja /
Caja neta visibles, Finanzas y Caja accesibles, órdenes y POS intactos.
SaaS Admin visible **sólo** si esa cuenta está en `system_admins` (hoy hay 1
activo). Mi Guita ya **no** aparece salvo que sea esa cuenta.

**B. Tech** — primero **reactivarlo** en Usuarios (hoy está inactivo). Luego:
sidebar **sin** Mayorista, Mi Guita ni SaaS Admin; dashboard **sin** Ganancia
Real, Cobrado en caja, Caja neta ni Registrar Gasto. Deep links
`/finance`, `/caja`, `/expenses`, `/mayorista`, `/mi-guita`,
`/admin/subscriptions` → todos deben rebotar a `/dashboard`.
Y **Órdenes / Garantías / Tareas tienen que seguir funcionando**.

**C. Network** — con el tech, el dashboard no debe disparar requests a
`financial_movements` ni `business_finance_entries`.

---

## 9-bis. HOTFIX de superficie de caja — merge `ccc8eac`

Tras el deploy quedaba un borde: `/caja` ya rebotaba, pero el Dashboard seguía
mostrando **estado Caja abierta/cerrada**, **Gestionar Caja / Abrir Caja**,
**Gasto** y la pestaña **Movimientos Caja**. Y `CajaProvider` —que envuelve toda
la app— consultaba `cajas` en el montaje, en cada `focus` y en cada
`cash-session-updated`, para cualquier usuario.

Se cerró con la capacidad canónica `finance`, expuesta como `canUseCaja` desde
`CajaContext` (una sola fuente, sin ramificar por rol).

**Dos preguntas distintas, y esto importa:**

```
canUseCaja          = can('finance')                        -> gobierna la UI
necesitaConocerCaja = can('finance') || can('comprobantes') -> gobierna el fetch
```

El POS manda `caja_id` al crear un comprobante para atar la venta a la sesión
abierta. Un `sales` tiene `comprobantes` pero no `finance`: cortarle el fetch lo
habría dejado vendiendo con `caja_id: null`, o sea **fuera del arqueo** — un
cambio de comportamiento contable que este hotfix no debía hacer.

| actor | UI de caja | fetch de `cajas` |
|---|---|---|
| tech default | ✗ | **0** |
| owner / cashier | ✓ | ✓ |
| tech con `finance:true` | ✓ | ✓ |
| cashier con `finance:false` | ✗ | — |
| sales | ✗ | ✓ (POS intacto) |
| viewer | ✗ | **0** |

Verificado en el bundle servido (`ccc8eac`): banner, CTA y pestaña detrás del
flag, y `if(!r||!u){...return}` cortando la consulta antes de salir.

---

## 9-ter. CIERRE FINAL de `public.cajas` — merge `80322c2`, DB 236

El hotfix anterior dejó de **pedir** la caja, pero la tabla seguía legible por
**acceso directo**. Su única policy era:

```sql
cajas_select : (current_business_id() = business_id) AND is_staff()
```

`is_staff()` = los **siete** roles del negocio. **Medido: un tech leía 81 filas**
fabricando una consulta a PostgREST.

### Contrato nuevo (migración `20260827120000`)

```sql
business_id = current_user_business_id()
AND ( public.current_user_can('finance')
      OR public.current_user_can('comprobantes') )
```

La rama `comprobantes` **no es un descuido**: un `sales` tiene `finance = false`
pero necesita conocer la caja abierta porque el POS manda `caja_id`. Sin ella
seguiría vendiendo con `caja_id = NULL` y sus ventas quedarían **fuera del
arqueo** — un cambio contable disfrazado de cambio de permisos. Es la misma
separación que ya hace el frontend desde `ccc8eac`.

**Se reemplaza, no se agrega**: dos permissive se combinan con OR y la más laxa
gana. Una postcondición exige **exactamente una** policy de SELECT y que no
vuelva a apoyarse en `is_staff()`.

`cajas` tenía **cero** policies de escritura (los grants existen pero sin policy
la RLS los deniega: abrir/cerrar pasa por RPC SECDEF), así que sólo se tocó
SELECT.

### Prueba viva en producción (`DO + RAISE`, revierte sola)

```
TECH   : finance=f comprobantes=f  -> cajas = 0        (antes 81)
SALES  : finance=f comprobantes=t  -> cajas = 81, caja_abierta = aa29f123-… ✅
OWNER  : finance=t                 -> cajas = 81
OWNER  : cajas de otro negocio     -> 0
```

### SQL security tests — 7 grupos

tech / viewer / sales-sin-capacidad → **0** · owner / admin / cashier → las 2 de
su negocio · **sales resuelve la caja abierta** · tech con override
`finance:true` → accede · cross-tenant en ambas direcciones → **0** · sin sesión
→ **0** · estructura (una policy, sin `is_staff`, tenant+capacidad, financieras
intactas).

### Counts antes / después

| | antes | después |
|---|---|---|
| cajas | 86 | **86** |
| financial_movements | 377 | **377** |
| business_finance_entries | 584 | **584** |
| comprobante_payments | 351 | **351** |
| comprobantes | 350 | **350** |
| profiles / businesses | 18 / 26 | **18 / 26** |
| migraciones | 235 | **236** |

**0 filas de negocio modificadas.** Sólo policy + migración.

---

## 10. Handoffs (registrados, no implementados)

- **`user_can_view_order_amounts`** filtra por la columna cruda `user_id`, que
  `provision_my_business` y `accept_business_invitation` dejan en NULL — mismo
  defecto latente que tenían las policies de Storage. Es fail-closed (niega de
  más), así que no es una fuga, pero le niega los montos a un cashier/sales
  invitado. Arreglo: `COALESCE(user_id, id)`.
- Mayorista Clic (deadlock privado) · métodos de pago del onboarding · cron de
  expiración de invitaciones · email automático de invitaciones · ARCA
  autoservicio · cleanup histórico.
