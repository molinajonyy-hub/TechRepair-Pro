# M7 HOTFIX — Aislamiento cross-tenant en las vistas canónicas de finanzas

**Estado: BLOQUEADO esperando autorización. No aplicado en producción. No mergeado. Sin tag.**

Rama: `fix/m7-canonical-views-security-invoker` (creada desde `origin/main` = `45b38f7`).
Posterior al tag `stable-finance-m7-audit-accrual-v1`, que **no se movió ni se modificó**.

Detectado durante la Fase 1 de M8A. M8A quedó **detenido**: no se construyó ninguna
vista, RPC ni contrato analítico, porque toda la fundación se apoyaría sobre estas
mismas vistas.

---

## 0. Nota sobre la evidencia — DATOS SANITIZADOS

**Ninguna cifra ni UUID de este documento es real.** La evidencia se obtuvo contra
producción, pero se redactó antes de versionarla.

| Símbolo | Significado |
|---|---|
| `11111111-…` | negocio **tenant_a** (UUID ficticio) |
| `22222222-…` | negocio **tenant_b** (UUID ficticio) |
| `aaaaaaaa-…` | usuario owner de tenant_a (UUID ficticio) |
| `bbbbbbbb-…` | usuario owner de tenant_b (UUID ficticio) |
| `N_A`, `N_B`, `N_A_margin` | conteos de filas, redactados |
| cifras en ARS | **sintéticas** |

Las cifras sintéticas **preservan las relaciones aritméticas** que sostienen el
argumento, para que el razonamiento siga siendo verificable:

- `net_sales` filtrado = `net_sales` propio + `sales_returns`
  (9.015.000,00 = 9.000.000,00 + 15.000,00) — así se ve que el CTE `returns` daba 0;
- `net_result` = `total_income` − `total_expenses` (§13).

Los valores reales **no se versionan**. Se re-derivan ejecutando los procedimientos
descritos, que están completos y son reproducibles sin ningún secreto.

> ⚠️ **Exposición residual conocida.** El mensaje del commit `a761792` —anterior a esta
> sanitización— contiene cifras productivas exactas y no fue reescrito, por indicación
> explícita de no modificarlo. Los **archivos** quedaron limpios, pero el **historial de
> git no**. Si esta rama va a un PR público o a un repo con más lectores, hay que
> decidir antes si se reescribe ese mensaje (`git rebase -i` / `filter-repo`), lo cual
> sí altera el commit. Es una decisión tuya: la señalo, no la tomo.

---

## 1. Las tres vistas afectadas

| | |
|---|---|
| Schema | `public` |
| Owner | `postgres` (las tres) |
| Motor | PostgreSQL 17.6 → `security_invoker` soportado (requiere 15+) |

| Vista | `reloptions` | `anon` | `authenticated` | `service_role` |
|---|---|---|---|---|
| `v_finance_sales_ledger` | `NULL` | — | `SELECT` | `SELECT` |
| `v_finance_pnl` | `NULL` | — | `SELECT` | `SELECT` |
| `v_finance_product_margin` | `NULL` | — | `SELECT` | `SELECT` |

`anon` **no** tiene SELECT sobre ninguna: el leak requiere estar autenticado.

### Relaciones subyacentes y sus políticas RLS

`v_finance_sales_ledger` → `comprobantes`, `comprobante_items`, `comprobante_payments`,
`account_movements`, `comprobante_annulments`.
`v_finance_pnl` → `v_finance_sales_ledger`, `v_finance_effective_comprobantes`,
`business_finance_entries`.
`v_finance_product_margin` → `v_finance_sales_ledger`.

Todas las tablas base **tienen RLS activo y correcto**:

| Tabla | Política SELECT |
|---|---|
| `comprobantes` | `business_id = current_user_business_id()` |
| `comprobante_items` | `business_id = current_user_business_id()` |
| `comprobante_payments` | `business_id = current_user_business_id()` |
| `business_finance_entries` | `business_id IN (SELECT business_id FROM profiles WHERE COALESCE(user_id,id)=auth.uid())` |
| `account_movements` | `current_business_id() = business_id AND is_staff() AND business_has_feature('currentAccounts')` |
| `comprobante_annulments` | owner del negocio OR perfil del negocio |

**El RLS nunca estuvo mal. Lo que estaba mal era el modo de evaluación de la vista**,
que hacía que esas políticas no llegaran a evaluarse.

### Consumidores

