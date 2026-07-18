-- ============================================================================
-- M7 Lote 7C.1 — Hardening de funciones SECURITY DEFINER.
--
-- NO es una migracion financiera: no toca el modelo economico ni la logica
-- comercial. Solo search_path, grants y comentarios.
--
-- ┌── VULNERABILIDAD PROBADA ────────────────────────────────────────────────┐
-- │ 13 funciones SECURITY DEFINER owned by postgres NO fijaban search_path,  │
-- │ y `public` tiene CREATE para anon, authenticated y PUBLIC.               │
-- │                                                                          │
-- │ Al resolver TABLAS, PostgreSQL busca pg_temp ANTES que public cuando el  │
-- │ search_path no lo fija. Un rol authenticated que cree una tabla temporal │
-- │ con el nombre de una dependencia no calificada hace que la funcion —que  │
-- │ corre como postgres— lea SU tabla.                                       │
-- │                                                                          │
-- │ Reproducido localmente con business_has_feature (plan 'basico'):         │
-- │   ANTES:   business_has_feature('mayorista') = false                     │
-- │   ATAQUE:  CREATE TEMP TABLE businesses (...); INSERT ... 'full'         │
-- │   DESPUES: business_has_feature('mayorista') = true                      │
-- │            business_has_feature('audit')     = true                      │
-- │ => el paywall de suscripciones completo se evade.                        │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- REMEDIACION: `SET search_path = pg_catalog, public, pg_temp` en cada funcion.
--
--   ⚠ pg_temp VA LISTADO EXPLICITAMENTE Y AL FINAL. No es un detalle: es LA
--     correccion. La documentacion de PostgreSQL (5.9.3) dice que el schema
--     temporal, "si NO esta listado en el path, se busca PRIMERO (incluso antes
--     que pg_catalog)". O sea: OMITIR pg_temp no lo excluye — lo pone primero.
--     Un primer intento con `SET search_path = pg_catalog, public` (sin pg_temp)
--     se probo y EL ATAQUE SEGUIA FUNCIONANDO. Listarlo al final es lo unico
--     que saca a pg_temp del camino de resolucion de tablas.
--
--   · pg_catalog primero y explicito.
--   · public es NECESARIO (las funciones viven y operan ahi). Sigue siendo
--     escribible por roles no confiables, pero eso ya no alcanza: un atacante
--     no puede crear en public un objeto que YA existe (colisiona por nombre).
--   · Ninguna de estas funciones usa tablas temporales, asi que pg_temp al
--     final es inocuo para su logica.
--   · Las firmas NO cambian. La logica comercial NO cambia.
--
-- GRANTS: se revoca PUBLIC/anon en todas. Se conserva authenticated solo donde
-- hay consumidor real (verificado en src/), y se limita a service_role lo que
-- es administrativo o de webhook.
-- ============================================================================

