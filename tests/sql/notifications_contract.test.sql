-- ============================================================================
-- P0 final pre-M8 — contrato canonico de `public.notifications`
--
-- Corre contra una BRANCH de Supabase o el stack LOCAL (NUNCA produccion), con
-- 20260805120000_notifications_contract.sql ya aplicada:
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/notifications_contract.test.sql
--
--   CASO  1  insert valido con business_id explicito.
--   CASO  2  insert que OMITE business_id lo deriva server-side (DEFAULT).
--   CASO  3  insert con business_id de OTRO negocio -> 42501 (no se cuela).
--   CASO  4  otro tenant no LEE las notificaciones ajenas.
--   CASO  5  anon no lee: 42501, no "0 filas".
--   CASO  6  marcar como leida funciona para el miembro.
--   CASO  7  otro negocio no puede marcar como leida la ajena.
--   CASO  8  order_id cross-business RECHAZADO por el guard.
--   CASO  9  order_id del MISMO negocio aceptado.
--   CASO 10  customer_id / read_at NO existen (contrato minimo).
--   CASO 11  metadata: default seguro, objeto, y tope de tamano.
--   CASO 12  cero notificaciones devuelve [] (no error, no 406).
--   CASO 13  la PK impide duplicar la misma fila (dedup por id).
--   CASO 14  anon no tiene INSERT/UPDATE/DELETE/TRUNCATE.
--   CASO 15  la publicacion supabase_realtime contiene notifications.
--   CASO 16  businesses NO esta publicada.
--   CASO 17  payments NO esta publicada.
--   CASO 18  REPLICA IDENTITY DEFAULT (payload de Realtime acotado).
--   CASO 19  authenticated no conserva TRUNCATE (bypassea RLS).
--   CASO 20  NEGATIVO: reponerle SELECT a anon reabre la lectura y el detector
--            lo ve. Demuestra que el cierre no es cosmetico.
--   CASO 21  NEGATIVO: sin el guard, el order_id cross-tenant entra.
--
-- Los casos 20-21 modifican el catalogo a proposito, dentro de la misma
-- transaccion. Todo termina en ROLLBACK: no deja fixtures ni grants.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;

-- ── Detector ────────────────────────────────────────────────────────────────
-- Mismo predicado que la postcondicion P1 de la migracion. Vive en pg_temp, se
-- va con el ROLLBACK. Que el CASO 20 lo haga disparar es lo que demuestra que
-- la migracion habria abortado ante ese estado.
CREATE FUNCTION pg_temp.acceso_publico_notifications() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(DISTINCT format('%s:%s', x.rol, x.priv), ', ')
  FROM (VALUES ('anon'), ('public')) AS r(rol)
  CROSS JOIN LATERAL (
    SELECT r.rol AS rol, p.priv
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p(priv)
    WHERE has_table_privilege(r.rol, 'public.notifications', p.priv)
  ) x;
$$;


DO $$
DECLARE
  v_user_a  uuid := gen_random_uuid();   -- owner del negocio A
  v_user_b  uuid := gen_random_uuid();   -- owner del negocio B
  v_biz_a   uuid := gen_random_uuid();
  v_biz_b   uuid := gen_random_uuid();
  v_order_a uuid := gen_random_uuid();
  v_order_b uuid := gen_random_uuid();
  v_notif   uuid;
  v_cnt     int;
  v_txt     text;
  v_biz_got uuid;
  v_ok      boolean;
  v_read    boolean;
