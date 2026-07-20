-- ============================================================================
-- M7 HOTFIX — Aislamiento cross-tenant de las 3 vistas canonicas.
--
-- No alcanza con leer `reloptions`: eso prueba que alguien escribio la opcion,
-- no que el aislamiento funcione. Este suite CONSULTA LAS VISTAS con un JWT
-- `authenticated` real y exige que un negocio no vea al otro.
--
-- CONTROL OBLIGATORIO: en la misma sesion y con el mismo JWT se consulta una
-- tabla base con RLS. Si el control no aisla, el contexto auth del test esta
-- mal armado y cualquier "PASS" seria mentira. Por eso el control se ASSERTEA,
-- no se asume.
--
-- FALSIFICACION: la seccion 5 apaga security_invoker dentro de la transaccion
-- y exige que el leak REAPAREZCA y que el check del Health Check pase a fail.
-- Un test de seguridad que nunca vio fallar el predicado no probo nada.
--
-- RUN: psql -X -f  (una tx + ROLLBACK; no deja nada).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- Actua como `authenticated` con el JWT de un usuario concreto.
CREATE OR REPLACE FUNCTION pg_temp.as_user(p_uid uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role','authenticated','aud','authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.as_postgres() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', NULL, true);
END; $$;

-- ══ 1. Configuracion del catalogo ═══════════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='v_finance_sales_ledger'),
  'SI1 v_finance_sales_ledger tiene security_invoker');

SELECT pg_temp.assert(
  (SELECT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='v_finance_pnl'),
  'SI2 v_finance_pnl tiene security_invoker');

SELECT pg_temp.assert(
  (SELECT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='v_finance_product_margin'),
  'SI3 v_finance_product_margin tiene security_invoker');

-- Invariante de clase, no de las 3 vistas: cubre la vista que se cree mañana.
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m')
      AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
      AND (has_table_privilege('anon', c.oid,'SELECT')
        OR has_table_privilege('authenticated', c.oid,'SELECT'))) = 0,
  'SI4 ninguna vista alcanzable por anon/authenticated corre con privilegios del owner');

-- ══ 2. Firma estable: el fix no puede cambiar el contrato ═══════════════════
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name IN ('v_finance_pnl','v_finance_sales_ledger','v_finance_product_margin')) = 43,
  'SI5 las 3 vistas conservan 43 columnas en total');

SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='v_finance_pnl'
      AND column_name IN ('business_id','period_date','net_sales','cogs','gross_profit','operating_result')) = 6,
  'SI6 v_finance_pnl conserva las columnas que consume el frontend');

-- ══ 3. anon no llega ════════════════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.v_finance_pnl','SELECT'),
  'SI7 anon no tiene SELECT sobre v_finance_pnl');
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.v_finance_sales_ledger','SELECT'),
  'SI8 anon no tiene SELECT sobre v_finance_sales_ledger');
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.v_finance_product_margin','SELECT'),
  'SI9 anon no tiene SELECT sobre v_finance_product_margin');

-- authenticated CONSERVA el acceso: el fix no puede cerrar de mas.
SELECT pg_temp.assert(has_table_privilege('authenticated','public.v_finance_pnl','SELECT'),
  'SI10 authenticated conserva SELECT sobre v_finance_pnl');

-- ══ 4. Aislamiento REAL con JWT, en ambas direcciones ═══════════════════════
DO $$
DECLARE
  a_biz uuid; a_uid uuid;
  b_biz uuid; b_uid uuid;
  v_ctl bigint; v_seen bigint; v_foreign bigint;
  v_own_pre numeric; v_own_post numeric;
