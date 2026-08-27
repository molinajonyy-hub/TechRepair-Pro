-- MOBILE-2A · Recepción mobile-first · EXPAND
-- Contrato aditivo: alta atómica/idempotente, acceso del equipo en Vault,
-- fotos privadas y asignación contra la identidad canónica (profiles).
-- EXPAND DUAL-WRITE TEMPORAL: device_password sigue escribible hasta que una
-- migración CONTRACT separada retire el bridge y el plaintext.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- ── Modelo aditivo ─────────────────────────────────────────────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS business_name text,
  ADD COLUMN IF NOT EXISTS contact_person text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS estimated_total_currency text NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS access_mode text,
  ADD COLUMN IF NOT EXISTS assigned_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_estimated_total_currency_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_estimated_total_currency_check
  CHECK (estimated_total_currency IN ('ARS', 'USD'));
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_access_mode_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_access_mode_check
  CHECK (access_mode IS NULL OR access_mode IN
    ('none', 'pin', 'pattern', 'password', 'not_provided', 'not_verifiable'));

ALTER TABLE public.device_inspections
  ADD COLUMN IF NOT EXISTS intake_check_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS general_condition text,
  ADD COLUMN IF NOT EXISTS physical_conditions text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS powers_on text,
  ADD COLUMN IF NOT EXISTS reception_notes text;

ALTER TABLE public.device_inspections DROP CONSTRAINT IF EXISTS device_inspections_powers_on_check;
ALTER TABLE public.device_inspections ADD CONSTRAINT device_inspections_powers_on_check
  CHECK (powers_on IS NULL OR powers_on IN ('yes', 'no', 'not_verified'));

ALTER TABLE public.documents
  ALTER COLUMN file_url DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'general';
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('general', 'intake'));
CREATE UNIQUE INDEX IF NOT EXISTS documents_storage_path_uidx
  ON public.documents(storage_path) WHERE storage_path IS NOT NULL;

