-- ============================================================================
-- P0 PV FISCAL - RBAC de la lectura del punto de venta en el POS.
--
-- El POS paso a consumir get_arca_config_safe para mostrar el PV fiscal. Los
-- permisos de Settings NO son los del POS: facturan cinco roles, pero solo dos
-- pueden tocar la configuracion de ARCA. Este test verifica que los cinco
-- puedan LEER el PV y que ninguno reciba material secreto.
--
-- REQUISITO: seed E2E aplicado (npm run e2e:prepare).
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/fiscal_pv_rbac.test.sql
--
-- Todo en UNA transaccion que termina en ROLLBACK.
--
-- Roles del dominio (profiles_role_check): owner, admin, manager, tech, sales,
-- cashier, viewer. Facturan (src/config/permissions.ts, comprobantes=true):
-- owner, admin, manager, sales, cashier. NO facturan: tech, viewer.
--
--   R00  el detector de fugas realmente detecta (control del control)
--   R01  los 5 roles que facturan leen el PV fiscal correcto (3)
--   R02  ninguna respuesta trae material secreto
--   R03  ningun rol puede leer la config de otro negocio
--   R04  sin sesion no se lee nada (fail-closed)
--   R05  no se ve "sin configurar" habiendo config valida
--   R06  los roles que no facturan no ganan privilegios nuevos por este lote
-- ============================================================================
BEGIN;

SET LOCAL client_min_messages = notice;

INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-0000-0000-00000e2e0001', 'owner@e2e.local')
ON CONFLICT (id) DO NOTHING;

-- CONTROL POSITIVO: se plantan secretos REALES en la fila. Si la funcion
-- filtrara algo, estos centinelas apareceran en la respuesta. Probar contra una
-- fila vacia no demostraria nada.
INSERT INTO public.arca_config (
  business_id, cuit_emisor, ambiente, punto_venta,
  wsaa_token, wsaa_sign, pfx_password, certificate_password, cert_file, pfx_file)
VALUES ('00000000-0000-0000-0000-00000e2eb001', '20111111112', 'homologacion', 3,
  'CENTINELA-TOKEN', 'CENTINELA-SIGN', 'CENTINELA-PFXPASS', 'CENTINELA-CERTPASS',
  '-----BEGIN CERTIFICATE-----CENTINELA-CERT', 'CENTINELA-PFX')
ON CONFLICT (business_id) DO UPDATE SET
  punto_venta = 3,
  wsaa_token = 'CENTINELA-TOKEN', wsaa_sign = 'CENTINELA-SIGN',
  pfx_password = 'CENTINELA-PFXPASS', certificate_password = 'CENTINELA-CERTPASS',
  cert_file = '-----BEGIN CERTIFICATE-----CENTINELA-CERT', pfx_file = 'CENTINELA-PFX';

/**
 * Material secreto dentro de una respuesta de get_arca_config_safe.
 *
 * Se mide por VALOR y por nombre EXACTO de columna secreta, no con un regex de
 * nombres: has_certificate / has_private_key_configured / wsaa_token_valid son
 * INDICADORES booleanos de presencia y forman parte del contrato seguro; no son
 * una fuga.
 */
CREATE OR REPLACE FUNCTION pg_temp.fugas(p jsonb) RETURNS text[]
LANGUAGE sql AS $$
  SELECT COALESCE(array_agg(k), '{}')
  FROM jsonb_each(COALESCE(p, '{}'::jsonb)) AS t(k, v)
  WHERE
    k IN ('wsaa_token','wsaa_sign','pfx_password','certificate_password',
          'cert_file','pfx_file','private_key','private_key_secret_id')
    OR v::text LIKE '%CENTINELA%'
    OR v::text LIKE '%BEGIN CERTIFICATE%'
    OR v::text LIKE '%BEGIN % PRIVATE KEY%'
$$;

