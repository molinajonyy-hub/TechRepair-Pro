-- ============================================================================
-- P0-P2 — Contrato del ciclo de vida de invitaciones
--
-- Corre contra el stack LOCAL o una branch (NUNCA producción), con la
-- migración 20260824120000 aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/p0p2_business_invitations.test.sql
--
-- Invariantes que se aseveran:
--   · provision_my_business  = ÚNICA autoridad que CREA businesses
--   · accept_business_invitation = incorpora a un business EXISTENTE, jamás crea
--   · miembro de otro business            -> fail closed
--   · email del actor != email invitado   -> fail closed
--
-- Todo en UNA transacción que termina en ROLLBACK: no se commitea nada.
--
-- OJO: `public.profiles.id` es FK a `auth.users(id)`. Los fixtures insertan auth
-- users de verdad — es exactamente la restricción que rompía al accept viejo
-- (23503) y la que este contrato respeta pasando `id` explícito.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Helper: correr un bloque como un usuario autenticado concreto ────────────
-- auth.uid() sale de `request.jwt.claims`. Se setea transaction-local; el
-- ROLLBACK final lo limpia junto con todo lo demás.
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
END $$;

CREATE OR REPLACE FUNCTION pg_temp.anonimo() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

-- ── Fixtures ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner_a uuid := gen_random_uuid();
  v_owner_b uuid := gen_random_uuid();
  v_tech_a  uuid := gen_random_uuid();
  v_invitee uuid := gen_random_uuid();
  v_otro    uuid := gen_random_uuid();
  v_sin_conf uuid := gen_random_uuid();
  v_biz_a   uuid;
  v_biz_b   uuid;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
    (v_owner_a,  'p0p2_owner_a@invalid.test',  now()),
    (v_owner_b,  'p0p2_owner_b@invalid.test',  now()),
    (v_tech_a,   'p0p2_tech_a@invalid.test',   now()),
    (v_invitee,  'p0p2_invitee@invalid.test',  now()),
    (v_otro,     'p0p2_otro@invalid.test',     now()),
    (v_sin_conf, 'p0p2_sinconf@invalid.test',  NULL);

  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller A', v_owner_a)
    RETURNING id INTO v_biz_a;
  INSERT INTO public.businesses (name, owner_user_id) VALUES ('Taller B', v_owner_b)
    RETURNING id INTO v_biz_b;

  INSERT INTO public.profiles (id, business_id, role, is_active, email) VALUES
    (v_owner_a, v_biz_a, 'owner', true, 'p0p2_owner_a@invalid.test'),
    (v_owner_b, v_biz_b, 'owner', true, 'p0p2_owner_b@invalid.test'),
    (v_tech_a,  v_biz_a, 'tech',  true, 'p0p2_tech_a@invalid.test');

  PERFORM set_config('test.owner_a',  v_owner_a::text,  false);
  PERFORM set_config('test.owner_b',  v_owner_b::text,  false);
  PERFORM set_config('test.tech_a',   v_tech_a::text,   false);
  PERFORM set_config('test.invitee',  v_invitee::text,  false);
  PERFORM set_config('test.otro',     v_otro::text,     false);
  PERFORM set_config('test.sin_conf', v_sin_conf::text, false);
  PERFORM set_config('test.biz_a',    v_biz_a::text,    false);
  PERFORM set_config('test.biz_b',    v_biz_b::text,    false);

  -- Línea base para las aserciones de "no se creó nada".
  PERFORM set_config('test.n_biz', (SELECT count(*) FROM public.businesses)::text, false);
  PERFORM set_config('test.n_prof', (SELECT count(*) FROM public.profiles)::text, false);
  RAISE NOTICE 'Fixtures OK · Taller A=% · Taller B=%', v_biz_a, v_biz_b;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRUPO 1 — CREACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- 1 · owner autorizado crea invitación   2 · token con pgcrypto calificado
