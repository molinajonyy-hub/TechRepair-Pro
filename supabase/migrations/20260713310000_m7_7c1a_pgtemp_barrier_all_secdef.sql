-- ============================================================================
-- M7 Lote 7C.1a (Â§B) â€” Barrera minima pg_temp para TODAS las SECURITY DEFINER.
--
-- â”Œâ”€â”€ HALLAZGO NUEVO DE ESTE LOTE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
-- â”‚ Al verificar el trabajo de 7C.1 descubri que la vulnerabilidad NO se     â”‚
-- â”‚ limitaba a las 13 funciones auditadas: alcanza a 110 SECURITY DEFINER,   â”‚
-- â”‚ incluidas TODAS las RPC y guards de M7 que yo mismo escribi.             â”‚
-- â”‚                                                                          â”‚
-- â”‚ Causa: usan `SET search_path TO 'public'` â€” sin pg_temp explicito. Y por â”‚
-- â”‚ la doc de PostgreSQL 5.9.3, pg_temp NO listado se busca PRIMERO.         â”‚
-- â”‚                                                                          â”‚
-- â”‚ PROBADO sobre is_comprobante_annulled (la condicion canonica que usan el â”‚
-- â”‚ guard de pagos y replace_comprobante_payment):                           â”‚
-- â”‚   ANTES:   is_comprobante_annulled(comp_vigente) = false                 â”‚
-- â”‚   ATAQUE:  CREATE TEMP TABLE comprobante_annulments (...); INSERT ...    â”‚
-- â”‚   DESPUES: is_comprobante_annulled(comp_vigente) = true                  â”‚
-- â”‚ El inverso (temp vacia) haria que un comprobante ANULADO parezca vigente â”‚
-- â”‚ y el guard dejaria pasar cobros sobre el.                                â”‚
-- â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
--
-- REMEDIACION MINIMA Y MECANICA: agregar `pg_temp` AL FINAL del search_path
-- existente de cada una. Un ALTER por funcion. NO cambia lÃ³gica, NO cambia
-- firmas, NO cambia grants, NO requiere calificar referencias. Cierra el vector
-- de la tabla temporal en las 110.
--
-- ALCANCE HONESTO: esto NO las deja al nivel de las 13. Las 13 recibieron el
-- tratamiento completo (referencias calificadas + `public` FUERA del path). Las
-- otras 110 conservan `public` en el path, asi que siguen dependiendo de que
-- nadie pueda shadowear un objeto que ya existe â€” hoy imposible por colision de
-- nombre, y ademas `authenticated` no puede crear schemas (verificado:
-- "permission denied for database"). Queda como deuda explicita para el lote
-- "Platform Schema Privileges Hardening".
--
-- Los ALTER se generaron desde pg_catalog (no a mano) para no omitir ninguna.
-- ============================================================================

