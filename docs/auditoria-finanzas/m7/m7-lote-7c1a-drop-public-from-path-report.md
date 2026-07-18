# M7 — Lote 7C.1a · Eliminar `public` del search_path de las SECURITY DEFINER

**Fecha:** 2026-07-16 · **Estado:** completo, local. **Cero escrituras en producción.**
Sin commit, push, deploy, backfill ni tag. Sin cambios en `src/`.

---

## Resumen

Las 13 funciones quedaron con `search_path = pg_catalog, pg_temp` — **sin `public`** — y sus **71 referencias calificadas**. El ataque temporal está muerto y ninguna resolución depende ya del search_path.

Pero al verificar mi propio trabajo encontré algo que no esperaba: **la vulnerabilidad no se limitaba a las 13. Alcanzaba a 110 funciones, incluidas todas las RPC y guards de M7 que yo mismo escribí.** Lo probé y lo cerré.

## 1. Referencias no calificadas encontradas — 71

| Función | Referencias corregidas |
|---|---|
| `business_has_feature` | rel:`businesses` · fn:`current_user_business_id` |
| `check_user_limit_before_invite` | rel:`businesses`, `profiles` |
| `insert_personal_default_categories` | rel:`personal_categories` |
| `pay_personal_debt` | rel:`personal_debts`, `personal_accounts`, `personal_categories`, `personal_transactions`, `personal_debt_payments` · fn:`personal_update_currency_balance` · **ROWTYPE**:`personal_debts`, `personal_accounts` |
| `pay_recurring_expense` | rel:`personal_recurring_expenses`, `personal_accounts`, `personal_recurring_expense_payments`, `personal_categories`, `personal_transactions` · fn:`personal_update_currency_balance` · **ROWTYPE**:`personal_recurring_expenses`, `personal_accounts` |
| `personal_savings_goal_operation` | rel:`personal_savings_goals`, `personal_accounts`, `personal_transactions` · **ROWTYPE**:`personal_savings_goals` |
| `personal_update_balance` | rel:`personal_accounts`, `personal_account_balances` |
| `personal_update_currency_balance` | rel:`personal_accounts`, `personal_account_balances` |
| `preview_missing_stock_movements` | rel:`comprobante_items`, `comprobantes`, `inventory`, `wholesale_order_items`, `wholesale_orders` |
| `process_mp_subscription_payment` | rel:`subscription_payments`, `subscription_webhook_logs`, `subscription_checkout_sessions`, `businesses` |
| `repair_missing_stock_movements` | rel:`comprobante_items`, `comprobantes`, `inventory`, `inventory_movements`, `wholesale_order_items`, `wholesale_orders` |
| `sync_business_logo_url` | rel:`businesses` |
| `update_inventory_dollar_prices` | rel:`profiles`, `inventory` |

Sin tipos/dominios propios ni funciones de extensión sin calificar (verificado contra `pg_proc`/`pg_type`): por eso **`extensions` no hizo falta** en ningún path.

**Los 5 `%ROWTYPE` los descubrió el verificador, no yo.** Mi primer pase sólo miraba `FROM`/`JOIN`/`INSERT INTO`/`UPDATE`/`DELETE FROM`, casts y llamadas. Al quitar `public` del path, la migración falló con `relation "personal_debts" does not exist` — porque `%ROWTYPE` en `DECLARE` también resuelve por search_path. Agregué esa detección y las 5 aparecieron.

**Método**: la calificación se generó **programáticamente** desde `pg_get_functiondef` (no a mano), respetando comentarios y literales, y tocando sólo posiciones donde SQL espera una relación/función/tipo. No toqué lógica comercial ni firmas de dominios que no me tocaba auditar. El verificador es la propia ausencia de `public`: cualquier referencia omitida revienta al crear la función.

## 2. `search_path` final

**Las 13**: `pg_catalog, pg_temp`

- `pg_catalog` primero.
- **`public` FUERA** — confirmado: `PB1` verifica que ninguna de las 13 lo conserva.
- `pg_temp` explícito y **al final** — omitirlo lo pondría **primero** (doc PG 5.9.3).
- Sin `"$user"` (`PB3`) ni schemas escribibles por roles no confiables.
- `extensions` no incluido: ninguna lo necesita.