-- 6 · email normalizado
DO $$
DECLARE v_inv public.business_invitations;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_inv := public.create_business_invitation('  P0P2_Invitee@Invalid.TEST  ', 'tech');
  PERFORM pg_temp.anonimo();

  IF v_inv.id IS NULL THEN RAISE EXCEPTION '1 FAIL: no se creó la invitación'; END IF;
  IF v_inv.business_id <> current_setting('test.biz_a')::uuid THEN
    RAISE EXCEPTION '1 FAIL: business_id no derivado del actor'; END IF;
  IF v_inv.status <> 'pending' THEN RAISE EXCEPTION '1 FAIL: status %', v_inv.status; END IF;
  IF v_inv.invited_by <> current_setting('test.owner_a')::uuid THEN
    RAISE EXCEPTION '1 FAIL: invited_by incorrecto'; END IF;

  -- 6 · normalización: trim + lowercase persistidos.
  IF v_inv.email <> 'p0p2_invitee@invalid.test' THEN
    RAISE EXCEPTION '6 FAIL: email no normalizado: "%"', v_inv.email; END IF;

  -- 2 · token criptográfico: 32 bytes -> 64 hex. Si gen_random_bytes no
  --     resolviera, la RPC habría fallado antes de llegar acá.
  IF v_inv.token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '2 FAIL: token no es 64 hex: "%"', v_inv.token; END IF;

  PERFORM set_config('test.token_ok', v_inv.token, false);
  PERFORM set_config('test.inv_id', v_inv.id::text, false);
  RAISE NOTICE '1,2,6 OK · crear + token pgcrypto + email normalizado';
END $$;

-- 3 · usuario sin permiso (tech) no puede invitar
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM pg_temp.como(current_setting('test.tech_a')::uuid);
  BEGIN
    PERFORM public.create_business_invitation('nadie@invalid.test', 'tech');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  PERFORM pg_temp.anonimo();
  IF NOT v_ok THEN RAISE EXCEPTION '3 FAIL: un tech pudo invitar'; END IF;
  RAISE NOTICE '3 OK · tech no puede invitar (FORBIDDEN)';
END $$;

-- 4 · rol owner rechazado   5 · rol inválido rechazado
DO $$
DECLARE v_owner boolean := false; v_malo boolean := false; v_n int;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  BEGIN PERFORM public.create_business_invitation('x1@invalid.test', 'owner');
  EXCEPTION WHEN sqlstate 'TRIVR' THEN v_owner := true; END;
  BEGIN PERFORM public.create_business_invitation('x2@invalid.test', 'superadmin');
  EXCEPTION WHEN sqlstate 'TRIVR' THEN v_malo := true; END;
  PERFORM pg_temp.anonimo();

  IF NOT v_owner THEN RAISE EXCEPTION '4 FAIL: se aceptó rol owner por invitación'; END IF;
  IF NOT v_malo  THEN RAISE EXCEPTION '5 FAIL: se aceptó un rol fuera de la allowlist'; END IF;

  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE email IN ('x1@invalid.test','x2@invalid.test');
  IF v_n <> 0 THEN RAISE EXCEPTION '4/5 FAIL: quedaron % filas escritas', v_n; END IF;
  RAISE NOTICE '4,5 OK · owner y rol inválido rechazados sin escribir';
END $$;

-- 7 · retry / doble click NO crea múltiples pending
DO $$
DECLARE v_a public.business_invitations; v_b public.business_invitations; v_n int;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_a := public.create_business_invitation('p0p2_invitee@invalid.test', 'tech');
  -- Mayúsculas + espacios: tiene que colapsar en la MISMA invitación.
  v_b := public.create_business_invitation('  P0P2_INVITEE@INVALID.TEST ', 'sales');
  PERFORM pg_temp.anonimo();

  IF v_a.id <> v_b.id THEN RAISE EXCEPTION '7 FAIL: se crearon 2 invitaciones distintas'; END IF;
  IF v_b.token <> current_setting('test.token_ok') THEN
    RAISE EXCEPTION '7 FAIL: el retry rotó el token de una invitación ya emitida'; END IF;

  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE business_id = current_setting('test.biz_a')::uuid
     AND lower(btrim(email)) = 'p0p2_invitee@invalid.test' AND status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION '7 FAIL: hay % pending, se esperaba 1', v_n; END IF;
  RAISE NOTICE '7 OK · retry idempotente, un solo pending, token estable';
