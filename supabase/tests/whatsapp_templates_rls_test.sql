-- ============================================================================
-- Test suite: RLS de public.whatsapp_templates (W1 security gate)
--
-- Fija el contrato de la migracion 20260819120000:
--   SELECT  -> cualquier miembro del negocio (is_staff), porque el flujo
--              estandar de WhatsApp necesita LEER las plantillas.
--   INSERT / UPDATE / DELETE -> solo owner/admin (is_owner_or_admin), que es
--              el espejo exacto de `settings_sensitive` en el frontend.
--   Cross-tenant -> denegado en todo.
--
-- COMO CORRERLO (stack local; NUNCA contra prod):
--   Get-Content supabase/tests/whatsapp_templates_rls_test.sql -Raw |
--     docker exec -i supabase_db_techrepair-vite psql -X -U postgres -d postgres
--
-- Toda la suite corre en UNA transaccion y termina en ROLLBACK: no persiste
-- nada. Los fixtures se insertan con FK/triggers apagados
-- (session_replication_role='replica') y la RLS se ejercita con ellos activos.
--
-- DOS TRAMPAS QUE ESTE ARCHIVO EVITA A PROPOSITO:
--
--  1. La RLS NO deniega igual en todos los comandos. Un INSERT bloqueado
--     LANZA 42501; un UPDATE/DELETE/SELECT bloqueado simplemente NO VE la
--     fila y afecta 0 filas SIN error. Un test que solo espere excepciones
--     pasaria en verde sin haber probado nada. Por eso cada denegacion de
--     UPDATE/DELETE se asevera por conteo de filas afectadas Y comparando el
--     contenido antes/despues.
--
--  2. `DO $$ ... SET LOCAL ROLE x; PERFORM <SECURITY DEFINER>; ... $$` crashea
--     el backend (SIGSEGV, incidente documentado). Aca nunca se invoca una
--     SECDEF directamente con el rol cambiado: se opera sobre la TABLA y se
--     deja que la RLS evalue los helpers, que es el patron que si funciona.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

-- ── helpers de asercion (locales a la transaccion) ───────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