## 3. Resultado del ataque temporal

```
baseline mayorista        = false
con pg_temp.businesses    = false   ✅ muerto
```

## 4. Pruebas orientadas a `public`

| prueba | resultado |
|---|---|
| `CREATE SCHEMA evil` como `authenticated` | **`permission denied for database postgres`** — no puede crear schemas |
| `CREATE TABLE public.businesses` | **`relation "businesses" already exists`** — no puede shadowear lo existente |
| `CREATE FUNCTION public.current_user_business_id()` | **`already exists with same argument types`** |
| crear un nombre **nuevo** en `public` (`tabla_del_atacante`) | sin efecto: ninguna función privilegiada lo referencia |
| `search_path` de sesión = `pg_temp, public` | sin efecto → `false` |
| `search_path` de sesión **vacío** | sin efecto → `false` (todo calificado) |
| consumidores legítimos | funcionan: `business_has_feature('arca')=false` (plan básico, correcto), `preview_missing_stock_movements`=0 filas, `check_user_limit_before_invite`=`LIMIT_REACHED:1:1:basico` |

No fabriqué un exploit artificial: la evidencia principal es **estática** — no quedan referencias de aplicación cuya resolución dependa del search_path — y las pruebas dinámicas confirman que ningún vector real lo altera.

## 5. 🔴 Hallazgo nuevo: la vulnerabilidad alcanzaba a 110 funciones, incluidas las mías

Al revisar por qué el health check no marcaba las M7, verifiqué `is_comprobante_annulled` — la **condición canónica de anulado** que usan `trg_cp_annulled_guard` y `replace_comprobante_payment`. Tenía `SET search_path TO 'public'`, **sin `pg_temp` explícito**:

```
search_path = search_path=public
ANTES:   is_comprobante_annulled(comprobante_vigente) = false
ATAQUE:  CREATE TEMP TABLE comprobante_annulments (...); INSERT ... 'completed'
DESPUÉS: is_comprobante_annulled(comprobante_vigente) = true   ← falseada
```

El inverso es peor: una temp **vacía** haría que un comprobante **anulado** parezca vigente y el guard dejaría pasar cobros sobre él — justo lo que 6F.4a cerró.

**Alcance medido**: 141 SECURITY DEFINER en `public`; **110 omitían `pg_temp`**. Todas mis RPC y guards de M7 entre ellas.

**Remediación mínima y mecánica** (`20260713310000`): agregar `pg_temp` **al final** del path existente de las 110. Un `ALTER` por función, generado desde `pg_catalog` para no omitir ninguna. **No cambia lógica, firmas ni grants.** Verificado:

```
search_path = search_path=public, pg_temp
ANTES:   false   ·   DESPUÉS: false   ✅ cerrado
```

**Soy explícito sobre el alcance**: esto **no** deja a las 110 al nivel de las 13. Las 13 tienen el tratamiento completo (calificadas + `public` fuera). Las 110 conservan `public` en el path, así que siguen dependiendo de que nadie pueda shadowear un objeto **existente** — hoy imposible por colisión de nombre y porque `authenticated` no puede crear schemas. Es deuda declarada, no cerrada.

## 6. Guard de CI

`scripts/finance/guard-security-definer.mjs`. Falla cuando una SECURITY DEFINER: no fija `search_path` · incluye `"$user"` · **omite `pg_temp`** · pone `pg_temp` antes de un schema confiable · incluye `public` **y** conserva referencias sin calificar (incluidos `%ROWTYPE`). Inspecciona `CREATE [OR REPLACE] FUNCTION` y `ALTER FUNCTION ... SET search_path`, con overloads en la firma reportada.

**10 fixtures**: segura · sin search_path · public+tabla sin calificar · public pero todo calificado · pg_temp primero · omite pg_temp · `"$user"` · ROWTYPE sin calificar · SECURITY INVOKER (no aplica) · ALTER con public sin pg_temp.

`--self-test` **cazó 3 bugs reales en mi propio guard**: el parser del `search_path` se tragaba el ` AS $$…` que sigue en la misma línea, y por eso clasificaba mal la función segura, la de `public` calificada y la de `pg_temp` primero. Corregido; las 10 clasifican bien.

## 7. Health Check v2 actualizado

