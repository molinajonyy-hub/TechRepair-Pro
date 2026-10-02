-- ============================================================================
-- BETA-MP · PLAN B · un preapproval pertenece a UNA sesion de checkout
--
-- Billing SaaS (mp-subscription + mp-webhook). No toca el POS ni Merchant Connect.
--
-- CONTEXTO (smoke real del 2026-10-02):
--   El checkout por URL de un `preapproval_plan` de Mercado Pago NO conserva
--   `external_reference`: el preapproval real quedo `authorized` con la
--   referencia vacia y no se pudo vincular con ningun negocio (fail-closed).
--   Plan B: el BACKEND crea el preapproval por API (`POST /preapproval`, estado
--   `pending`) y guarda su id en la sesion ANTES de devolver el checkout. Desde
--   entonces la identidad de un pago es ese id, no una referencia que Mercado
--   Pago puede no devolver.
--
-- DISCOVERY (produccion read-only 2026-10-02):
--   subscription_checkout_sessions   2 filas, ambas `pending`, ambas con
--                                    mp_preapproval_id NULL (checkouts del Plan A).
--   idx_scs_mp_preapproval           indice NO unico, parcial, de la 20261012120000.
--
-- QUE HACE
--   Reemplaza idx_scs_mp_preapproval por uq_scs_mp_preapproval: UNIQUE sobre
--   (mp_preapproval_id) cuando no es NULL. Con eso la base garantiza
--       preapproval -> una sola sesion -> un solo negocio
--   y, junto con uq_businesses_mp_preapproval_id, que un preapproval no puede
--   activar a dos negocios. La busqueda por id de preapproval (webhook y
--   reconcile) usa este mismo indice.
--
-- QUE NO HACE: cero DML. No cambia grants, policies ni columnas.
--
-- ORDEN DE ROLLOUT: va ANTES que las Edge Functions del Plan B, pero ninguno de
-- los dos ordenes rompe:
--   · Con la migracion y las funciones ANTERIORES (Plan A): solo anotaban el id
--     de un preapproval `pending` en la sesion resuelta por referencia; el
--     indice unico no cambia ese camino.
--   · Con las funciones del Plan B y SIN la migracion: funcionan igual. La
--     lectura por id usa `maybeSingle`: dos filas para un mismo preapproval dan
--     error y no activan nada (fail-closed). La migracion vuelve imposible ese
--     estado en vez de solo detectarlo.
--
-- IDEMPOTENTE: se puede re-ejecutar. FAIL-CLOSED: si una precondicion no
-- coincide con el discovery, RAISE y nada se aplica.
--
-- ROLLBACK (manual, sin perdida de datos):
--   DROP INDEX public.uq_scs_mp_preapproval;
--   CREATE INDEX idx_scs_mp_preapproval ON public.subscription_checkout_sessions (mp_preapproval_id)
--     WHERE mp_preapproval_id IS NOT NULL;
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_scs  oid := to_regclass('public.subscription_checkout_sessions');
  v_role text;
BEGIN
  -- PRECONDICION 1 · la migracion BETA-MP (20261012120000) esta aplicada: la
  -- columna existe y la tabla sigue siendo una tabla comun con RLS.
  IF v_scs IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: falta public.subscription_checkout_sessions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_scs AND c.relkind = 'r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'PRECONDICION 1: subscription_checkout_sessions no es una tabla comun con RLS activo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_scs AND a.attname = 'mp_preapproval_id'
                    AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION 1: falta subscription_checkout_sessions.mp_preapproval_id (aplicar antes la 20261012120000)';
  END IF;

  -- PRECONDICION 2 · la tabla sigue siendo solo del backend. Esta migracion no
  -- toca grants: si un rol de cliente tuviera acceso, hay drift que no vio.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_any_column_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE') THEN
      RAISE EXCEPTION 'PRECONDICION 2: % tiene acceso a subscription_checkout_sessions (BETA-MP lo habia revocado)', v_role;
    END IF;
  END LOOP;

  -- PRECONDICION 3 · ningun preapproval figura en dos sesiones: el indice unico
  -- tiene que poder crearse sin tocar una fila.
  IF EXISTS (SELECT 1 FROM public.subscription_checkout_sessions WHERE mp_preapproval_id IS NOT NULL
              GROUP BY mp_preapproval_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'PRECONDICION 3: hay un mp_preapproval_id repetido en subscription_checkout_sessions';
  END IF;
END
$pre$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Un preapproval -> una sesion
-- ════════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_scs_mp_preapproval
  ON public.subscription_checkout_sessions (mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;

-- El indice unico cubre las mismas busquedas: el anterior queda redundante.
DROP INDEX IF EXISTS public.idx_scs_mp_preapproval;

COMMENT ON COLUMN public.subscription_checkout_sessions.mp_preapproval_id IS
  'BETA-MP Plan B: preapproval que el BACKEND creo en Mercado Pago para este checkout (POST /preapproval). '
  'Se guarda antes de devolver el init_point y es la identidad del pago. Unico: un preapproval pertenece a una sola sesion.';
COMMENT ON COLUMN public.subscription_checkout_sessions.mp_preapproval_plan_id IS
  'BETA-MP Plan A (CONFIRMED UNSUPPORTED): plan de Mercado Pago esperado. El Plan B no usa planes de MP: queda NULL en los checkouts nuevos.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_scs  oid := 'public.subscription_checkout_sessions'::regclass;
  v_def  text;
  v_role text;
BEGIN
  -- POSTCONDICION 1 · el indice unico existe, es valido y tiene la forma esperada.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_def
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.uq_scs_mp_preapproval')
     AND i.indrelid = v_scs AND i.indisunique AND i.indisvalid;
  IF v_def IS NULL OR v_def NOT LIKE '%(mp_preapproval_id)%' OR v_def NOT LIKE '%mp_preapproval_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'POSTCONDICION 1: uq_scs_mp_preapproval no tiene la forma esperada (%)', v_def;
  END IF;

  -- POSTCONDICION 2 · no queda el indice no unico.
  IF to_regclass('public.idx_scs_mp_preapproval') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 2: sigue existiendo idx_scs_mp_preapproval';
  END IF;

  -- POSTCONDICION 3 · el contrato de BETA-MP sigue intacto: la tabla es solo del
  -- backend, service_role lee/crea/actualiza y no borra, RLS activo.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       OR has_any_column_privilege(v_role, v_scs, 'SELECT, INSERT, UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % tiene acceso a subscription_checkout_sessions', v_role;
    END IF;
  END LOOP;
  IF NOT (has_table_privilege('service_role', v_scs, 'SELECT')
          AND has_table_privilege('service_role', v_scs, 'INSERT')
          AND has_table_privilege('service_role', v_scs, 'UPDATE'))
     OR has_table_privilege('service_role', v_scs, 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICION 3: los privilegios de service_role sobre subscription_checkout_sessions cambiaron';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_scs) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: subscription_checkout_sessions perdio RLS';
  END IF;

  RAISE NOTICE 'BETA-MP PLAN B OK · un preapproval pertenece a una sola sesion de checkout '
    '(uq_scs_mp_preapproval) · grants y policies de BETA-MP intactos · cero DML.';
END
$post$;

COMMIT;
