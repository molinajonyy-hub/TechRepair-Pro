# P0 FIRST-STEPS-1 — "Primeros pasos" derivado del estado real

**Rama:** `feat/p0-first-steps-1-derived` (worktree propio, desde `origin/main` = `bdedfca`)
**Migración:** `supabase/migrations/20260905120000_first_steps_derived.sql`
**Estado:** listo y verde en local. **NO** aplicado, **NO** mergeado, **NO** desplegado.

---

## 1. Baseline

| Ítem | Valor |
|---|---|
| `origin/main` | `bdedfcab3554d66b9b218e85f28a5cd741e3d4b9` |
| HEAD del worktree | `bdedfca` + este lote |
| Migration head del repo | `20260902120000` |
| Migration head de **producción** | `20260902120000` |
| Migration head de la base **local** | `20260904120000` (ya tiene 2A y ONB-1 aplicadas) |

Worktrees vivos al empezar (ninguno tocado): `techrepair-vite`,
`techrepair-mobile2a-expand-compat`, `techrepair-onboarding-01`,
`techrepair-vite-mobile-01`, más 6 worktrees de `.claude/worktrees/`.

### Elección de versión

Reservadas: `20260903120000` (MOBILE-2A) y `20260904120000` (ONBOARDING-1).

Se eligió **`20260905120000`** y se verificó que estuviera libre en las tres
superficies, sin asumir:

* **todas las refs git** — `git log --all --remotes --name-only` sobre
  `supabase/migrations` devuelve exactamente `…0901`, `…0902`, `…0903`, `…0904`;
* **remoto** — el mismo barrido incluye `--remotes` tras un `git fetch origin`;
* **producción** — `select version from supabase_migrations.schema_migrations`
  termina en `20260902120000`.

---

## 2. Problema que cierra

`OnboardingChecklist.tsx` usaba `localStorage` como **fuente de completitud**:

```ts
const STORAGE_KEY = (bizId) => `onboarding_done_${bizId}`
const toggle = (id) => { /* … */ localStorage.setItem(STORAGE_KEY(businessId), …) }
```

Tres defectos, no uno:

1. **El navegador afirmaba hechos del negocio.** Tildar la casilla marcaba la
   tarea sin que pasara nada. Cambiar de dispositivo reseteaba el progreso.
2. **Las tareas eran checkboxes.** El usuario podía "completar" el onboarding
   sin crear un solo cliente.
3. **La regla de visibilidad ocultaba trabajo pendiente**: `onboarding_completed
   && edad > 7 días → return`. Al día 8 desaparecía aunque faltaran 4 tareas.

---

## 3. Arquitectura

```
Dashboard
  └─ FirstStepsChecklist        contenedor: decide visibilidad
       ├─ useFirstSteps         estado, refresco, dismiss
       │    └─ firstStepsService.get()
       │         └─ supabase.rpc('get_my_first_steps')   ← 1 round-trip, 0 args
       └─ SetupChecklist        presentación pura (recibe items ya resueltos)
```

* `OnboardingChecklist.tsx` — **eliminado**.
* `SetupChecklist.tsx` — reutilizado como capa presentacional (ver §9).

---

## 4. La RPC

```sql
public.get_my_first_steps()
  RETURNS TABLE (has_customer, has_order, has_inventory, has_cobro, has_logo : boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
```

Sin parámetros. El tenant sale de `public.current_user_business_id()`, que
deriva de `auth.uid()`. **El cross-tenant es imposible por firma**: no hay dónde
poner un `business_id` ajeno.

Devuelve cinco booleanos. No devuelve `business_id`, conteos, montos, PII ni
detalle financiero.

### Por qué SECURITY DEFINER y no INVOKER

La preferencia del lote era INVOKER. Se descartó **después de medir** las
policies reales de las tablas fuente:

| Tabla | `qual` de la policy de SELECT |
|---|---|
| `account_movements` | `current_business_id() = business_id AND current_user_can('finance') AND business_has_feature('currentAccounts')` |
| `comprobante_payments` | `business_id = current_user_business_id() AND current_user_can('comprobantes')` |
| `orders`, `order_payments`, `inventory` | `… AND is_staff()` |

Bajo INVOKER el progreso de onboarding dejaría de ser una propiedad del
**tenant** y pasaría a depender de:

* **el rol del que mira** — un cajero sin capacidad `comprobantes` vería "Hacer
  tu primer cobro" pendiente para siempre;
* **el plan contratado** — `business_has_feature('currentAccounts')` es un gate
  de plan. Un tenant sin ese feature nunca podría ver su propia cobranza de CC,
  y la tarea **volvería a pendiente al cambiar de plan**.