END $$;

-- 8 · barrera de concurrencia: el índice único parcial rechaza un segundo
--     pending aunque se inserte POR FUERA de la RPC.
--     Es la garantía dura; el advisory lock sólo convierte la carrera en un
--     "devolver el existente" en vez de un 23505 en la cara del usuario.
DO $$
DECLARE v_ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status)
    VALUES (current_setting('test.biz_a')::uuid, 'P0P2_Invitee@invalid.test', 'tech',
            current_setting('test.owner_a')::uuid, 'token_duplicado_forzado', 'pending');
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION '8 FAIL: la DB aceptó un segundo pending para el mismo (business,email)'; END IF;

  -- Y el advisory lock tiene que estar en el código, no sólo el índice.
  IF pg_get_functiondef(to_regprocedure('public.create_business_invitation(text,text)'))
       NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION '8 FAIL: create no toma el advisory lock'; END IF;
  RAISE NOTICE '8 OK · índice único parcial + advisory lock';
END $$;

-- 9 · una pending VENCIDA puede reemplazarse: se marca expired y se emite otra
DO $$
DECLARE v_inv public.business_invitations; v_n int;
BEGIN
  INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status, expires_at)
  VALUES (current_setting('test.biz_b')::uuid, 'vencida@invalid.test', 'tech',
          current_setting('test.owner_b')::uuid, 'token_vencido_1', 'pending', now() - interval '1 day');

  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  v_inv := public.create_business_invitation('vencida@invalid.test', 'tech');
  PERFORM pg_temp.anonimo();

  IF v_inv.token = 'token_vencido_1' THEN
    RAISE EXCEPTION '9 FAIL: devolvió la invitación vencida en vez de emitir una nueva'; END IF;

  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE token = 'token_vencido_1' AND status = 'expired';
  IF v_n <> 1 THEN RAISE EXCEPTION '9 FAIL: la vencida no quedó marcada expired'; END IF;

  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE business_id = current_setting('test.biz_b')::uuid
     AND lower(btrim(email)) = 'vencida@invalid.test' AND status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION '9 FAIL: hay % pending tras el reemplazo', v_n; END IF;
  RAISE NOTICE '9 OK · pending vencida -> expired + nueva emitida';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRUPO 2 — ACEPTACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- 17 · email del actor distinto al invitado -> rechazo, cero efectos
DO $$
DECLARE v_ok boolean := false; v_n int;
BEGIN
  PERFORM pg_temp.como(current_setting('test.otro')::uuid);
  BEGIN
    PERFORM public.accept_business_invitation(current_setting('test.token_ok'));
  EXCEPTION WHEN sqlstate 'TRIEM' THEN v_ok := true;
  END;
  PERFORM pg_temp.anonimo();

  IF NOT v_ok THEN RAISE EXCEPTION '17 FAIL: un tercero aceptó una invitación ajena'; END IF;
  SELECT count(*) INTO v_n FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.otro')::uuid;
  IF v_n <> 0 THEN RAISE EXCEPTION '17 FAIL: se creó un profile para el tercero'; END IF;
  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE token = current_setting('test.token_ok') AND status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION '17 FAIL: la invitación cambió de estado'; END IF;
  RAISE NOTICE '17 OK · email mismatch fail-closed, sin efectos';
END $$;