-- ============================================================================
-- §A — search_path fijo. Firma COMPLETA en cada ALTER para no tocar overloads.
-- ============================================================================
ALTER FUNCTION "public"."business_has_feature"(text)                                       SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."check_user_limit_before_invite"(uuid)                             SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."insert_personal_default_categories"(uuid)                         SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."pay_personal_debt"(uuid, uuid, numeric, date, text)               SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."pay_recurring_expense"(uuid, uuid, numeric, date, text)           SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."personal_savings_goal_operation"(uuid, uuid, numeric, text, date, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."personal_update_balance"(uuid, numeric)                           SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."personal_update_currency_balance"(uuid, text, numeric)            SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."preview_missing_stock_movements"(uuid)                            SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."process_mp_subscription_payment"(text, text, text, numeric, text, jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."repair_missing_stock_movements"(uuid, boolean)                    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."sync_business_logo_url"()                                         SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "public"."update_inventory_dollar_prices"(uuid, numeric)                    SET search_path = pg_catalog, public, pg_temp;

-- ============================================================================
-- §B — Grants minimos. Consumidor verificado para cada uno.
-- ============================================================================

-- ── Mi Guita (finanzas personales): consumidor = frontend autenticado ───────
-- src/personal/services/debtService.ts:190
REVOKE ALL ON FUNCTION "public"."pay_personal_debt"(uuid, uuid, numeric, date, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_personal_debt"(uuid, uuid, numeric, date, text) TO "authenticated";
-- src/personal/services/recurringExpenseService.ts:250
REVOKE ALL ON FUNCTION "public"."pay_recurring_expense"(uuid, uuid, numeric, date, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."pay_recurring_expense"(uuid, uuid, numeric, date, text) TO "authenticated";
-- src/personal/services/savingsService.ts:105
REVOKE ALL ON FUNCTION "public"."personal_savings_goal_operation"(uuid, uuid, numeric, text, date, text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."personal_savings_goal_operation"(uuid, uuid, numeric, text, date, text) TO "authenticated";
-- src/personal/services/personalService.ts:306,323
REVOKE ALL ON FUNCTION "public"."personal_update_currency_balance"(uuid, text, numeric) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."personal_update_currency_balance"(uuid, text, numeric) TO "authenticated";

-- Sin consumidor en src/: helper interno de Mi Guita. Se cierra a service_role.
REVOKE ALL ON FUNCTION "public"."personal_update_balance"(uuid, numeric) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."personal_update_balance"(uuid, numeric) TO "service_role";
REVOKE ALL ON FUNCTION "public"."insert_personal_default_categories"(uuid) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."insert_personal_default_categories"(uuid) TO "service_role";

-- ── Entitlements: consumidor = src/lib/entitlements.ts + policies RLS ───────
-- authenticated lo NECESITA (lo llama el frontend y lo usan policies).
REVOKE ALL ON FUNCTION "public"."business_has_feature"(text) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."business_has_feature"(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."business_has_feature"(text) TO "service_role";

-- ── Invitaciones: consumidor = src/pages/UsersManagement.tsx:263 ────────────
REVOKE ALL ON FUNCTION "public"."check_user_limit_before_invite"(uuid) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."check_user_limit_before_invite"(uuid) TO "authenticated";

-- ── Stock repair: consumidor = src/components/inventory/StockRepairTool.tsx ─
-- §6: SI debe ser invocable por el cliente — es una herramienta del comercio,
-- no de plataforma. Se conserva authenticated; su validacion de negocio vive
-- dentro de la funcion. Se cierra a anon/PUBLIC.
REVOKE ALL ON FUNCTION "public"."preview_missing_stock_movements"(uuid) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."preview_missing_stock_movements"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."preview_missing_stock_movements"(uuid) TO "service_role";
REVOKE ALL ON FUNCTION "public"."repair_missing_stock_movements"(uuid, boolean) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."repair_missing_stock_movements"(uuid, boolean) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."repair_missing_stock_movements"(uuid, boolean) TO "service_role";

-- ── Precios USD: consumidor = src/services/currencyService.ts:201 ───────────
REVOKE ALL ON FUNCTION "public"."update_inventory_dollar_prices"(uuid, numeric) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."update_inventory_dollar_prices"(uuid, numeric) TO "authenticated";

-- ── Mercado Pago: §6 — su caller legitimo es el webhook (service_role) ──────
-- SIN consumidor en src/ ni en supabase/functions. Procesa pagos de suscripcion:
-- ningun usuario final debe poder invocarla. anon Y authenticated PIERDEN EXECUTE.
REVOKE ALL ON FUNCTION "public"."process_mp_subscription_payment"(text, text, text, numeric, text, jsonb) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."process_mp_subscription_payment"(text, text, text, numeric, text, jsonb) TO "service_role";

-- ── Trigger function: no se invoca por RPC ─────────────────────────────────
REVOKE ALL ON FUNCTION "public"."sync_business_logo_url"() FROM PUBLIC, "anon", "authenticated";

COMMENT ON FUNCTION "public"."business_has_feature"(text) IS
  'M7 7C.1 — search_path fijo (pg_catalog, public). Sin el, un rol authenticated '
  'podia crear pg_temp.businesses y evadir el paywall completo de suscripciones: '
  'la funcion, corriendo como postgres, leia la tabla del atacante. Probado.';
COMMENT ON FUNCTION "public"."process_mp_subscription_payment"(text, text, text, numeric, text, jsonb) IS
  'M7 7C.1 — Caller legitimo: webhook de Mercado Pago via service_role. anon y '
  'authenticated NO tienen EXECUTE: procesa pagos de suscripcion.';

-- NOTA: el gate de operador de los checks globales (7C §8),
-- finance_hc_can_see_global(uuid), se define en 20260713280000 junto al resto de
-- los helpers del health check — v2 lo invoca y debe existir antes que ella.

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   ALTER FUNCTION ... RESET search_path;   (por cada una de las 13)
--   GRANT EXECUTE ON FUNCTION ... TO PUBLIC;  (restaura el estado inseguro)
--   DROP FUNCTION finance_hc_can_see_global(uuid);
-- NO se recomienda: revertir reabre la evasion del paywall probada arriba.
-- ============================================================================