BEGIN
  -- ── Fixtures sinteticas ───────────────────────────────────────────────────
  INSERT INTO auth.users (id, email) VALUES
    (v_user_a, 'notif_a@example.invalid'),
    (v_user_b, 'notif_b@example.invalid')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.businesses (id, name, owner_user_id, subscription_status, subscription_plan)
  VALUES (v_biz_a, 'NOTIF A', v_user_a, 'active', 'full'),
         (v_biz_b, 'NOTIF B', v_user_b, 'active', 'full');

  INSERT INTO public.profiles (id, user_id, business_id, role, is_active) VALUES
    (v_user_a, v_user_a, v_biz_a, 'owner', true),
    (v_user_b, v_user_b, v_biz_b, 'owner', true);

  INSERT INTO public.orders (id, business_id, status) VALUES
    (v_order_a, v_biz_a, 'new'),
    (v_order_b, v_biz_b, 'new');

  -- Helper de sesion: nos hacemos pasar por el owner de A.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);


  -- ══ CASO 1 — insert valido con business_id explicito ════════════════════
  INSERT INTO public.notifications (business_id, type, title, message, created_by)
  VALUES (v_biz_a, 'status_change', 'T1', 'M1', v_user_a)
  RETURNING id INTO v_notif;
  IF v_notif IS NULL THEN
    RAISE EXCEPTION 'CASO 1 FAIL: el insert valido no devolvio id';
  END IF;
  RAISE NOTICE 'CASO 1 OK — insert valido con business_id explicito.';

  -- ══ CASO 2 — insert que OMITE business_id lo deriva server-side ═════════
  -- §8: ningun insert puede omitirlo; el DEFAULT current_business_id() lo
  -- resuelve sin confiar en lo que mande React.
  INSERT INTO public.notifications (type, title, message)
  VALUES ('status_change', 'T2', 'M2')
  RETURNING business_id INTO v_biz_got;
  IF v_biz_got IS DISTINCT FROM v_biz_a THEN
    RAISE EXCEPTION 'CASO 2 FAIL: business_id derivado = % (esperado %)', v_biz_got, v_biz_a;
  END IF;
  RAISE NOTICE 'CASO 2 OK — business_id omitido se deriva server-side.';

  -- ══ CASO 3 — insert con business_id AJENO -> rechazado ══════════════════
  v_ok := false;
  BEGIN
    INSERT INTO public.notifications (business_id, type, title, message)
    VALUES (v_biz_b, 'status_change', 'CROSS', 'no deberia entrar');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 3 FAIL: se pudo insertar una notificacion en el negocio ajeno';
  END IF;
  RAISE NOTICE 'CASO 3 OK — business_id ajeno -> 42501.';

  -- ══ CASO 4 — otro tenant no LEE lo ajeno ════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM public.notifications WHERE business_id = v_biz_a;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 4 FAIL: el negocio B ve % notificaciones de A', v_cnt;
  END IF;
  RAISE NOTICE 'CASO 4 OK — cross-tenant de lectura cerrado.';

  -- ══ CASO 5 — anon no lee: 42501, NO "0 filas" ═══════════════════════════
  -- Un rechazo tiene que ser distinguible de un resultado vacio: si solo se
  -- hubiera arreglado la policy dejando el GRANT, esto daria 0 filas y el test
  -- pasaria por el motivo equivocado.
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('role', 'anon', true);
  v_ok := false;
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.notifications' INTO v_cnt;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  PERFORM set_config('role', 'postgres', true);
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 5 FAIL: anon todavia puede leer notifications (% filas)', v_cnt;
  END IF;
  RAISE NOTICE 'CASO 5 OK — anon -> 42501 (no "0 filas").';

  -- ══ CASO 6 — marcar como leida funciona para el miembro ═════════════════
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  UPDATE public.notifications SET is_read = true WHERE id = v_notif;
  SELECT is_read INTO v_read FROM public.notifications WHERE id = v_notif;
  IF v_read IS NOT TRUE THEN
    RAISE EXCEPTION 'CASO 6 FAIL: el miembro no pudo marcar como leida';
  END IF;
  RAISE NOTICE 'CASO 6 OK — markAsRead funciona para el miembro.';

  -- ══ CASO 7 — otro negocio no marca como leida la ajena ══════════════════
  UPDATE public.notifications SET is_read = false WHERE id = v_notif;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
  UPDATE public.notifications SET is_read = true WHERE id = v_notif;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 7 FAIL: el negocio B marco como leida una notificacion de A';
  END IF;
  RAISE NOTICE 'CASO 7 OK — markAsRead cross-tenant no afecta filas ajenas.';

  -- ══ CASO 8 — order_id cross-business RECHAZADO ══════════════════════════
  -- Una FK garantiza que la orden EXISTE, no que sea del mismo negocio.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  v_ok := false;
  BEGIN
    INSERT INTO public.notifications (business_id, type, title, message, order_id)
    VALUES (v_biz_a, 'status_change', 'T8', 'M8', v_order_b);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 8 FAIL: se acepto un order_id de otro negocio';
  END IF;
  RAISE NOTICE 'CASO 8 OK — order_id cross-business rechazado por el guard.';

  -- ══ CASO 9 — order_id del MISMO negocio aceptado ════════════════════════
  INSERT INTO public.notifications (business_id, type, title, message, order_id, metadata)
  VALUES (v_biz_a, 'status_change', 'T9', 'M9', v_order_a,
          jsonb_build_object('from_status', 'new', 'to_status', 'repair'));
  RAISE NOTICE 'CASO 9 OK — order_id del propio negocio aceptado.';

  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', NULL, true);

  -- ══ CASO 10 — customer_id / read_at NO existen ══════════════════════════
  -- Contrato minimo: solo se agregaron las columnas CON consumidor real.
  SELECT string_agg(attname, ', ') INTO v_txt
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.notifications'::regclass
    AND attnum > 0 AND NOT attisdropped
    AND attname IN ('customer_id', 'read_at');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 10 FAIL: existen columnas sin consumidor: %', v_txt;
  END IF;
  RAISE NOTICE 'CASO 10 OK — customer_id y read_at fuera del contrato.';

  -- ══ CASO 11 — metadata: default, tipo y tope de tamano ══════════════════
  SELECT metadata INTO v_txt FROM public.notifications WHERE id = v_notif;
  IF v_txt::jsonb <> '{}'::jsonb THEN
    RAISE EXCEPTION 'CASO 11 FAIL: metadata no defaultea a {} (obtuvo %)', v_txt;
  END IF;
  -- Un array no es un objeto: el CHECK lo rechaza.
  v_ok := false;
  BEGIN
    INSERT INTO public.notifications (business_id, type, title, message, metadata)
    VALUES (v_biz_a, 't', 'T11a', 'M11a', '[1,2,3]'::jsonb);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 11 FAIL: metadata acepto un array';
  END IF;
  -- Y un payload gigante tampoco entra (tope 2 KB).
  v_ok := false;
  BEGIN
    INSERT INTO public.notifications (business_id, type, title, message, metadata)
    VALUES (v_biz_a, 't', 'T11b', 'M11b',
            jsonb_build_object('x', repeat('a', 4096)));
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 11 FAIL: metadata acepto un payload > 2KB';
  END IF;
  RAISE NOTICE 'CASO 11 OK — metadata: default {}, solo objetos, tope 2KB.';

  -- ══ CASO 12 — cero notificaciones devuelve [] ═══════════════════════════
  -- El negocio B no tiene ninguna: la consulta de LISTA no es un error.
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM public.notifications WHERE business_id = v_biz_b;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'CASO 12 FAIL: el negocio B tiene % notificaciones inesperadas', v_cnt;
  END IF;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', NULL, true);
  RAISE NOTICE 'CASO 12 OK — cero notificaciones es un estado legitimo.';

  -- ══ CASO 13 — la PK impide duplicar la misma fila ═══════════════════════
  -- Es la identidad que usa la deduplicacion del cliente (HTTP + Realtime).
  v_ok := false;
  BEGIN
    INSERT INTO public.notifications (id, business_id, type, title, message)
    VALUES (v_notif, v_biz_a, 't', 'DUP', 'DUP');
  EXCEPTION WHEN unique_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'CASO 13 FAIL: se pudo insertar dos veces el mismo id';
  END IF;
  RAISE NOTICE 'CASO 13 OK — id es identidad unica (base del dedup).';

  -- ══ CASO 14 — anon sin ninguna forma de acceso ══════════════════════════
  v_txt := pg_temp.acceso_publico_notifications();
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 14 FAIL: anon/PUBLIC conservan privilegios: %', v_txt;
  END IF;
  RAISE NOTICE 'CASO 14 OK — anon y PUBLIC a cero en las 5 formas de acceso.';

  -- ══ CASO 15 — notifications publicada en supabase_realtime ══════════════
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    RAISE EXCEPTION 'CASO 15 FAIL: notifications no esta en supabase_realtime';
  END IF;
  RAISE NOTICE 'CASO 15 OK — notifications publicada.';

  -- ══ CASO 16 y 17 — businesses y payments NO publicadas ══════════════════
  SELECT string_agg(tablename, ', ') INTO v_txt
  FROM pg_catalog.pg_publication_tables
  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    AND tablename IN ('businesses', 'payments', 'comprobante_payments', 'financial_movements');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 16/17 FAIL: hay tablas vetadas publicadas: %', v_txt;
  END IF;
  RAISE NOTICE 'CASO 16/17 OK — businesses y payments fuera de la publicacion.';

  -- ══ CASO 18 — REPLICA IDENTITY DEFAULT ══════════════════════════════════
  -- FULL empujaria la tupla OLD completa a cada suscriptor y duplicaria el WAL
  -- sin ninguna necesidad funcional: el unico binding de la app es INSERT.
  IF (SELECT relreplident FROM pg_catalog.pg_class
      WHERE oid = 'public.notifications'::regclass) <> 'd' THEN
    RAISE EXCEPTION 'CASO 18 FAIL: notifications no esta en REPLICA IDENTITY DEFAULT';
  END IF;
  RAISE NOTICE 'CASO 18 OK — REPLICA IDENTITY DEFAULT (payload acotado).';

  -- ══ CASO 19 — authenticated sin TRUNCATE ════════════════════════════════
  -- TRUNCATE bypassea RLS: con el, una sesion cualquiera vaciaria la tabla de
  -- TODOS los negocios.
  IF has_table_privilege('authenticated', 'public.notifications', 'TRUNCATE') THEN
    RAISE EXCEPTION 'CASO 19 FAIL: authenticated conserva TRUNCATE';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.notifications', 'SELECT') THEN
    RAISE EXCEPTION 'CASO 19 FAIL: authenticated perdio SELECT (rompe la app)';
  END IF;
  RAISE NOTICE 'CASO 19 OK — authenticated conserva DML y perdio TRUNCATE.';

  -- ══ CASO 20 — NEGATIVO: reponerle SELECT a anon reabre la lectura ═══════
  -- Demuestra que el detector no es cosmetico: si el REVOKE se revirtiera, esto
  -- lo veria. Se deshace enseguida, y ademas todo el archivo termina en ROLLBACK.
  GRANT SELECT ON TABLE public.notifications TO anon;
  IF pg_temp.acceso_publico_notifications() IS NULL THEN
    RAISE EXCEPTION 'CASO 20 FAIL: el detector NO vio un GRANT SELECT a anon (es cosmetico)';
  END IF;
  REVOKE SELECT ON TABLE public.notifications FROM anon;
  IF pg_temp.acceso_publico_notifications() IS NOT NULL THEN
    RAISE EXCEPTION 'CASO 20 FAIL: no se pudo restaurar el estado cerrado';
  END IF;
  RAISE NOTICE 'CASO 20 OK — el detector reacciona a un GRANT repuesto.';

  -- ══ CASO 21 — NEGATIVO: sin el guard, el cross-tenant entra ═════════════
  -- Prueba que el CASO 8 pasa POR EL GUARD y no por la FK ni por casualidad.
  ALTER TABLE public.notifications DISABLE TRIGGER trig_notifications_guard_order_tenant;
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_a, 'role', 'authenticated')::text, true);
  INSERT INTO public.notifications (business_id, type, title, message, order_id)
  VALUES (v_biz_a, 'status_change', 'T21', 'M21', v_order_b);
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', NULL, true);
  ALTER TABLE public.notifications ENABLE TRIGGER trig_notifications_guard_order_tenant;
  RAISE NOTICE 'CASO 21 OK — sin el guard el order_id ajeno entra: el CASO 8 pasa por el guard.';

  RAISE NOTICE '───────────────────────────────────────────────────────────';
  RAISE NOTICE 'TODOS LOS CASOS OK — contrato de notifications verificado.';
END
$$;

ROLLBACK;