-- ── Capacidades: espejo server-side del cliente ────────────────────────────
CREATE OR REPLACE FUNCTION public.current_user_can(p_key text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid; v_role text; v_perms jsonb; v_override jsonb; v_default boolean;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL OR p_key IS NULL THEN RETURN false; END IF;
  SELECT p.role, p.permissions INTO v_role, v_perms
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid AND COALESCE(p.is_active, true)
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC LIMIT 1;
  IF v_role IS NULL THEN RETURN false; END IF;
  IF p_key = 'personal_finance' THEN RETURN false; END IF;

  v_default := CASE p_key
    WHEN 'orders' THEN v_role IN ('admin','manager','tech','sales','cashier','viewer')
    WHEN 'orders_create' THEN v_role IN ('admin','manager','tech','sales','cashier')
    WHEN 'device_access_secret' THEN v_role IN ('admin','manager','tech')
    WHEN 'orders_change_status' THEN v_role IN ('admin','manager','tech','sales')
    WHEN 'orders_view_financials' THEN v_role IN ('admin','manager','sales','cashier')
    WHEN 'inventory' THEN v_role IN ('admin','manager','sales')
    WHEN 'inventory_view_costs' THEN v_role IN ('admin','manager')
    WHEN 'customers' THEN v_role IN ('admin','manager','sales','cashier')
    WHEN 'finance' THEN v_role IN ('admin','cashier')
    WHEN 'comprobantes' THEN v_role IN ('admin','manager','sales','cashier')
    WHEN 'reports' THEN v_role IN ('admin','manager','cashier')
    WHEN 'settings' THEN v_role IN ('admin')
    WHEN 'settings_sensitive' THEN v_role IN ('admin')
    WHEN 'subscription' THEN false
    WHEN 'users' THEN v_role IN ('admin')
    WHEN 'wholesale' THEN v_role IN ('admin','manager','sales')
    WHEN 'personal_finance' THEN false
    ELSE NULL
  END;
  IF v_default IS NULL THEN RETURN false; END IF;
  IF v_role = 'owner' THEN RETURN true; END IF;
  IF v_perms IS NOT NULL AND jsonb_typeof(v_perms) = 'object' THEN
    v_override := v_perms -> p_key;
    IF v_override IS NOT NULL AND jsonb_typeof(v_override) = 'boolean' THEN
      RETURN (v_override)::text::boolean;
    END IF;
  END IF;
  RETURN v_default;
END;
$$;
REVOKE ALL ON FUNCTION public.current_user_can(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can(text) TO authenticated;
COMMENT ON FUNCTION public.current_user_can(text) IS
  'MOBILE-2A: capacidades canónicas, incluidos orders_create y device_access_secret; fail-closed.';
COMMENT ON COLUMN public.profiles.permissions IS
  'Overrides parciales: orders, orders_create, device_access_secret, orders_change_status, orders_view_financials, inventory, inventory_view_costs, customers, finance, comprobantes, reports, settings, settings_sensitive, subscription, users, wholesale, personal_finance.';

-- ── Secreto privado y auditoría dedicada (sin valores) ─────────────────────
CREATE TABLE IF NOT EXISTS private.order_device_access_secrets (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  vault_secret_id uuid NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('pin','pattern','password')),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.order_device_access_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.order_device_access_secrets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.order_device_access_secrets FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS private.order_device_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL,
  business_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL CHECK (action IN
    ('migrated','stored','replaced','revealed','deleted','legacy_secret_write_mirrored')),
  operation text NOT NULL CHECK (operation IN ('backfill','set','replace','reveal','delete')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.order_device_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.order_device_access_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.order_device_access_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS private.order_intake_requests (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_hash bytea NOT NULL,
  order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, request_id)
);
ALTER TABLE private.order_intake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.order_intake_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON private.order_intake_requests FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_business_for_actor(p_actor uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.business_id FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = p_actor AND COALESCE(p.is_active, true)
   ORDER BY COALESCE(p.updated_at, p.created_at, now()) DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION private.mobile2a_business_for_actor(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_valid_imei(p_value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_digits text:=regexp_replace(coalesce(p_value,''),'[[:space:]-]','','g');v_sum int:=0;v_digit int;
BEGIN
  IF v_digits !~ '^[0-9]{15}$' THEN RETURN false;END IF;
  FOR i IN 1..15 LOOP
    v_digit:=substring(v_digits from i for 1)::int;
    IF i%2=0 THEN v_digit:=v_digit*2;IF v_digit>9 THEN v_digit:=v_digit-9;END IF;END IF;
    v_sum:=v_sum+v_digit;
  END LOOP;
  RETURN v_sum%10=0;
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_valid_imei(text) FROM PUBLIC,anon,authenticated,service_role;

-- Un único codec conserva el contrato del frontend productivo viejo:
-- pattern:0-1-2 | pin:1234 | text:abc. Vault usa JSON para patrones.
CREATE OR REPLACE FUNCTION private.mobile2a_mode_from_legacy(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_value LIKE 'pattern:%' THEN 'pattern'
              WHEN p_value LIKE 'pin:%' THEN 'pin'
              ELSE 'password' END
$$;
REVOKE ALL ON FUNCTION private.mobile2a_mode_from_legacy(text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_secret_from_legacy(p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_pattern text; v_json text;
BEGIN
  IF p_value LIKE 'pattern:%' THEN
    v_pattern := substring(p_value from 9);
    IF v_pattern ~ '^[0-8](-[0-8])+$' THEN
      SELECT jsonb_agg(part::integer ORDER BY position)::text INTO v_json
        FROM regexp_split_to_table(v_pattern,'-') WITH ORDINALITY AS p(part,position);
      RETURN v_json;
    END IF;
    RETURN v_pattern;
  END IF;
  IF p_value LIKE 'pin:%' THEN RETURN substring(p_value from 5); END IF;
  IF p_value LIKE 'text:%' THEN RETURN substring(p_value from 6); END IF;
  RETURN p_value;
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_secret_from_legacy(text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_legacy_from_access(p_mode text,p_secret text)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_pattern jsonb; v_encoded text;
BEGIN
  IF p_mode='pin' THEN RETURN 'pin:'||p_secret; END IF;
  IF p_mode='password' THEN RETURN 'text:'||p_secret; END IF;
  IF p_mode<>'pattern' THEN RETURN NULL; END IF;
  BEGIN v_pattern:=p_secret::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'INVALID_ACCESS_PATTERN' USING ERRCODE='22023';
  END;
  IF jsonb_typeof(v_pattern)<>'array' OR jsonb_array_length(v_pattern)<2
     OR jsonb_array_length(v_pattern)>9
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_pattern) p(value)
                WHERE p.value !~ '^[0-8]$')
     OR (SELECT count(DISTINCT p.value) FROM jsonb_array_elements_text(v_pattern) p(value))
        <> jsonb_array_length(v_pattern) THEN
    RAISE EXCEPTION 'INVALID_ACCESS_PATTERN' USING ERRCODE='22023';
  END IF;
  SELECT string_agg(p.value,'-' ORDER BY p.position) INTO v_encoded
    FROM jsonb_array_elements_text(v_pattern) WITH ORDINALITY AS p(value,position);
  RETURN 'pattern:'||v_encoded;
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_legacy_from_access(text,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_store_access(
  p_order_id uuid, p_business_id uuid, p_actor uuid, p_mode text, p_secret text,
  p_audit_action text DEFAULT 'stored', p_audit_operation text DEFAULT 'set')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_old uuid; v_new uuid;
BEGIN
  IF p_mode NOT IN ('pin','pattern','password') OR p_secret IS NULL
     OR length(p_secret) < 1 OR length(p_secret) > 256 THEN
    RAISE EXCEPTION 'INVALID_ACCESS_SECRET' USING ERRCODE = '22023';
  END IF;
  SELECT s.vault_secret_id INTO v_old
    FROM private.order_device_access_secrets s WHERE s.order_id = p_order_id FOR UPDATE;
  v_new := vault.create_secret(p_secret,
    'order-device-access:' || p_order_id::text || ':' || replace(gen_random_uuid()::text,'-',''),
    'TechRepair device access secret');
  INSERT INTO private.order_device_access_secrets
    (order_id,business_id,vault_secret_id,access_mode,created_by)
  VALUES (p_order_id,p_business_id,v_new,p_mode,p_actor)
  ON CONFLICT (order_id) DO UPDATE SET
    vault_secret_id=EXCLUDED.vault_secret_id, access_mode=EXCLUDED.access_mode,
    updated_at=now();
  IF v_old IS NOT NULL THEN DELETE FROM vault.secrets WHERE id=v_old; END IF;
  INSERT INTO private.order_device_access_audit(order_id,business_id,actor_id,action,operation)
  VALUES (p_order_id,p_business_id,p_actor,p_audit_action,p_audit_operation);
END;
$$;
REVOKE ALL ON FUNCTION private.mobile2a_store_access(uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.mobile2a_delete_access(
  p_order_id uuid,p_business_id uuid,p_actor uuid,p_audit_action text,p_audit_operation text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_secret_id uuid;
BEGIN
  SELECT s.vault_secret_id INTO v_secret_id
    FROM private.order_device_access_secrets s
   WHERE s.order_id=p_order_id AND s.business_id=p_business_id FOR UPDATE;
  IF v_secret_id IS NOT NULL THEN
    DELETE FROM private.order_device_access_secrets WHERE order_id=p_order_id;
    DELETE FROM vault.secrets WHERE id=v_secret_id;
  END IF;
  INSERT INTO private.order_device_access_audit(order_id,business_id,actor_id,action,operation)
  VALUES(p_order_id,p_business_id,p_actor,p_audit_action,p_audit_operation);
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_delete_access(uuid,uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Backfill EXPAND: copia a Vault y deriva access_mode, pero conserva plaintext.
DO $$
DECLARE r record; v_mode text; v_secret text;
BEGIN
  FOR r IN SELECT id,business_id,created_by,device_password FROM public.orders
            WHERE device_password IS NOT NULL AND btrim(device_password) <> '' LOOP
    v_mode := private.mobile2a_mode_from_legacy(r.device_password);
    v_secret := private.mobile2a_secret_from_legacy(r.device_password);
    PERFORM private.mobile2a_store_access(
      r.id,r.business_id,r.created_by,v_mode,v_secret,'migrated','backfill');
    UPDATE public.orders SET access_mode=v_mode WHERE id=r.id;
  END LOOP;
END $$;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_device_password_retired_check;
COMMENT ON COLUMN public.orders.device_password IS
  'EXPAND DUAL-WRITE TEMPORAL: espejo legacy de Vault. Retirar y bloquear sólo mediante MOBILE-2A-CONTRACT autorizado por separado.';

-- Escrituras de RPC nueva usan este helper para actualizar el espejo legacy.
-- El setting local evita que el trigger interprete ese UPDATE como tráfico viejo.
CREATE OR REPLACE FUNCTION private.mobile2a_write_legacy_shadow(
  p_order_id uuid,p_business_id uuid,p_mode text,p_secret text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_previous_guard text; v_legacy text;
BEGIN
  v_legacy:=private.mobile2a_legacy_from_access(p_mode,p_secret);
  v_previous_guard:=current_setting('app.mobile2a_secret_write_origin',true);
  PERFORM set_config('app.mobile2a_secret_write_origin','vault_to_legacy',true);
  BEGIN
    UPDATE public.orders SET access_mode=p_mode,device_password=v_legacy,updated_at=now()
     WHERE id=p_order_id AND business_id=p_business_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.mobile2a_secret_write_origin',coalesce(v_previous_guard,''),true);
    RAISE;
  END;
  PERFORM set_config('app.mobile2a_secret_write_origin',coalesce(v_previous_guard,''),true);
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_write_legacy_shadow(uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Bridge legacy -> Vault. RLS conserva la autorización histórica de UPDATE;
-- el trigger vuelve a comprobar actor, tenant e is_staff antes de tocar Vault.
CREATE OR REPLACE FUNCTION private.mobile2a_mirror_legacy_device_password()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid:=auth.uid();v_business uuid;v_mode text;v_secret text;
BEGIN
  IF current_setting('app.mobile2a_secret_write_origin',true)='vault_to_legacy' THEN RETURN NEW; END IF;
  v_business:=private.mobile2a_business_for_actor(v_actor);
  IF v_actor IS NULL OR v_business IS NULL OR v_business IS DISTINCT FROM OLD.business_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NOT public.is_staff() THEN
    RAISE EXCEPTION 'FORBIDDEN_LEGACY_DEVICE_ACCESS' USING ERRCODE='42501';
  END IF;
  IF NEW.device_password IS NULL OR btrim(NEW.device_password)='' THEN
    PERFORM private.mobile2a_delete_access(
      OLD.id,OLD.business_id,v_actor,'legacy_secret_write_mirrored','delete');
    NEW.device_password:=NULL;
    NEW.access_mode:='none';
    RETURN NEW;
  END IF;
  v_mode:=private.mobile2a_mode_from_legacy(NEW.device_password);
  v_secret:=private.mobile2a_secret_from_legacy(NEW.device_password);
  PERFORM private.mobile2a_store_access(
    OLD.id,OLD.business_id,v_actor,v_mode,v_secret,'legacy_secret_write_mirrored','set');
  NEW.access_mode:=v_mode;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_mirror_legacy_device_password()
  FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS mobile2a_mirror_legacy_device_password ON public.orders;
CREATE TRIGGER mobile2a_mirror_legacy_device_password
BEFORE UPDATE OF device_password ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.mobile2a_mirror_legacy_device_password();

-- ── RPC público de creación atómica e idempotente ──────────────────────────
CREATE OR REPLACE FUNCTION public.create_order_intake(
  p_request_id uuid, p_payload jsonb, p_access_secret text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_business uuid; v_hash bytea; v_existing record;
  v_customer uuid; v_device uuid; v_order uuid; v_assignee uuid;
  v_mode text; v_budget numeric; v_currency text; v_check jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='28000'; END IF;
  IF NOT public.current_user_can('orders_create') THEN
    RAISE EXCEPTION 'FORBIDDEN_ORDERS_CREATE' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_INTAKE_PAYLOAD' USING ERRCODE='22023';
  END IF;
  v_business := private.mobile2a_business_for_actor(v_actor);
  IF v_business IS NULL THEN RAISE EXCEPTION 'ACTIVE_PROFILE_REQUIRED' USING ERRCODE='42501'; END IF;
  v_hash := extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256');

  INSERT INTO private.order_intake_requests(business_id,request_id,payload_hash,created_by)
  VALUES(v_business,p_request_id,v_hash,v_actor) ON CONFLICT DO NOTHING;
  SELECT * INTO v_existing FROM private.order_intake_requests
   WHERE business_id=v_business AND request_id=p_request_id FOR UPDATE;
  IF v_existing.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505';
  END IF;
  IF v_existing.order_id IS NOT NULL THEN
    RETURN jsonb_build_object('order_id',v_existing.order_id,'replayed',true);
  END IF;

  v_customer := nullif(p_payload->>'customer_id','')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.customers c
                  WHERE c.id=v_customer AND c.business_id=v_business AND c.active) THEN
    RAISE EXCEPTION 'INVALID_CUSTOMER' USING ERRCODE='23503';
  END IF;
  IF coalesce(btrim(p_payload#>>'{device,brand}'),'')='' OR
     coalesce(btrim(p_payload#>>'{device,model}'),'')='' OR
     coalesce(btrim(p_payload->>'problem'),'')='' THEN
    RAISE EXCEPTION 'DEVICE_AND_PROBLEM_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF coalesce(btrim(p_payload#>>'{device,imei}'),'')<>''
     AND NOT private.mobile2a_valid_imei(p_payload#>>'{device,imei}') THEN
    RAISE EXCEPTION 'INVALID_IMEI' USING ERRCODE='22023';
  END IF;
  v_assignee := nullif(p_payload->>'assigned_profile_id','')::uuid;
  IF v_assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id=v_assignee
      AND p.business_id=v_business AND COALESCE(p.is_active,true)) THEN
    RAISE EXCEPTION 'INVALID_ASSIGNEE' USING ERRCODE='23503';
  END IF;
  v_mode := p_payload->>'access_mode';
  IF v_mode NOT IN ('none','pin','pattern','password','not_provided','not_verifiable') THEN
    RAISE EXCEPTION 'ACCESS_MODE_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF v_mode IN ('pin','pattern','password') AND coalesce(p_access_secret,'')='' THEN
    RAISE EXCEPTION 'ACCESS_SECRET_REQUIRED' USING ERRCODE='22023';
  END IF;
  IF v_mode NOT IN ('pin','pattern','password') AND p_access_secret IS NOT NULL THEN
    RAISE EXCEPTION 'UNEXPECTED_ACCESS_SECRET' USING ERRCODE='22023';
  END IF;
  v_currency := coalesce(nullif(p_payload#>>'{budget,currency}',''),'ARS');
  IF v_currency NOT IN ('ARS','USD') THEN RAISE EXCEPTION 'INVALID_CURRENCY' USING ERRCODE='22023'; END IF;
  v_budget := nullif(p_payload#>>'{budget,amount}','')::numeric;
  IF v_budget IS NOT NULL AND v_budget < 0 THEN RAISE EXCEPTION 'INVALID_BUDGET' USING ERRCODE='22023'; END IF;
  v_check := coalesce(p_payload->'checklist','{}'::jsonb);
  IF jsonb_typeof(v_check) <> 'object' THEN RAISE EXCEPTION 'INVALID_CHECKLIST' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each_text(v_check) c WHERE c.value NOT IN ('ok','fail','not_tested','not_applicable')) THEN
    RAISE EXCEPTION 'INVALID_CHECK_RESULT' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.devices(customer_id,type,brand,model,serial,imei,issue,created_by,business_id)
  VALUES(v_customer,coalesce(nullif(p_payload#>>'{device,type}',''),'other'),
    btrim(p_payload#>>'{device,brand}'),btrim(p_payload#>>'{device,model}'),
    nullif(btrim(p_payload#>>'{device,serial}'),''),nullif(regexp_replace(p_payload#>>'{device,imei}','[[:space:]-]','','g'),''),
    btrim(p_payload->>'problem'),v_actor,v_business) RETURNING id INTO v_device;

  INSERT INTO public.orders(customer_id,device_id,status,priority,estimated_total,
    estimated_total_currency,notes,created_by,business_id,access_mode,assigned_profile_id)
  VALUES(v_customer,v_device,'new',coalesce(nullif(p_payload->>'priority',''),'medium'),
    coalesce(v_budget,0),v_currency,nullif(btrim(p_payload->>'observations'),''),v_actor,
    v_business,v_mode,v_assignee) RETURNING id INTO v_order;

  INSERT INTO public.device_inspections(order_id,type,intake_check_results,general_condition,
    physical_conditions,powers_on,reception_notes,created_by,business_id)
  VALUES(v_order,'reception',v_check,nullif(p_payload#>>'{condition,general}',''),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(p_payload#>'{condition,physical}','[]'::jsonb))),
    nullif(p_payload#>>'{condition,powers_on}',''),nullif(btrim(p_payload->>'observations'),''),
    v_actor,v_business);
  IF v_mode IN ('pin','pattern','password') THEN
    PERFORM private.mobile2a_store_access(
      v_order,v_business,v_actor,v_mode,p_access_secret,'stored','set');
    PERFORM private.mobile2a_write_legacy_shadow(
      v_order,v_business,v_mode,p_access_secret);
  END IF;
  UPDATE private.order_intake_requests SET order_id=v_order
   WHERE business_id=v_business AND request_id=p_request_id;
  RETURN jsonb_build_object('order_id',v_order,'device_id',v_device,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.create_order_intake(uuid,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order_intake(uuid,jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_order_device_access_secret(
  p_order_id uuid, p_mode text, p_secret text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid:=auth.uid(); v_business uuid;
BEGIN
  IF NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'FORBIDDEN_DEVICE_ACCESS' USING ERRCODE='42501'; END IF;
  v_business:=private.mobile2a_business_for_actor(v_actor);
  IF NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=p_order_id AND o.business_id=v_business) THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM private.mobile2a_store_access(p_order_id,v_business,v_actor,p_mode,p_secret,
    CASE WHEN EXISTS(SELECT 1 FROM private.order_device_access_secrets s WHERE s.order_id=p_order_id) THEN 'replaced' ELSE 'stored' END,
    CASE WHEN EXISTS(SELECT 1 FROM private.order_device_access_secrets s WHERE s.order_id=p_order_id) THEN 'replace' ELSE 'set' END);
  PERFORM private.mobile2a_write_legacy_shadow(p_order_id,v_business,p_mode,p_secret);
END; $$;
REVOKE ALL ON FUNCTION public.set_order_device_access_secret(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_order_device_access_secret(uuid,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reveal_order_device_access(p_order_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid:=auth.uid(); v_business uuid; v_secret_id uuid; v_value text;
BEGIN
  IF NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'FORBIDDEN_DEVICE_ACCESS' USING ERRCODE='42501'; END IF;
  v_business:=private.mobile2a_business_for_actor(v_actor);
  SELECT s.vault_secret_id INTO v_secret_id FROM private.order_device_access_secrets s
   WHERE s.order_id=p_order_id AND s.business_id=v_business;
  IF v_secret_id IS NULL THEN RETURN NULL; END IF;
  SELECT d.decrypted_secret INTO v_value FROM vault.decrypted_secrets d WHERE d.id=v_secret_id;
  INSERT INTO private.order_device_access_audit(order_id,business_id,actor_id,action,operation)
  VALUES(p_order_id,v_business,v_actor,'revealed','reveal');
  RETURN v_value;
END; $$;
REVOKE ALL ON FUNCTION public.reveal_order_device_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reveal_order_device_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_order_device_access_secret(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid:=auth.uid(); v_business uuid;
BEGIN
  IF NOT public.current_user_can('device_access_secret') THEN RAISE EXCEPTION 'FORBIDDEN_DEVICE_ACCESS' USING ERRCODE='42501'; END IF;
  v_business:=private.mobile2a_business_for_actor(v_actor);
  IF NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=p_order_id AND o.business_id=v_business) THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM private.mobile2a_delete_access(p_order_id,v_business,v_actor,'deleted','delete');
  PERFORM private.mobile2a_write_legacy_shadow(p_order_id,v_business,'none',NULL);
END; $$;
REVOKE ALL ON FUNCTION public.delete_order_device_access_secret(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_order_device_access_secret(uuid) TO authenticated;

-- ── Fotos privadas ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.mobile2a_enforce_intake_document_rpc()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.kind='intake' AND current_setting('app.mobile2a_register_document',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'INTAKE_DOCUMENT_RPC_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.mobile2a_enforce_intake_document_rpc() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS mobile2a_intake_document_rpc_only ON public.documents;
CREATE TRIGGER mobile2a_intake_document_rpc_only BEFORE INSERT OR UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION private.mobile2a_enforce_intake_document_rpc();

CREATE OR REPLACE FUNCTION public.register_order_intake_document(
  p_order_id uuid,p_storage_path text,p_file_name text,p_file_type text,p_file_size integer)
RETURNS public.documents LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_actor uuid:=auth.uid(); v_business uuid; v_doc public.documents; v_previous_guard text;
BEGIN
  IF NOT public.current_user_can('orders_create') THEN RAISE EXCEPTION 'FORBIDDEN_ORDERS_CREATE' USING ERRCODE='42501'; END IF;
  v_business:=private.mobile2a_business_for_actor(v_actor);
  IF NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=p_order_id AND o.business_id=v_business) THEN RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_storage_path NOT LIKE 'business/'||v_business::text||'/orders/'||p_order_id::text||'/intake/%'
     OR coalesce(p_file_name,'')='' OR p_file_type NOT LIKE 'image/%'
     OR p_file_size IS NULL OR p_file_size<1 OR p_file_size>10485760
     OR NOT EXISTS(SELECT 1 FROM storage.objects so
                    WHERE so.bucket_id='documents' AND so.name=p_storage_path) THEN
    RAISE EXCEPTION 'INVALID_INTAKE_DOCUMENT' USING ERRCODE='22023';
  END IF;
  v_previous_guard:=current_setting('app.mobile2a_register_document',true);
  PERFORM set_config('app.mobile2a_register_document','1',true);
  BEGIN
    INSERT INTO public.documents(order_id,file_name,file_url,file_type,file_size,created_by,business_id,storage_path,kind)
    VALUES(p_order_id,p_file_name,NULL,p_file_type,p_file_size,v_actor,v_business,p_storage_path,'intake')
    RETURNING * INTO v_doc;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.mobile2a_register_document',coalesce(v_previous_guard,''),true);
    RAISE;
  END;
  PERFORM set_config('app.mobile2a_register_document',coalesce(v_previous_guard,''),true);
  RETURN v_doc;
END $$;
REVOKE ALL ON FUNCTION public.register_order_intake_document(uuid,text,text,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_order_intake_document(uuid,text,text,text,integer) TO authenticated;

DROP POLICY IF EXISTS "mobile2a_documents_select" ON storage.objects;
CREATE POLICY "mobile2a_documents_select" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id='documents' AND (storage.foldername(name))[1]='business'
  AND (storage.foldername(name))[2]=public.current_user_business_id()::text
  AND public.current_user_can('orders'));
DROP POLICY IF EXISTS "mobile2a_documents_insert" ON storage.objects;
CREATE POLICY "mobile2a_documents_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id='documents' AND (storage.foldername(name))[1]='business'
  AND (storage.foldername(name))[2]=public.current_user_business_id()::text
  AND (storage.foldername(name))[3]='orders' AND (storage.foldername(name))[5]='intake'
  AND EXISTS(SELECT 1 FROM public.orders o WHERE o.business_id=public.current_user_business_id()
    AND o.id::text=(storage.foldername(name))[4])
  AND public.current_user_can('orders_create'));
DROP POLICY IF EXISTS "mobile2a_documents_delete" ON storage.objects;
CREATE POLICY "mobile2a_documents_delete" ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id='documents' AND (storage.foldername(name))[1]='business'
  AND (storage.foldername(name))[2]=public.current_user_business_id()::text
  AND public.current_user_can('orders_create'));

-- El cliente nunca necesita privilegios directos sobre el schema privado.
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA private FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
