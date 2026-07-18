# M7 — Lote 7C.1 · Auditoría y hardening de funciones SECURITY DEFINER

**Fecha:** 2026-07-16 · **Estado:** completo, local. **Cero escrituras en producción.**
Sin commit, push, backfill ni tag. Sin cambios en `src/`.

---

## Resumen ejecutivo

**La vulnerabilidad es real y la reproduje.** Un rol `authenticated` puede **evadir el paywall completo de suscripciones** creando una tabla temporal. No es teórico:

```
ANTES:   business_has_feature('mayorista') = false   ← negocio plan 'basico'
ATAQUE:  CREATE TEMP TABLE businesses (...); INSERT ... 'full'
DESPUÉS: business_has_feature('mayorista') = true
         business_has_feature('audit')     = true
```

La función corre como `postgres` (SECURITY DEFINER) y termina leyendo **la tabla del atacante**.

Y hay un giro que sólo apareció por probarlo: **mi primer arreglo no funcionó.**

## 1. Las 13 funciones

Todas `owner=postgres`, `SECURITY DEFINER`, **sin `proconfig`**, y ejecutables por `PUBLIC`, `anon`, `authenticated` y `service_role`.

| Función (firma) | Dominio | Search path | Refs no calificadas | Consumidor activo | Riesgo prelim. |
|---|---|---|---|---|---|
| `business_has_feature(text)` | entitlements | *(ninguno)* | `businesses`, `current_user_business_id()` | `src/lib/entitlements.ts` + policies RLS | **Explotable** |
| `check_user_limit_before_invite(uuid)` | usuarios | *(ninguno)* | sí | `UsersManagement.tsx:263` | Riesgo latente |
| `insert_personal_default_categories(uuid)` | Mi Guita | *(ninguno)* | sí | **ninguno** | Riesgo latente |
| `pay_personal_debt(uuid,uuid,numeric,date,text)` | Mi Guita | *(ninguno)* | sí | `debtService.ts:190` | **Explotable** |
| `pay_recurring_expense(uuid,uuid,numeric,date,text)` | Mi Guita | *(ninguno)* | sí | `recurringExpenseService.ts:250` | **Explotable** |
| `personal_savings_goal_operation(uuid,uuid,numeric,text,date,text)` | Mi Guita | *(ninguno)* | sí | `savingsService.ts:105` | **Explotable** |
| `personal_update_balance(uuid,numeric)` | Mi Guita | *(ninguno)* | sí | **ninguno** | Riesgo latente |
| `personal_update_currency_balance(uuid,text,numeric)` | Mi Guita | *(ninguno)* | sí | `personalService.ts:306,323` | **Explotable** |
| `preview_missing_stock_movements(uuid)` | inventario | *(ninguno)* | sí | `StockRepairTool.tsx:43` | Riesgo latente (STABLE) |
| `process_mp_subscription_payment(text,text,text,numeric,text,jsonb)` | suscripciones | *(ninguno)* | sí | **ninguno** | **Explotable** |
| `repair_missing_stock_movements(uuid,boolean)` | inventario | *(ninguno)* | sí | `StockRepairTool.tsx:58` | **Explotable** |
| `sync_business_logo_url()` | negocio | *(ninguno)* | sí | trigger | Riesgo latente |
| `update_inventory_dollar_prices(uuid,numeric)` | inventario | *(ninguno)* | sí | `currencyService.ts:201` | **Explotable** |

## 2. Matriz de privilegios de schemas — el dato que lo decide

| schema | anon USAGE | **anon CREATE** | auth USAGE | **auth CREATE** | **PUBLIC CREATE** |
|---|---|---|---|---|---|
| **`public`** | ✅ | **🔴 SÍ** | ✅ | **🔴 SÍ** | **🔴 SÍ** |
| `extensions` | ✅ | ❌ | ✅ | ❌ | ❌ |
| `auth`, `storage`, `realtime`, `graphql*`, `net`, `supabase_functions` | ✅ | ❌ | ✅ | ❌ | ❌ |
| `pg_catalog`, `information_schema` | ✅ | ❌ | ✅ | ❌ | ❌ |
| `cron`, `vault`, `pgbouncer`, `_realtime`, `supabase_migrations` | ❌ | ❌ | ❌ | ❌ | ❌ |