CREATE OR REPLACE FUNCTION pg_temp.assert_raises(sql text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION
    WHEN others THEN
      IF sqlerrm LIKE 'FAIL:%' THEN RAISE; END IF;
      RAISE NOTICE 'PASS (rechazado como se esperaba): % [%]', label, sqlerrm;
      RETURN;
  END;
  RAISE EXCEPTION 'FAIL (se esperaba un rechazo y no hubo): %', label;
END; $$;

/** Ejecuta `sql` y devuelve cuantas filas afecto. Para denegaciones silenciosas. */
CREATE OR REPLACE FUNCTION pg_temp.filas_afectadas(sql text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $$;

-- ── identificadores ficticios ────────────────────────────────────────────────
\set bizA    '00000000-0000-0000-0000-0000000a0001'
\set bizB    '00000000-0000-0000-0000-0000000b0002'
\set ownerA  '00000000-0000-0000-0000-0000000a00a9'
\set adminA  '00000000-0000-0000-0000-0000000a00ad'
\set viewerA '00000000-0000-0000-0000-0000000a00e9'
\set ownerB  '00000000-0000-0000-0000-0000000b00b9'
\set tplA    '00000000-0000-0000-0000-0000000a0f01'
\set tplB    '00000000-0000-0000-0000-0000000b0f02'

-- ════════════════════════════════════════════════════════════════════════════
-- G · POLICIES EFECTIVAS (catalogo, no el texto del .sql)
-- ════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.assert(
  (SELECT with_check FROM pg_policies WHERE schemaname='public'
     AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_insert')
  LIKE '%is_owner_or_admin()%',
  'G1 INSERT efectivo exige is_owner_or_admin()');

SELECT pg_temp.assert(
  (SELECT qual FROM pg_policies WHERE schemaname='public'
     AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_update')
  LIKE '%is_owner_or_admin()%'
  AND (SELECT with_check FROM pg_policies WHERE schemaname='public'
     AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_update')
  LIKE '%is_owner_or_admin()%',
  'G2 UPDATE efectivo exige is_owner_or_admin() en USING y WITH CHECK');

SELECT pg_temp.assert(
  (SELECT qual FROM pg_policies WHERE schemaname='public'
     AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_delete')
  LIKE '%is_owner_or_admin()%',
  'G3 DELETE efectivo exige is_owner_or_admin()');

SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='whatsapp_templates'
       AND cmd IN ('INSERT','UPDATE','DELETE')
       AND (COALESCE(qual,'') LIKE '%is_staff()%' OR COALESCE(with_check,'') LIKE '%is_staff()%')),
  'G4 ninguna ESCRITURA acepta ya is_staff() (el agujero original)');

SELECT pg_temp.assert(
  (SELECT qual FROM pg_policies WHERE schemaname='public'
     AND tablename='whatsapp_templates' AND policyname='whatsapp_templates_select')
  LIKE '%is_staff()%',
  'G5 la LECTURA sigue abierta a todo miembro del negocio');

SELECT pg_temp.assert(
  (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='whatsapp_templates'),
  'G6 RLS habilitada (sin esto las policies son decorativas)');

-- ════════════════════════════════════════════════════════════════════════════
-- H · NO SE ABRIERON GRANTS
-- ════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='whatsapp_templates'
       AND grantee NOT IN ('authenticated','postgres','service_role','supabase_admin')),
  'H1 sin grants fuera de authenticated/roles internos');

SELECT pg_temp.assert(
  NOT has_table_privilege('anon','public.whatsapp_templates','SELECT')
  AND NOT has_table_privilege('anon','public.whatsapp_templates','INSERT')
  AND NOT has_table_privilege('anon','public.whatsapp_templates','UPDATE')
  AND NOT has_table_privilege('anon','public.whatsapp_templates','DELETE'),
  'H2 anon no tiene ningun privilegio sobre la tabla');

-- ── fixtures ────────────────────────────────────────────────────────────────
-- `profiles.id = auth.uid()` con user_id NULL: es la forma real de 9 de los 16
-- profiles de produccion, y la unica que satisface a la vez a
-- current_business_id() (matchea por profiles.id) y a current_user_role()
-- (matchea por COALESCE(user_id, id)).
SET LOCAL session_replication_role = 'replica';

INSERT INTO public.businesses(id, name) VALUES (:'bizA','Biz A'), (:'bizB','Biz B');

INSERT INTO public.profiles(id, business_id, user_id, role, is_active) VALUES
  (:'ownerA',  :'bizA', NULL, 'owner',  true),
  (:'adminA',  :'bizA', NULL, 'admin',  true),
  (:'viewerA', :'bizA', NULL, 'viewer', true),
  (:'ownerB',  :'bizB', NULL, 'owner',  true);

INSERT INTO public.whatsapp_templates(id, business_id, status_key, status_label, message_template)
VALUES
  (:'tplA', :'bizA', 'ready_pickup', 'Listo para Retirar', 'ORIGINAL A: hola {nombre}'),
  (:'tplB', :'bizB', 'ready_pickup', 'Listo para Retirar', 'ORIGINAL B: hola {nombre}');

SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════════════════════
-- A · USUARIO AUTORIZADO DEL NEGOCIO A
-- ════════════════════════════════════════════════════════════════════════════
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'ownerA', 'role','authenticated')::text, true);

SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'INSERT INTO public.whatsapp_templates(business_id, status_key, status_label, message_template)
       VALUES (%L, %L, %L, %L)', :'bizA', 'debt_reminder', 'Recordatorio', 'nuevo A')) = 1,
  'A1 owner de A PUEDE crear una plantilla de A');

SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'EDITADO POR OWNER A', :'tplA')) = 1,
  'A2 owner de A PUEDE editar una plantilla de A');

RESET ROLE;
SELECT pg_temp.assert(
  (SELECT message_template FROM public.whatsapp_templates WHERE id=:'tplA') = 'EDITADO POR OWNER A',
  'A3 la edicion del owner realmente persistio');

-- admin tambien: settings_sensitive es owner+admin
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'adminA', 'role','authenticated')::text, true);
SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'EDITADO POR ADMIN A', :'tplA')) = 1,
  'A4 admin de A PUEDE editar (settings_sensitive = owner + admin)');
RESET ROLE;

-- ════════════════════════════════════════════════════════════════════════════
-- B/C/D/E · VIEWER DEL NEGOCIO A
-- ════════════════════════════════════════════════════════════════════════════
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'viewerA', 'role','authenticated')::text, true);