| Consumidor | Vía | Impacto del fix |
|---|---|---|
| `finance_dashboard_summary` (RPC) | `v_finance_pnl`, `v_finance_position` | **Ninguno** — es `SECURITY DEFINER`, corre como `postgres` y filtra por `p_business_id` con guard de membresía server-side. JSON verificado **byte-idéntico** antes y después. |
| `src/pages/FinanceDashboard.tsx:304` | `v_finance_pnl` directo | Pasa a estar acotado por RLS. Datos propios sin cambios. |
| `src/hooks/useDashboardStats.ts:260` | `v_finance_product_margin` directo | Ídem. N_A_margin filas propias antes y después. |
| `v_finance_sales_ledger` | sin consumo directo desde el frontend | Sustrato de las otras dos. |

---

## 2. Causa raíz

**No fue un olvido al crear las vistas. Fue un `CREATE OR REPLACE` posterior.**

```
20260704120000_canonical_views.sql:48
    CREATE OR REPLACE VIEW "public"."v_finance_pnl"
      WITH (security_invoker = true) AS ...          ← nace BIEN

20260713270000_m7_6f4c_accrual_views.sql:119
    CREATE OR REPLACE VIEW "public"."v_finance_pnl" AS ...   ← queda MAL
```

En PostgreSQL, `CREATE OR REPLACE VIEW` **sin** cláusula `WITH` no preserva las
`reloptions`: **las resetea**. La migración 6F.4c cambió el cuerpo de las vistas para
que leyeran el ledger devengado y, sin nombrarlo ni notarlo, les quitó
`security_invoker`.

- `v_finance_pnl` y `v_finance_product_margin`: nacieron correctas en `20260704120000`, quedaron expuestas por `20260713270000`.
- `v_finance_sales_ledger`: creada en `20260713270000`, nunca lo tuvo.

Es una regresión silenciosa: no hay diff que diga "se quitó security_invoker", el
permiso desaparece como efecto colateral de reemplazar el cuerpo.

---

## 3. Evidencia reproducible

Toda la evidencia se obtuvo con **JWT `authenticated` real** (`SET LOCAL ROLE authenticated`
\+ `request.jwt.claims` con el `sub` de un usuario real). **Ninguna prueba se ejecutó con
`postgres`, `service_role` ni `supabase_admin`.** Todo dentro de transacciones con
`ROLLBACK`: no se modificó ni un dato.

- Negocio **A** = `11111111-1111-4111-8111-111111111111`, usuario `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` (owner)
- Negocio **B** = `22222222-2222-4222-8222-222222222222`, usuario `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` (owner)

### 3.1 El leak, con control en la misma sesión

Usuario A, su propio JWT:

| Consulta | Resultado | |
|---|---|---|
| `count(distinct business_id)` en `comprobantes` | **1** | CONTROL: RLS funciona |
| `count(distinct business_id)` en `comprobante_items` | **1** | CONTROL: RLS funciona |
| `count(distinct business_id)` en `v_finance_pnl` | **3** | ← LEAK |
| `count(distinct business_id)` en `v_finance_sales_ledger` | **3** | ← LEAK |
| `count(distinct business_id)` en `v_finance_product_margin` | **2** | ← LEAK |
| `sum(net_sales)` de **B** leído por **A** | **400.000,00** | dato ajeno |
| filas de ledger de **B** leídas por **A** | **N_B** | dato ajeno |

El control es lo que hace concluyente la prueba: en la **misma sesión y con el mismo
JWT**, las tablas base aíslan y las vistas no. El defecto es de la vista, no del
contexto de autenticación del test.

### 3.2 Dirección inversa (B → A)

| | |
|---|---|
| CONTROL `comprobantes` | 1 negocio |
| `v_finance_pnl` | 3 negocios |
| `sum(net_sales)` de **A** leído por **B** | **9.015.000,00** |
| filas de ledger de **A** leídas por **B** | **N_A** |

### 3.3 `anon`

`permission denied for view v_finance_pnl` — sin grant. Correcto.

### 3.4 Los datos filtrados además eran incorrectos

`v_finance_pnl` compone `v_finance_effective_comprobantes`, que **sí** tiene
`security_invoker`. Al leer un negocio ajeno se mezclaban dos contextos de seguridad:
el CTE `sales` corría como `postgres` (veía todo) y el CTE `returns` corría como el
lector (no veía nada del negocio ajeno). Las notas de crédito del negocio observado se
computaban como **0**:

| | net_sales | sales_returns |
|---|---|---|
| A leído por **A** (correcto) | 9.000.000,00 | 15.000,00 |
| A leído por **B** (filtrado) | 9.015.000,00 | **0,00** |

La cifra expuesta no sólo era privada: era **falsa**. Ningún consumidor legítimo lee un
negocio ajeno, por eso **el fix no altera ninguna métrica en uso**.

---

## 4. El fix

`supabase/migrations/20260720120000_m7_hotfix_canonical_views_security_invoker.sql`

```sql
ALTER VIEW public.v_finance_sales_ledger   SET (security_invoker = true);
ALTER VIEW public.v_finance_pnl            SET (security_invoker = true);
ALTER VIEW public.v_finance_product_margin SET (security_invoker = true);
```

Más un guard de versión de motor (aborta bajo PG15) y una post-condición dura que hace
fallar la migración si alguna de las tres quedó sin la opción — una migración de
seguridad que se aplica a medias y reporta éxito es peor que una que no corre.

**No se recrean las vistas.** `ALTER VIEW` conserva definición, columnas, tipos,
dependencias y grants. Verificado: **43 columnas antes y después, 0 diferencias de firma**.

Las tres sentencias son **literales a propósito**. La primera versión las aplicaba en un
bucle con `format()`/`EXECUTE`; es más compacto, pero deja el cambio invisible para
cualquier herramienta que lea SQL, y el guard estático no podía verlo. SQL de seguridad
tiene que ser greppable.

**Alcance:** un barrido del catálogo confirmó que son las **únicas** relaciones de
`public` alcanzables por `anon`/`authenticated` a las que les falta `security_invoker`.
No toca ledger, checkout, caja, ARCA, POS, ni ninguna otra vista, función o tabla.

---

## 5. Verificación de que no rompe acceso legítimo

Aplicado dentro de una transacción con `ROLLBACK` contra producción:

| Escenario | Resultado |
|---|---|
| A ve sólo lo suyo | `v_finance_pnl`, ledger y margin → **1 negocio** |
| Filas de B visibles para A | **0** |
| Agregado de B leído por A (`sum(net_sales)`) | **0** — limpio también en agregados, no sólo en filas crudas |
| **Totales propios de A sin cambios** | net_sales **9.000.000,00** antes y después; N_A filas de ledger antes y después |
| **Totales propios de B sin cambios** | N_B filas, net_sales **400.000,00**, operating_result **380.000,00** — idénticos |
| B ve sólo lo suyo | ledger de A → **0 filas**; agregado de A → **0** |
| Usuario autenticado sin negocio | **0 filas** en las tres |
| `anon` | sigue sin acceso |
| `authenticated` conserva SELECT | sí |
| `service_role` | sin cambios |
| **`permission denied` inesperados** | **ninguno** — `authenticated` ya tenía los SELECT necesarios sobre las tablas base; el fix **no requirió ampliar ningún grant** |
| Columnas y tipos | 43 = 43, 0 diffs |
| `finance_dashboard_summary` (consumidor principal) | JSON **byte-idéntico** (`json_identico = true`) |
| `finance_health_check_v2` sigue `STABLE` | sí (read-only por motor) |

No se concedió `SELECT` sobre ninguna tabla base. No hizo falta la alternativa por RPC
`SECURITY DEFINER`.

---

## 6. Health Check

`supabase/migrations/20260720121000_m7_hotfix_hc_canonical_view_isolation_check.sql`

Nuevo check **`canonical_views_without_security_invoker`** (categoría `security`,
severidad `critical`), incorporado al conteo real: **78 → 79 checks**.

Inspecciona `pg_class.reloptions` y reporta una vista sólo si se cumplen **las dos**
condiciones: le falta `security_invoker` **y** es alcanzable por `anon`/`authenticated`.
Una vista interna sin grants no puede filtrar hacia la app y no se reporta — así el check
no genera falsos positivos.

Va detrás de `p_include_global` + `finance_hc_can_see_global` (owner real verificado
server-side), como el resto de los checks de plataforma: un hallazgo de infraestructura no
debe pintar de rojo el health check de cada comercio.

**Cómo se construyó la migración:** por **copia binaria** de
`20260714130000_…` (hash verificado idéntico) más un bloque insertado. Diff verificado:
**78 líneas agregadas, 9 quitadas**, todas del encabezado y del bloque nuevo. No se
transcribió el cuerpo a mano — `7E.3` documenta que hacerlo le devolvió a las funciones un
`search_path` viejo sin `pg_temp` y deshizo la barrera de `20260713310000`. El `DO` final
de la migración vuelve a verificarlo.

