-- ============================================================================
-- LOCAL ONLY · BETA-UX-1B — abrir y cerrar la caja exige la capacidad `finance`.
--
--   npm run test:sql:beta-ux-1b
--
-- El POS ahora ofrece «Abrir caja» a quien tiene `finance` (`canUseCaja`). Eso es
-- UX: la autoridad tiene que estar en el servidor. Este test la mide sobre
-- PostgreSQL real, con el rol `authenticated` y un JWT por actor, contra las
-- funciones PÚBLICAS tal como las deja el historial de migraciones.
--
-- Qué fija:
--   1. Estructura: wrapper SECURITY DEFINER con search_path endurecido, gate
--      `require_action_authority(p_business_id, 'finance', …)`, sin EXECUTE para
--      `anon`, y la implementación privada no ejecutable desde el navegador.
--   2. Matriz por rol y override: la RPC decide EXACTAMENTE lo que decide
--      `current_user_can('finance')`, y esa capacidad es la tabla del producto
--      (owner, admin, cashier · override true la da · override false la quita).
--   3. Denegado = 42501 `FORBIDDEN` y CERO efectos, también si el actor miente en
--      `p_user_id`, está inactivo, no tiene perfil o apunta a otro negocio.
--   4. Permitido = la caja queda abierta con los saldos enviados, y el contrato
--      del que depende el cliente: segunda apertura → «Ya hay una caja abierta»,
--      misma key → replay, misma key con otros montos → IDEMPOTENCY_CONFLICT.
--   5. Control negativo: sin el gate, un `sales` SÍ abre la caja. O sea: lo que
--      lo frena es el gate, no otra cosa — y este test puede fallar.
--
-- Transaccional: todo termina en ROLLBACK. No deja nada en la base.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE ids (name text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid());
INSERT INTO ids(name) VALUES
 ('A'),('B'),
 ('owner'),('admin'),('manager'),('tech'),('sales'),('cashier'),('viewer'),
 ('tech_true'),('sales_true'),('admin_false'),('cashier_false'),
 ('ownerB'),('inactive'),('no_profile');
GRANT SELECT ON ids TO anon, authenticated, service_role;

CREATE FUNCTION pg_temp.id(n text) RETURNS uuid LANGUAGE sql AS
$$ SELECT id FROM pg_temp.ids WHERE name=n $$;

CREATE FUNCTION pg_temp.check_true(cond boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
END $$;

-- Huella de todo lo que una apertura/cierre podría tocar — y de lo que NO debe.
CREATE FUNCTION pg_temp.fingerprint() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t text; f text; result jsonb := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cajas','cash_session_requests','financial_movements','business_finance_entries',
    'comprobantes','comprobante_payments'
  ] LOOP
    EXECUTE format(
      'SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,''[]'')) FROM public.%I r', t
    ) INTO f;
    result := result || jsonb_build_object(t,f);
  END LOOP;
  RETURN result;
END $$;

-- Ejecuta `query` como el rol de base `dbrole` con el JWT del actor. Un error
-- vuelve como {sqlstate,message} para poder aseverarlo.
CREATE FUNCTION pg_temp.call_as(actor text, dbrole text, query text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; uid uuid;
BEGIN
  uid := CASE WHEN actor IS NULL THEN NULL ELSE pg_temp.id(actor) END;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role',dbrole)::text,true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(uid::text,''),true);
  EXECUTE format('SET LOCAL ROLE %I',dbrole);
  BEGIN
    EXECUTE query INTO result;
  EXCEPTION WHEN OTHERS THEN
    result := jsonb_build_object('sqlstate',SQLSTATE,'message',SQLERRM);
  END;
  RESET ROLE;
  RETURN result;
END $$;

CREATE FUNCTION pg_temp.is_forbidden(result jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(result->>'sqlstate' = '42501' AND result->>'message' = 'FORBIDDEN', false)
$$;

CREATE FUNCTION pg_temp.open_sql(actor text, key text, efectivo numeric DEFAULT 100) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.open_cash_session_atomic(%L,%L,%s,20,30,5,1450,%L)',
                pg_temp.id('A'), pg_temp.id(actor), efectivo, key)
$$;

CREATE FUNCTION pg_temp.close_sql(actor text, caja uuid, key text) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.close_cash_session_atomic(%L,%L,%L,NULL,NULL,NULL,NULL,NULL,NULL,%L)',
                pg_temp.id('A'), pg_temp.id(actor), caja, key)
$$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users(id,email,email_confirmed_at)
  SELECT id, name||'@betaux1b.invalid', now() FROM ids
   WHERE name NOT IN ('A','B');
