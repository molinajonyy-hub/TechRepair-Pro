-- SEC-08D - contrato SQL de la VISIBILIDAD DE LOS INSIGHTS FINANCIEROS.
--
-- Prueba las dos superficies con las que se llega al dato:
--   1. la TABLA por PostgREST  (SELECT directo sobre public.finance_insights)
--   2. la RPC public.finance_insights_read (INVOKER: lee bajo la misma RLS)
--
-- y ademas se auto-verifica: al final rompe la policy a proposito -una vez por
-- cada termino- y comprueba que la matriz de arriba HABRIA fallado. Un gate que
-- nunca se vio fallar no es un gate.
--
-- Nota de seguridad del propio test: NUNCA se entra a una funcion SECURITY
-- DEFINER con el rol cambiado dentro de un bloque DO -ese patron crashea el
-- backend en postgres 17.6, el mismo build que produccion-. Por eso el cambio de
-- rol dentro de DO se usa SOLO para tablas y vistas, y las llamadas a
-- finance_insights_read van a nivel psql, guardando el resultado en una temp
-- table que se asevera despues.
--
-- RUN: supabase db reset
--      docker cp tests/sql/sec08d_finance_insights_visibility.test.sql <db>:/tmp/s8d.sql
--      docker exec <db> psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f /tmp/s8d.sql
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN PERFORM set_config('request.jwt.claims','',true);
  ELSE PERFORM set_config('request.jwt.claims',
    json_build_object('sub',p_user_id::text,'role','authenticated')::text,true); END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.read_expr(p_role text, p_actor uuid, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM set_config('role', p_role, true);
  PERFORM pg_temp.act_as(p_actor);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION
    WHEN insufficient_privilege THEN PERFORM set_config('role','none',true); RETURN 'DENIED';
  END;
  PERFORM set_config('role','none',true);
  RETURN COALESCE(v,'NO_ROWS');
END;
$$;

-- Cuenta filas visibles de finance_insights para un actor dado.
CREATE OR REPLACE FUNCTION pg_temp.visible_insights(p_actor uuid, p_biz uuid)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.read_expr('authenticated', p_actor,
    format('SELECT count(*)::text FROM public.finance_insights WHERE business_id=%L', p_biz));
$$;

\set bizA   '00000000-0000-0000-0000-00000008d001'
\set ownA   '00000000-0000-0000-0000-00000008d009'
\set techA  '00000000-0000-0000-0000-00000008d00a'
\set cashA  '00000000-0000-0000-0000-00000008d00b'
\set inacA  '00000000-0000-0000-0000-00000008d00c'
\set bizB   '00000000-0000-0000-0000-00000008d101'
\set ownB   '00000000-0000-0000-0000-00000008d109'
\set bizC   '00000000-0000-0000-0000-00000008d201'
\set ownC   '00000000-0000-0000-0000-00000008d209'

-- ===========================================================================
-- 1. Forma de la policy
-- ===========================================================================
DO $$
DECLARE v_qual text; v_n int; v_roles text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='finance_insights' AND cmd='SELECT';
  PERFORM pg_temp.assert(v_n = 1, 'existe exactamente una policy SELECT en finance_insights');

  SELECT qual, roles::text INTO v_qual, v_roles FROM pg_policies
   WHERE schemaname='public' AND tablename='finance_insights' AND cmd='SELECT';

  PERFORM pg_temp.assert(v_roles = '{authenticated}', 'la policy aplica solo a authenticated');
  PERFORM pg_temp.assert(v_qual LIKE '%current_user_business_id()%',
    'la policy scopea por tenant con el helper que filtra is_active');
  -- `current_business_id` no es substring de `current_user_business_id`.
  PERFORM pg_temp.assert(v_qual NOT LIKE '%current_business_id()%',
    'la policy NO usa el helper sin filtro is_active');
  PERFORM pg_temp.assert(v_qual LIKE '%current_user_can_in_business%' AND v_qual LIKE '%''finance''%',
    'la policy exige la capability `finance` resuelta en el negocio de la fila');
  PERFORM pg_temp.assert(v_qual LIKE '%business_has_feature%' AND v_qual LIKE '%''advancedFinance''%',
    'la policy exige el feature de plan `advancedFinance`');

  -- Simetria con la escritura.
  PERFORM pg_temp.assert(
    pg_get_functiondef('public.generate_finance_insights(uuid,date,date)'::regprocedure)
      LIKE '%advancedFinance%',
    'la escritura ya exigia advancedFinance: lectura y escritura quedan simetricas');

  -- La RPC de lectura tiene que seguir siendo INVOKER para heredar la RLS.
  PERFORM pg_temp.assert(
    NOT (SELECT prosecdef FROM pg_proc
          WHERE oid='public.finance_insights_read(uuid,date,date,text,integer)'::regprocedure),
    'finance_insights_read sigue siendo INVOKER (hereda la policy)');

  PERFORM pg_temp.assert(
    NOT has_table_privilege('anon','public.finance_insights','SELECT'),
    'anon sigue sin SELECT sobre finance_insights');
  PERFORM pg_temp.assert(
    has_table_privilege('authenticated','public.finance_insights','SELECT'),
    'authenticated conserva el GRANT (el lote no es un apagon)');
END $$;

-- ===========================================================================
-- 2. Fixture
-- ===========================================================================
--   bizA  pro/active   -> ownA (owner), cashA (cashier: finance=true por rol),
--                         techA (tech: finance=false), inacA (admin DESACTIVADO)
--   bizB  pro/active   -> ownB                     (cross-tenant)
--   bizC  basico/active-> ownC (owner: finance=true, pero SIN advancedFinance)
--   bizD  pro/active   -> ownD, OWNER con el perfil DESACTIVADO.
--
-- Sobre bizD: es el unico actor que AISLA la dimension is_active. A un `admin`
-- desactivado lo frenan DOS terminos a la vez (el helper de tenant y tambien
-- current_user_can_in_business, que filtra is_active en su lookup de perfil),
-- asi que no sirve para probar cual de los dos manda. Un OWNER desactivado si:
-- current_user_can_in_business corta por `businesses.owner_user_id` ANTES de
-- mirar el perfil, con lo cual pasa la capability y lo unico que puede frenarlo
-- es el helper de tenant.
DO $$
BEGIN
  SET LOCAL session_replication_role = replica;

  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    ('00000000-0000-0000-0000-00000008d009','owna@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d00a','tech@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d00b','cash@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d00c','inac@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d109','ownb@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d209','ownc@sec08d.invalid',now()),
    ('00000000-0000-0000-0000-00000008d309','ownd@sec08d.invalid',now());

  INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
    ('00000000-0000-0000-0000-00000008d001','B-08D-A','00000000-0000-0000-0000-00000008d009','pro','active'),
    ('00000000-0000-0000-0000-00000008d101','B-08D-B','00000000-0000-0000-0000-00000008d109','pro','active'),
    -- plan basico: tiene `finance` (es owner) pero NO `advancedFinance`.
    ('00000000-0000-0000-0000-00000008d201','B-08D-C','00000000-0000-0000-0000-00000008d209','basico','active'),
    ('00000000-0000-0000-0000-00000008d301','B-08D-D','00000000-0000-0000-0000-00000008d309','pro','active');

  INSERT INTO public.profiles(id,business_id,role,is_active,email) VALUES
    ('00000000-0000-0000-0000-00000008d009','00000000-0000-0000-0000-00000008d001','owner',  true, 'owna@sec08d.invalid'),
    ('00000000-0000-0000-0000-00000008d00a','00000000-0000-0000-0000-00000008d001','tech',   true, 'tech@sec08d.invalid'),
    ('00000000-0000-0000-0000-00000008d00b','00000000-0000-0000-0000-00000008d001','cashier',true, 'cash@sec08d.invalid'),
    -- admin (finance=true por rol) pero DESACTIVADO: aisla la dimension is_active.
    ('00000000-0000-0000-0000-00000008d00c','00000000-0000-0000-0000-00000008d001','admin',  false,'inac@sec08d.invalid'),
    ('00000000-0000-0000-0000-00000008d109','00000000-0000-0000-0000-00000008d101','owner',  true, 'ownb@sec08d.invalid'),
    ('00000000-0000-0000-0000-00000008d209','00000000-0000-0000-0000-00000008d201','owner',  true, 'ownc@sec08d.invalid'),
    -- OWNER con el perfil desactivado: pasa la capability, no pasa el tenant.
    ('00000000-0000-0000-0000-00000008d309','00000000-0000-0000-0000-00000008d301','owner',  false,'ownd@sec08d.invalid');

  -- Insight REAL en bizA y en bizC. Sin datos sembrados, un "0 filas" no
  -- distingue "cerrado" de "vacio".
  INSERT INTO public.finance_insights(
      business_id,rule_id,rule_version,period_start,period_end,severity,
      title,message,evidence,action,status,impact_ars,fingerprint)
  VALUES
    ('00000000-0000-0000-0000-00000008d001','dead_stock','v1','2026-08-01','2026-08-31','warning',
     'Capital inmovilizado','Hay stock sin movimiento',
     jsonb_build_object('metric','dead_stock_share','threshold',jsonb_build_object('days',90),
       'source','inventory','calculation_version','v1','currency','ARS',
       'period_start','2026-08-01','period_end','2026-08-31','dead_value',11903078),
     jsonb_build_object('label','Ver inventario','target_type','route','target','/inventory'),
     'active', 11903078, 'sec08d-fp-bizA'),
    ('00000000-0000-0000-0000-00000008d201','dead_stock','v1','2026-08-01','2026-08-31','warning',
     'Capital inmovilizado','Hay stock sin movimiento',
     jsonb_build_object('metric','dead_stock_share','threshold',jsonb_build_object('days',90),
       'source','inventory','calculation_version','v1','currency','ARS',
       'period_start','2026-08-01','period_end','2026-08-31','dead_value',777777),
     jsonb_build_object('label','Ver inventario','target_type','route','target','/inventory'),
     'active', 777777, 'sec08d-fp-bizC'),
    ('00000000-0000-0000-0000-00000008d301','dead_stock','v1','2026-08-01','2026-08-31','warning',
     'Capital inmovilizado','Hay stock sin movimiento',
     jsonb_build_object('metric','dead_stock_share','threshold',jsonb_build_object('days',90),
       'source','inventory','calculation_version','v1','currency','ARS',
       'period_start','2026-08-01','period_end','2026-08-31','dead_value',424242),
     jsonb_build_object('label','Ver inventario','target_type','route','target','/inventory'),
     'active', 424242, 'sec08d-fp-bizD');

  SET LOCAL session_replication_role = origin;
END $$;

-- ===========================================================================
-- 3. Matriz de lectura DIRECTA sobre la tabla (PostgREST)
-- ===========================================================================
DO $$
DECLARE v text;
BEGIN
  -- POSITIVO (caso 5). Va PRIMERO: sin el, ningun "0" de abajo prueba nada.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d009',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '1',
    format('POSITIVO ownA (finance + advancedFinance + activo) VE su insight (llego %s)', v));

  v := pg_temp.read_expr('authenticated','00000000-0000-0000-0000-00000008d009',
    'SELECT impact_ars::text FROM public.finance_insights WHERE fingerprint=''sec08d-fp-bizA''');
  PERFORM pg_temp.assert(v::numeric = 11903078,
    format('POSITIVO ownA recibe el impact_ars REAL (llego %s)', v));

  -- El cashier tambien: `finance` es suya por rol. Perderla habria sido una
  -- regresion de operacion legitima, no seguridad.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00b',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '1', format('POSITIVO cashA (finance por rol) conserva la lectura (llego %s)', v));

  -- NEGATIVO 1: tech del MISMO negocio, activo, sin `finance`.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00a',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0',
    format('NEG1 techA (activo, finance=false) NO ve insights (llego %s)', v));

  -- ...y tampoco por proyeccion directa del importe.
  v := pg_temp.read_expr('authenticated','00000000-0000-0000-0000-00000008d00a',
    'SELECT COALESCE(impact_ars::text,''IS_NULL'') FROM public.finance_insights WHERE fingerprint=''sec08d-fp-bizA''');
  PERFORM pg_temp.assert(v = 'NO_ROWS',
    format('NEG1 techA no alcanza impact_ars ni por fingerprint (llego %s)', v));

  -- NEGATIVO 2: perfil del mismo negocio DESACTIVADO, con rol admin
  -- (finance=true por rol). Lo unico que lo separa del positivo es is_active.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00c',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0',
    format('NEG2a admin DESACTIVADO no ve insights (llego %s)', v));

  -- NEGATIVO 2b: OWNER con el perfil desactivado. Este SI aisla la dimension:
  -- la capability lo deja pasar (corta por owner_user_id), asi que el unico que
  -- puede frenarlo es current_user_business_id().
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d309',
                                '00000000-0000-0000-0000-00000008d301');
  PERFORM pg_temp.assert(v = '0',
    format('NEG2b OWNER DESACTIVADO no ve insights (llego %s)', v));

  -- NEGATIVO 3: autoridad financiera SI (es owner) pero el plan no da
  -- advancedFinance.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d209',
                                '00000000-0000-0000-0000-00000008d201');
  PERFORM pg_temp.assert(v = '0',
    format('NEG3 ownC (owner, plan basico) no ve insights: falta advancedFinance (llego %s)', v));

  -- NEGATIVO 4: cross-tenant.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d109',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0',
    format('NEG4 ownB no ve los insights de bizA (llego %s)', v));

  -- anon, sobre la tabla, es un 42501 limpio: le falta el GRANT, ni siquiera
  -- llega a evaluarse la RLS. (`visible_insights` fija el rol `authenticated`,
  -- asi que aca se llama a read_expr con el rol `anon` explicito.)
  v := pg_temp.read_expr('anon', NULL,
    format('SELECT count(*)::text FROM public.finance_insights WHERE business_id=%L',
           '00000000-0000-0000-0000-00000008d001'));
  PERFORM pg_temp.assert(v = 'DENIED', format('anon recibe DENIED sobre la tabla (llego %s)', v));

  -- Y un `authenticated` SIN JWT si tiene el GRANT, pero la RLS no le da
  -- ninguna fila: la frontera son dos capas distintas y las dos sostienen.
  v := pg_temp.visible_insights(NULL, '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0',
    format('authenticated sin JWT pasa el GRANT pero la RLS lo deja en cero (llego %s)', v));