---

## 7. Guard estático

`scripts/finance/guard-view-security-invoker.mjs` — `npm run guard:view-invoker`,
integrado a `npm run guards`.

El Health Check mira la base viva; el guard mira el **texto de las migraciones**, que es
una red distinta: atrapa el defecto en el diff, antes de que exista en ninguna base.

Es **ordenado, no acumulativo**: gana la última sentencia. Esa es la diferencia que
importa — la primera versión preguntaba "¿alguna vez se le puso `security_invoker`?" y
daba verde justamente sobre las dos vistas que un `REPLACE` posterior había roto.

**Validación cruzada:** ejecutado sobre el corpus **sin** el hotfix, el guard identifica
exactamente las tres vistas:

```
public.v_finance_pnl             (authenticated)
public.v_finance_product_margin  (authenticated)
public.v_finance_sales_ledger    (authenticated)
```

Dos métodos independientes — sondeo empírico en producción y análisis estático del repo —
convergen en el mismo conjunto.

Dos bugs propios los encontró el propio banco de fixtures y correrlo contra el repo real:
la forma `pg_dump` (`WITH ("security_invoker"='true')`, mayoritaria en el baseline) daba
falsos positivos, y un cuantificador goloso en el parser de `GRANT` se comía sentencias
enteras y ocultaba `v_finance_sales_ledger`.

---

## 8. Pruebas

`supabase/tests/m7_hotfix_canonical_views_security_invoker_test.sql` — 26 asserts,
transacción + `ROLLBACK`.

Cubre: configuración de catálogo (SI1-SI4), estabilidad de firma (SI5-SI6), `anon` sin
acceso y `authenticated` conservándolo (SI7-SI10), aislamiento real con JWT en **ambas
direcciones** con control asserteado (SI11-SI19), usuario sin negocio (SI20),
**falsificación** (SI21-SI24), idempotencia (SI25) y read-only del health check (SI26).

La sección de falsificación apaga `security_invoker` dentro de la transacción y exige que
el leak **reaparezca** y que el predicado del check pase a `fail`. Un test de seguridad que
nunca vio fallar su predicado no probó nada.

Los negocios y usuarios se **descubren en runtime**: el suite corre igual en local,
staging y producción, sin ids hardcodeados.

### Resultados ejecutados

| | |
|---|---|
| `npx tsc --noEmit` | **0 errores** |
| `npm run lint:errors` | **0 errores** |
| `npm run guards` (incluye los 2 self-tests nuevos) | **PASS** |
| `guard:view-invoker` self-test | **22/22 fixtures** |
| `npm run test:unit` | **484/484 pass** |
| `npm run build` | **OK** (11.47s) |
| Validación transaccional contra prod | **PASS** (§5) |

**No ejecutado:** `supabase db reset` local y el suite SQL contra una base local. El
entorno Docker local no se levantó en esta sesión. Las pruebas SQL se validaron
transaccionalmente contra producción con `ROLLBACK`, que verifica el comportamiento real
pero **no** el flujo `reset`/`push` desde cero. Queda como paso previo al deploy.

---

## 9. Archivos

| Archivo | |
|---|---|
| `supabase/migrations/20260720120000_m7_hotfix_canonical_views_security_invoker.sql` | nuevo — el fix |
| `supabase/migrations/20260720121000_m7_hotfix_hc_canonical_view_isolation_check.sql` | nuevo — check del health check |
| `supabase/tests/m7_hotfix_canonical_views_security_invoker_test.sql` | nuevo — 26 asserts |
| `scripts/finance/guard-view-security-invoker.mjs` | nuevo — guard + 22 fixtures |
| `scripts/finance/secdef-baseline.json` | +1 entrada (deuda heredada, 0 regresiones) |
| `package.json` | +2 scripts, integrados a `guards` |
| `docs/auditoria-finanzas/m7-hotfix-vistas/rollback.sql` | nuevo — rollback escrito y revisado |
| `docs/auditoria-finanzas/m7-hotfix-vistas/README.md` | este documento |

**Cero cambios en `src/`.** El fix es enteramente de base de datos.

---

