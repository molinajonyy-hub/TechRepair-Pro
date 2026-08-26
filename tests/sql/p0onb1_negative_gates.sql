-- ============================================================================
-- P0-ONBOARDING-1 — NEGATIVE GATES a nivel DB
--
-- Cada caso REINTRODUCE a propósito el defecto que el lote cerró y verifica que
-- la postcondición correspondiente lo DETECTE. Después revierte.
--
-- Es lo que distingue un guard real de uno decorativo: una postcondición que
-- nunca se probó contra el defecto que dice detectar no es evidencia de nada.
--
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0onb1_negative_gates.sql
--
-- Todo dentro de UNA transacción que termina en ROLLBACK.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- N1 · Si se cae el CHECK, un vocabulario legacy vuelve a entrar
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_biz uuid; v_uid uuid := gen_random_uuid(); v_n int; v_detecto boolean;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (v_uid,'neg1@invalid.test',now());
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Neg1', v_uid) RETURNING id INTO v_biz;
  INSERT INTO public.business_settings (business_id) VALUES (v_biz);

  -- MUTACIÓN: se retira el CHECK.
  ALTER TABLE public.business_settings DROP CONSTRAINT business_settings_condicion_iva_check;
  UPDATE public.business_settings SET condicion_iva = 'Responsable Inscripto' WHERE business_id = v_biz;

  -- La postcondición P10b de la migración tiene que ver esto.
  SELECT count(*) INTO v_n FROM public.business_settings
   WHERE condicion_iva IS NOT NULL
     AND condicion_iva NOT IN ('responsable_inscripto','monotributo','monotributista_social','exento','consumidor_final');
  v_detecto := v_n > 0;
  IF NOT v_detecto THEN
    RAISE EXCEPTION 'N1 FAIL: se reintrodujo un vocabulario legacy y la postcondición NO lo detectó';
  END IF;

  -- REVERTIR.
  UPDATE public.business_settings SET condicion_iva = 'responsable_inscripto' WHERE business_id = v_biz;
  ALTER TABLE public.business_settings
    ADD CONSTRAINT business_settings_condicion_iva_check
    CHECK (condicion_iva IS NULL OR condicion_iva IN (
      'responsable_inscripto','monotributo','monotributista_social','exento','consumidor_final'));

  RAISE NOTICE 'N1 OK · quitar el CHECK reabre el defecto y la postcondición lo ve';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- N2 · Una reparación SIN el guard de «destino vacío» pisa un dato real
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_uid uuid := gen_random_uuid(); v_biz uuid; v_nom text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (v_uid,'neg2@invalid.test',now());
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Nombre Tecnico Viejo', v_uid) RETURNING id INTO v_biz;
  INSERT INTO public.business_settings (business_id, nombre_comercial)
    VALUES (v_biz, 'Nombre Canonico Real');

  -- MUTACIÓN: la MISMA reparación pero SIN la condición de destino vacío. Es el
  -- error de una línea que convierte una reparación en una corrupción.
  UPDATE public.business_settings s
     SET nombre_comercial = btrim(b.name)
    FROM public.businesses b
   WHERE b.id = s.business_id AND s.business_id = v_biz;

  SELECT nombre_comercial INTO v_nom FROM public.business_settings WHERE business_id = v_biz;
  IF v_nom = 'Nombre Canonico Real' THEN
    RAISE EXCEPTION 'N2 FAIL: la mutación no reprodujo el daño — el gate no prueba nada';
  END IF;

  -- REVERTIR y correr la reparación REAL: no debe tocarlo.
  UPDATE public.business_settings SET nombre_comercial = 'Nombre Canonico Real' WHERE business_id = v_biz;

  UPDATE public.business_settings s
     SET nombre_comercial = CASE
           WHEN nullif(btrim(coalesce(s.nombre_comercial,'')),'') IS NULL
                AND nullif(btrim(b.name),'') IS NOT NULL
                AND btrim(b.name) <> 'Mi Negocio'
             THEN btrim(b.name) ELSE s.nombre_comercial END
    FROM public.businesses b
   WHERE b.id = s.business_id AND s.business_id = v_biz;

  SELECT nombre_comercial INTO v_nom FROM public.business_settings WHERE business_id = v_biz;
  IF v_nom <> 'Nombre Canonico Real' THEN
    RAISE EXCEPTION 'N2 FAIL: la reparación REAL pisó un nombre canónico (= %)', v_nom;
  END IF;

  RAISE NOTICE 'N2 OK · sin el guard se corrompe; con el guard no se toca';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- N3 · Un OVERLOAD de la RPC legacy rompe PostgREST y la postcondición lo ve
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_n int;
BEGIN
  -- MUTACIÓN: se agrega un parámetro. `CREATE OR REPLACE` no cambia la firma:
  -- crea una SEGUNDA función. Con dos candidatas que aceptan los mismos
  -- nombres, PostgREST responde PGRST203 y el frontend productivo deja de
  -- poder guardar durante toda la ventana de rollout.
  CREATE OR REPLACE FUNCTION public.update_my_business_onboarding(
    p_name text DEFAULT NULL, p_rubro text DEFAULT NULL, p_ciudad text DEFAULT NULL,
    p_whatsapp text DEFAULT NULL, p_condicion_fiscal text DEFAULT NULL,
    p_cuit text DEFAULT NULL, p_logo_url text DEFAULT NULL,
    p_complete boolean DEFAULT false, p_razon_social text DEFAULT NULL
  ) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$ SELECT '{}'::jsonb $f$;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='update_my_business_onboarding';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'N3 FAIL: la mutación no creó el overload (hay %)', v_n;
  END IF;

  -- La postcondición P3 de la migración cuenta 4 funciones de perfil; con el
  -- overload cuenta 5.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('get_my_business_onboarding','update_my_business_onboarding',
                       'get_my_business_profile','update_my_business_profile');
  IF v_n = 4 THEN
    RAISE EXCEPTION 'N3 FAIL: hay un overload y la postcondición P3 NO lo detectó';
  END IF;

  -- REVERTIR.
  DROP FUNCTION public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean,text);

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('get_my_business_onboarding','update_my_business_onboarding',
                       'get_my_business_profile','update_my_business_profile');
  IF v_n <> 4 THEN RAISE EXCEPTION 'N3 FAIL: no se revirtió la mutación (hay %)', v_n; END IF;

  RAISE NOTICE 'N3 OK · un overload dispara la postcondición del rollout';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- N4 · Abrirle EXECUTE a anon dispara la postcondición de ACL
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- MUTACIÓN.
  GRANT EXECUTE ON FUNCTION public.update_my_business_profile(jsonb,boolean) TO anon;

  IF NOT has_function_privilege('anon','public.update_my_business_profile(jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'N4 FAIL: la mutación no otorgó el privilegio';
  END IF;
  -- Es exactamente lo que asevera la postcondición P5.
  RAISE NOTICE 'N4 · anon con EXECUTE -> P5 dispararía';

  -- REVERTIR.
  REVOKE EXECUTE ON FUNCTION public.update_my_business_profile(jsonb,boolean) FROM anon;
  IF has_function_privilege('anon','public.update_my_business_profile(jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'N4 FAIL: no se revirtió el grant';
  END IF;

  RAISE NOTICE 'N4 OK · el ACL se puede violar y la postcondición lo ve';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- N5 · Si el writer deja de espejar, nombre y espejo divergen
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_uid uuid := gen_random_uuid(); v_biz uuid; v_nom text; v_name text;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES (v_uid,'neg5@invalid.test',now());
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Original', v_uid) RETURNING id INTO v_biz;
  INSERT INTO public.profiles (id, business_id, role, is_active, email)
    VALUES (v_uid, v_biz, 'owner', true, 'neg5@invalid.test');

  -- MUTACIÓN: escribir SÓLO business_settings, que es lo que hacía Settings.
  INSERT INTO public.business_settings (business_id, nombre_comercial)
    VALUES (v_biz, 'Nombre Nuevo')
    ON CONFLICT (business_id) DO UPDATE SET nombre_comercial = 'Nombre Nuevo';

  SELECT s.nombre_comercial, b.name INTO v_nom, v_name
    FROM public.businesses b JOIN public.business_settings s ON s.business_id = b.id
   WHERE b.id = v_biz;
  IF v_nom = v_name THEN
    RAISE EXCEPTION 'N5 FAIL: la mutación no produjo divergencia — el gate no prueba nada';
  END IF;
  RAISE NOTICE 'N5 · writer parcial -> «%» vs espejo «%»', v_nom, v_name;

  -- El WRITER CANÓNICO deja las dos alineadas.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  PERFORM public.update_my_business_profile(jsonb_build_object('nombre_comercial','Nombre Nuevo'));
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT s.nombre_comercial, b.name INTO v_nom, v_name
    FROM public.businesses b JOIN public.business_settings s ON s.business_id = b.id
   WHERE b.id = v_biz;
  IF v_nom IS DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'N5 FAIL: el writer canónico dejó divergencia («%» vs «%»)', v_nom, v_name;
  END IF;

  RAISE NOTICE 'N5 OK · el writer parcial diverge; el canónico espeja';
END $$;

ROLLBACK;
