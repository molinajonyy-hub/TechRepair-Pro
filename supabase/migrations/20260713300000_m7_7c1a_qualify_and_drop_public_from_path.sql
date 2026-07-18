-- ============================================================================
-- M7 Lote 7C.1a â€” Eliminar la dependencia de `public` en el search_path de las
-- funciones SECURITY DEFINER.
--
-- POR QUE: 7C.1 cerro el ataque por tabla temporal con
--   SET search_path = pg_catalog, public, pg_temp
-- pero `public` SIGUE siendo escribible por anon, authenticated y PUBLIC
-- (verificado con has_schema_privilege). Un schema escribible por callers no
-- confiables no puede considerarse confiable dentro del search_path de una
-- funcion privilegiada: mientras este ahi, la seguridad depende de que no
-- exista ningun objeto shadoweable, no de una barrera.
--
-- QUE HACE:
--   1. Califica explicitamente TODAS las referencias de aplicacion de las 13
--      funciones (66 en total: relaciones y llamadas a funciones de public).
--   2. Deja el search_path minimo:  pg_catalog, pg_temp  â€” SIN public.
--      Â· pg_temp va explicito y AL FINAL: omitirlo lo pondria PRIMERO (doc
--        PostgreSQL 5.9.3), que es justo el vector que 7C.1 cerro.
--      Â· `extensions` NO se incluye: ninguna de las 13 llama a una funcion de
--        extension sin calificar (verificado contra el catalogo de pg_proc).
--      Â· NO se usa "$user" ni ningun schema escribible por roles no confiables.
--
-- La calificacion se genero programaticamente desde pg_get_functiondef y se
-- verifica sola: sin `public` en el path, cualquier referencia que se hubiera
-- escapado falla con "relation does not exist" al ejecutarse. La bateria
-- completa (1879 asserts) es el verificador.
--
-- NO cambia firmas. NO cambia logica comercial. NO cambia grants: la matriz
-- aprobada en 7C.1 se conserva (CREATE OR REPLACE preserva los privilegios).
--
-- DEUDA DE PLATAFORMA (NO se aborda aca, lote propio):
--   `public` conserva CREATE para anon/authenticated/PUBLIC. Tras este lote eso
--   ya NO afecta a ninguna funcion privilegiada, porque ninguna depende de
--   `public` para resolver. Ver "Platform Schema Privileges Hardening".
--
-- ROLLBACK (documentado): volver a 20260713290000 (search_path con public y
-- referencias sin calificar). NO se recomienda: reintroduce la dependencia de
-- un schema escribible por roles no confiables.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.business_has_feature(p_feature text)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
   SELECT EXISTS (
     SELECT 1 FROM public.businesses b
     WHERE b.id = public.current_user_business_id()
       AND b.subscription_status IN ('active', 'trialing')
       AND CASE p_feature
             WHEN 'arca'            THEN b.subscription_plan IN ('pro','full')
                                      OR b.subscription_status = 'trialing'
             WHEN 'currentAccounts' THEN b.subscription_plan IN ('pro','full')
                                      OR b.subscription_status = 'trialing'
             WHEN 'tasks'           THEN b.subscription_plan IN ('pro','full')
                                      OR b.subscription_status = 'trialing'
             WHEN 'advancedFinance' THEN b.subscription_plan IN ('pro','full')
                                      OR b.subscription_status = 'trialing'
             WHEN 'reports'         THEN b.subscription_plan IN ('pro','full')
                                      OR b.subscription_status = 'trialing'
             WHEN 'mayorista'       THEN b.subscription_plan = 'full'
             WHEN 'advancedRoles'   THEN b.subscription_plan = 'full'
             WHEN 'audit'           THEN b.subscription_plan = 'full'
             WHEN 'multisucursal'   THEN b.subscription_plan = 'full'
             ELSE true
           END
   );
 $function$;