Cinco booleanos sobre hechos del propio negocio del que pregunta no son
información privilegiada. DEFINER acotado a esos cinco `EXISTS` es el mínimo
privilegio correcto, y el aislamiento por tenant lo impone la función.

---

## 5. Definición de cada tarea

| Tarea | Regla | Por qué |
|---|---|---|
| **customer** | `EXISTS customers WHERE business_id = biz AND active` | `active` es `NOT NULL`. Un cliente dado de baja no demuestra el estado canónico visible. |
| **order** | `EXISTS orders WHERE business_id = biz` | Sin filtro de `status`. Una orden entregada o cancelada demuestra igual que el usuario aprendió a crear una orden. |
| **inventory** | `EXISTS inventory WHERE business_id = biz AND COALESCE(is_active,true) IS TRUE AND COALESCE(has_variants,false) IS FALSE` | Unidad **vendible**. Ver abajo. |
| **cobro** | ver §6 | |
| **logo** | `businesses.logo_url` **O** `business_settings.logo_url`, con `NULLIF(btrim(…),'')` | Doble fuente durante la transición con ONBOARDING-1. |

### Auditoría de `inventory` (§7)

Representación real medida en producción:

| `tipo` | `has_variants` | `parent_id` | `is_active` | filas |
|---|---|---|---|---|
| product | false | null | **true** | 655 |
| product | false | null | **false** | 115 |
| product | **true** | null | true | 23 |
| service | false | null | true | 2 |

* `product_variants` tiene **0 filas**; `inventory.parent_id` está seteado en
  **0 filas**. La representación viva es la fila plana de `inventory`.
* `productService.createVariant` escribe el hijo con `parent_id` seteado y
  `has_variants: false` → **el hijo cuenta** (es lo vendible).
* `createProductWithVariants` marca el padre **sólo después** de crear los
  hijos, así que un padre marcado implica hijos.

**Regla elegida:** activo **y** no-padre-estructural. Simple (dos predicados,
sin subconsulta correlacionada) y semánticamente correcta.

**Verificado contra datos reales**: los 7 tenants con inventario tienen ≥1 fila
vendible bajo esta regla (588/721, 47/50, 11/11, 5/7, 4/4, 1/1, 1/1). **Ninguno
pierde el paso.**

---

## 6. Definición de "primer cobro" (§9 y §19)

> **Existencia histórica de un cobro canónico que ocurrió realmente.**

```sql
EXISTS comprobante_payments (business_id = biz)
OR EXISTS order_payments     (business_id = biz)
OR EXISTS account_movements  (business_id = biz AND credit > 0)
```

**Sin filtrar por `replaced_at` ni por `reversed_at`.** Cobró ayer, anuló hoy →
sigue completado. El checklist mide aprendizaje, no saldo.

### NO cuentan (decisión explícita)

| Fuente | Por qué no |
|---|---|
| `payments`, `subscription_payments` | Es el SaaS cobrándole al comerciante, no el comerciante a su cliente. |
| existencia de una orden | No es un cobro. |
| `orders.amount_paid` | Campo manual, no un asiento. |
| `financial_movements` | Incluye egresos y aperturas de caja. |
| apertura de Caja / egresos | Un gasto no es un cobro. |
| `account_movements.debit > 0` | Es un **cargo** al cliente (`venta`/`ajuste`), lo contrario de una cobranza. Verificado: `type ∈ {venta, ajuste}` van a `debit`; `type = 'pago'` va a `credit`. |

### Por qué la monotonicidad se puede afirmar (§19)

El lote pedía **detener y reportar** si no se pudiera determinar sin inventar
una tabla nueva. **Sí se puede**, y se probó, no se supuso:

1. **Ninguna policy de UPDATE ni de DELETE** sobre las tres tablas para
   `authenticated`. Medido en `pg_policies`:
   * `comprobante_payments` → sólo `INSERT` + `SELECT`;
   * `order_payments` → **sólo `SELECT`**;
   * `account_movements` → **sólo `SELECT`**.
2. **Ninguna función del esquema borra de ellas.** Barrido sobre
   `pg_get_functiondef` de todas las funciones de `public` buscando
   `DELETE FROM (comprobante_payments|order_payments|account_movements)`:
   **0 resultados**.
3. Las reversas se asientan como **filas nuevas**, en tablas dedicadas que
   existen: `order_payment_reversals`, `account_payment_reversals`,
   `comprobante_payment_replace_requests`. La fila original sobrevive con
   `reversed_at` / `replaced_at` seteados.

Por eso **no se creó ninguna tabla de "completed steps"**: los registros
históricos existentes alcanzan.

#### Límite honesto de la afirmación