**`public` admite CREATE para anon, authenticated y PUBLIC.** No lo asumí: lo probé con `has_schema_privilege`. Es el default de Supabase y nadie lo cerró.

`search_path` del cluster: `"$user", public, extensions`. `anon`/`authenticated`/`service_role` no tienen `search_path` propio ni membresías, y son **NOLOGIN** (sólo `authenticator` y `postgres` pueden conectarse).

## 3. Clasificación

### 🔴 Explotables (8)

`business_has_feature`, `pay_personal_debt`, `pay_recurring_expense`, `personal_savings_goal_operation`, `personal_update_currency_balance`, `process_mp_subscription_payment`, `repair_missing_stock_movements`, `update_inventory_dollar_prices`.

Cumplen los tres requisitos: caller no confiable con EXECUTE + puede crear objetos en un schema buscado (`pg_temp`, siempre; `public`, por el grant) + referencias susceptibles de shadowing.

**Evidencia reproducible** (`business_has_feature`, la más grave): arriba. Benigna — sin secretos, sin efectos económicos, sin APIs, dentro de una transacción con `ROLLBACK`.

### 🟡 Riesgo latente (5)

`check_user_limit_before_invite`, `insert_personal_default_categories`, `personal_update_balance`, `preview_missing_stock_movements`, `sync_business_logo_url`.

Mismo defecto estructural, pero el impacto es menor (lectura, trigger, o sin consumidor). Dependen de que nadie cambie los grants.

### ⚪ Falsos positivos: **ninguno**

Las 13 tienen el defecto. Ninguna califica sus referencias, y todas eran invocables por `PUBLIC`.

### Alcance práctico — lo digo con precisión

Vía **PostgREST no hay superficie DDL**: un atacante con sólo una API key no puede correr `CREATE TEMP TABLE`. Eso **acota** la explotabilidad inmediata, pero no la elimina como primitiva:

- `authenticator` **sí** puede loguearse, y desde ahí `SET ROLE authenticated` + `CREATE TEMP TABLE` → **escalada real a `postgres`** (`authenticator` no es superuser ni bypassrls; `postgres` sí).
- Cualquier RPC futura que cree tablas temporales con nombres influenciables reabre el vector.
- Una inyección SQL en cualquier punto se convierte en escalada a `postgres`.

Por eso lo traté como explotable: **el arreglo es trivial y sin riesgo, y la primitiva está probada.**

## 4. El hardening — y el error que la prueba cazó

Mi primer intento fue `SET search_path = pg_catalog, public`, **omitiendo `pg_temp`** con el razonamiento de que así quedaba fuera. Volví a correr el exploit como exige tu §4… **y seguía funcionando**:

```
DESPUÉS del primer "arreglo": business_has_feature('mayorista') = true   ← seguía roto
```

La documentación de PostgreSQL (5.9.3) explica por qué:

> *El schema temporal … **si no está listado en el path, se busca primero** (incluso antes que `pg_catalog`).*

**Omitir `pg_temp` no lo excluye: lo pone primero.** La corrección real es listarlo **explícitamente y al final**:

```sql
SET search_path = pg_catalog, public, pg_temp
```

Con eso, mismo ataque:

```
ANTES:   business_has_feature('mayorista') = false
ATAQUE:  CREATE TEMP TABLE businesses (...)
DESPUÉS: business_has_feature('mayorista') = false   ✅ el ataque está muerto
```

**`search_path` final de las 13**: `pg_catalog, public, pg_temp`.

- `pg_catalog` primero y explícito.
- `public` es **necesario** (las funciones viven y operan ahí). Sigue siendo escribible por roles no confiables, pero ya no alcanza: un atacante **no puede crear en `public` un objeto que ya existe** — colisiona por nombre.
- `pg_temp` **al final**, que es lo único que lo saca del camino de resolución de tablas. Ninguna de las 13 usa tablas temporales, así que es inocuo para su lógica.
- **Ninguna firma cambió. Ninguna lógica comercial cambió.**