-- B · INSERT: la RLS lo rechaza con ERROR (42501).
SELECT pg_temp.assert_raises(format(
  'INSERT INTO public.whatsapp_templates(business_id, status_key, status_label, message_template)
     VALUES (%L, %L, %L, %L)', :'bizA', 'guarantee', 'Garantia', 'viewer no deberia poder'),
  'B1 viewer de A NO puede INSERT');

-- C · UPDATE: la RLS NO lanza error, simplemente no ve la fila -> 0 filas.
SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'VIEWER INTENTO ESCRIBIR', :'tplA')) = 0,
  'C1 viewer de A NO puede UPDATE (0 filas, sin error)');

-- D · DELETE: mismo mecanismo silencioso.
SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'DELETE FROM public.whatsapp_templates WHERE id = %L', :'tplA')) = 0,
  'D1 viewer de A NO puede DELETE (0 filas, sin error)');

-- E · SELECT: el viewer SI lee, porque lo necesita para usar el flujo estandar.
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.whatsapp_templates WHERE business_id = :'bizA') >= 1,
  'E1 viewer de A SI puede LEER las plantillas de A');

RESET ROLE;

-- Y nada de lo que intento el viewer toco los datos.
SELECT pg_temp.assert(
  (SELECT message_template FROM public.whatsapp_templates WHERE id=:'tplA') = 'EDITADO POR ADMIN A',
  'C2 el UPDATE del viewer no cambio el contenido');
SELECT pg_temp.assert(
  EXISTS(SELECT 1 FROM public.whatsapp_templates WHERE id=:'tplA'),
  'D2 el DELETE del viewer no borro la fila');
SELECT pg_temp.assert(
  NOT EXISTS(SELECT 1 FROM public.whatsapp_templates
              WHERE business_id=:'bizA' AND status_key='guarantee'),
  'B2 el INSERT del viewer no creo ninguna fila');

-- ════════════════════════════════════════════════════════════════════════════
-- F · CROSS-TENANT
-- ════════════════════════════════════════════════════════════════════════════
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'ownerB', 'role','authenticated')::text, true);

SELECT pg_temp.assert(
  (SELECT count(*) FROM public.whatsapp_templates WHERE business_id = :'bizA') = 0,
  'F1 owner de B NO ve ninguna plantilla de A');

SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'B PISANDO A', :'tplA')) = 0,
  'F2 owner de B NO puede editar una plantilla de A');

SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'DELETE FROM public.whatsapp_templates WHERE id = %L', :'tplA')) = 0,
  'F3 owner de B NO puede borrar una plantilla de A');

-- Ni siquiera siendo owner puede CREAR una fila en el negocio ajeno.
SELECT pg_temp.assert_raises(format(
  'INSERT INTO public.whatsapp_templates(business_id, status_key, status_label, message_template)
     VALUES (%L, %L, %L, %L)', :'bizA', 'free_message', 'Libre', 'B inyectando en A'),
  'F4 owner de B NO puede INSERT en el negocio A');

-- Y su propio negocio le sigue funcionando (la RLS no rompio el caso legitimo).
SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'B EDITA LO SUYO', :'tplB')) = 1,
  'F5 owner de B SI puede editar sus propias plantillas');

RESET ROLE;

SELECT pg_temp.assert(
  (SELECT message_template FROM public.whatsapp_templates WHERE id=:'tplA') = 'EDITADO POR ADMIN A',
  'F6 la plantilla de A quedo intacta tras todos los intentos de B');

-- ════════════════════════════════════════════════════════════════════════════
-- FALSIFICACION · el test tiene que poder fallar
-- Se reabre la policy a is_staff() y se comprueba que el viewer SI escribe.
-- Si esto no pasara, las aserciones de arriba serian vacuas.
-- ════════════════════════════════════════════════════════════════════════════
DROP POLICY "whatsapp_templates_update" ON public.whatsapp_templates;
CREATE POLICY "whatsapp_templates_update" ON public.whatsapp_templates
  FOR UPDATE USING (business_id = public.current_business_id() AND public.is_staff())
  WITH CHECK (business_id = public.current_business_id() AND public.is_staff());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :'viewerA', 'role','authenticated')::text, true);
SELECT pg_temp.assert(
  pg_temp.filas_afectadas(format(
    'UPDATE public.whatsapp_templates SET message_template = %L WHERE id = %L',
    'AGUJERO REABIERTO', :'tplA')) = 1,
  'X1 con is_staff() el viewer SI escribe -> el test C1 no es vacuo');
RESET ROLE;

-- ROLLBACK deja la base como estaba, incluida la policy falsificada.
ROLLBACK;
