BEGIN READ ONLY;
SELECT 'policy' AS kind, schemaname AS schema, tablename AS object, policyname AS name
FROM pg_policies WHERE coalesce(qual,'') || coalesce(with_check,'') ~
  'repair_missing_stock_movements|preview_missing_stock_movements|delete_supplier_purchase_safe|backfill_remito_fm|check_user_limit_before_invite|pay_comprobante_from_account_atomic|user_can_allocate_payments|user_can_reverse_allocations|user_can_view_order_amounts'
UNION ALL
SELECT 'cron', 'cron', jobname, username FROM cron.job WHERE command ~
  'repair_missing_stock_movements|preview_missing_stock_movements|delete_supplier_purchase_safe|backfill_remito_fm|check_user_limit_before_invite|pay_comprobante_from_account_atomic|user_can_allocate_payments|user_can_reverse_allocations|user_can_view_order_amounts';
ROLLBACK;