Preferí `SET search_path` por función antes que calificar cientos de referencias: es una sola línea por función, verificable, y no toca código de dominios ajenos (Mi Guita, suscripciones) que no me tocaba auditar.

## 5. Grants antes / después

| función | antes | después | motivo |
|---|---|---|---|
| `business_has_feature` | PUBLIC, anon, auth, svc | **auth, svc** | `entitlements.ts` + policies RLS |
| `check_user_limit_before_invite` | PUBLIC, anon, auth, svc | **auth** | `UsersManagement.tsx:263` |
| `insert_personal_default_categories` | PUBLIC, anon, auth, svc | **svc** | sin consumidor en `src/` |
| `pay_personal_debt` | PUBLIC, anon, auth, svc | **auth** | `debtService.ts:190` |
| `pay_recurring_expense` | PUBLIC, anon, auth, svc | **auth** | `recurringExpenseService.ts:250` |
| `personal_savings_goal_operation` | PUBLIC, anon, auth, svc | **auth** | `savingsService.ts:105` |
| `personal_update_balance` | PUBLIC, anon, auth, svc | **svc** | sin consumidor en `src/` |
| `personal_update_currency_balance` | PUBLIC, anon, auth, svc | **auth** | `personalService.ts:306,323` |
| `preview_missing_stock_movements` | PUBLIC, anon, auth, svc | **auth, svc** | `StockRepairTool.tsx:43` |
| **`process_mp_subscription_payment`** | PUBLIC, anon, auth, svc | **🔒 svc únicamente** | webhook; **anon y authenticated pierden EXECUTE** |
| `repair_missing_stock_movements` | PUBLIC, anon, auth, svc | **auth, svc** | `StockRepairTool.tsx:58` |
| `sync_business_logo_url` | PUBLIC, anon, auth, svc | **ninguno** | trigger; no se invoca por RPC |
| `update_inventory_dollar_prices` | PUBLIC, anon, auth, svc | **auth** | `currencyService.ts:201` |

**Ningún `anon` sobrevive. Ningún `PUBLIC` sobrevive.** Cada `authenticated` conservado tiene un consumidor verificado con línea exacta.

### Las tres del §6

- **`process_mp_subscription_payment`** → su caller legítimo es el **webhook por service_role**. No tiene consumidor en `src/` ni en `supabase/functions`. Procesa pagos de suscripción: **anon y authenticated pierden EXECUTE**.
- **`repair_missing_stock_movements`** → **sí** debe ser invocable por el cliente: es una herramienta del comercio (`StockRepairTool.tsx`), no de plataforma. Conservo `authenticated`; su validación de negocio vive dentro. Cierro anon/PUBLIC.
- **`pay_personal_debt`** → flujo legítimo de Mi Guita preservado con `authenticated`. **No cambié su lógica comercial**: no encontré una vulnerabilidad directa más allá del `search_path`, y auditar su validación de actor/ownership es otro dominio y otro lote.

## 6. Helpers M7 — reverificados

| helper | search_path | anon | authenticated |
|---|---|---|---|
| `finance_begin_audit_scope()` | ✅ fijo | ❌ | ❌ |
| `finance_log_audit(…)` | ✅ fijo | ❌ | ❌ |
| `assert_period_open(uuid,date)` | ✅ fijo | ❌ | ❌ |
| `is_comprobante_annulled(uuid)` | ✅ fijo | ❌ | ✅ (STABLE, solo lectura) |
| `comprobante_state_is_annulled(…)` | ✅ fijo | ❌ | ✅ (IMMUTABLE, función pura) |
| `normalize_*_payment_method` | ✅ fijo | ❌ | ❌ |

**Ningún helper que setee una GUC sensible es invocable por el cliente.** Y probé (HM5) que **la GUC no alcanza como autorización**: un `authenticated` que setea `m7.annulment_scope='1'` a mano **sigue sin poder anular** — el guard exige `current_user='postgres'`.

## 7. Checks globales restringidos (§8)