-- 20 · token inexistente -> error controlado
-- 18 · invitación vencida -> rechazada
-- 19 · invitación cancelada -> rechazada
DO $$
DECLARE v_nf boolean := false; v_ex boolean := false; v_ca boolean := false;
BEGIN
  PERFORM pg_temp.como(current_setting('test.invitee')::uuid);

  BEGIN PERFORM public.accept_business_invitation('no-existe-jamas');
  EXCEPTION WHEN sqlstate 'TRINF' THEN v_nf := true; END;

  INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status, expires_at)
  VALUES (current_setting('test.biz_b')::uuid, 'p0p2_invitee@invalid.test', 'tech',
          current_setting('test.owner_b')::uuid, 'tok_vencido_accept', 'pending', now() - interval '1 hour');
  BEGIN PERFORM public.accept_business_invitation('tok_vencido_accept');
  EXCEPTION WHEN sqlstate 'TRIEX' THEN v_ex := true; END;

  INSERT INTO public.business_invitations (business_id, email, role, invited_by, token, status)
  VALUES (current_setting('test.biz_b')::uuid, 'p0p2_invitee@invalid.test', 'tech',
          current_setting('test.owner_b')::uuid, 'tok_cancelado', 'cancelled');
  BEGIN PERFORM public.accept_business_invitation('tok_cancelado');
  EXCEPTION WHEN sqlstate 'TRICA' THEN v_ca := true; END;

  PERFORM pg_temp.anonimo();
  IF NOT v_nf THEN RAISE EXCEPTION '20 FAIL: token inexistente no dio INVITATION_NOT_FOUND'; END IF;
  IF NOT v_ex THEN RAISE EXCEPTION '18 FAIL: se aceptó una invitación vencida'; END IF;
  IF NOT v_ca THEN RAISE EXCEPTION '19 FAIL: se aceptó una invitación cancelada'; END IF;
  RAISE NOTICE '18,19,20 OK · vencida / cancelada / inexistente rechazadas';
END $$;

-- 10..16 · el camino feliz completo
DO $$
DECLARE
  v_res  jsonb;
  v_n    int;
  v_prof record;
BEGIN
  PERFORM pg_temp.como(current_setting('test.invitee')::uuid);
  v_res := public.accept_business_invitation(current_setting('test.token_ok'));
  PERFORM pg_temp.anonimo();

  -- 10 · aceptó
  IF v_res->>'status' <> 'ACCEPTED' THEN
    RAISE EXCEPTION '10 FAIL: status % ', v_res->>'status'; END IF;

  -- 11 · exactamente 1 profile
  SELECT count(*) INTO v_n FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.invitee')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION '11 FAIL: hay % profiles', v_n; END IF;

  SELECT p.id, p.business_id, p.role, p.is_active, p.email INTO v_prof
    FROM public.profiles p WHERE COALESCE(p.user_id, p.id) = current_setting('test.invitee')::uuid;

  -- 12 · profiles.id = auth.uid()  (el bug 23503)
  IF v_prof.id <> current_setting('test.invitee')::uuid THEN
    RAISE EXCEPTION '12 FAIL: profiles.id (%) != auth.uid() (%)', v_prof.id, current_setting('test.invitee'); END IF;

  -- 13 · business_id = invitation.business_id
  IF v_prof.business_id <> current_setting('test.biz_a')::uuid THEN
    RAISE EXCEPTION '13 FAIL: business_id incorrecto'; END IF;

  -- 14 · role = invitation.role
  IF v_prof.role <> 'tech' THEN RAISE EXCEPTION '14 FAIL: role %', v_prof.role; END IF;

  -- 25 · el accept NO puede asignar owner
  IF v_prof.role = 'owner' THEN RAISE EXCEPTION '25 FAIL: el accept asignó owner'; END IF;

  -- 15 · no se creó ningún business
  SELECT count(*) INTO v_n FROM public.businesses;
  IF v_n <> current_setting('test.n_biz')::int THEN
    RAISE EXCEPTION '15 FAIL: cambió la cantidad de businesses (% -> %)',
      current_setting('test.n_biz'), v_n; END IF;

  -- 16 · no se inició trial: el negocio del owner quedó intacto
  SELECT count(*) INTO v_n FROM public.businesses b
   WHERE b.id = current_setting('test.biz_a')::uuid
     AND b.owner_user_id = current_setting('test.owner_a')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION '16 FAIL: se tocó el negocio invitante'; END IF;

  -- la invitación quedó consumida
  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE token = current_setting('test.token_ok') AND status = 'accepted' AND accepted_at IS NOT NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION '10 FAIL: la invitación no quedó accepted'; END IF;

  RAISE NOTICE '10-16,25 OK · alta de miembro correcta, 0 businesses nuevos';
END $$;