BEGIN
  -- Se descubren dos negocios distintos con usuario real. Nada hardcodeado:
  -- el suite corre igual en local, en staging y en prod.
  SELECT p.business_id, COALESCE(p.user_id,p.id) INTO a_biz, a_uid
    FROM profiles p JOIN v_finance_sales_ledger l ON l.business_id=p.business_id
   WHERE COALESCE(p.user_id,p.id) IS NOT NULL
   GROUP BY p.business_id, COALESCE(p.user_id,p.id) ORDER BY count(*) DESC LIMIT 1;

  SELECT p.business_id, COALESCE(p.user_id,p.id) INTO b_biz, b_uid
    FROM profiles p JOIN v_finance_sales_ledger l ON l.business_id=p.business_id
   WHERE COALESCE(p.user_id,p.id) IS NOT NULL AND p.business_id <> a_biz
   GROUP BY p.business_id, COALESCE(p.user_id,p.id) ORDER BY count(*) DESC LIMIT 1;

  IF a_biz IS NULL OR b_biz IS NULL THEN
    RAISE NOTICE 'SKIP SI11-SI16: hacen falta 2 negocios con datos y usuario. Ejecutar en un entorno con seed multi-tenant.';
    RETURN;
  END IF;

  -- ── A mira ──────────────────────────────────────────────────────────────
  PERFORM pg_temp.as_user(a_uid);

  -- CONTROL: la tabla base DEBE aislar. Si esto falla, el JWT no esta puesto
  -- y el resto del bloque no probaria nada.
  SELECT count(DISTINCT business_id) INTO v_ctl FROM comprobantes;
  PERFORM pg_temp.assert(v_ctl <= 1, 'SI11 CONTROL: con JWT de A, comprobantes aisla ('||v_ctl||' negocios)');

  SELECT count(DISTINCT business_id) INTO v_seen FROM v_finance_pnl;
  PERFORM pg_temp.assert(v_seen <= 1, 'SI12 A->B v_finance_pnl aisla ('||v_seen||' negocios visibles)');

  SELECT count(*) INTO v_foreign FROM v_finance_sales_ledger WHERE business_id = b_biz;
  PERFORM pg_temp.assert(v_foreign = 0, 'SI13 A no ve NINGUNA fila de ledger de B ('||v_foreign||')');

  SELECT count(*) INTO v_foreign FROM v_finance_product_margin WHERE business_id = b_biz;
  PERFORM pg_temp.assert(v_foreign = 0, 'SI14 A no ve margenes de B ('||v_foreign||')');

  -- Agregado, no solo filas crudas: un SUM tambien debe estar limpio.
  SELECT COALESCE(sum(net_sales),0) INTO v_own_pre FROM v_finance_pnl WHERE business_id = b_biz;
  PERFORM pg_temp.assert(v_own_pre = 0, 'SI15 el agregado de B leido por A es 0 (no solo las filas)');

  -- A conserva SUS numeros: el fix no puede cambiar lo que ve el dueño legitimo.
  SELECT count(*) INTO v_seen FROM v_finance_sales_ledger;
  PERFORM pg_temp.assert(v_seen > 0, 'SI16 A sigue viendo su propio ledger ('||v_seen||' filas)');

  -- ── B mira (direccion inversa) ──────────────────────────────────────────
  PERFORM pg_temp.as_user(b_uid);

  SELECT count(DISTINCT business_id) INTO v_ctl FROM comprobantes;
  PERFORM pg_temp.assert(v_ctl <= 1, 'SI17 CONTROL: con JWT de B, comprobantes aisla ('||v_ctl||' negocios)');

  SELECT count(*) INTO v_foreign FROM v_finance_sales_ledger WHERE business_id = a_biz;
  PERFORM pg_temp.assert(v_foreign = 0, 'SI18 B->A B no ve ledger de A ('||v_foreign||')');

  SELECT COALESCE(sum(net_sales),0) INTO v_own_pre FROM v_finance_pnl WHERE business_id = a_biz;
  PERFORM pg_temp.assert(v_own_pre = 0, 'SI19 el agregado de A leido por B es 0');

  -- ── Usuario autenticado SIN negocio ─────────────────────────────────────
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-000000000999'::uuid);
  SELECT count(*) INTO v_seen FROM v_finance_pnl;
  PERFORM pg_temp.assert(v_seen = 0, 'SI20 usuario sin negocio no ve nada ('||v_seen||' filas)');

  PERFORM pg_temp.as_postgres();
END $$;

-- ══ 5. FALSIFICACION ════════════════════════════════════════════════════════
-- Se apaga security_invoker y se exige que el leak vuelva y que el check falle.
-- Todo dentro de la tx: el ROLLBACK final lo deshace.
DO $$
DECLARE
  a_biz uuid; a_uid uuid; b_biz uuid;
  v_seen bigint;
  v_hc jsonb; v_check jsonb;