Nuevo check **`secdef_untrusted_search_path`** (`critical`, global, gated por owner). Falla si una SECURITY DEFINER tiene en su path: un schema **escribible por `anon`/`authenticated`/`PUBLIC`** (resuelto con `has_schema_privilege`, no por lista fija), `"$user"`, o **omite `pg_temp`**.

Estado real que reporta hoy: **`fail`, n=128** — las que aún conservan `public`. Es la deuda declarada del §5, medida automáticamente. `secdef_without_search_path` sigue en `pass` (n=0). No se expone a no-owners, conforme al diseño aprobado.

## 8. Grants preservados

**Sin cambios respecto de la matriz aprobada en 7C.1** — `CREATE OR REPLACE FUNCTION` preserva privilegios, y lo verifiqué: ningún `anon` (GR1), ningún `PUBLIC` (GR2), `process_mp_subscription_payment` sólo `service_role` (MP1–MP3), stock repair y Mi Guita con sus consumidores intactos (ST1–ST3, MG1–MG5), entitlements/invitaciones/USD intactos (EN1–EN3). **No reabrí ningún grant para hacer pasar un test.**

## 9. Suites

`etapa7_7c1_security_definer_hardening_test.sql`: 40 → **55 asserts**. Batería completa: **42 suites, 1894 asserts, 0 fallas**.

Nuevo: `public` fuera de las 13 (PB1–PB3) · cero SECURITY DEFINER sin `pg_temp` (PT3) · **el helper M7 ya no es falseable** (M7V1–M7V2) · el atacante no puede crear schemas ni shadowear lo existente (SC1–SC2) · el search_path de sesión (incluso vacío) no altera nada (SP1–SP2) · el health check detecta el schema no confiable y declara la deuda (HC1–HC5).

Gates: `tsc`, `lint:errors`, `test:unit`, `build`, `guard:finance-writes`, `guard-readonly-healthcheck`, `guard-security-definer --self-test`, `git diff --check` — **todos en 0**. Mi Guita, MP, inventario, features/planes, Health Check v2, M7 financiera y RLS: dentro de la batería, verdes.

## 10. Riesgos restantes

1. **128 funciones conservan `public` en su path** (deuda declarada arriba). El vector de la tabla temporal está cerrado en todas; lo que queda depende de la colisión de nombres. Cerrarlo del todo = calificar sus referencias, función por función. **Lote propio.**
2. **`public` sigue admitiendo `CREATE`** para `anon`/`authenticated`/`PUBLIC`. **No lo revoqué**, como pediste. Tras este lote **ninguna de las 13 depende de ese schema**, así que el resultado es seguro aunque siga escribible. Ver el lote propuesto abajo.
3. **La calificación se generó programáticamente.** Mitigación fuerte: sin `public` en el path, cualquier referencia omitida falla ruidosamente — y de hecho así aparecieron los `%ROWTYPE`. La batería de 1894 asserts es el verificador de que la lógica no cambió.
4. **No auditué la lógica interna** de Mi Guita ni de MP (validación de actor/ownership). Sólo `search_path`, calificación y grants.
5. **El guard de CI no está cableado a un script de `package.json`.** Recomiendo `"guard:secdef": "node scripts/finance/guard-security-definer.mjs"` y sumarlo al gate de CI — pero eso toca `package.json` y preferí no hacerlo sin tu visto bueno.

## 11. Lote futuro propuesto: *Platform Schema Privileges Hardening*

**No implementado.** Antes de `REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated` hay que auditar: extensiones · objetos internos de Supabase · migraciones que crean en `public` · funciones · herramientas operativas · objetos ya creados por `anon`/`authenticated` · **default privileges**. Y sumaría la deuda del §10.1: calificar las 128 restantes.

## 12. Recomendación

# 🟢 GO FRONTEND

Las 13 no dependen de ningún schema no confiable, el ataque temporal está muerto en las 13 **y en las otras 110** (incluidas las guards de M7 que yo mismo había dejado expuestas), los consumidores legítimos funcionan, los grants aprobados están intactos, hay un guard de CI con fixtures que impide la regresión, y el health check mide la deuda que queda.

---

**Me detengo acá.** No avancé con frontend, no desplegué, no escribí en producción, y no hice commit, push, deploy, backfill ni tag.