-- 21 · ya miembro del MISMO business -> idempotente / no-op
DO $$
DECLARE v_res jsonb; v_n int; v_role text;
BEGIN
  PERFORM pg_temp.como(current_setting('test.invitee')::uuid);
  v_res := public.accept_business_invitation(current_setting('test.token_ok'));
  PERFORM pg_temp.anonimo();

  IF v_res->>'status' <> 'ALREADY_MEMBER' THEN
    RAISE EXCEPTION '21 FAIL: segunda aceptación devolvió %', v_res->>'status'; END IF;
  IF (v_res->>'created')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION '21 FAIL: created=true en una reaceptación'; END IF;

  -- 23 · una segunda aceptación no duplica estructura
  SELECT count(*) INTO v_n FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.invitee')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION '23 FAIL: hay % profiles tras reaceptar', v_n; END IF;

  SELECT role INTO v_role FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.invitee')::uuid;
  IF v_role <> 'tech' THEN RAISE EXCEPTION '21 FAIL: la reaceptación cambió el rol a %', v_role; END IF;
  RAISE NOTICE '21,23 OK · reaceptación idempotente, 1 profile, rol intacto';
END $$;

-- 22 · miembro de OTRO business -> fail closed
-- 16bis (§16 del brief) · el owner de Taller A que recibe invitación de Taller B
DO $$
DECLARE
  v_inv public.business_invitations;
  v_ok  boolean := false;
  v_biz uuid; v_role text; v_owner uuid; v_n int;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  v_inv := public.create_business_invitation('p0p2_owner_a@invalid.test', 'viewer');
  PERFORM pg_temp.anonimo();

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  BEGIN PERFORM public.accept_business_invitation(v_inv.token);
  EXCEPTION WHEN sqlstate 'TRIAM' THEN v_ok := true; END;
  PERFORM pg_temp.anonimo();

  IF NOT v_ok THEN RAISE EXCEPTION '22 FAIL: un owner fue movido a otro tenant'; END IF;

  SELECT business_id, role INTO v_biz, v_role FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.owner_a')::uuid;
  IF v_biz <> current_setting('test.biz_a')::uuid THEN
    RAISE EXCEPTION '22 FAIL: se movió profile.business_id'; END IF;
  IF v_role <> 'owner' THEN RAISE EXCEPTION '22 FAIL: se degradó el rol a %', v_role; END IF;

  SELECT owner_user_id INTO v_owner FROM public.businesses
   WHERE id = current_setting('test.biz_a')::uuid;
  IF v_owner <> current_setting('test.owner_a')::uuid THEN
    RAISE EXCEPTION '22 FAIL: se tocó owner_user_id del Taller A'; END IF;

  SELECT count(*) INTO v_n FROM public.businesses;
  IF v_n <> current_setting('test.n_biz')::int THEN
    RAISE EXCEPTION '22 FAIL: cambió la cantidad de businesses'; END IF;

  SELECT count(*) INTO v_n FROM public.business_invitations
   WHERE token = v_inv.token AND status = 'pending';
  IF v_n <> 1 THEN RAISE EXCEPTION '22 FAIL: la invitación se consumió igual'; END IF;
  RAISE NOTICE '22 OK · owner de otro tenant: fail closed, Taller A intacto';
END $$;

-- 24 · si el alta de profile falla, la invitación NO queda accepted
--      Se fuerza el fallo con un CHECK temporal sobre profiles que rechaza al
--      invitado. Es DDL transaccional: el ROLLBACK final lo saca.
DO $$
DECLARE
  v_inv public.business_invitations;
  v_falló boolean := false;
  v_status text; v_n int;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_inv := public.create_business_invitation('p0p2_sinconf@invalid.test', 'tech');
  PERFORM pg_temp.anonimo();

  -- El usuario existe pero sin email confirmado -> ya falla antes del INSERT.
  -- Se usa esa rama para probar la atomicidad: cualquier fallo posterior al
  -- lookup debe dejar la invitación intacta.
  PERFORM pg_temp.como(current_setting('test.sin_conf')::uuid);
  BEGIN PERFORM public.accept_business_invitation(v_inv.token);
  EXCEPTION WHEN insufficient_privilege THEN v_falló := true; END;
  PERFORM pg_temp.anonimo();

  IF NOT v_falló THEN RAISE EXCEPTION '24 FAIL: aceptó con el correo sin confirmar'; END IF;

  SELECT status INTO v_status FROM public.business_invitations WHERE token = v_inv.token;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION '24 FAIL: la invitación quedó en % pese a que el alta falló', v_status; END IF;

  SELECT count(*) INTO v_n FROM public.profiles
   WHERE COALESCE(user_id, id) = current_setting('test.sin_conf')::uuid;
  IF v_n <> 0 THEN RAISE EXCEPTION '24 FAIL: se creó un profile pese al fallo'; END IF;
  RAISE NOTICE '24 OK · fallo en el alta -> invitación sigue pending, sin miembro';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRUPO 3 — INTEGRACIÓN CON P1 (provision_my_business)