La monotonicidad es absoluta ante **reversa**. **No** lo es ante **borrado del
documento padre**, que es una operación distinta:

* `comprobantes` **sí** tiene policy de DELETE (`can_manage()`) y
  `comprobante_payments.comprobante_id` es `ON DELETE CASCADE`;
* `orders` **sí** tiene policy de DELETE y `order_payments.order_id` es
  `ON DELETE CASCADE`;
* `account_movements → accounts` es CASCADE, pero **`accounts` no tiene policy
  de DELETE**, así que ese camino es inalcanzable.

O sea: borrar la factura entera sí puede hacer retroceder el paso. Eso no es una
reversa —es destruir el registro— y el resultado (la evidencia ya no existe) es
coherente. Se documenta en vez de ocultarse.

---

## 7. Seguridad

| Control | Estado | Cómo se verificó |
|---|---|---|
| `authenticated` únicamente | ✅ | `has_function_privilege('authenticated', …)` = true |
| `anon` sin EXECUTE | ✅ | postcondición en la migración + test SQL + **HTTP real: 401 `42501`** |
| `PUBLIC` revocado | ✅ | `REVOKE ALL … FROM PUBLIC` (el EXECUTE a PUBLIC es el **default** de PostgreSQL) |
| Tenant derivado server-side | ✅ | `current_user_business_id()`, sin parámetros |
| Cross-tenant imposible por firma | ✅ | `pronargs = 0` aseverado en el test |
| `search_path` endurecido | ✅ | `pg_catalog, public, pg_temp` — `pg_temp` **al final** |
| Guard SECDEF del repo | ✅ | `guard-security-definer.mjs` sin hallazgos |

`pg_temp` va explícito y último: **omitirlo no lo excluye, lo pone primero**
(doc PG 5.9.3), que es el vector de shadowing por tabla temporal.

Fail-closed: sin sesión, `current_user_business_id()` devuelve `NULL`, todos los
`EXISTS` dan `false` y el resultado es 0/5. Probado (`sin sesion -> fail-closed`).

---

## 8. Performance (§16)

`EXPLAIN (ANALYZE, BUFFERS)` contra **producción** sobre el tenant más pesado
(721 filas de inventario, 354 de `comprobante_payments`):

```
Execution Time: 7.493 ms
Buffers: shared hit=11
```

* **`EXISTS` en todos los casos**, nunca `COUNT(*)` ni `SELECT *`. El guard
  falla si alguien mete un `COUNT`.
* **El `OR` corta**: `order_payments`, `account_movements` y `business_settings`
  aparecen como `never executed` cuando la primera fuente ya acertó.
* **1 round-trip** para las 5 tareas (antes: 1 query + N lecturas de storage).
* Índices: las 6 tablas fuente ya tienen btree por `business_id`
  (`idx_customers_business_id`, `idx_orders_business_id`,
  `idx_inventory_business_id`, `idx_cp_biz_date`,
  `idx_order_payments_business_id`, `idx_acctmov_business`).
  **No hace falta ningún índice nuevo.**

---

## 9. Frontend

### `SetupChecklist` — reutilizar, no borrar (§12)

Había dos implementaciones del mismo checklist. Se eligió **A (reutilizar
`SetupChecklist` como presentacional)** y eliminar `OnboardingChecklist`:

| | `OnboardingChecklist` (montado) | `SetupChecklist` (muerto) |
|---|---|---|
| Colores | `#0f1829`, `#94a3b8` hardcodeados (sólo dark) | `var(--bg-card)`, `var(--text-primary)` |
| Estado | lo inventaba (localStorage) | recibía `items` por props |
| Indicador | `<button>` que tildaba | icono |

Menor deuda y mejor accesibilidad. Mejoras aplicadas al reutilizarlo:

* la fila entera es un **`<button>`** (antes `<div onClick>`: inalcanzable por
  teclado);
* `aria-label` anuncia "Completado" / "Pendiente";
* el indicador es `aria-hidden` — **no es un checkbox y no se puede tildar**;
* `role="progressbar"` con `aria-valuenow/min/max`;
* lista semántica `<ul>/<li>`, contenedor `<section aria-label>`;
* `minHeight: 44px` por fila (objetivo táctil mobile-first);
* los ítems completados **también** navegan (antes quedaban muertos).

### Visibilidad (§13) — decisión

La regla vieja (`completo + >7 días → desaparece`) era arbitraria y ocultaba
tareas realmente pendientes. La nueva:

* **hay pendientes** → se muestra **hasta que el usuario lo descarte**;
* **5/5** → estado de éxito con "Listo, ocultar";
* **descartado** → oculto en ese navegador.