END $$;

-- ===========================================================================
-- 4. La misma matriz a traves de finance_insights_read
--    (a nivel psql: nunca se llama una funcion con el rol cambiado dentro de DO)
-- ===========================================================================
CREATE TEMP TABLE s8d_out(tag text primary key, j jsonb);
-- El INSERT ocurre con el rol ya cambiado a `authenticated`, asi que la temp
-- table necesita el grant o el probe muere por permisos y no por la policy.
GRANT ALL ON s8d_out TO PUBLIC;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-00000008d009','role','authenticated')::text, true);
INSERT INTO s8d_out VALUES ('rpc_ownA',
  public.finance_insights_read('00000000-0000-0000-0000-00000008d001','2026-08-01','2026-08-31','active',20));
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-00000008d00a','role','authenticated')::text, true);
INSERT INTO s8d_out VALUES ('rpc_techA',
  public.finance_insights_read('00000000-0000-0000-0000-00000008d001','2026-08-01','2026-08-31','active',20));
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-00000008d00c','role','authenticated')::text, true);
INSERT INTO s8d_out VALUES ('rpc_inacA',
  public.finance_insights_read('00000000-0000-0000-0000-00000008d001','2026-08-01','2026-08-31','active',20));
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-00000008d209','role','authenticated')::text, true);
INSERT INTO s8d_out VALUES ('rpc_ownC',
  public.finance_insights_read('00000000-0000-0000-0000-00000008d201','2026-08-01','2026-08-31','active',20));
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub','00000000-0000-0000-0000-00000008d109','role','authenticated')::text, true);
INSERT INTO s8d_out VALUES ('rpc_ownB_of_A',
  public.finance_insights_read('00000000-0000-0000-0000-00000008d001','2026-08-01','2026-08-31','active',20));