CREATE OR REPLACE FUNCTION public.check_user_limit_before_invite(p_business_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_active_count int;
   v_max_users    int;
   v_plan         text;
   v_status       text;
 BEGIN
   SELECT subscription_plan, subscription_status
   INTO   v_plan, v_status
   FROM   public.businesses WHERE id = p_business_id;

   v_max_users := CASE
     WHEN v_status = 'trialing'     THEN 3
     WHEN v_plan   = 'full'         THEN 10
     WHEN v_plan   = 'pro'          THEN 3
     ELSE 1
   END;

   SELECT COUNT(*) INTO v_active_count
   FROM   public.profiles
   WHERE  business_id = p_business_id AND is_active = true;

   IF v_active_count >= v_max_users THEN
     RETURN 'LIMIT_REACHED:' || v_active_count || ':' || v_max_users || ':' || COALESCE(v_plan,'basico');
   END IF;

   RETURN 'OK';
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.insert_personal_default_categories(p_user_id uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 BEGIN
   INSERT INTO public.personal_categories (user_id, name, type, icon, color, is_default, is_active)
   SELECT p_user_id, v.name, v.type, v.icon, v.color, true, true
   FROM (VALUES
     -- Gastos
     ('Comida',          'expense', 'utensils',      '#f59e0b'),
     ('Alquiler',        'expense', 'home',           '#ef4444'),
     ('Servicios',       'expense', 'zap',            '#6366f1'),
     ('Internet',        'expense', 'wifi',           '#8b5cf6'),
     ('Celular',         'expense', 'smartphone',     '#06b6d4'),
     ('Transporte',      'expense', 'car',            '#14b8a6'),
     ('Salud',           'expense', 'heart',          '#ec4899'),
     ('Mascotas',        'expense', 'paw-print',      '#f97316'),
     ('Salidas',         'expense', 'music',          '#a78bfa'),
     ('Ropa',            'expense', 'shopping-bag',   '#fb7185'),
     ('Suscripciones',   'expense', 'credit-card',    '#64748b'),
     ('Tarjetas',        'expense', 'credit-card',    '#dc2626'),
     ('Deudas',          'expense', 'trending-down',  '#f87171'),
     ('Ahorro',          'expense', 'piggy-bank',     '#34d399'),
     ('Otros gastos',    'expense', 'circle',         '#475569'),
     -- Ingresos
     ('Sueldo del negocio',  'income', 'building-2',     '#34d399'),
     ('Retiro de ganancia',  'income', 'trending-up',    '#10b981'),
     ('Trabajo extra',       'income', 'briefcase',      '#60a5fa'),
     ('Venta personal',      'income', 'package',        '#818cf8'),
     ('Regalo',              'income', 'gift',           '#f472b6'),
     ('Otro ingreso',        'income', 'circle',         '#94a3b8')
   ) AS v(name, type, icon, color)
   ON CONFLICT DO NOTHING;
 END; $function$;

CREATE OR REPLACE FUNCTION public.pay_personal_debt(p_debt_id uuid, p_account_id uuid, p_amount numeric, p_date date, p_notes text DEFAULT NULL::text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 declare
   v_user_id    uuid := auth.uid();
   v_debt       public.personal_debts%rowtype;
   v_account    public.personal_accounts%rowtype;
   v_tx_id      uuid;
   v_payment_id uuid;
   v_new_bal    numeric;
   v_cat_id     uuid;
 begin
   -- Validate debt ownership
   select * into v_debt from public.personal_debts
   where id = p_debt_id and user_id = v_user_id;
   if not found then
     return jsonb_build_object('ok', false, 'error', 'Deuda no encontrada');
   end if;
   if v_debt.status = 'paid' then
     return jsonb_build_object('ok', false, 'error', 'La deuda ya estÃ¡ pagada');
   end if;
   if p_amount > v_debt.current_balance then
     return jsonb_build_object('ok', false, 'error', 'El monto supera el saldo restante');
   end if;

   -- Validate account ownership
   select * into v_account from public.personal_accounts
   where id = p_account_id and user_id = v_user_id and is_active = true;
   if not found then
     return jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada');
   end if;

   -- Find or skip debt category (graceful fallback to null)
   select id into v_cat_id from public.personal_categories
   where user_id = v_user_id and type = 'expense'
     and (lower(name) like '%deuda%' or lower(name) like '%pr%stamo%' or lower(name) like '%cuota%')
   limit 1;

   -- Create expense transaction
   insert into public.personal_transactions (
     user_id, account_id, category_id, type, amount, currency,
     date, description, notes, payment_method, linked_owner_withdrawal_id
   ) values (
     v_user_id, p_account_id, v_cat_id, 'expense', p_amount, v_debt.currency,
     p_date, 'Pago deuda: ' || v_debt.name, p_notes, null, null
   ) returning id into v_tx_id;

   -- Debit account balance
   perform public.personal_update_currency_balance(p_account_id, v_debt.currency, -p_amount);

   -- Reduce debt balance
   v_new_bal := v_debt.current_balance - p_amount;
   update public.personal_debts
   set current_balance = v_new_bal,
       status = case when v_new_bal <= 0 then 'paid' else status end
   where id = p_debt_id;

   -- Record payment
   insert into public.personal_debt_payments (
     user_id, debt_id, account_id, currency, amount,
     payment_date, notes, transaction_id
   ) values (
     v_user_id, p_debt_id, p_account_id, v_debt.currency, p_amount,
     p_date, p_notes, v_tx_id
   ) returning id into v_payment_id;

   return jsonb_build_object(
     'ok', true,
     'payment_id', v_payment_id,
     'transaction_id', v_tx_id,
     'new_balance', v_new_bal,
     'paid_off', v_new_bal <= 0
   );
 exception when others then
   return jsonb_build_object('ok', false, 'error', sqlerrm);
 end;
 $function$;

CREATE OR REPLACE FUNCTION public.pay_recurring_expense(p_expense_id uuid, p_account_id uuid, p_amount numeric, p_paid_date date, p_notes text DEFAULT NULL::text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 declare
   v_user_id    uuid := auth.uid();
   v_expense    public.personal_recurring_expenses%rowtype;
   v_account    public.personal_accounts%rowtype;
   v_tx_id      uuid;
   v_payment_id uuid;
   v_period_y   int  := extract(year  from p_paid_date)::int;
   v_period_m   int  := extract(month from p_paid_date)::int;
   v_next_due   date;
   v_cat_id     uuid;
 begin
   -- Validate ownership of expense
   select * into v_expense from public.personal_recurring_expenses
   where id = p_expense_id and user_id = v_user_id;
   if not found then
     return jsonb_build_object('ok', false, 'error', 'Gasto fijo no encontrado');
   end if;
   if v_expense.status = 'cancelled' then
     return jsonb_build_object('ok', false, 'error', 'El gasto fijo estÃ¡ cancelado');
   end if;
   if p_amount <= 0 then
     return jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a $0');
   end if;

   -- Validate ownership of account
   select * into v_account from public.personal_accounts
   where id = p_account_id and user_id = v_user_id and is_active = true;
   if not found then
     return jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada');
   end if;

   -- Check for duplicate payment this month
   if exists (
     select 1 from public.personal_recurring_expense_payments
     where recurring_expense_id = p_expense_id
       and period_year = v_period_y and period_month = v_period_m
   ) then
     return jsonb_build_object('ok', false, 'error', 'Ya se registrÃ³ un pago para este mes');
   end if;

   -- Resolve category: use expense's category_id or find expense-type category
   v_cat_id := v_expense.category_id;
   if v_cat_id is null then
     select id into v_cat_id from public.personal_categories
     where user_id = v_user_id and type = 'expense'
       and (lower(name) like '%servicio%' or lower(name) like '%fijo%'
            or lower(name) like '%gasto%' or lower(name) like '%hogar%')
     limit 1;
   end if;

   -- Create expense transaction
   insert into public.personal_transactions (
     user_id, account_id, category_id, type, amount, currency,
     date, description, notes, payment_method, linked_owner_withdrawal_id
   ) values (
     v_user_id, p_account_id, v_cat_id, 'expense', p_amount, v_expense.currency,
     p_paid_date, 'Gasto fijo: ' || v_expense.name, p_notes, null, null
   ) returning id into v_tx_id;

   -- Debit account
   perform public.personal_update_currency_balance(p_account_id, v_expense.currency, -p_amount);

   -- Record payment
   insert into public.personal_recurring_expense_payments (
     user_id, recurring_expense_id, account_id, transaction_id,
     currency, amount, paid_date, period_year, period_month, notes
   ) values (
     v_user_id, p_expense_id, p_account_id, v_tx_id,
     v_expense.currency, p_amount, p_paid_date, v_period_y, v_period_m, p_notes
   ) returning id into v_payment_id;

   -- Advance next_due_date to next cycle
   if v_expense.due_day is not null then
     v_next_due := (
       date_trunc('month', p_paid_date + interval '1 month')
       + (v_expense.due_day - 1) * interval '1 day'
     )::date;
     -- Clamp to end of month
     v_next_due := least(v_next_due,
       (date_trunc('month', p_paid_date + interval '1 month')
        + interval '1 month - 1 day')::date
     );
     update public.personal_recurring_expenses
     set next_due_date = v_next_due
     where id = p_expense_id;
   end if;

   return jsonb_build_object(
     'ok',            true,
     'payment_id',    v_payment_id,
     'transaction_id', v_tx_id,
     'next_due_date', v_next_due
   );
 exception when others then
   return jsonb_build_object('ok', false, 'error', sqlerrm);
 end;
 $function$;

CREATE OR REPLACE FUNCTION public.personal_savings_goal_operation(p_goal_id uuid, p_account_id uuid, p_amount numeric, p_operation text, p_date date, p_notes text DEFAULT NULL::text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_user_id    uuid := auth.uid();
   v_goal       public.personal_savings_goals%ROWTYPE;
   v_new_amount numeric;
   v_tx_type    text;
   v_description text;
   v_delta      numeric;
   v_tx_id      uuid;
 BEGIN
   -- Auth
   IF v_user_id IS NULL THEN
     RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
   END IF;

   -- Validate amount
   IF p_amount <= 0 THEN
     RETURN jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor a 0');
   END IF;

   -- Lock & verify goal ownership
   SELECT * INTO v_goal
   FROM public.personal_savings_goals
   WHERE id = p_goal_id AND user_id = v_user_id
   FOR UPDATE;

   IF NOT FOUND THEN
     RETURN jsonb_build_object('ok', false, 'error', 'Objetivo no encontrado');
   END IF;

   IF v_goal.status = 'cancelled' THEN
     RETURN jsonb_build_object('ok', false, 'error', 'No se puede operar sobre un objetivo cancelado');
   END IF;

   -- Verify account ownership and active status
   IF NOT EXISTS (
     SELECT 1 FROM public.personal_accounts
     WHERE id = p_account_id AND user_id = v_user_id AND is_active = true
   ) THEN
     RETURN jsonb_build_object('ok', false, 'error', 'Cuenta no encontrada o inactiva');
   END IF;

   -- Determine operation
   IF p_operation = 'contribute' THEN
     v_new_amount  := v_goal.current_amount + p_amount;
     v_tx_type     := 'expense';
     v_description := 'Aporte a ahorro: ' || v_goal.name;
     v_delta       := -p_amount;   -- debit account

   ELSIF p_operation = 'withdraw' THEN
     IF p_amount > v_goal.current_amount THEN
       RETURN jsonb_build_object('ok', false, 'error', 'No podÃ©s retirar mÃ¡s de lo ahorrado');
     END IF;
     v_new_amount  := v_goal.current_amount - p_amount;
     v_tx_type     := 'income';
     v_description := 'Retiro de ahorro: ' || v_goal.name;
     v_delta       := p_amount;    -- credit account

   ELSE
     RETURN jsonb_build_object('ok', false, 'error', 'OperaciÃ³n no vÃ¡lida');
   END IF;

   -- Update goal
   UPDATE public.personal_savings_goals
   SET current_amount = v_new_amount,
       updated_at     = now()
   WHERE id = p_goal_id AND user_id = v_user_id;

   -- Insert transaction
   INSERT INTO public.personal_transactions (
     user_id, account_id, type, amount, currency,
     date, description, notes, payment_method, linked_owner_withdrawal_id
   ) VALUES (
     v_user_id, p_account_id, v_tx_type, p_amount, v_goal.currency,
     p_date, v_description, p_notes, NULL, NULL
   ) RETURNING id INTO v_tx_id;

   -- Update account balance
   UPDATE public.personal_accounts
   SET current_balance = current_balance + v_delta,
       updated_at      = now()
   WHERE id = p_account_id AND user_id = v_user_id;

   RETURN jsonb_build_object(
     'ok',         true,
     'new_amount', v_new_amount,
     'tx_id',      v_tx_id
   );

 EXCEPTION WHEN OTHERS THEN
   RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.personal_update_balance(p_account_id uuid, p_delta numeric)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_currency text;
 BEGIN
   -- Obtener moneda primaria de la cuenta
   SELECT currency INTO v_currency
   FROM   public.personal_accounts
   WHERE  id = p_account_id AND user_id = auth.uid();

   -- Actualizar personal_accounts (comportamiento original)
   UPDATE public.personal_accounts
   SET    current_balance = current_balance + p_delta,
          updated_at      = now()
   WHERE  id = p_account_id AND user_id = auth.uid();

   -- Sincronizar personal_account_balances para la moneda primaria
   UPDATE public.personal_account_balances
   SET    current_balance = current_balance + p_delta,
          updated_at      = now()
   WHERE  account_id = p_account_id
     AND  user_id    = auth.uid()
     AND  currency   = v_currency;
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.personal_update_currency_balance(p_account_id uuid, p_currency text, p_delta numeric)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_rows   int;
   v_prim   text;
 BEGIN
   -- Obtener moneda primaria
   SELECT currency INTO v_prim
   FROM   public.personal_accounts
   WHERE  id = p_account_id AND user_id = auth.uid();

   -- Intentar actualizar entrada existente
   UPDATE public.personal_account_balances
   SET    current_balance = current_balance + p_delta,
          updated_at      = now()
   WHERE  account_id = p_account_id
     AND  user_id    = auth.uid()
     AND  currency   = p_currency;

   GET DIAGNOSTICS v_rows = ROW_COUNT;

   IF v_rows = 0 THEN
     -- No existe la entrada: actualizar personal_accounts si moneda coincide
     UPDATE public.personal_accounts
     SET    current_balance = current_balance + p_delta,
            updated_at      = now()
     WHERE  id = p_account_id
       AND  user_id = auth.uid()
       AND  currency = p_currency;
   ELSIF v_prim = p_currency THEN
     -- Moneda primaria: tambiÃ©n sincronizar personal_accounts
     UPDATE public.personal_accounts
     SET    current_balance = current_balance + p_delta,
            updated_at      = now()
     WHERE  id = p_account_id AND user_id = auth.uid();
   END IF;
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.preview_missing_stock_movements(p_business_id uuid)
  RETURNS TABLE(source text, sale_id uuid, item_id uuid, inventory_id uuid, product_name text, quantity numeric, current_stock integer, can_deduct boolean, sale_date timestamp with time zone)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
   SELECT * FROM (
     SELECT
       'comprobante'::text,
       ci.comprobante_id,
       ci.id,
       ci.inventory_id,
       COALESCE(inv.name, '(sin nombre)'),
       ci.cantidad,
       COALESCE(inv.stock_quantity, 0),
       (COALESCE(inv.stock_quantity, 0) >= ci.cantidad::integer),
       c.created_at
     FROM public.comprobante_items ci
     JOIN public.comprobantes c   ON c.id  = ci.comprobante_id
     JOIN public.inventory    inv ON inv.id = ci.inventory_id
     WHERE ci.business_id   = p_business_id
       AND ci.inventory_id  IS NOT NULL
       AND ci.cantidad        > 0
       AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND c.estado          NOT IN ('anulado')
       AND c.status          NOT IN ('cancelled')
       AND c.estado_comercial NOT IN ('anulado')
       AND c.estado_comercial IS DISTINCT FROM NULL

     UNION ALL

     SELECT
       'wholesale_order'::text,
       woi.order_id,
       woi.id,
       woi.inventory_item_id,
       COALESCE(inv.name, '(sin nombre)'),
       woi.quantity::numeric,
       COALESCE(inv.stock_quantity, 0),
       (COALESCE(inv.stock_quantity, 0) >= woi.quantity),
       wo.created_at
     FROM public.wholesale_order_items woi
     JOIN public.wholesale_orders wo  ON wo.id  = woi.order_id
     JOIN public.inventory        inv ON inv.id = woi.inventory_item_id
     WHERE woi.business_id      = p_business_id
       AND woi.inventory_item_id IS NOT NULL
       AND woi.quantity           > 0
       AND (woi.stock_processed = false OR woi.stock_processed IS NULL)
       AND wo.status NOT IN ('cancelled', 'rejected')
   ) sub
   ORDER BY sub.created_at;
 $function$;

CREATE OR REPLACE FUNCTION public.process_mp_subscription_payment(p_external_ref text, p_mp_payment_id text, p_mp_status text, p_amount numeric, p_currency text DEFAULT 'ARS'::text, p_raw_payload jsonb DEFAULT NULL::jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_session record;
   v_biz_id  uuid;
   v_result  text;
   v_msg     text;
 BEGIN
   -- â”€â”€ Idempotencia: payment_id ya registrado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   IF EXISTS (SELECT 1 FROM public.subscription_payments WHERE provider_payment_id = p_mp_payment_id) THEN
     v_result := 'already_processed';
     v_msg    := 'Payment already registered: ' || p_mp_payment_id;
     INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
     VALUES(NULL,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
     RETURN jsonb_build_object('result',v_result,'message',v_msg);
   END IF;

   -- â”€â”€ Buscar sesiÃ³n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   SELECT * INTO v_session
   FROM public.subscription_checkout_sessions
   WHERE external_reference = p_external_ref
   FOR UPDATE SKIP LOCKED;

   IF NOT FOUND THEN
     v_result := 'not_found';
     v_msg    := 'Session not found: ' || COALESCE(p_external_ref,'null');
     INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
     VALUES(NULL,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
     RETURN jsonb_build_object('result',v_result,'message',v_msg);
   END IF;

   v_biz_id := v_session.business_id;

   -- â”€â”€ SesiÃ³n ya pagada â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   IF v_session.status = 'paid' THEN
     v_result := 'already_processed';
     v_msg    := 'Session already paid';
     INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
     VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
     RETURN jsonb_build_object('result',v_result,'message',v_msg);
   END IF;

   -- â”€â”€ Pago no aprobado â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   IF p_mp_status != 'approved' THEN
     UPDATE public.subscription_checkout_sessions
     SET status = CASE p_mp_status
                    WHEN 'rejected'  THEN 'failed'
                    WHEN 'cancelled' THEN 'canceled'
                    ELSE 'pending'
                  END,
         updated_at = now()
     WHERE id = v_session.id;
     v_result := 'not_approved';
     v_msg    := 'MP status: ' || p_mp_status;
     INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
     VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
     RETURN jsonb_build_object('result',v_result,'mp_status',p_mp_status);
   END IF;

   -- â”€â”€ Validar monto (Â±5%) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   IF v_session.amount > 0 AND ABS(p_amount - v_session.amount) / v_session.amount > 0.05 THEN
     v_result := 'amount_mismatch';
     v_msg    := 'Expected ' || v_session.amount || ' got ' || p_amount;
     INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
     VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);
     RETURN jsonb_build_object('result',v_result,'expected',v_session.amount,'received',p_amount);
   END IF;

   -- â”€â”€ Marcar sesiÃ³n pagada â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   UPDATE public.subscription_checkout_sessions
   SET status = 'paid', updated_at = now()
   WHERE id = v_session.id;

   -- â”€â”€ Registrar pago â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   INSERT INTO public.subscription_payments(business_id,checkout_session_id,plan_id,billing_cycle,amount,currency,provider,provider_payment_id,status,paid_at)
   VALUES(v_biz_id,v_session.id,v_session.plan_id,v_session.billing_cycle,p_amount,p_currency,'mercadopago',p_mp_payment_id,'approved',now())
   ON CONFLICT(provider_payment_id) DO NOTHING;

   -- â”€â”€ Activar suscripciÃ³n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   UPDATE public.businesses SET
     subscription_status   = 'active',
     subscription_plan     = v_session.plan_id,
     subscription_provider = 'mercadopago',
     current_period_start  = now(),
     current_period_end    = CASE v_session.billing_cycle
                               WHEN 'annual'    THEN now() + INTERVAL '1 year'
                               WHEN 'quarterly' THEN now() + INTERVAL '3 months'
                               ELSE now() + INTERVAL '1 month' END,
     last_payment_status   = 'approved',
     last_payment_id       = p_mp_payment_id,
     updated_at            = now()
   WHERE id = v_biz_id;

   -- â”€â”€ Log Ã©xito â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   v_result := 'success';
   v_msg    := 'Activated plan=' || v_session.plan_id;
   INSERT INTO public.subscription_webhook_logs(business_id,event_type,mp_payment_id,mp_status,external_ref,result,error_msg,raw_payload)
   VALUES(v_biz_id,'payment',p_mp_payment_id,p_mp_status,p_external_ref,v_result,v_msg,p_raw_payload);

   RETURN jsonb_build_object(
     'result','success',
     'business_id',v_biz_id,
     'plan_id',v_session.plan_id,
     'billing_cycle',v_session.billing_cycle
   );
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.repair_missing_stock_movements(p_business_id uuid, p_allow_negative boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_comp_count     int     := 0;
   v_ws_count       int     := 0;
   v_skip_stock     int     := 0;
   v_skip_product   int     := 0;
   v_total_units    numeric := 0;
   v_movement_id    uuid;
   v_prev_stock     int;
   v_new_stock      int;
   r                record;
 BEGIN

   FOR r IN
     SELECT ci.id, ci.comprobante_id, ci.inventory_id, ci.cantidad
     FROM   public.comprobante_items ci
     JOIN   public.comprobantes c ON c.id = ci.comprobante_id
     WHERE  ci.business_id   = p_business_id
       AND  ci.inventory_id  IS NOT NULL
       AND  ci.cantidad        > 0
       AND  (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND  c.estado          NOT IN ('anulado')
       AND  c.status          NOT IN ('cancelled')
       AND  c.estado_comercial NOT IN ('anulado')
       AND  c.estado_comercial IS DISTINCT FROM NULL
     FOR UPDATE OF ci SKIP LOCKED
   LOOP
     SELECT stock_quantity INTO v_prev_stock
     FROM public.inventory
     WHERE id = r.inventory_id AND business_id = p_business_id;

     IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

     IF v_prev_stock < r.cantidad::int AND NOT p_allow_negative THEN
       v_skip_stock := v_skip_stock + 1; CONTINUE;
     END IF;

     v_new_stock := v_prev_stock - r.cantidad::int;

     UPDATE public.inventory SET stock_quantity = v_new_stock, updated_at = now()
      WHERE id = r.inventory_id AND business_id = p_business_id;

     INSERT INTO public.inventory_movements
       (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note)
     VALUES
       (p_business_id, r.inventory_id, 'sale', -r.cantidad::int,
        v_prev_stock, v_new_stock, 'comprobante', r.comprobante_id,
        'ReparaciÃ³n de stock â€” venta anterior')
     RETURNING id INTO v_movement_id;

     UPDATE public.comprobante_items
        SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
      WHERE id = r.id;

     v_comp_count  := v_comp_count  + 1;
     v_total_units := v_total_units + r.cantidad;
   END LOOP;

   FOR r IN
     SELECT woi.id, woi.order_id, woi.inventory_item_id, woi.quantity
     FROM   public.wholesale_order_items woi
     JOIN   public.wholesale_orders wo ON wo.id = woi.order_id
     WHERE  woi.business_id       = p_business_id
       AND  woi.inventory_item_id IS NOT NULL
       AND  woi.quantity            > 0
       AND  (woi.stock_processed = false OR woi.stock_processed IS NULL)
       AND  wo.status NOT IN ('cancelled','rejected')
     FOR UPDATE OF woi SKIP LOCKED
   LOOP
     SELECT stock_quantity INTO v_prev_stock
     FROM public.inventory
     WHERE id = r.inventory_item_id AND business_id = p_business_id;

     IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

     IF v_prev_stock < r.quantity AND NOT p_allow_negative THEN
       v_skip_stock := v_skip_stock + 1; CONTINUE;
     END IF;

     v_new_stock := v_prev_stock - r.quantity;

     UPDATE public.inventory SET stock_quantity = v_new_stock, updated_at = now()
      WHERE id = r.inventory_item_id AND business_id = p_business_id;

     INSERT INTO public.inventory_movements
       (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note)
     VALUES
       (p_business_id, r.inventory_item_id, 'sale', -r.quantity,
        v_prev_stock, v_new_stock, 'wholesale_order', r.order_id,
        'ReparaciÃ³n de stock â€” pedido mayorista anterior')
     RETURNING id INTO v_movement_id;

     UPDATE public.wholesale_order_items
        SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
      WHERE id = r.id;

     v_ws_count    := v_ws_count    + 1;
     v_total_units := v_total_units + r.quantity;
   END LOOP;

   RETURN jsonb_build_object(
     'comprobantes_procesados',         v_comp_count,
     'pedidos_mayoristas_procesados',   v_ws_count,
     'items_sin_stock_suficiente',      v_skip_stock,
     'items_producto_no_encontrado',    v_skip_product,
     'total_unidades_descontadas',      v_total_units
   );
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.sync_business_logo_url()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 BEGIN
   UPDATE public.businesses
   SET logo_url = NEW.logo_url
   WHERE id = NEW.business_id;
   RETURN NEW;
 END;
 $function$;

CREATE OR REPLACE FUNCTION public.update_inventory_dollar_prices(p_business_id uuid, p_new_rate numeric)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
 DECLARE
   v_updated integer := 0;
   v_skipped integer := 0;
 BEGIN
   -- Validar que el usuario autenticado pertenece al negocio
   IF NOT EXISTS (
     SELECT 1 FROM public.profiles
     WHERE business_id = p_business_id
       AND user_id = auth.uid()
       AND is_active = true
   ) THEN
     RETURN jsonb_build_object('ok', false, 'error', 'No autorizado');
   END IF;

   IF p_new_rate <= 0 THEN
     RETURN jsonb_build_object('ok', false, 'error', 'La cotizaciÃ³n debe ser mayor a 0');
   END IF;

   -- Contar productos que no son elegibles (para el log)
   SELECT COUNT(*) INTO v_skipped
   FROM public.inventory
   WHERE business_id   = p_business_id
     AND auto_update_price = true
     AND (base_currency != 'USD' OR base_price IS NULL OR base_price <= 0);

   -- Actualizar en batch todos los productos elegibles
   -- sale_price = base_price * nueva_cotizacion (redondeado a entero para ARS)
   UPDATE public.inventory
   SET
     sale_price         = ROUND(base_price * p_new_rate),
     exchange_rate_used = p_new_rate,
     updated_at         = now()
   WHERE business_id      = p_business_id
     AND auto_update_price = true
     AND base_currency     = 'USD'
     AND base_price        IS NOT NULL
     AND base_price        > 0;

   GET DIAGNOSTICS v_updated = ROW_COUNT;

   RETURN jsonb_build_object(
     'ok',      true,
     'updated', v_updated,
     'skipped', v_skipped,
     'rate',    p_new_rate
   );

 EXCEPTION WHEN OTHERS THEN
   RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
 END;
 $function$;