ALTER FUNCTION accept_business_invitation(text) SET search_path = public, pg_temp;
ALTER FUNCTION adjust_stock_on_order_item() SET search_path = public, pg_temp;
ALTER FUNCTION annul_comprobante_atomic(uuid,text,text,boolean,text) SET search_path = public, pg_temp;
ALTER FUNCTION assert_period_open(uuid,date) SET search_path = public, pg_temp;
ALTER FUNCTION backfill_remito_fm(uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION bootstrap_owner_profile(text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION can_manage() SET search_path = public, pg_temp;
ALTER FUNCTION cancel_business_invitation(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION change_user_role(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION claim_comprobante_arca_emission(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION close_cash_session_atomic(uuid,uuid,uuid,numeric,numeric,numeric,numeric,numeric,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION close_period(uuid,date,text) SET search_path = public, pg_temp;
ALTER FUNCTION complete_arca_attempt(uuid,text,text,timestamp with time zone,text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION comprobante_payments_annulled_guard() SET search_path = public, pg_temp;
ALTER FUNCTION create_business_invitation(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_business_invitation(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION create_comprobante_checkout_atomic(uuid,text,text,jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION create_credit_note_finance_reversal(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION create_credit_note_from_comprobante(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION create_default_payment_buttons(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION create_expense_with_finance(uuid,uuid,text,text,text,text,numeric,text,date,boolean,text,text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_manual_cash_movement_atomic(uuid,text,text,numeric,text,uuid,numeric,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_order_payment_atomic(uuid,uuid,numeric,text,text,numeric,uuid,text,date,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_owner_contribution(uuid,numeric,date,uuid,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_owner_withdrawal(uuid,numeric,date,uuid,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text) SET search_path = public, pg_temp;
ALTER FUNCTION current_business_id() SET search_path = public, pg_temp;
ALTER FUNCTION current_user_business_id() SET search_path = public, pg_temp;
ALTER FUNCTION current_user_role() SET search_path = public, pg_temp;
ALTER FUNCTION customer_purchase_history(uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION decrypt_data(text) SET search_path = public, pg_temp;
ALTER FUNCTION delete_comprobante_with_finance(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION delete_supplier_purchase_safe(uuid,uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION encrypt_data(text) SET search_path = public, pg_temp;
ALTER FUNCTION ensure_brand_and_model(text,text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION expire_old_invitations() SET search_path = public, pg_temp;
ALTER FUNCTION finance_audit_backstop() SET search_path = public, pg_temp;
ALTER FUNCTION finance_begin_audit_scope() SET search_path = public, pg_temp;
ALTER FUNCTION finance_dashboard_summary(uuid,date,date) SET search_path = public, pg_temp;
ALTER FUNCTION finance_hc_can_see_global(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION finance_health_check(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION finance_health_check_v2(uuid,boolean) SET search_path = public, pg_temp;
ALTER FUNCTION finance_log_audit(uuid,text,text,uuid,text,text,text,date,text,uuid,jsonb,jsonb,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION finance_pending_historicals(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION finance_period_guard_biu() SET search_path = public, pg_temp;
ALTER FUNCTION finance_period_guard_cp_update() SET search_path = public, pg_temp;
ALTER FUNCTION generar_numero_comprobante(text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION generar_numero_garantia(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION get_active_sales_point(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION get_business_settings() SET search_path = public, pg_temp;
ALTER FUNCTION get_checkout_request_status(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION get_current_exchange_rate(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION get_finance_summary(uuid,date,date) SET search_path = public, pg_temp;
ALTER FUNCTION get_my_profile() SET search_path = public, pg_temp;
ALTER FUNCTION get_or_create_brand(text,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION get_or_create_model(text,uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION inventory_product_history(uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION is_comprobante_annulled(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION is_owner_or_admin() SET search_path = public, pg_temp;
ALTER FUNCTION is_period_closed(uuid,date) SET search_path = public, pg_temp;
ALTER FUNCTION is_staff() SET search_path = public, pg_temp;
ALTER FUNCTION link_profile_to_auth_user() SET search_path = public, pg_temp;
ALTER FUNCTION mark_arca_attempt_sent(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION open_cash_session_atomic(uuid,uuid,numeric,numeric,numeric,numeric,numeric,text) SET search_path = public, pg_temp;
ALTER FUNCTION pay_card_statement_atomic(uuid,uuid,uuid,text,numeric,text,date,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION pay_supplier_free_atomic(uuid,uuid,uuid,text,date,numeric,text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION pay_supplier_purchase_atomic(uuid,uuid,uuid,text,uuid,date,numeric,text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION recalcular_totales_comprobante(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION recalculate_order_total() SET search_path = public, pg_temp;
ALTER FUNCTION recalculate_product_prices(uuid,numeric) SET search_path = public, pg_temp;
ALTER FUNCTION reconcile_ledger_record(uuid,text,uuid,text,text,text,jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION record_customer_account_payment_atomic(uuid,uuid,numeric,text,uuid,text,date,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION register_order_payment(uuid,uuid,numeric) SET search_path = public, pg_temp;
ALTER FUNCTION reopen_period(uuid,date,text) SET search_path = public, pg_temp;
ALTER FUNCTION replace_comprobante_payment(uuid,uuid,text,numeric,numeric,text,numeric,text,uuid,numeric,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION reserve_arca_number(uuid,integer) SET search_path = public, pg_temp;
ALTER FUNCTION reserve_comprobante_number(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION reverse_manual_cash_movement(uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION reverse_operating_expense_atomic(uuid,uuid,text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION reverse_order_payment_atomic(uuid,uuid,text,uuid,text) SET search_path = public, pg_temp;
ALTER FUNCTION rls_auto_enable() SET search_path = public, pg_temp;
ALTER FUNCTION set_exchange_rate_on_product_save() SET search_path = public, pg_temp;
ALTER FUNCTION set_user_active_status(uuid,boolean) SET search_path = public, pg_temp;
ALTER FUNCTION sync_bfe_to_financial_movements() SET search_path = public, pg_temp;
ALTER FUNCTION sync_inventory_stock_alias() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_account_movement_balance() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_comprobante_finance() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_comprobante_payment_finance() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_comprobante_payment_sync() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_expense_finance() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_payment_creates_movements() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_payment_transaction_approved() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_recalcular_totales() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_set_movement_caja() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_supplier_account_movement_balance() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_task_history() SET search_path = public, pg_temp;
ALTER FUNCTION update_timestamp() SET search_path = public, pg_temp;
ALTER FUNCTION upsert_business_settings(uuid,text,boolean,boolean,text,integer) SET search_path = public, pg_temp;
ALTER FUNCTION upsert_exchange_rate(uuid,text,text,numeric,boolean,text) SET search_path = public, pg_temp;
ALTER FUNCTION user_can_override_price(uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION user_can_sell_below_cost(uuid,uuid) SET search_path = public, pg_temp;
ALTER FUNCTION whatsapp_admin_provision_connection(uuid,text,text,text,text,text,timestamp with time zone,text) SET search_path = pg_catalog, public, vault, pg_temp;
ALTER FUNCTION whatsapp_admin_record_event(uuid,text,text,uuid,jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION whatsapp_admin_revoke_connection(uuid,text) SET search_path = pg_catalog, public, vault, pg_temp;
ALTER FUNCTION whatsapp_credential_delete(uuid) SET search_path = pg_catalog, public, vault, pg_temp;
ALTER FUNCTION whatsapp_credential_get_token(uuid) SET search_path = pg_catalog, public, vault, pg_temp;
ALTER FUNCTION whatsapp_credential_purge_vault() SET search_path = pg_catalog, public, vault, pg_temp;
ALTER FUNCTION whatsapp_credential_store(uuid,text,timestamp with time zone) SET search_path = pg_catalog, public, vault, pg_temp;