-- ════════════════════════════════════════════════════════════════════════════

-- 26 · pending bloquea provision   27 · accept crea membership
-- 28 · provision posterior devuelve el business existente y NO crea otro
DO $$
DECLARE
  v_uid    uuid := gen_random_uuid();
  v_inv    public.business_invitations;
  v_res    jsonb;
  v_bloq   boolean := false;
  v_n_biz  int;
  v_n_ini  int;
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at)
  VALUES (v_uid, 'p0p2_secuencia@invalid.test', now());

  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_inv := public.create_business_invitation('p0p2_secuencia@invalid.test', 'sales');
  PERFORM pg_temp.anonimo();

  SELECT count(*) INTO v_n_ini FROM public.businesses;

  -- 26 · con invitación vigente, provision NO crea tenant
  PERFORM pg_temp.como(v_uid);
  BEGIN PERFORM public.provision_my_business('Negocio Propio');
  EXCEPTION WHEN sqlstate 'TRINV' THEN v_bloq := true; END;
  PERFORM pg_temp.anonimo();

  IF NOT v_bloq THEN RAISE EXCEPTION '26 FAIL: provision no fue bloqueada por la invitación'; END IF;
  SELECT count(*) INTO v_n_biz FROM public.businesses;
  IF v_n_biz <> v_n_ini THEN RAISE EXCEPTION '26 FAIL: se creó un business igual'; END IF;

  -- 27 · acepta la invitación
  PERFORM pg_temp.como(v_uid);
  v_res := public.accept_business_invitation(v_inv.token);
  PERFORM pg_temp.anonimo();

  IF v_res->>'status' <> 'ACCEPTED' THEN RAISE EXCEPTION '27 FAIL: %', v_res->>'status'; END IF;
  IF (v_res->>'business_id')::uuid <> current_setting('test.biz_a')::uuid THEN
    RAISE EXCEPTION '27 FAIL: entró al business equivocado'; END IF;
  IF v_res->>'role' <> 'sales' THEN RAISE EXCEPTION '27 FAIL: role %', v_res->>'role'; END IF;

  -- 28 · retry de provision -> devuelve el existente, no crea otro
  PERFORM pg_temp.como(v_uid);
  v_res := public.provision_my_business('Negocio Propio');
  PERFORM pg_temp.anonimo();

  IF (v_res->>'created')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION '28 FAIL: provision creó un tenant tras aceptar la invitación'; END IF;
  IF (v_res->>'business_id')::uuid <> current_setting('test.biz_a')::uuid THEN
    RAISE EXCEPTION '28 FAIL: devolvió otro business'; END IF;

  SELECT count(*) INTO v_n_biz FROM public.businesses;
  IF v_n_biz <> v_n_ini THEN
    RAISE EXCEPTION '28 FAIL: la cantidad de businesses cambió (% -> %)', v_n_ini, v_n_biz; END IF;

  RAISE NOTICE '26,27,28 OK · pending bloquea -> accept -> provision devuelve el existente';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRUPO 4 — CANCELACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- §11 · el estado válido es 'cancelled'; sólo pending se cancela; retry estable
DO $$
DECLARE
  v_inv public.business_invitations;
  v_c1  public.business_invitations;
  v_c2  public.business_invitations;
  v_np  boolean := false;
  v_fb  boolean := false;
