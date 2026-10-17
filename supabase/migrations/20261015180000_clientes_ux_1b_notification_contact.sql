-- ============================================================================
-- CLIENTES-UX-1B · Contacto alternativo para avisos + destinatario por orden
-- ============================================================================
-- ADITIVA. No modifica ni borra ningún teléfono existente, no toca `orders`, ni
-- sus grants por columna (SEC-08A), ni `create_order_intake`, ni comprobantes,
-- garantías o cuentas corrientes. La titularidad de la orden sigue siendo
-- `orders.customer_id`.
--
-- A. customers.notification_contact_name / notification_contact_phone
--    Opcionales y de a dos: un contacto sin teléfono no sirve para avisar.
--    `contact_person` NO se reutiliza: es el contacto MAYORISTA (PRE-BETA-3A-2S
--    lo protege con trig_customers_wholesale_authority). Estas columnas no
--    entran en ese trigger: son datos comunes de cualquier cliente.
--
-- B. public.order_notification_recipients
--    A quién se avisa en ESTA orden. Sin fila = el teléfono principal del
--    cliente (todas las órdenes existentes, sin backfill).
--      · 'customer'  → el titular. No se copia nada: si el cliente corrige su
--                      teléfono, la orden avisa al número corregido.
--      · 'alternate' → se COPIA el contacto alternativo del cliente al elegirlo.
--                      Si después la ficha cambia o borra ese contacto, la orden
--                      sigue avisando a quien se eligió para esta reparación.
--    Lectura: tenant + capacidad `orders`. Escritura: sólo por la RPC.
--
-- C. public.set_order_notification_recipient(order, 'customer'|'alternate')
--    SECURITY DEFINER endurecida. Autoridad: negocio del actor + capacidad
--    `orders_create` (recepción) u `orders_change_status` (seguimiento, la
--    misma que exige la policy de UPDATE de orders). Idempotente.
-- ============================================================================

BEGIN;

-- ── A. Contacto alternativo del cliente ──────────────────────────────────────
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS notification_contact_name  text,
  ADD COLUMN IF NOT EXISTS notification_contact_phone text;

COMMENT ON COLUMN public.customers.notification_contact_name IS
  'CLIENTES-UX-1B — nombre de la persona a la que se puede avisar en lugar del '
  'cliente (p. ej. quien retira el equipo). NO es contact_person (mayorista).';
COMMENT ON COLUMN public.customers.notification_contact_phone IS
  'CLIENTES-UX-1B — teléfono para avisos de ese contacto. El teléfono principal '
  '(phone) sigue siendo del cliente.';

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_notification_contact_pair_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_notification_contact_pair_check CHECK (
  (notification_contact_name IS NULL AND notification_contact_phone IS NULL)
  OR (notification_contact_name IS NOT NULL AND notification_contact_phone IS NOT NULL)
);

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_notification_contact_name_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_notification_contact_name_check CHECK (
  notification_contact_name IS NULL
  OR (btrim(notification_contact_name) <> '' AND char_length(notification_contact_name) <= 120)
);

-- Mismo criterio que el frontend (src/features/customer-core/notice.ts):
-- dígitos, espacios, +, guiones y paréntesis; de 8 a 15 dígitos (E.164).
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_notification_contact_phone_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_notification_contact_phone_check CHECK (
  notification_contact_phone IS NULL
  OR (
    notification_contact_phone ~ '^\+?[0-9 ()-]+$'
    AND char_length(notification_contact_phone) <= 32
    AND char_length(regexp_replace(notification_contact_phone, '[^0-9]', '', 'g')) BETWEEN 8 AND 15
  )
);

-- ── B. Destinatario de avisos por orden ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.order_notification_recipients (
  order_id      uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  recipient     text NOT NULL,
  contact_name  text,
  contact_phone text,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_notification_recipients_recipient_check
    CHECK (recipient IN ('customer', 'alternate')),
  CONSTRAINT order_notification_recipients_snapshot_check CHECK (
    (recipient = 'customer' AND contact_name IS NULL AND contact_phone IS NULL)
    OR (recipient = 'alternate'
        AND contact_name IS NOT NULL AND btrim(contact_name) <> ''
        AND contact_phone IS NOT NULL AND btrim(contact_phone) <> '')
  )
);

COMMENT ON TABLE public.order_notification_recipients IS
  'CLIENTES-UX-1B — a quién se avisa en cada orden. Sin fila = teléfono principal '
  'del cliente. ''alternate'' guarda una COPIA del contacto elegido. Escritura '
  'sólo por set_order_notification_recipient(). No cambia la titularidad.';

CREATE INDEX IF NOT EXISTS idx_order_notification_recipients_business
  ON public.order_notification_recipients (business_id);

ALTER TABLE public.order_notification_recipients ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.order_notification_recipients FROM PUBLIC;
REVOKE ALL ON TABLE public.order_notification_recipients FROM anon;
REVOKE ALL ON TABLE public.order_notification_recipients FROM authenticated;
GRANT SELECT ON TABLE public.order_notification_recipients TO authenticated;

