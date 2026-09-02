BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH wanted(name) AS (VALUES
 ('close_cash_session_atomic'),('create_comprobante_checkout_atomic'),
 ('create_credit_note_finance_reversal'),('create_credit_note_from_comprobante'),
 ('create_expense_with_finance'),('create_manual_cash_movement_atomic'),
 ('create_order_payment_atomic'),('create_quick_inventory_purchase_atomic'),
 ('create_supplier_purchase_atomic'),('customer_purchase_history'),
 ('delete_comprobante_with_finance'),('finance_dashboard_summary'),
 ('finance_health_check'),('finance_health_check_v2'),('finance_pending_historicals'),
 ('generate_finance_insights'),('get_checkout_request_status'),
 ('open_cash_session_atomic'),('pay_supplier_free_atomic'),
 ('pay_supplier_purchase_atomic'),('replace_comprobante_payment'),
 ('reverse_manual_cash_movement'),('reverse_operating_expense_atomic'),
 ('reverse_order_payment_atomic'),('update_inventory_dollar_prices')
)
SELECT jsonb_build_object(
  'captured_at', now(),
  'database', current_database(),
  'latest_migration', (SELECT jsonb_build_object('version',version,'name',name)
    FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'functions', (SELECT jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',p.proname,
    'identity_arguments',pg_get_function_identity_arguments(p.oid),
    'result',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'proconfig',p.proconfig,'proacl',p.proacl::text,
    'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'service_role_execute',has_function_privilege('service_role',p.oid,'EXECUTE'),
    'definition',pg_get_functiondef(p.oid)
  ) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN wanted w ON w.name=p.proname WHERE n.nspname='public'),
  'is_staff', (SELECT jsonb_build_object(
    'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
    'proconfig',p.proconfig,'proacl',p.proacl::text
  ) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='is_staff' AND p.pronargs=0),
  'is_staff_policies', (SELECT jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'table',c.relname,'policy',p.polname,
    'command',CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
    'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) role_oid),
    'using',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid)
  ) ORDER BY n.nspname,c.relname,p.polname)
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE COALESCE(pg_get_expr(p.polqual,p.polrelid),'') ILIKE '%is_staff%'
     OR COALESCE(pg_get_expr(p.polwithcheck,p.polrelid),'') ILIKE '%is_staff%'),
  'payment_transactions', jsonb_build_object(
    'rls_enabled',(SELECT relrowsecurity FROM pg_class WHERE oid='public.payment_transactions'::regclass),
    'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.payment_transactions'::regclass AND a.attnum>0 AND NOT a.attisdropped),
    'policies',(SELECT jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'roles',polroles,'using',pg_get_expr(polqual,polrelid),'with_check',pg_get_expr(polwithcheck,polrelid)) ORDER BY polname)
      FROM pg_policy WHERE polrelid='public.payment_transactions'::regclass),
    'grants',(SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'privilege',privilege_type) ORDER BY grantee,privilege_type)
      FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='payment_transactions'),
    'triggers',(SELECT jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid,true)) ORDER BY tgname)
      FROM pg_trigger WHERE tgrelid='public.payment_transactions'::regclass AND NOT tgisinternal),
    'indexes',(SELECT jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) ORDER BY indexname)
      FROM pg_indexes WHERE schemaname='public' AND tablename='payment_transactions'),
    'foreign_keys',(SELECT jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true)) ORDER BY conname)
      FROM pg_constraint WHERE conrelid='public.payment_transactions'::regclass AND contype='f')
  )
) AS catalog;

ROLLBACK;