INSERT INTO public.businesses(id,name,owner_user_id,subscription_plan,subscription_status) VALUES
 (pg_temp.id('A'),'Synthetic BETA-UX-1B A',pg_temp.id('owner'),'full','active'),
 (pg_temp.id('B'),'Synthetic BETA-UX-1B B',pg_temp.id('ownerB'),'full','active');
INSERT INTO public.profiles(id,user_id,business_id,role,is_active,email)
 SELECT id, id,
   pg_temp.id(CASE WHEN name='ownerB' THEN 'B' ELSE 'A' END),
   CASE name
     WHEN 'ownerB' THEN 'owner' WHEN 'inactive' THEN 'admin'
     WHEN 'tech_true' THEN 'tech' WHEN 'sales_true' THEN 'sales'
     WHEN 'admin_false' THEN 'admin' WHEN 'cashier_false' THEN 'cashier'
     ELSE name END,
   name <> 'inactive', name||'@betaux1b.invalid'
  FROM ids WHERE name NOT IN ('A','B','no_profile');
UPDATE public.profiles SET permissions = '{"finance":true}'
 WHERE id IN (pg_temp.id('tech_true'), pg_temp.id('sales_true'));
UPDATE public.profiles SET permissions = '{"finance":false}'
 WHERE id IN (pg_temp.id('admin_false'), pg_temp.id('cashier_false'));
SET LOCAL session_replication_role = origin;