`p_include_global` es un parámetro **del cliente**: por sí solo no autoriza nada. Ahora exige una condición **real de operador** — ser owner del negocio, verificado server-side por `finance_hc_can_see_global(uuid)` contra `businesses.owner_user_id` vía `auth.uid()`.

Un miembro no-owner **no recibe error**: obtiene sus 44 checks del negocio más un check `global_checks_restricted` (`info`) que le informa que se omitieron, **sin exponer detalles sensibles**. El contrato del frontend no se rompe.

## 8. Suites

`etapa7_7c1_security_definer_hardening_test.sql` — **40 asserts**. Batería completa: **42 suites, 1879 asserts, 0 fallas**.

Cobertura: inventario (0 SECURITY DEFINER sin search_path) · `pg_temp` nunca antes de otro schema · las 13 con `pg_catalog, public, pg_temp` · **shadowing antes/después** (SH1–SH3) · anon y PUBLIC sin EXECUTE (GR1–GR2) · Mercado Pago sólo service_role (MP1–MP3) · stock repair preservado (ST1–ST3) · Mi Guita preservado (MG1–MG5) · entitlements/invitaciones/USD preservados (EN1–EN3) · helpers M7 (HM1–HM7, incluida la GUC insuficiente) · checks globales restringidos sin romper contrato (GC1–GC7) · cross-tenant y actor falsificado (XT1–XT2).

Gates: `tsc`, `lint:errors`, `test:unit`, `build`, `guard:finance-writes`, `guard-readonly-healthcheck`, `git diff --check` — **todos en 0**. Suites de Mi Guita, MP, inventario, RLS y M7 financiera: dentro de la batería, todas verdes.

## 9. Riesgos restantes

1. **`public` sigue admitiendo CREATE para `anon`, `authenticated` y `PUBLIC`.** Es el defecto de base. `REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated` sería el hardening estructural — **no lo hice**: podría romper extensiones, migraciones o herramientas de Supabase que asuman ese grant, y verificarlo excede este lote. **Lo recomiendo como lote propio.** Con el `search_path` fijo, el vector conocido está cerrado igual.
2. **Cualquier función nueva SECURITY DEFINER sin `search_path` reabre el agujero.** Mitigación: el check `secdef_without_search_path` del health check v2 ya lo detecta — conviene sumarlo a un gate de CI.
3. **No auditué la lógica interna de Mi Guita ni de MP** (validación de actor/ownership dentro de `pay_personal_debt` y compañía). Sólo cerré el `search_path` y los grants. Otro dominio, otro lote.
4. **`sync_business_logo_url` quedó sin EXECUTE para nadie**: es una trigger function y los triggers no chequean EXECUTE. Verificado que el trigger sigue funcionando (batería verde), pero es una decisión que conviene recordar.
5. **`personal_update_balance` e `insert_personal_default_categories` pasaron a `service_role`.** No tienen consumidor en `src/`, pero si alguna RPC de Mi Guita las llama internamente vía SECURITY DEFINER seguirán funcionando (el caller es `postgres`). Si aparece un consumidor directo de frontend, habrá que revisarlo.
6. **El exploit se probó sobre `business_has_feature`.** Las otras 12 tienen el mismo defecto estructural y la misma corrección; no reproduje una prueba individual para cada una — para las de efectos peligrosos (pagos, stock) usé análisis estático, como pedía tu §3.

## 10. Recomendación

# 🟢 GO FRONTEND

El agujero probado está cerrado y verificado con el mismo ataque que lo demostró. Los 13 `search_path` están fijos, `anon` y `PUBLIC` fuera de todas, cada `authenticated` conservado tiene consumidor verificado, los helpers M7 siguen cerrados, los checks globales quedaron restringidos a owner sin romper el contrato, y la batería completa pasa en verde.

Queda un riesgo estructural conocido y documentado (`CREATE` sobre `public`), que **no bloquea** el frontend mínimo: el vector concreto ya no funciona.

---

**Me detengo acá.** No avancé con frontend, no desplegué, no escribí en producción, y no hice commit, push, backfill ni tag.