DROP POLICY IF EXISTS order_notification_recipients_select ON public.order_notification_recipients;
CREATE POLICY order_notification_recipients_select ON public.order_notification_recipients
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id() AND public.current_user_can('orders'));

-- ── C. Única escritura ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_order_notification_recipient(
  p_order_id  uuid,
  p_recipient text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_business uuid;
  v_customer uuid;
  v_name     text;
  v_phone    text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;
  IF p_order_id IS NULL OR p_recipient IS NULL OR p_recipient NOT IN ('customer', 'alternate') THEN
    RAISE EXCEPTION 'INVALID_NOTIFICATION_RECIPIENT' USING ERRCODE = '22023';
  END IF;
  IF NOT (public.current_user_can('orders_create') OR public.current_user_can('orders_change_status')) THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTIFICATION_RECIPIENT' USING ERRCODE = '42501';
  END IF;

  v_business := public.current_user_business_id();
  SELECT o.customer_id INTO v_customer
    FROM public.orders o
   WHERE o.id = p_order_id AND o.business_id = v_business;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_recipient = 'alternate' THEN
    SELECT c.notification_contact_name, c.notification_contact_phone
      INTO v_name, v_phone
      FROM public.customers c
     WHERE c.id = v_customer AND c.business_id = v_business;
    IF v_name IS NULL OR v_phone IS NULL THEN
      RAISE EXCEPTION 'ALTERNATE_CONTACT_MISSING' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.order_notification_recipients AS r
    (order_id, business_id, recipient, contact_name, contact_phone, updated_by, updated_at)
  VALUES (p_order_id, v_business, p_recipient, v_name, v_phone, v_actor, now())
  ON CONFLICT (order_id) DO UPDATE
     SET recipient     = EXCLUDED.recipient,
         contact_name  = EXCLUDED.contact_name,
         contact_phone = EXCLUDED.contact_phone,
         updated_by    = EXCLUDED.updated_by,
         updated_at    = EXCLUDED.updated_at;

  RETURN jsonb_build_object(
    'order_id',      p_order_id,
    'recipient',     p_recipient,
    'contact_name',  v_name,
    'contact_phone', v_phone
  );
END;
$$;

ALTER FUNCTION public.set_order_notification_recipient(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_order_notification_recipient(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_order_notification_recipient(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_order_notification_recipient(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_order_notification_recipient(uuid, text) IS
  'CLIENTES-UX-1B — única escritura de order_notification_recipients. Autoridad: '
  'negocio del actor + orders_create u orders_change_status. ''alternate'' copia '
  'el contacto alternativo del cliente de la orden; sin contacto -> '
  'ALTERNATE_CONTACT_MISSING. Idempotente. No toca orders ni customers.';

-- ── Postcondiciones (cualquier falla revierte todo) ──────────────────────────
DO $post$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'customers'
     AND column_name IN ('notification_contact_name', 'notification_contact_phone');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POSTCONDICION 1: faltan columnas de contacto alternativo'; END IF;

  -- Nada se escribió en filas existentes: aditiva, sin backfill.
  IF EXISTS (SELECT 1 FROM public.customers
              WHERE notification_contact_name IS NOT NULL OR notification_contact_phone IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDICION 2: la migración no debe completar contactos alternativos';
  END IF;

  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
           WHERE c.oid = 'public.order_notification_recipients'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: RLS apagada en order_notification_recipients';
  END IF;

  IF has_table_privilege('anon', 'public.order_notification_recipients', 'SELECT')
     OR has_table_privilege('authenticated', 'public.order_notification_recipients', 'INSERT')
     OR has_table_privilege('authenticated', 'public.order_notification_recipients', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.order_notification_recipients', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.order_notification_recipients', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION 4: grants de order_notification_recipients fuera de contrato';
  END IF;

  IF has_function_privilege('anon', 'public.set_order_notification_recipient(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_order_notification_recipient(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 5: EXECUTE de set_order_notification_recipient fuera de contrato';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = 'public.set_order_notification_recipient(uuid, text)'::regprocedure
                    AND p.prosecdef
                    AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'POSTCONDICION 6: set_order_notification_recipient no está endurecida';
  END IF;

  -- El trigger mayorista sigue mirando SOLO sus columnas: estas no lo disparan.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
              WHERE t.tgrelid = 'public.customers'::regclass
                AND t.tgname = 'trig_customers_wholesale_authority'
                AND pg_catalog.pg_get_triggerdef(t.oid) ILIKE '%notification_contact%') THEN
    RAISE EXCEPTION 'POSTCONDICION 7: el trigger mayorista no debe mirar el contacto para avisos';
  END IF;

  RAISE NOTICE 'CLIENTES-UX-1B OK · contacto alternativo opcional (0 filas tocadas) · order_notification_recipients con RLS, sólo SELECT para authenticated · escritura por RPC endurecida · orders, SEC-08A y mayorista intactos';
END;
$post$;

COMMIT;