-- ── 1. Estructura ───────────────────────────────────────────────────────────
DO $$
DECLARE fn text; p record;
BEGIN
  FOREACH fn IN ARRAY ARRAY['open_cash_session_atomic','close_cash_session_atomic'] LOOP
    PERFORM pg_temp.check_true(
      (SELECT count(*) = 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid=pr.pronamespace
        WHERE n.nspname='public' AND pr.proname=fn),
      fn||': una sola función pública (sin sobrecargas que esquiven el gate)');
    SELECT pr.* INTO p FROM pg_proc pr JOIN pg_namespace n ON n.oid=pr.pronamespace
     WHERE n.nspname='public' AND pr.proname=fn;
    PERFORM pg_temp.check_true(p.prosecdef, fn||' es SECURITY DEFINER');
    PERFORM pg_temp.check_true(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], fn||' search_path endurecido');
    PERFORM pg_temp.check_true(
      position('private.require_action_authority(p_business_id, ''finance''' in p.prosrc) > 0,
      fn||' exige finance antes de delegar');
    PERFORM pg_temp.check_true(
      position('require_action_authority' in p.prosrc) < position('RETURN private.'||fn in p.prosrc),
      fn||': el gate va ANTES de la implementación');
    PERFORM pg_temp.check_true(NOT has_function_privilege('anon', p.oid, 'EXECUTE'), fn||' sin EXECUTE para anon');
    PERFORM pg_temp.check_true(has_function_privilege('authenticated', p.oid, 'EXECUTE'), fn||' con EXECUTE para authenticated');
    PERFORM pg_temp.check_true(EXISTS(
      SELECT 1 FROM pg_proc q JOIN pg_namespace n2 ON n2.oid=q.pronamespace
       WHERE n2.nspname='private' AND q.proname=fn
         AND NOT has_function_privilege('anon', q.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', q.oid, 'EXECUTE')
         AND NOT has_function_privilege('service_role', q.oid, 'EXECUTE')
    ), fn||': la implementación privada no es ejecutable desde afuera');
  END LOOP;
END $$;

-- ── 2, 3 y 4. Matriz por actor ──────────────────────────────────────────────
DO $$
DECLARE
  actor text; r jsonb; puede boolean; huella jsonb; v_caja uuid; n int := 0;
  actores text[] := ARRAY['owner','admin','manager','tech','sales','cashier','viewer',
                          'tech_true','sales_true','admin_false','cashier_false'];
  -- La tabla del PRODUCTO, escrita a mano: es lo que `canUseCaja` promete.
  con_finance text[] := ARRAY['owner','admin','cashier','tech_true','sales_true'];
BEGIN
  FOREACH actor IN ARRAY actores LOOP
    puede := (pg_temp.call_as(actor,'authenticated',
      'SELECT to_jsonb(public.current_user_can(''finance''))') #>> '{}') = 'true';
    PERFORM pg_temp.check_true(puede = (actor = ANY(con_finance)),
      'capacidad finance de '||actor||' = '||(actor = ANY(con_finance)));
    n := n + 1;

    -- Cada actor corre en una subtransacción que SIEMPRE se deshace: la matriz
    -- no acumula cajas y un caso no contamina al siguiente.
    BEGIN
      huella := pg_temp.fingerprint();
      r := pg_temp.call_as(actor,'authenticated', pg_temp.open_sql(actor, 'bux1b-open-'||actor));

      IF puede THEN
        PERFORM pg_temp.check_true((r->>'ok')::boolean AND r->>'replay' = 'false',
          actor||' abre la caja: '||r::text);
        v_caja := (r->>'caja_id')::uuid;
        PERFORM pg_temp.check_true(EXISTS(
          SELECT 1 FROM public.cajas c
           WHERE c.id = v_caja AND c.business_id = pg_temp.id('A') AND c.status = 'abierta'
             AND c.efectivo_inicial = 100 AND c.transferencia_inicial = 20
             AND c.tarjeta_inicial = 30 AND c.usd_inicial = 5
             AND c.usd_cotizacion_apertura = 1450 AND c.opened_by = pg_temp.id(actor)
        ), actor||': la caja quedó abierta con los saldos y la cotización enviados');
        PERFORM pg_temp.check_true(
          (SELECT count(*) = 1 FROM public.cajas WHERE business_id = pg_temp.id('A') AND status = 'abierta'),
          actor||': exactamente una caja abierta');
        -- Abrir caja no es un cobro: no mueve tesorería ni clasifica nada.
        PERFORM pg_temp.check_true(
          (huella - 'cajas' - 'cash_session_requests') = (pg_temp.fingerprint() - 'cajas' - 'cash_session_requests'),
          actor||': abrir caja no crea movimientos, BFE ni comprobantes');

        -- Contrato de la carrera, del que depende el POS.
        r := pg_temp.call_as(actor,'authenticated', pg_temp.open_sql(actor, 'bux1b-open2-'||actor, 999));
        PERFORM pg_temp.check_true(r->>'ok' = 'false' AND r->>'error' = 'Ya hay una caja abierta',
          actor||': segunda apertura → «Ya hay una caja abierta»: '||r::text);
        PERFORM pg_temp.check_true(
          (SELECT count(*) = 1 FROM public.cajas WHERE business_id = pg_temp.id('A') AND status = 'abierta')
          AND NOT EXISTS(SELECT 1 FROM public.cajas WHERE business_id = pg_temp.id('A') AND efectivo_inicial = 999),
          actor||': la segunda apertura no abrió otra caja ni pisó los saldos');

        -- Idempotencia.
        r := pg_temp.call_as(actor,'authenticated', pg_temp.open_sql(actor, 'bux1b-open-'||actor));
        PERFORM pg_temp.check_true((r->>'ok')::boolean AND (r->>'replay')::boolean AND (r->>'caja_id')::uuid = v_caja,
          actor||': misma key y mismos montos → replay de la misma caja: '||r::text);
        r := pg_temp.call_as(actor,'authenticated', pg_temp.open_sql(actor, 'bux1b-open-'||actor, 555));
        PERFORM pg_temp.check_true(r->>'error' = 'IDEMPOTENCY_CONFLICT',
          actor||': misma key con otros montos → IDEMPOTENCY_CONFLICT: '||r::text);

        -- Quien puede abrir también puede cerrar.
        r := pg_temp.call_as(actor,'authenticated', pg_temp.close_sql(actor, v_caja, 'bux1b-close-'||actor));
        PERFORM pg_temp.check_true((r->>'ok')::boolean
          AND (SELECT status = 'cerrada' FROM public.cajas WHERE id = v_caja),
          actor||' cierra la caja: '||r::text);
        n := n + 8;
      ELSE
        PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), actor||' NO abre la caja (42501 FORBIDDEN): '||r::text);
        PERFORM pg_temp.check_true(huella = pg_temp.fingerprint(), actor||': apertura denegada, CERO efectos');

        -- Mentir en `p_user_id` no ayuda: la autoridad sale del JWT.
        r := pg_temp.call_as(actor,'authenticated', pg_temp.open_sql('owner', 'bux1b-spoof-'||actor));
        PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), actor||' con p_user_id del owner: sigue denegado: '||r::text);
        PERFORM pg_temp.check_true(huella = pg_temp.fingerprint(), actor||': apertura con identidad ajena, CERO efectos');

        -- Cerrar tampoco. La caja a cerrar la abre el owner por el camino
        -- canónico (la misma RPC): el fixture no escribe en `cajas` a mano.
        r := pg_temp.call_as('owner','authenticated', pg_temp.open_sql('owner', 'bux1b-seed-'||actor));
        PERFORM pg_temp.check_true((r->>'ok')::boolean, 'fixture: el owner abre la caja que '||actor||' va a intentar cerrar: '||r::text);
        v_caja := (r->>'caja_id')::uuid;
        huella := pg_temp.fingerprint();
        r := pg_temp.call_as(actor,'authenticated', pg_temp.close_sql(actor, v_caja, 'bux1b-close-'||actor));
        PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), actor||' NO cierra la caja (42501 FORBIDDEN): '||r::text);
        PERFORM pg_temp.check_true(huella = pg_temp.fingerprint()
          AND (SELECT status = 'abierta' FROM public.cajas WHERE id = v_caja),
          actor||': cierre denegado, la caja sigue abierta y CERO efectos');
        n := n + 7;
      END IF;

      RAISE EXCEPTION USING ERRCODE = 'BUX1B', MESSAGE = 'rollback del caso';
    EXCEPTION WHEN SQLSTATE 'BUX1B' THEN NULL;
    END;
  END LOOP;

  -- La matriz no dejó nada: cada caso se deshizo.
  PERFORM pg_temp.check_true(
    NOT EXISTS(SELECT 1 FROM public.cajas WHERE business_id IN (pg_temp.id('A'), pg_temp.id('B'))),
    'la matriz no dejó cajas');
  RAISE NOTICE 'BETA-UX-1B · matriz por actor: % aserciones OK', n + 1;