## 10. Riesgos

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Un consumidor dependía de leer datos cross-tenant | **Baja** | Ninguno lo hace. `finance_dashboard_summary` da JSON byte-idéntico; los dos lectores directos conservan sus datos propios exactos. |
| `security_invoker` exige permisos que un rol no tiene | **Cerrada** | Probado con roles reales: cero `permission denied`. No se amplió ningún grant. |
| Un rol legítimo ve *menos* que antes | **Cerrada** | Totales propios idénticos para A y B, antes y después. |
| Reaparición por otro `CREATE OR REPLACE` sin `WITH` | **Media → mitigada** | Es exactamente lo que pasó. Ahora hay dos redes: el check del Health Check (base viva) y el guard estático ordenado (texto de migraciones). |
| El flujo `reset`/`push` desde cero no se probó | **Media** | Pendiente antes del deploy (§8). |
| Números del dashboard cambian tras el deploy | **Nula** | Verificado byte-idéntico. |

---

## 11. Plan de despliegue

**No ejecutado. Requiere autorización explícita.**

1. Levantar Docker local, `supabase db reset`, correr el suite SQL nuevo + los suites 7C.1 y 7E.1 (PT3/PC14 vigilan el `search_path`). Cierra el hueco de §8.
2. `npm run guards && npm run test:unit && npm run build`.
3. Backup lógico manual antes de tocar prod — el plan es free y no tiene backups automáticos (ver `m7-7e3-blocked-on-backup`).
4. `supabase db push` (aplica `20260720120000` y `20260720121000`). Mergear **no** aplica migraciones: el push es a mano.
5. Post-deploy inmediato:
   - las tres vistas con `security_invoker=true` en `pg_class.reloptions`;
   - `finance_health_check_v2(:biz, true)` → `canonical_views_without_security_invoker` en **pass**, 79 checks, sin fails nuevos;
   - repetir el sondeo A→B y B→A con JWT real → **0 filas ajenas**;
   - `finance_dashboard_summary` del negocio A → `net_sales = 9.000.000,00`, `operating_result = 3.500.000,00`;
   - abrir el dashboard de finanzas y confirmar que los KPI no cambiaron.
6. Si algo sale mal: `docs/auditoria-finanzas/m7-hotfix-vistas/rollback.sql` — **reabre el leak a propósito**, sólo como paso intermedio.

---

## 12. Recomendación

**GO sobre el contenido — BLOQUEADO por dos condiciones previas.**

El defecto es real, está probado con el rol correcto, la causa raíz es concreta y el fix
es mínimo, reversible y verificado como no disruptivo para ningún consumidor.

Condiciones antes de aplicar:

1. Ejecutar el paso 1 del plan (`db reset` local + suites SQL). Es el único bloque de
   verificación que quedó sin correr.
2. Backup lógico manual (§11.3).

**Y una decisión aparte que no es parte de este hotfix**, abajo.

---

## 13. Hallazgo separado — `get_finance_summary`, severidad MAYOR

Encontrado durante el barrido. **Fuera del alcance de este hotfix; no se tocó.**

`public.get_finance_summary(p_business_id uuid, p_from date, p_to date)` es
`SECURITY DEFINER`, propiedad de `postgres`, **no tiene ninguna verificación de
`auth.uid()`** — filtra únicamente por el `p_business_id` que le pasa el llamador — y
tiene **`EXECUTE` otorgado a `anon`**.

Probado como `anon`, **sin autenticación alguna**:

```
get_finance_summary('tenant_a') →
  total_income     8.500.000,00
  total_expenses    5.000.000,00
  net_result        3.500.000,00
  pending_balance     250.000,00
```

Es **más grave** que el leak de las vistas: aquel exigía una sesión autenticada válida;
éste es alcanzable desde internet con la publishable key.

La función es **código muerto en el frontend** — sólo aparece en
`supabase/_archive/` y en el baseline remoto; ningún `.ts`/`.tsx` la invoca. Eso sugiere
que el arreglo correcto es `REVOKE` a `anon` y `authenticated`, o directamente `DROP`,
pero **no lo hice**: excede el alcance que fijaste y merece su propia decisión.

El barrido encontró además **23 funciones `SECURITY DEFINER` más** con `EXECUTE` para
`anon` y sin `auth.uid()` literal en su cuerpo — incluidas varias `admin_*` de
suscripciones. **No las verifiqué**: muchas probablemente se protegen con helpers como
`current_platform_admin_role()`, que sí usa `auth.uid()` por dentro, así que el listado
tiene falsos positivos casi con certeza. Lo dejo señalado como superficie a triar, **no**
como hallazgos confirmados. El único **probado** es `get_finance_summary`.

Recomendación: tratarlo como un segundo hotfix, con su propia rama y evidencia.