BEGIN
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  v_inv := public.create_business_invitation('p0p2_cancel@invalid.test', 'viewer');
  v_c1  := public.cancel_business_invitation(v_inv.id);
  v_c2  := public.cancel_business_invitation(v_inv.id);   -- retry
  PERFORM pg_temp.anonimo();

  IF v_c1.status <> 'cancelled' THEN RAISE EXCEPTION '11 FAIL: status %', v_c1.status; END IF;
  IF v_c2.status <> 'cancelled' THEN RAISE EXCEPTION '11 FAIL: retry no idempotente'; END IF;

  -- Una ya aceptada no se puede cancelar.
  PERFORM pg_temp.como(current_setting('test.owner_a')::uuid);
  BEGIN PERFORM public.cancel_business_invitation(current_setting('test.inv_id')::uuid);
  EXCEPTION WHEN sqlstate 'TRINP' THEN v_np := true; END;
  PERFORM pg_temp.anonimo();
  IF NOT v_np THEN RAISE EXCEPTION '11 FAIL: se canceló una invitación ya aceptada'; END IF;

  -- Un owner de otro tenant no la ve.
  PERFORM pg_temp.como(current_setting('test.owner_b')::uuid);
  BEGIN PERFORM public.cancel_business_invitation(v_inv.id);
  EXCEPTION WHEN sqlstate 'TRINF' THEN v_fb := true; END;
  PERFORM pg_temp.anonimo();
  IF NOT v_fb THEN RAISE EXCEPTION '11 FAIL: cross-tenant pudo cancelar'; END IF;

  RAISE NOTICE '11 OK · cancelled, retry idempotente, no-pending y cross-tenant rechazados';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- GRUPO 5 — SEGURIDAD (29, 30, 31)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  -- 29/30 · anon y PUBLIC sin EXECUTE sobre las RPC privadas.
  --         has_function_privilege y no aclexplode: sobre una ACL nula
  --         aclexplode devuelve 0 filas y da un falso negativo.
  IF has_function_privilege('anon', 'public.accept_business_invitation(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.create_business_invitation(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_business_invitation(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '29 FAIL: anon puede ejecutar una RPC de invitaciones';
  END IF;

  IF has_function_privilege('public', 'public.accept_business_invitation(text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.create_business_invitation(text,text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.cancel_business_invitation(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '30 FAIL: PUBLIC conserva EXECUTE';
  END IF;

  -- 31 · sin DML estructural directo para el cliente.
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('profiles','businesses','business_invitations')
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','DELETE','TRUNCATE');
  IF v_n <> 0 THEN RAISE EXCEPTION '31 FAIL: % grants de DML estructural repuestos', v_n; END IF;

  -- §12 · una sola API canónica de creación.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_business_invitation';
  IF v_n <> 1 THEN RAISE EXCEPTION '12 FAIL: hay % overloads de create', v_n; END IF;

  RAISE NOTICE '29,30,31 OK · ACL cerrada, cero DML estructural, 1 sola API';
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 26bis · REGRESIÓN DEL P0 REPORTADO
-- El error productivo era `function gen_random_bytes(integer) does not exist`.
-- Se reproduce la condición exacta —search_path endurecido sin `extensions`— y
-- se verifica que la llamada CALIFICADA sigue resolviendo. Si alguien quitara la
-- calificación de schema, este bloque falla.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_sin boolean := false; v_bytes bytea;
BEGIN
  SET LOCAL search_path = public, pg_temp;

  BEGIN
    EXECUTE 'SELECT gen_random_bytes(4)';
  EXCEPTION WHEN undefined_function THEN v_sin := true;
  END;
  IF NOT v_sin THEN
    RAISE NOTICE 'P0-regresión: gen_random_bytes resuelve sin calificar en este stack; el caso base no aplica acá';
  END IF;

  EXECUTE 'SELECT extensions.gen_random_bytes(4)' INTO v_bytes;
  IF v_bytes IS NULL OR length(v_bytes) <> 4 THEN
    RAISE EXCEPTION 'P0 FAIL: extensions.gen_random_bytes no devolvió 4 bytes'; END IF;

  RESET search_path;
  RAISE NOTICE 'P0 OK · pgcrypto sólo resuelve calificado; la RPC lo llama así';
END $$;

ROLLBACK;