**Se evaluó la ventana de 30 días que proponía el lote y se descartó**, con
motivo: sólo mueve el problema del día 8 al día 31. Un negocio que a los dos
meses todavía no cargó un producto necesita ese recordatorio **más**, no menos.
Cerrar la tarjeta ya es un gesto de un clic, así que el control queda en el
usuario y no en un timer. Bonus: evita leer `businesses.created_at`, que habría
costado un segundo round-trip contra el §16.

Ante **error de lectura la tarjeta no se dibuja** — mejor nada que un 0/5 falso.

### Dismiss (§14)

Clave **nueva**: `first_steps_dismissed_{businessId}`. Es una preferencia local
de UI, no una afirmación del negocio. `onboarding_done_*` no se lee ni se
escribe nunca más (el guard falla si reaparece). Todo acceso a `localStorage`
va en `try/catch`.

### Refresco (§15)

Al montar el Dashboard, al volver a él, tras refresh/login, y en
`visibilitychange` con throttle de 60 s. **Sin realtime**: un checklist de
onboarding no justifica una subscription, y menos cinco (una por tabla fuente).

---

## 10. Tests

### SQL — 27/27 PASS

Corre entero dentro de una transacción que termina en `ROLLBACK`; verificado
que la base local queda sin rastro (0 funciones, 0 filas sembradas).

```
PASS t0  tenant vacio -> 0/5
PASS t1  SOLO cliente -> 1/5 (DISTINTIVO §17)
PASS t2  SOLO orden
PASS t3  SOLO inventario
PASS t4  SOLO logo en businesses
PASS t5  SOLO logo en business_settings
PASS t6  SOLO cobro POS (comprobante_payments)
PASS t7  seña order_payment -> orden + cobro
PASS t8  cobranza CC (credit>0) -> cobro
PASS t9  debit CC -> NO es cobro
PASS t10 egreso financiero -> NO es cobro
PASS t11 pago SaaS -> NO es cobro
PASS t12 cliente inactivo -> NO cuenta
PASS t13 producto inactivo -> NO cuenta
PASS t14 padre de variantes solo -> NO es vendible
PASS t15 hijo variante -> SI es vendible
PASS t16 logo vacio/whitespace -> NO cuenta
PASS t17 cobro REEMPLAZADO -> sigue contando (§19)
PASS t18 seña REVERSADA -> sigue contando (§19)
PASS t0  cross-tenant: no ve los datos del vecino
PASS t19 tenant ajeno ve LO SUYO
PASS sin sesion -> fail-closed 0/5
PASS grant: anon NO tiene EXECUTE
PASS grant: PUBLIC NO tiene EXECUTE
PASS grant: authenticated SI tiene EXECUTE
PASS firma: 0 parametros (no acepta business_id del cliente)
PASS search_path endurecido (pg_temp ultimo)
```

### Test distintivo (§17) — probado en las **tres** capas

| Capa | Evidencia |
|---|---|
| SQL | `t1  SOLO cliente -> 1/5` |
| Componente | `crear SOLO un customer da 1 de 5, con las otras 4 pendientes` |
| **HTTP real** | `POST /rpc/get_my_first_steps → 200 {"has_customer":true,"has_order":false,"has_inventory":false,"has_cobro":false,"has_logo":false}` |

La implementación vieja **falla** este test: sin tildar nada devolvía 0/5
(negative gate A lo demuestra rompiendo 5 tests).

### Componente — 14/14 PASS

Cubre: 0/5, el distintivo, segundo navegador con storage vacío → mismo
progreso, 5/5, error → no dibuja nada, la fila navega en vez de marcar, no hay
ningún `input`/`role=checkbox`, `aria-label` de estado, dismiss guarda la clave
nueva, dismiss no altera el estado server-side, la clave vieja llena se ignora,
dismiss por negocio, RPC sin argumentos, 1 round-trip.

---

## 11. Negative gates (§20) — los 5 verificados en rojo

`npm run test:first-steps:negative-gates`

Baseline: los 3 gates en verde con el árbol intacto. Después, cada defecto:

| # | Defecto reintroducido | Gate | Resultado |
|---|---|---|---|
| A | `localStorage` vuelve a ser la fuente de "done" | componente | **ROJO** — 5 tests fallan |
| B | contar `financial_movements` de egreso como cobro | SQL | **ROJO** — `t10 esperado f/f/f/f/f / obtenido f/f/f/t/f` |
| C | eliminar el scoping por tenant | SQL | **ROJO** — `t0 esperado f/f/f/f/f / obtenido t/t/t/t/f` |
| D | `GRANT EXECUTE … TO anon` | SQL | **ROJO** — `ERROR: anon conserva EXECUTE` |
| E | la RPC acepta `business_id` del cliente | estático | **ROJO** — guard con hallazgos |

