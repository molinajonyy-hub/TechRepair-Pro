-- ============================================================================
-- P0-DÓLAR — Contrato canónico de la fuente de cotización.
--
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK.
--
-- Cubre:
--   · la lectura expone `dolar_source` y devuelve el valor REAL;
--   · el anti-pisada: omitir la fuente NO la resetea;
--   · la allowlist de fuentes y de monedas;
--   · el gate RBAC por RPC y por escritura directa a la tabla;
--   · el aislamiento entre tenants;
--   · la ausencia de las policies heredadas que salteaban el gate de rol.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-00000d01a001'
\set biz2  '00000000-0000-0000-0000-00000d01a002'
\set own   '00000000-0000-0000-0000-00000d01a0a1'
\set adm   '00000000-0000-0000-0000-00000d01a0a2'
\set tch   '00000000-0000-0000-0000-00000d01a0a3'
\set own2  '00000000-0000-0000-0000-00000d01a0b1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'),(:'adm'),(:'tch'),(:'own2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','P0-DOLAR A',:'own'), (:'biz2','P0-DOLAR B',:'own2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'biz',:'own','owner',true), (:'biz',:'adm','admin',true), (:'biz',:'tch','tech',true),
  (:'biz2',:'own2','owner',true);
-- Punto de partida: el negocio eligió Córdoba.
INSERT INTO business_settings(business_id, default_currency, auto_update_rate, dolar_source)
  VALUES (:'biz','ARS',true,'cordoba');
SET LOCAL session_replication_role='origin';

-- ─── S1. La lectura expone la fuente configurada ─────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a1';

  SELECT to_jsonb(g) INTO v FROM public.get_business_settings() g;

  PERFORM pg_temp.assert(v ? 'dolar_source',
    'S1a get_business_settings expone dolar_source');
  PERFORM pg_temp.assert(v->>'dolar_source' = 'cordoba',
    'S1b devuelve el valor REAL (cordoba), no un default — leyo: '||COALESCE(v->>'dolar_source','NULL'));
  RESET ROLE;
END $$;

-- ─── S2. Anti-pisada: omitir la fuente NO la cambia ──────────────────────────
-- Es el bug exacto que se reporto: guardar cualquier ajuste reseteaba la
-- fuente a 'nacional' porque el cliente mandaba `undefined ?? 'nacional'`.
DO $$
DECLARE v text;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a1';

  SELECT r.dolar_source INTO v FROM public.upsert_business_settings(
    '00000000-0000-0000-0000-00000d01a001'::uuid,
    'ARS', true, true, NULL, 12, NULL) r;

  PERFORM pg_temp.assert(v = 'cordoba',
    'S2 guardar sin fuente conserva cordoba — quedo: '||COALESCE(v,'NULL'));
  RESET ROLE;
END $$;

-- ─── S3. Cambio explícito de fuente ──────────────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a1';

  SELECT r.dolar_source INTO v FROM public.upsert_business_settings(
    '00000000-0000-0000-0000-00000d01a001'::uuid,
    'ARS', false, false, NULL, 24, 'nacional') r;
  PERFORM pg_temp.assert(v = 'nacional', 'S3a el usuario elige nacional y persiste');

  SELECT r.dolar_source INTO v FROM public.upsert_business_settings(
    '00000000-0000-0000-0000-00000d01a001'::uuid,
    'ARS', false, false, NULL, 24, 'cordoba') r;
  PERFORM pg_temp.assert(v = 'cordoba', 'S3b y vuelve a cordoba');
  RESET ROLE;
END $$;

-- ─── S4. Allowlist de fuentes (sin proveedor arbitrario) ─────────────────────
DO $$
DECLARE ok boolean := false;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a1';
  BEGIN
    PERFORM public.upsert_business_settings(
      '00000000-0000-0000-0000-00000d01a001'::uuid,
      'ARS', false, false, NULL, 24, 'https://evil.example/quote');
  EXCEPTION WHEN others THEN ok := true;
  END;
  PERFORM pg_temp.assert(ok, 'S4 fuente fuera del catalogo es rechazada');
  RESET ROLE;
END $$;

-- ─── S5. Allowlist de monedas con mensaje legible ────────────────────────────
-- La UI ofrecia EUR y GBP contra un CHECK que solo acepta ARS/USD.
DO $$
DECLARE msg text := '';
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a1';
  BEGIN
    PERFORM public.upsert_business_settings(
      '00000000-0000-0000-0000-00000d01a001'::uuid,
      'EUR', false, false, NULL, 24, NULL);
  EXCEPTION WHEN others THEN msg := SQLERRM;
  END;
  PERFORM pg_temp.assert(msg ILIKE '%Moneda no soportada%',
    'S5 moneda invalida da mensaje legible, no un 23514 crudo — dio: '||msg);
  RESET ROLE;
END $$;

-- ─── S6. RBAC por RPC: tech no configura la cotización ───────────────────────
DO $$
DECLARE msg text := '';
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a3';
  BEGIN
    PERFORM public.upsert_business_settings(
      '00000000-0000-0000-0000-00000d01a001'::uuid,
      'ARS', false, false, NULL, 24, 'nacional');
  EXCEPTION WHEN others THEN msg := SQLERRM;
  END;
  PERFORM pg_temp.assert(msg ILIKE '%permisos%', 'S6 tech es rechazado por la RPC — dio: '||msg);
  RESET ROLE;
END $$;

-- ─── S7. RBAC por escritura directa: el bypass legacy quedo cerrado ──────────
-- Con las policies heredadas vivas, tech podia UPDATE-ar la tabla salteando el
-- gate owner/admin. Un UPDATE denegado por RLS devuelve 0 filas SIN error.
DO $$
DECLARE n int; v text;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0a3';

  WITH upd AS (
    UPDATE public.business_settings SET dolar_source='nacional'
    WHERE business_id='00000000-0000-0000-0000-00000d01a001'::uuid
    RETURNING 1
  ) SELECT count(*) INTO n FROM upd;
  PERFORM pg_temp.assert(n = 0, 'S7a tech no modifica la tabla directo — filas: '||n);

  RESET ROLE;
  SELECT dolar_source INTO v FROM public.business_settings
   WHERE business_id='00000000-0000-0000-0000-00000d01a001'::uuid;
  PERFORM pg_temp.assert(v = 'cordoba', 'S7b la fuente quedo intacta — quedo: '||COALESCE(v,'NULL'));
END $$;

-- ─── S8. Aislamiento entre tenants ───────────────────────────────────────────
DO $$
DECLARE msg text := ''; n int;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000d01a0b1';

  SELECT count(*) INTO n FROM public.get_business_settings() g
   WHERE g.business_id = '00000000-0000-0000-0000-00000d01a001'::uuid;
  PERFORM pg_temp.assert(n = 0, 'S8a otro tenant no lee esta configuracion');

  BEGIN
    PERFORM public.upsert_business_settings(
      '00000000-0000-0000-0000-00000d01a001'::uuid,
      'ARS', false, false, NULL, 24, 'nacional');
  EXCEPTION WHEN others THEN msg := SQLERRM;
  END;
  PERFORM pg_temp.assert(msg ILIKE '%acceso%', 'S8b otro tenant no escribe — dio: '||msg);
  RESET ROLE;
END $$;

-- ─── S9. No quedan policies heredadas en business_settings ───────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid='public.business_settings'::regclass
     AND polname LIKE 'Users can %business settings%';
  PERFORM pg_temp.assert(n = 0, 'S9 policies heredadas retiradas — quedan: '||n);
END $$;

-- ─── S10. La RPC de escritura sigue siendo la unica autoridad con gate ───────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policy
   WHERE polrelid='public.business_settings'::regclass
     AND polcmd IN ('a','w')
     AND pg_get_expr(COALESCE(polwithcheck, polqual), polrelid) NOT ILIKE '%current_user_role%';
  PERFORM pg_temp.assert(n = 0, 'S10 toda policy de escritura exige rol — sin gate: '||n);
END $$;

ROLLBACK;