BEGIN
  SELECT p.business_id, COALESCE(p.user_id,p.id) INTO a_biz, a_uid
    FROM profiles p JOIN v_finance_sales_ledger l ON l.business_id=p.business_id
   WHERE COALESCE(p.user_id,p.id) IS NOT NULL
   GROUP BY p.business_id, COALESCE(p.user_id,p.id) ORDER BY count(*) DESC LIMIT 1;
  SELECT p.business_id INTO b_biz
    FROM profiles p JOIN v_finance_sales_ledger l ON l.business_id=p.business_id
   WHERE p.business_id <> a_biz GROUP BY p.business_id ORDER BY count(*) DESC LIMIT 1;

  -- 5a. El check del Health Check PASA con la configuracion correcta.
  SELECT count(*) INTO v_seen FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('v','m')
     AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     AND (has_table_privilege('anon', c.oid,'SELECT') OR has_table_privilege('authenticated', c.oid,'SELECT'));
  PERFORM pg_temp.assert(v_seen = 0, 'SI21 predicado del check = 0 con la config correcta (pass)');

  -- 5b. Se rompe a proposito. Se apaga v_finance_sales_ledger: es la vista BASE
  -- que lee las tablas con RLS directamente. v_finance_pnl y v_finance_product_
  -- margin la LEEN, y mientras el ledger tenga invoker=true el RLS se sigue
  -- aplicando aunque ellas esten en invoker=false (semantica de vistas anidadas:
  -- el invoker propaga desde el usuario original). Por eso el leak de DATOS solo
  -- reaparece si se apaga el ledger; apagar solo pnl no alcanza.
  ALTER VIEW public.v_finance_sales_ledger SET (security_invoker = false);

  SELECT count(*) INTO v_seen FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('v','m')
     AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     AND (has_table_privilege('anon', c.oid,'SELECT') OR has_table_privilege('authenticated', c.oid,'SELECT'));
  PERFORM pg_temp.assert(v_seen = 1, 'SI22 FALSIFICACION: el predicado detecta la vista rota ('||v_seen||')');

  -- 5c. Y el leak REAPARECE: es la prueba de que el predicado vigila algo real.
  IF b_biz IS NOT NULL THEN
    PERFORM pg_temp.as_user(a_uid);
    SELECT count(*) INTO v_seen FROM v_finance_sales_ledger WHERE business_id = b_biz;
    PERFORM pg_temp.as_postgres();
    PERFORM pg_temp.assert(v_seen > 0,
      'SI23 FALSIFICACION: sin security_invoker, A vuelve a ver filas de B ('||v_seen||')');
  END IF;

  -- 5d. Se restaura y el predicado vuelve a 0 (idempotencia del fix).
  ALTER VIEW public.v_finance_sales_ledger SET (security_invoker = true);
  SELECT count(*) INTO v_seen FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('v','m')
     AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false)
     AND (has_table_privilege('anon', c.oid,'SELECT') OR has_table_privilege('authenticated', c.oid,'SELECT'));
  PERFORM pg_temp.assert(v_seen = 0, 'SI24 reaplicar el fix devuelve el predicado a 0');
END $$;

-- ══ 6. Idempotencia del ALTER ═══════════════════════════════════════════════
-- La migracion puede correr dos veces (reset local, re-push) sin romper.
DO $$
BEGIN
  ALTER VIEW public.v_finance_pnl SET (security_invoker = true);
  ALTER VIEW public.v_finance_pnl SET (security_invoker = true);
  PERFORM pg_temp.assert(
    (SELECT c.reloptions::text[] @> ARRAY['security_invoker=true']
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='v_finance_pnl'),
    'SI25 aplicar el ALTER dos veces es idempotente');
END $$;

-- ══ 7. El Health Check sigue siendo read-only ═══════════════════════════════
-- El motor lo garantiza: STABLE no puede escribir. Si alguien lo volviera
-- VOLATILE para "arreglar" algo, este assert lo caza.
SELECT pg_temp.assert(
  (SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finance_health_check_v2') = 's',
  'SI26 finance_health_check_v2 sigue siendo STABLE (read-only por motor)');

ROLLBACK;