RESET ROLE;

SELECT set_config('request.jwt.claims','',true);

DO $$
DECLARE j jsonb;
BEGIN
  SELECT s.j INTO j FROM s8d_out s WHERE tag='rpc_ownA';
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') = 1,
    'POSITIVO RPC ownA recibe su insight');
  PERFORM pg_temp.assert((j->'insights'->0->>'impact_ars')::numeric = 11903078,
    'POSITIVO RPC ownA recibe el impact_ars REAL');

  SELECT s.j INTO j FROM s8d_out s WHERE tag='rpc_techA';
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') = 0,
    'NEG1 RPC techA no recibe ningun insight');

  SELECT s.j INTO j FROM s8d_out s WHERE tag='rpc_inacA';
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') = 0,
    'NEG2 RPC admin desactivado no recibe ningun insight');

  SELECT s.j INTO j FROM s8d_out s WHERE tag='rpc_ownC';
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') = 0,
    'NEG3 RPC ownC sin advancedFinance no recibe ningun insight');

  SELECT s.j INTO j FROM s8d_out s WHERE tag='rpc_ownB_of_A';
  PERFORM pg_temp.assert(jsonb_array_length(j->'insights') = 0,
    'NEG4 RPC cross-tenant no recibe ningun insight');
END $$;

-- ===========================================================================
-- 5. CONTROLES NEGATIVOS - se rompe la policy a proposito, un termino por vez
--
-- Sin esto la seccion 3 podria estar pasando por el motivo equivocado (por
-- ejemplo: que el fixture no tenga filas). Cada control demuestra que, si ese
-- termino desaparece, el caso correspondiente HABRIA fallado.
--
-- Todo vive dentro de la transaccion y el archivo termina en ROLLBACK, asi que
-- el esquema no queda debilitado ni aunque un assert aborte a mitad de camino.
-- ===========================================================================
DO $$
DECLARE v text;
BEGIN
  -- -- NC-A: se quita la capability `finance` ---------------------------------
  DROP POLICY finance_insights_select ON public.finance_insights;
  CREATE POLICY finance_insights_select ON public.finance_insights
    FOR SELECT TO authenticated
    USING (business_id = current_user_business_id() AND business_has_feature('advancedFinance'));

  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00a',
                                '00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '1',
    format('NC-A sin el termino `finance`, techA SI veria el insight => NEG1 tiene dientes (llego %s)', v));

  -- -- NC-B: se vuelve al helper sin filtro is_active -------------------------
  -- Se deja fuera el termino de plan a proposito. `business_has_feature()`
  -- tambien resuelve por current_user_business_id(), asi que dejarlo puesto
  -- taparia el efecto que este control quiere aislar.
  --
  -- (Y NO sirve reemplazarlo por un EXISTS sobre `businesses`: esa subconsulta
  -- corre bajo la RLS de businesses -businesses_select exige
  -- id = current_user_business_id()-, con lo cual seria is_active-sensible por
  -- una via distinta y el control volveria a estar confundido. Justamente por
  -- eso el termino de plan en la policy canonica va con el helper SECDEF.)
  DROP POLICY finance_insights_select ON public.finance_insights;
  CREATE POLICY finance_insights_select ON public.finance_insights
    FOR SELECT TO authenticated
    USING (
      business_id = current_business_id()
      AND current_user_can_in_business(business_id, 'finance')
    );

  -- Actor: el OWNER desactivado de bizD (ver nota del fixture). Con el admin
  -- desactivado este control no probaria nada, porque lo frena tambien la
  -- capability.
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d309',
                                '00000000-0000-0000-0000-00000008d301');
  PERFORM pg_temp.assert(v = '1',
    format('NC-B con current_business_id(), el OWNER DESACTIVADO SI veria el insight => NEG2b tiene dientes (llego %s)', v));

  -- Control del control: se cambia UNA sola cosa -el helper de tenant- y el
  -- mismo actor vuelve a quedar afuera. Eso prueba que la diferencia la hace
  -- current_user_business_id() y no otra parte de la expresion.
  DROP POLICY finance_insights_select ON public.finance_insights;
  CREATE POLICY finance_insights_select ON public.finance_insights
    FOR SELECT TO authenticated
    USING (
      business_id = current_user_business_id()
      AND current_user_can_in_business(business_id, 'finance')
    );
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d309',
                                '00000000-0000-0000-0000-00000008d301');
  PERFORM pg_temp.assert(v = '0',
    format('NC-B (control del control) el helper con is_active basta por si solo (llego %s)', v));

  -- -- NC-C: se quita el feature de plan --------------------------------------
  DROP POLICY finance_insights_select ON public.finance_insights;
  CREATE POLICY finance_insights_select ON public.finance_insights
    FOR SELECT TO authenticated
    USING (business_id = current_user_business_id()
           AND current_user_can_in_business(business_id, 'finance'));

  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d209',
                                '00000000-0000-0000-0000-00000008d201');
  PERFORM pg_temp.assert(v = '1',
    format('NC-C sin `advancedFinance`, ownC del plan basico SI veria el insight => NEG3 tiene dientes (llego %s)', v));

  -- -- Restauracion de la policy canonica -------------------------------------
  DROP POLICY finance_insights_select ON public.finance_insights;
  CREATE POLICY finance_insights_select ON public.finance_insights
    FOR SELECT TO authenticated
    USING (
      business_id = current_user_business_id()
      AND current_user_can_in_business(business_id, 'finance')
      AND business_has_feature('advancedFinance')
    );
  RAISE NOTICE 'PASS: los tres controles negativos fallaron como debian; policy restaurada';
END $$;

-- ===========================================================================
-- 6. Con la policy canonica de vuelta, la matriz sigue valiendo
-- ===========================================================================
DO $$
DECLARE v text;
BEGIN
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d009','00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '1', 'post-restauracion: ownA sigue viendo su insight');
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00a','00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0', 'post-restauracion: techA sigue sin ver');
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d00c','00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0', 'post-restauracion: el admin desactivado sigue sin ver');
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d309','00000000-0000-0000-0000-00000008d301');
  PERFORM pg_temp.assert(v = '0', 'post-restauracion: el owner desactivado sigue sin ver');
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d209','00000000-0000-0000-0000-00000008d201');
  PERFORM pg_temp.assert(v = '0', 'post-restauracion: ownC sigue sin ver');
  v := pg_temp.visible_insights('00000000-0000-0000-0000-00000008d109','00000000-0000-0000-0000-00000008d001');
  PERFORM pg_temp.assert(v = '0', 'post-restauracion: cross-tenant sigue cerrado');
END $$;

DO $$ BEGIN RAISE NOTICE '--- SEC-08D SUITE COMPLETA ---'; END $$;

-- Todo el fixture y los controles negativos viven dentro de la transaccion.
ROLLBACK;