Todas las mutaciones se revierten en un `finally`; se verifica que el árbol
vuelva a verde.

> El gate B se escribió **aditivo** (suma una cuarta fuente ilegítima en vez de
> reemplazar una legítima) a propósito: si reemplazara, el rojo vendría de
> *perder* una fuente y no probaría nada sobre los egresos.

---

## 12. Matriz de compatibilidad (§21) — **medida por PostgREST**

`npm run` → `node scripts/guards/first-steps-compat-matrix.mjs`
(stack local; aplica la migración, mide por HTTP, y la revierte).

| Celda | Resultado | Medición |
|---|---|---|
| control: DB vieja + frontend viejo | PASS | `GET /businesses → 200` |
| **B. DB vieja + frontend NUEVO** | **FALLA EXPLÍCITA** | `POST /rpc/get_my_first_steps → 404 PGRST202` |
| **A. DB nueva + frontend VIEJO** | **PASA** | `GET /businesses → 200` |
| DB nueva + frontend nuevo | PASS | `200`, 1 de 5 |
| DB nueva + `anon` | denegado | `401` / `42501` |

**A pasa y B falla ruidosamente (nunca en silencio, nunca un 0/5 falso) →
rollout DB-FIRST.**

---

## 13. Gates ejecutados

| Gate | Resultado |
|---|---|
| TypeScript `tsc --noEmit` | ✅ 0 errores |
| ESLint `--quiet` (errores) | ✅ 0 |
| `vite build` | ✅ ok (23 s) |
| Unit (`node --test`) | ✅ **1032/1032** |
| Componentes (vitest, suite completa) | ✅ **578/578** en 38 archivos |
| SQL FIRST-STEPS | ✅ **27/27** |
| Guard SECDEF del repo | ✅ sin hallazgos |
| Guard FIRST-STEPS + self-test | ✅ detecta los 7 casos sembrados |
| Negative gates | ✅ 5/5 en rojo, árbol restaurado |
| Matriz de compatibilidad | ✅ 5/5 celdas |
| Diff check | ✅ sólo FIRST-STEPS (ver §14) |

> Nota de entorno: `tests/unit/safeDevPreflight.test.ts` falla en un worktree
> recién creado porque `.env.development.local` está gitignoreado y no se
> clona. **No es una regresión** — es el preflight fail-closed que impide
> levantar `dev` contra producción. Copiado el archivo, 1032/1032.

---

## 14. Diff — sólo FIRST-STEPS

```
 D src/components/onboarding/OnboardingChecklist.tsx
 M src/components/onboarding/SetupChecklist.tsx
 M src/pages/Dashboard.tsx                      (2 líneas: import + tag)
 M package.json                                 (scripts nuevos)
 A src/components/onboarding/FirstStepsChecklist.tsx
 A src/hooks/useFirstSteps.ts
 A src/services/firstStepsService.ts
 A supabase/migrations/20260905120000_first_steps_derived.sql
 A tests/sql/first_steps_derived.test.sql
 A tests/components/firstStepsChecklist.test.tsx
 A scripts/guards/first-steps-derived.mjs
 A scripts/guards/first-steps-negative-gates.mjs
 A scripts/guards/first-steps-compat-matrix.mjs
 A docs/p0-first-steps-1.md
```

**No** se tocó: MOBILE-2A, ONBOARDING-1/2, ARCA, Orders, Finance, Caja, Cuenta
Corriente, Warranty, Tracking, P0-DÓLAR, subscriptions.

---

## 15. Rollout recomendado

**DB-FIRST**, y **retenido** detrás de dos lotes.

`20260905120000` es posterior a las dos reservas, así que **no se puede aplicar
a producción antes de**:

1. `20260903120000` — MOBILE-2A
2. `20260904120000` — ONBOARDING-1

Orden cuando se libere:

1. `db push` de 2A → ONB-1 → FIRST-STEPS (en ese orden);
2. verificar `get_my_first_steps()` por PostgREST con un usuario real;
3. recién entonces mergear el frontend.

Con la DB adelantada, el frontend viejo sigue funcionando (celda A medida), así
que la ventana entre ambos pasos es segura.

> **`db push` a mano.** Mergear no aplica migraciones, y Vercel auto-deploya en
> el merge: si el frontend sale primero, cada Dashboard pega un `404 PGRST202`
> por carga (ruidoso pero inofensivo — la tarjeta no se dibuja).

### Independencia de ONBOARDING-1 (§2)

FIRST-STEPS no depende del frontend de ONB-1. El logo se lee de **ambas**
fuentes (`businesses.logo_url` **O** `business_settings.logo_url`) sin exigir
que coincidan; normalizarlas es trabajo de ONB-1. **Este lote no duplica el
writer canónico**: sólo lee.