END $$;

-- ── 3 (resto). Actores que nunca pasan ──────────────────────────────────────
DO $$
DECLARE huella jsonb; r jsonb;
BEGIN
  huella := pg_temp.fingerprint();

  r := pg_temp.call_as('inactive','authenticated', pg_temp.open_sql('inactive','bux1b-inactive'));
  PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), 'perfil inactivo (aunque sea admin): denegado: '||r::text);

  r := pg_temp.call_as('no_profile','authenticated', pg_temp.open_sql('no_profile','bux1b-noprofile'));
  PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), 'usuario sin perfil: denegado: '||r::text);

  -- Dueño de OTRO negocio pidiendo abrir la caja de A.
  r := pg_temp.call_as('ownerB','authenticated', pg_temp.open_sql('ownerB','bux1b-foreign'));
  PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), 'dueño de otro negocio: denegado: '||r::text);

  -- Dueño de A pidiendo abrir la caja de B.
  r := pg_temp.call_as('owner','authenticated', format(
    'SELECT public.open_cash_session_atomic(%L,%L,1,0,0,0,1,%L)', pg_temp.id('B'), pg_temp.id('owner'), 'bux1b-cross'));
  PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), 'owner de A sobre el negocio B: denegado: '||r::text);

  -- Sin sesión: `anon` ni siquiera tiene EXECUTE.
  r := pg_temp.call_as(NULL,'anon', pg_temp.open_sql('owner','bux1b-anon'));
  PERFORM pg_temp.check_true(r->>'sqlstate' = '42501', 'anon: sin permiso de ejecución: '||r::text);

  PERFORM pg_temp.check_true(huella = pg_temp.fingerprint(), 'ninguna de las denegaciones tuvo efectos');
END $$;

-- ── 5. Control negativo: sin el gate, `sales` abre la caja ──────────────────
-- Se reemplaza el wrapper público por uno que delega sin autorizar — la forma
-- que tenía la RPC antes de Lote 3 — y se deshace con el SAVEPOINT. Si este
-- bloque NO lograra abrir la caja, las denegaciones de arriba no probarían nada.
SAVEPOINT sin_gate;
CREATE OR REPLACE FUNCTION public.open_cash_session_atomic(
  p_business_id uuid, p_user_id uuid, p_efectivo numeric, p_transferencia numeric,
  p_tarjeta numeric, p_usd numeric, p_usd_rate numeric DEFAULT NULL::numeric,
  p_idempotency_key text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $sin_gate$
BEGIN
  RETURN private.open_cash_session_atomic(p_business_id,p_user_id,p_efectivo,p_transferencia,p_tarjeta,p_usd,p_usd_rate,p_idempotency_key);
END;
$sin_gate$;
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('sales','authenticated', pg_temp.open_sql('sales','bux1b-control'));
  IF NOT COALESCE((r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'control negativo: sin el gate, sales debería poder abrir la caja: %', r;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.cajas WHERE business_id = pg_temp.id('A') AND status = 'abierta') THEN
    RAISE EXCEPTION 'control negativo: la apertura sin gate no dejó una caja abierta';
  END IF;
END $$;
ROLLBACK TO SAVEPOINT sin_gate;

-- Con el wrapper real repuesto, `sales` vuelve a estar afuera.
DO $$
DECLARE r jsonb;
BEGIN
  r := pg_temp.call_as('sales','authenticated', pg_temp.open_sql('sales','bux1b-control-2'));
  PERFORM pg_temp.check_true(pg_temp.is_forbidden(r), 'tras el control negativo el gate vuelve a denegar a sales: '||r::text);
  PERFORM pg_temp.check_true(
    NOT EXISTS(SELECT 1 FROM public.cajas WHERE business_id = pg_temp.id('A')),
    'el control negativo no dejó cajas');
END $$;

SELECT 'BETA-UX-1B · open/close_cash_session_atomic exigen finance: TODOS LOS CASOS PASARON' AS resultado;
ROLLBACK;