/** Lee el PV fiscal actuando como el rol indicado. */
CREATE OR REPLACE FUNCTION pg_temp.como_rol(p_rol text, p_business uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  UPDATE public.profiles SET role = p_rol
   WHERE id = '00000000-0000-0000-0000-00000e2e0001';
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000e2e0001","role":"authenticated"}', true);
  RETURN public.get_arca_config_safe(p_business);
END;
$$;

-- == R00 - el detector detecta ==============================================
-- Un detector que nunca dispara convertiria R02 en teatro.
DO $$
BEGIN
  IF array_length(pg_temp.fugas('{"wsaa_token":"x"}'::jsonb), 1) IS NULL THEN
    RAISE EXCEPTION 'R00: el detector no ve una columna secreta por nombre';
  END IF;
  IF array_length(pg_temp.fugas('{"algo":"CENTINELA-TOKEN"}'::jsonb), 1) IS NULL THEN
    RAISE EXCEPTION 'R00: el detector no ve un centinela por valor';
  END IF;
  IF array_length(pg_temp.fugas('{"has_certificate":true,"punto_venta":3}'::jsonb), 1) IS NOT NULL THEN
    RAISE EXCEPTION 'R00: el detector marca indicadores de presencia como fuga';
  END IF;
  RAISE NOTICE 'R00 OK - el detector distingue secreto de indicador.';
END $$;

-- == R01 / R02 / R05 - los 5 roles que facturan =============================
DO $$
DECLARE
  v_facturan CONSTANT text[] := ARRAY['owner','admin','manager','sales','cashier'];
  v_rol text; r jsonb; v_malas text[];
BEGIN
  FOREACH v_rol IN ARRAY v_facturan LOOP
    r := pg_temp.como_rol(v_rol, '00000000-0000-0000-0000-00000e2eb001');

    IF r IS NULL THEN
      RAISE EXCEPTION 'R01: el rol % no puede leer el PV fiscal (get_arca_config_safe devolvio NULL). El POS le mostraria "sin configurar".', v_rol;
    END IF;
    IF COALESCE((r->>'configured')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'R05: el rol % ve "sin configurar" con config valida: %', v_rol, r;
    END IF;
    IF (r->>'punto_venta')::int IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'R01: el rol % lee un PV fiscal incorrecto: %', v_rol, r->>'punto_venta';
    END IF;

    v_malas := pg_temp.fugas(r);
    IF array_length(v_malas, 1) IS NOT NULL THEN
      RAISE EXCEPTION 'R02: el rol % recibe material secreto: %', v_rol, v_malas;
    END IF;
  END LOOP;
  RAISE NOTICE 'R01/R02/R05 OK - los 5 roles que facturan leen PV=3, con secretos plantados en la fila y ninguno filtrado.';
END $$;

-- == R03 - cross-business ===================================================
DO $$
DECLARE v_rol text; r jsonb;
BEGIN
  FOREACH v_rol IN ARRAY ARRAY['owner','admin','manager','sales','cashier','tech','viewer'] LOOP
    r := pg_temp.como_rol(v_rol, '00000000-0000-0000-0000-00000e2eb002');
    IF r IS NOT NULL THEN
      RAISE EXCEPTION 'R03: el rol % leyo la configuracion de OTRO negocio: %', v_rol, r;
    END IF;
  END LOOP;
  RAISE NOTICE 'R03 OK - ningun rol lee la configuracion de otro negocio.';
END $$;

-- == R04 - sin sesion, fail-closed ==========================================
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  r := public.get_arca_config_safe('00000000-0000-0000-0000-00000e2eb001');
  IF r IS NOT NULL THEN
    RAISE EXCEPTION 'R04: sin sesion se pudo leer la configuracion ARCA: %', r;
  END IF;
  RAISE NOTICE 'R04 OK - sin sesion no se lee nada (corta por auth.uid() NULL).';
END $$;

-- == R06 - los que no facturan no ganan privilegios =========================
-- No se les niega la lectura: get_arca_config_safe SIEMPRE fue por MEMBRESIA,
-- no por rol, y este lote no la amplio ni un privilegio. Lo que importa es que
-- no puedan FACTURAR, cosa que deciden el checkout y el gating de UI, no esta
-- funcion. Se deja constancia del estado real y de que tampoco ven secretos.
DO $$
DECLARE v_rol text; r jsonb; v_malas text[];
BEGIN
  FOREACH v_rol IN ARRAY ARRAY['tech','viewer'] LOOP
    r := pg_temp.como_rol(v_rol, '00000000-0000-0000-0000-00000e2eb001');
    IF r IS NOT NULL THEN
      v_malas := pg_temp.fugas(r);
      IF array_length(v_malas, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'R06: el rol % (no factura) recibe material secreto: %', v_rol, v_malas;
      END IF;
      RAISE NOTICE 'R06 - el rol % lee el PV por membresia (sin cambio en este lote) y no recibe secretos.', v_rol;
    ELSE
      RAISE NOTICE 'R06 - el rol % no lee la config.', v_rol;
    END IF;
  END LOOP;
  RAISE NOTICE 'R06 OK - los roles que no facturan no ganaron privilegios nuevos.';
END $$;

ROLLBACK;