---

## 16. Veredicto

**VEREDICTO A** — FIRST-STEPS-1 listo, retenido detrás de MOBILE-2A y
ONBOARDING-1.

Sin `db push`. Sin merge. Sin deploy. Sin escrituras a producción (lo único que
se ejecutó contra prod fueron `SELECT` y un `EXPLAIN`).

> **Superado el 2026-08-26.** Ver la sección 17: el lote salió a producción.

---

## 17. PRODUCTION ROLLOUT — 2026-08-26

El veredicto A de la sección 16 se levantó una vez que MOBILE-2A (`20260903120000`)
y ONBOARDING-1 (`20260904120000`) quedaron estables en producción. Todo lo que
sigue se midió **después** de integrar `origin/main`: los resultados previos no
sustituyen esta ejecución.

### 17.1 Sync con `main`

| Ítem | Valor |
|---|---|
| `origin/main` al integrar | `916a488` (merge del PR #82, cierre de ONBOARDING-1) |
| Merge-base previo | `bdedfca` |
| Commit de integración | `d707db3` (merge commit — convención del repo, no squash) |
| Conflictos | **1**: `package.json` |

El conflicto era aditivo en ambos lados y se resolvió como **unión**, no eligiendo
un lado:

- script agregador `guards`: conserva `guard:onboarding-canonical` (de `main`) y
  añade `guard:first-steps` (de esta rama) al final;
- entradas de scripts: se conservan los dos bloques completos
  (`onboarding-canonical` / `compat` / `sql` / `negative-gates` de `main`, más
  `first-steps` / `sql` / `negative-gates` de esta rama).

Que la unión sea correcta **se verificó ejecutando** `npm run guards`: el
agregado corre `onboarding-canonical` **y** `first-steps` en la misma pasada.
Ningún `reset --hard`, ningún force push.

Las migraciones `20260903120000` y `20260904120000` quedaron **byte-idénticas** a
`origin/main` tras el merge (`git diff origin/main -- <ambas>` = 0 líneas).

### 17.2 Orden y unicidad de la migración (§2)

Orden físico en `supabase/migrations/`, verificado en disco:

```
20260903120000_mobile2a_order_intake.sql
20260904120000_p0onb1_canonical_business_profile.sql
20260905120000_first_steps_derived.sql
```

`20260905120000` se re-verificó como única **sin apoyarse en mediciones
anteriores**:

- `git log --all --diff-filter=A` sobre ese prefijo → **un solo commit**
  (`995c09d`), contando refs locales y remotas;
- ausente de `supabase_migrations.schema_migrations` en producción antes del push.

### 17.3 Gates post-integración

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | 0 errores |
| `npm run lint:errors` | 0 |
| `vite build` | OK (21.75s) |
| Unit (`node --test`) | **1032/1032**, 30 suites, 0 fail |
| Componentes (vitest) | **595/595**, 43 archivos — incluye los 14 de FIRST-STEPS |
| `npm run guards` (agregado) | exit 0 |
| `guard:mobile2a` + self-test | OK — «sin CONTRACT pendiente» |
| `test:sql:first-steps` | **27/27 PASS**, cierra en `ROLLBACK` |
| `test:first-steps:negative-gates` | **5/5 en rojo**, árbol restaurado a verde |
| `git diff --check` | limpio |

### 17.4 Negative gates (§20) — re-medidos

Los cinco defectos se inyectaron de nuevo y cada uno puso su gate en **rojo**:

| Gate | Defecto inyectado | Señal |
|---|---|---|
| A | `localStorage` vuelve a ser la fuente de «done» | gate de componente exit 1 (5 de 14 tests fallan) |
| B | contar `financial_movements` de egreso como cobro | `FAIL t10 · esperado f/f/f/f/f · obtenido f/f/f/t/f` |
| C | eliminar el scoping por tenant | `FAIL t0 · tenant vacío obtiene t/t/t/t/f` |
| D | `GRANT EXECUTE` a `anon` | la postcondición de la migración aborta el push |
| E | la RPC acepta un `business_id` del cliente | guard estático exit 1 |

### 17.5 Matriz de compatibilidad (§21) — medida por PostgREST real

| Celda | Medición |
|---|---|
| control: DB vieja + frontend viejo | `GET /businesses` → 200 |
| **B.** DB vieja + frontend NUEVO | `POST /rpc/get_my_first_steps` → **404 `PGRST202`** |
| **A.** DB nueva + frontend VIEJO | `GET /businesses` → **200** |
| DB nueva + frontend NUEVO | 200 → `1 de 5` |
| DB nueva + `anon` | **401 `42501`** |

**A pasa y B falla explícitamente → rollout DB-FIRST.** La base local quedó
restaurada tras la medición (función ausente, head de nuevo en `20260904120000`).

### 17.6 PR y CI

| Ítem | Valor |
|---|---|
| Rama | `feat/p0-first-steps-1-derived` |
| PR | [#83](https://github.com/molinajonyy-hub/TechRepair-Pro/pull/83) |
| HEAD aprobado | `d707db3f4dc047525541383506f04580e04fb8bf` |
| TypeScript + Lint + Build | PASS (1m27s) |
| E2E Smoke Tests | PASS (6m32s) |
| Vercel Preview | PASS |

### 17.7 Dry-run contra producción

Producción estaba en `20260904120000`. `supabase db push --linked --dry-run`
devolvió **exclusivamente**:

```
Would push these migrations:
 • 20260905120000_first_steps_derived.sql
```

Sin `0903`, sin `0904`, sin CONTRACT, sin nada posterior.

### 17.8 Snapshot PRE (producción, sólo lectura, sin PII)

| Tabla | Filas |
|---|---|
| `businesses` | 30 |
| `customers` | 128 |
| `orders` | 117 |
| `inventory` | 795 |
| `comprobante_payments` | 354 |
| `order_payments` | 1 |
| `account_movements` | 5 (de los cuales `credit > 0`: 1) |

**Estado esperado del tenant QA, calculado ANTES de desplegar la RPC**
(«cuenta prieba» `3b52e902…`; **nunca** «Clic.» `aa930802…`, que es real),
aplicando a mano los mismos cinco predicados:

| Paso | Esperado |
|---|---|
| `has_customer` | **true** |
| `has_order` | **true** |
| `has_inventory` | false |
| `has_cobro` | false |
| `has_logo` | **true** |

→ **3 de 5**. No se alteró ningún dato para fabricar este estado.

### 17.9 DB push

`supabase db push --linked` aplicó **una sola** migración,
`20260905120000_first_steps_derived.sql`, sin errores y sin reparaciones
manuales.

### 17.10 Postcondiciones en producción

| Comprobación | Resultado |
|---|---|
| Migration head | `20260905120000` |
| `public.get_my_first_steps()` | existe |
| Firma | `pronargs = 0` — no acepta `business_id` |
| Resultado | `TABLE(has_customer, has_order, has_inventory, has_cobro, has_logo)` — sólo booleanos |
| `prosecdef` | `true` (SECURITY DEFINER) |
| `provolatile` | `s` (STABLE) |
| `proconfig` | `search_path=pg_catalog, public, pg_temp` — `pg_temp` **al final** |
| `authenticated` EXECUTE | **sí** |
| `anon` EXECUTE | **no** |
| `PUBLIC` EXECUTE | **no** |
| `service_role` EXECUTE | no |

La denegación a `anon` se verificó además **en ejecución**, no sólo por el bit de
privilegio, con una sonda transaccional que discrimina: `anon → DENEGADO (42501)`
y `authenticated → EJECUTÓ`. Que la sonda pueda distinguir ambos casos es lo que
impide un falso verde.

### 17.11 QA real de la RPC en producción (§17)

Actor: el OWNER del tenant QA dedicado (`29345c0b…`, último login 2026-08-27
01:27 UTC — el del smoke humano de ONBOARDING-1). **No se usó «Clic.».**

Invocada como rol `authenticated` con las claims de ese usuario:

```
actor = authenticated
uid   = 29345c0b-4c56-469b-9e45-f0566e684d7f
biz   = 3b52e902-bcdf-4048-bf2b-6af3d7496002   <- derivado server-side
has_customer=true  has_order=true  has_inventory=false  has_cobro=false  has_logo=true
```

**Coincide exactamente con el estado esperado de §17.8: 3 de 5.** El tenant se
derivó server-side, no se pidió.

### 17.12 Frontend viejo con DB nueva (§18)

Con la RPC ya desplegada y el frontend productivo todavía en `cba9098`, el actor
QA leyó sin errores lo que consumen Dashboard / Orders / NewOrder / Settings:
`businesses` 1, `business_settings` 1, `customers` 3, `orders` 3, `inventory` 0,
`comprobantes` 0 — todo correctamente acotado a su propio tenant, sin `42501`.
(`inventory` 0 y `comprobantes` 0 cruzan además con `has_inventory=false` y
`has_cobro=false`.)

### 17.13 Merge y deploy

| Ítem | Valor |
|---|---|
| PR | #83 |
| HEAD aprobado | `d707db3` |
| Merge commit | `bbcd618b20db504ed23b1cc1e7fffcc9a36c2928` |
| Timestamp | 2026-08-26 23:10:05 -0300 |
| Método | merge commit (convención del repo) |
| Vercel | success |
| `version.json` | `{"buildTime":"2026-08-27T02:10:19.417Z","commit":"bbcd618"}` |
| apex `techrepairpro.app` | 200 (redirige al canónico `www`) |
| `www.techrepairpro.app` | 200 |

### 17.14 Sanity de UI medido (§22, §23, §24)

Contra el stack **local** con la migración aplicada (misma forma que producción),
sesión real del owner E2E. El tenant local tiene un perfil **distinto** al de QA
(`customer=T, order=F, inventory=T, cobro=T, logo=F` → 3/5), lo que hace de
control independiente:

| Comprobación | Resultado |
|---|---|
| §21 la UI coincide **exactamente** con `get_my_first_steps()` | PASS — 5/5 pasos y el contador `3/5` |
| §21 sembrar basura `onboarding_done_*` | PASS — el progreso **no cambia** |
| §22 contexto de navegador limpio, misma sesión | PASS — **mismo** progreso |
| §23 dismiss oculta la tarjeta | PASS |
| §23 dismiss **no** altera el resultado de la RPC | PASS — idéntica antes y después |
| §23 al limpiar la preferencia local vuelve | PASS — con el **mismo** progreso |
| §24 320 / 390 / 430 / 1440 | PASS — 0 desborde horizontal, 5 filas, todas ≥44 px y alcanzables al toque, contador con forma `n/5` y ≥11 px |
| §24 dark / light | PASS — los tokens resuelven en ambos (ni fondo ni texto transparentes) |

A 320 px la fila más larga («Crear tu primera orden de reparación») envuelve en
dos líneas sin romper la tarjeta ni empujar el `Ir →`.

### 17.15 MOBILE-2A sin regresión (§25)

La suite `@mobile2a` completa corrió con la DB nueva: **3/3 PASS**, incluido el
quick-create de `/orders/new` en 320/390/430. No se tocaron Vault ni secretos.
Las capturas de evidencia que la suite regenera se revirtieron: pertenecen al
lote MOBILE-2A, no a éste.

### 17.16 Finanzas intactas (§26)

Recuento de producción **después** de todo el rollout, comparado contra el
snapshot PRE de §17.8:

| Tabla | PRE | POST |
|---|---|---|
| `businesses` | 30 | 30 |
| `customers` | 128 | 128 |
| `orders` | 117 | 117 |
| `inventory` | 795 | 795 |
| `comprobante_payments` | 354 | 354 |
| `order_payments` | 1 | 1 |
| `account_movements` | 5 | 5 |
| `financial_movements` | 382 | 382 |
| `business_finance_entries` | 592 | 592 |

**Cero escrituras.** Consultar el progreso no asienta nada — FIRST-STEPS es
read-only por construcción.

### 17.17 Estado final de migraciones (§27)

| Versión | Lote | Estado |
|---|---|---|
| `20260903120000` | MOBILE-2A (EXPAND) | ✅ aplicada |
| `20260904120000` | ONBOARDING-1 | ✅ aplicada |
| `20260905120000` | **FIRST-STEPS-1** | ✅ **aplicada** |
| — | MOBILE-2A CONTRACT | ❌ **no aplicada** (pendiente de drenaje, no tocar) |
| — | ONBOARDING-2 | ❌ no iniciado |

Migration head de producción: **`20260905120000`**.

### 17.18 Pendiente

Queda **una** cosa, y requiere una persona con la sesión del OWNER QA:

- **Smoke humano en producción (§21).** Abrir el Dashboard con «cuenta prieba»
  (no «Clic.») y confirmar que «Primeros pasos» muestra **3 de 5**, con
  *cliente*, *orden* y *logo* tildados, y *inventario* y *cobro* pendientes —
  exactamente lo que devolvió la RPC en §17.11. Si ese navegador conserva la
  clave vieja `onboarding_done_<businessId>`, se puede borrar: es basura del
  componente anterior. El componente nuevo la ignora de todos modos (probado en
  §17.14), así que borrarla no debería cambiar nada de lo que se ve.

Todo lo demás quedó medido.

---

## 18. Veredicto del rollout

**P0-FIRST-STEPS-1 — EN PRODUCCIÓN.**

Frontend `bbcd618` servido, DB en `20260905120000`, seguridad verificada contra
producción (`anon` denegado en ejecución, firma sin `business_id`, `PUBLIC`
revocado), progreso real del tenant QA reproducido exactamente, y cero
escrituras. Falta únicamente el smoke humano de §17.18 para declararlo
**STABLE IN PRODUCTION**.
