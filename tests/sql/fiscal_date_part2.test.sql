-- ============================================================================
-- FISCAL DATE ARGENTINA Parte 2 — regresión SQL
--
-- NO se corre directo con psql -f. Lo corre
--   node scripts/fiscal-date-part2/run-sql-tests.mjs
-- que reemplaza el marcador @@MIGRATION@@ por el cuerpo de
-- supabase/migrations/20260927120000_fiscal_date_part2.sql SIN su BEGIN/COMMIT,
-- y manda todo por stdin a psql dentro del contenedor.
--
-- Por qué se saca el BEGIN/COMMIT: un `COMMIT` embebido cerraría la
-- transacción envolvente de este test, dejando la migración APLICADA y las
-- filas de fixture COMMITEADAS en la base local, y el ROLLBACK final sería un
-- warning inofensivo. Con el splice, todo el test vive en una sola transacción
-- que termina en ROLLBACK y no deja rastro.
--
-- Cubre, en orden:
--   M. estado previo (identidad vieja de 7 argumentos)
--   A. identidad del RPC (un solo overload, 7 y 8 argumentos)
--   B. parser defensivo
--   C. el CAE se persiste SIEMPRE (ausente / legacy / malformada / imposible /
--      hostil / no autorizada / ya seteada / fallo real de metadata)
--   D. inmutabilidad de la fecha ya persistida
--   E. autoridad de escritura
-- ============================================================================
BEGIN;

-- Función, no procedimiento: Postgres NO admite subqueries como argumento de
-- CALL ("cannot use subquery in CALL argument"), y casi toda aserción de acá
-- lee estado con (SELECT ...). Como función invocada con PERFORM, sí se puede.
CREATE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  RAISE NOTICE 'PASS: %', label;
END;
$assert$;

-- ── M. Estado previo: la identidad vieja de 7 argumentos ────────────────────
DO $$
DECLARE v_args text; v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  PERFORM pg_temp.assert(v_count = 1, 'M1 antes de migrar hay exactamente una complete_arca_attempt');

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  PERFORM pg_temp.assert(v_args NOT LIKE '%p_fecha_cbte%', 'M2 la identidad previa no tiene p_fecha_cbte');

  PERFORM pg_temp.assert(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='comprobantes'
                   AND column_name='fecha_comprobante_fiscal'),
    'M3 la columna fiscal todavía no existe');
END;
$$;

-- ===========================================================================
-- @@MIGRATION@@
-- ===========================================================================

-- ── A. Identidad ────────────────────────────────────────────────────────────
DO $$
DECLARE v_count int; v_args text;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  PERFORM pg_temp.assert(v_count = 1, 'A1 tras migrar sigue habiendo UNA sola complete_arca_attempt (cero overloads)');

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'complete_arca_attempt';
  PERFORM pg_temp.assert(
    v_args = 'p_attempt_id uuid, p_status text, p_cae text, p_cae_vencimiento timestamp with time zone, p_resultado text, p_observaciones text, p_error_mensaje text, p_fecha_cbte text',
    'A2 la identidad nueva es exactamente la de 8 argumentos');

  PERFORM pg_temp.assert(
    (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='complete_arca_attempt'),
    'A3 sigue siendo SECURITY DEFINER');
  PERFORM pg_temp.assert(
    (SELECT proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='complete_arca_attempt') = ARRAY['search_path=public, pg_temp'],
    'A4 search_path preservado (la Parte 2 no amplía el alcance)');
  PERFORM pg_temp.assert(
    (SELECT pg_get_userbyid(proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='complete_arca_attempt') = 'postgres',
    'A5 owner postgres (SECURITY DEFINER corre con el mismo rol que antes)');
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text,text)', 'EXECUTE'),
    'A6 ACL: sólo service_role ejecuta');
END;
$$;

-- ── B. Parser defensivo ─────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20260911') = DATE '2026-09-11', 'B1 20260911 -> 2026-09-11');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20261231') = DATE '2026-12-31', 'B2 fin de año');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20280229') = DATE '2028-02-29', 'B3 29/02 bisiesto válido');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20260229') IS NULL, 'B4 29/02 en año no bisiesto -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20260231') IS NULL, 'B5 31 de febrero -> NULL (to_date habría inventado 2026-03-03)');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20261301') IS NULL, 'B6 mes 13 -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('20260900') IS NULL, 'B7 día 0 -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('00000000') IS NULL, 'B8 todo ceros -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('2026-09-11') IS NULL, 'B9 con guiones -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('2026091') IS NULL, 'B10 7 dígitos -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('202609110') IS NULL, 'B11 9 dígitos -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch(' 20260911') IS NULL, 'B12 con espacio -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('DROP TABLE') IS NULL, 'B13 texto arbitrario -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch('') IS NULL, 'B14 vacío -> NULL');
  PERFORM pg_temp.assert(public.arca_parse_cbte_fch(NULL) IS NULL, 'B15 NULL -> NULL');
END;
$$;

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Un negocio, y un caso = un comprobante + un intento.
--
-- OJO con idx_arca_attempt_one_live_per_serie: es UNIQUE sobre
-- (ambiente, cuit_emisor, punto_venta, tipo_comprobante) mientras el intento
-- está vivo ('claimed'|'number_reserved'|'sent'|'pending_reconciliation').
-- Por eso cada caso usa su PROPIO cuit_emisor: si compartieran serie, el
-- segundo fixture violaría el índice, y un caso que termina en
-- pending_reconciliation (que sigue vivo) bloquearía a todos los siguientes.
DO $$
DECLARE v_biz uuid := gen_random_uuid();
BEGIN
  INSERT INTO businesses(id, name) VALUES (v_biz, 'FDP2 regression');
  PERFORM set_config('fdp2.biz', v_biz::text, true);
  PERFORM set_config('fdp2.seq', '0', true);
END;
$$;

CREATE FUNCTION pg_temp.nuevo_caso(p_label text)
RETURNS TABLE(comprobante_id uuid, attempt_id uuid)
LANGUAGE plpgsql AS $caso$
DECLARE
  v_biz  uuid := current_setting('fdp2.biz')::uuid;
  v_seq  int  := current_setting('fdp2.seq')::int + 1;
  v_comp uuid := gen_random_uuid();
  v_att  uuid := gen_random_uuid();
  v_cuit text := '20' || lpad(v_seq::text, 9, '0'); -- serie propia por caso
BEGIN
  PERFORM set_config('fdp2.seq', v_seq::text, true);

  INSERT INTO comprobantes(id, business_id, tipo, numero, punto_venta, fecha,
                           subtotal, impuestos, total, estado, estado_fiscal)
    VALUES (v_comp, v_biz, 'factura_c', lpad(v_seq::text, 8, '0'), '0010', now(),
            1000, 0, 1000, 'borrador', 'pendiente_emision');

  INSERT INTO arca_emission_attempts(id, comprobante_id, business_id, correlation_id,
                                     ambiente, cuit_emisor, punto_venta, tipo_comprobante,
                                     numero_intentado, status, started_at, sent_at)
    VALUES (v_att, v_comp, v_biz, 'fdp2-' || p_label, 'produccion', v_cuit, 10, 11,
            v_seq, 'sent', now(), now());

  RETURN QUERY SELECT v_comp, v_att;
END;
$caso$;

-- ── C. El CAE se persiste siempre ───────────────────────────────────────────
DO $$
DECLARE c record; r jsonb;
BEGIN
  -- C1 fecha válida: CAE + fecha fiscal exacta
  SELECT * INTO c FROM pg_temp.nuevo_caso('C1');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C1', now(), 'A', NULL, NULL, '20260911');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C1a completado exitoso');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'persisted', 'C1b fiscal_date_status=persisted');
  PERFORM pg_temp.assert(r->>'fiscal_date' = '2026-09-11', 'C1c el resultado devuelve la fecha fiscal');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C1', 'C1d CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-09-11',
    'C1e fecha fiscal EXACTA, no derivada de now()');
  PERFORM pg_temp.assert((SELECT fecha_emision_fiscal::date FROM comprobantes WHERE id = c.comprobante_id) = current_date,
    'C1f fecha_emision_fiscal sigue siendo el instante de completado, que es OTRA cosa');
  PERFORM pg_temp.assert((SELECT status FROM arca_emission_attempts WHERE id = c.attempt_id) = 'authorized', 'C1g intento authorized');

  -- C2 llamada LEGACY de 7 argumentos (Edge viejo + DB nueva)
  SELECT * INTO c FROM pg_temp.nuevo_caso('C2');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C2', now(), 'A', NULL, NULL);
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C2a la llamada de 7 argumentos sigue resolviendo');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C2', 'C2b CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id),
    'C2c sin fecha fiscal: queda para backfill, no se inventa');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'absent', 'C2d fiscal_date_status=absent');

  -- C3 fecha malformada
  SELECT * INTO c FROM pg_temp.nuevo_caso('C3');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C3', now(), 'A', NULL, NULL, '2026-09-11');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C3a malformada: completado exitoso igual');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C3', 'C3b CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id), 'C3c fecha NULL');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'invalid', 'C3d fiscal_date_status=invalid');

  -- C4 fecha IMPOSIBLE
  SELECT * INTO c FROM pg_temp.nuevo_caso('C4');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C4', now(), 'A', NULL, NULL, '20260231');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C4a 31 de febrero no aborta el completado');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C4', 'C4b CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id),
    'C4c no se inventa 2026-03-03');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'invalid', 'C4d fiscal_date_status=invalid');

  -- C5 texto hostil en el argumento de metadata
  SELECT * INTO c FROM pg_temp.nuevo_caso('C5');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C5', now(), 'A', NULL, NULL,
        '20260911''; DROP TABLE comprobantes; --');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C5a texto hostil: completado normal');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C5', 'C5b CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id), 'C5c fecha NULL');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='comprobantes') = 1,
    'C5d comprobantes sigue existiendo');

  -- C6 rechazo: nunca hay fecha fiscal
  SELECT * INTO c FROM pg_temp.nuevo_caso('C6');
  r := public.complete_arca_attempt(c.attempt_id, 'rejected', NULL, NULL, 'R', NULL, 'rechazo fiscal', '20260911');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C6a rejected completa');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id),
    'C6b un rechazo no tiene fecha fiscal');
  PERFORM pg_temp.assert((SELECT estado_fiscal FROM comprobantes WHERE id = c.comprobante_id) = 'error_emision', 'C6c estado_fiscal=error_emision');

  -- C7 pending_reconciliation: tampoco
  SELECT * INTO c FROM pg_temp.nuevo_caso('C7');
  r := public.complete_arca_attempt(c.attempt_id, 'pending_reconciliation', NULL, NULL, NULL, NULL, 'ambiguo', '20260911');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id),
    'C7a pending_reconciliation no fija fecha fiscal');
  PERFORM pg_temp.assert((SELECT estado_fiscal FROM comprobantes WHERE id = c.comprobante_id) = 'pendiente_conciliacion', 'C7b estado_fiscal conciliación');

  -- C8 fecha ya seteada: no se pisa, y el completado no se degrada
  SELECT * INTO c FROM pg_temp.nuevo_caso('C8');
  UPDATE comprobantes SET fecha_comprobante_fiscal = DATE '2026-09-10' WHERE id = c.comprobante_id;
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C8', now(), 'A', NULL, NULL, '20260911');
  PERFORM pg_temp.assert(r->>'success' = 'true', 'C8a completado exitoso');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C8', 'C8b CAE persistido');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-09-10',
    'C8c la fecha previa NO fue pisada');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'already_set', 'C8d fiscal_date_status=already_set');
END;
$$;

-- ── C9. Fallo REAL al escribir la metadata — fail-open ──────────────────────
-- C8 no ejercita el EXCEPTION: el UPDATE filtra por `fecha IS NULL`, no matchea
-- ninguna fila y sale por `already_set` sin lanzar nada. Para probar el
-- savepoint hay que hacer que el UPDATE EXPLOTE, así que se instala un trigger
-- saboteador temporal y se saca enseguida.
CREATE FUNCTION pg_temp.sabotaje() RETURNS trigger LANGUAGE plpgsql AS $sab$
BEGIN
  RAISE EXCEPTION 'sabotaje deliberado del UPDATE de metadata fiscal' USING ERRCODE = 'raise_exception';
END;
$sab$;

CREATE TRIGGER trg_fdp2_sabotaje
  BEFORE UPDATE OF fecha_comprobante_fiscal ON public.comprobantes
  FOR EACH ROW EXECUTE FUNCTION pg_temp.sabotaje();

DO $$
DECLARE c record; r jsonb;
BEGIN
  SELECT * INTO c FROM pg_temp.nuevo_caso('C9');
  r := public.complete_arca_attempt(c.attempt_id, 'authorized', 'CAE-C9', now(), 'A', NULL, NULL, '20260911');

  PERFORM pg_temp.assert(r->>'success' = 'true', 'C9a el completado NO falla aunque la metadata explote');
  PERFORM pg_temp.assert(r->>'fiscal_date_status' = 'metadata_failed', 'C9b fiscal_date_status=metadata_failed');
  PERFORM pg_temp.assert((SELECT cae FROM comprobantes WHERE id = c.comprobante_id) = 'CAE-C9',
    'C9c EL CAE SE PERSISTE — la metadata nunca puede tumbarlo');
  PERFORM pg_temp.assert((SELECT estado_fiscal FROM comprobantes WHERE id = c.comprobante_id) = 'emitido',
    'C9d no se degrada a pendiente_conciliacion por un fallo de metadata');
  PERFORM pg_temp.assert((SELECT numero_fiscal FROM comprobantes WHERE id = c.comprobante_id) IS NOT NULL,
    'C9e el numero_fiscal del completado canónico sobrevive al savepoint');
  PERFORM pg_temp.assert((SELECT status FROM arca_emission_attempts WHERE id = c.attempt_id) = 'authorized',
    'C9f el intento queda authorized');
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal IS NULL FROM comprobantes WHERE id = c.comprobante_id),
    'C9g la fecha queda NULL, para backfill');
END;
$$;

DROP TRIGGER trg_fdp2_sabotaje ON public.comprobantes;

-- ── D. Inmutabilidad ────────────────────────────────────────────────────────
DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM pg_temp.nuevo_caso('D1');

  -- NULL -> valor: permitido (es el camino del backfill controlado)
  UPDATE comprobantes SET fecha_comprobante_fiscal = DATE '2026-07-17' WHERE id = c.comprobante_id;
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-07-17',
    'D1 NULL -> fecha permitido');

  -- mismo valor: idempotente
  UPDATE comprobantes SET fecha_comprobante_fiscal = DATE '2026-07-17' WHERE id = c.comprobante_id;
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-07-17',
    'D2 misma fecha -> idempotente, no bloquea');

  -- valor distinto: bloqueado
  BEGIN
    UPDATE comprobantes SET fecha_comprobante_fiscal = DATE '2026-07-18' WHERE id = c.comprobante_id;
    PERFORM pg_temp.assert(false, 'D3 reescribir con otra fecha debía fallar');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert(SQLSTATE = '55006', 'D3 reescritura con otra fecha bloqueada (SQLSTATE 55006, fue ' || SQLSTATE || ')');
  END;
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-07-17',
    'D4 la fecha original sobrevive al intento de reescritura');

  -- borrar tampoco
  BEGIN
    UPDATE comprobantes SET fecha_comprobante_fiscal = NULL WHERE id = c.comprobante_id;
    PERFORM pg_temp.assert(false, 'D5 borrar la fecha debía fallar');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert(SQLSTATE = '55006', 'D5 borrar una fecha fiscal persistida también está bloqueado');
  END;

  -- un UPDATE que no menciona la columna no se ve afectado
  UPDATE comprobantes SET observaciones = 'nota posterior' WHERE id = c.comprobante_id;
  PERFORM pg_temp.assert((SELECT fecha_comprobante_fiscal FROM comprobantes WHERE id = c.comprobante_id) = DATE '2026-07-17',
    'D6 el trigger no interfiere con updates de otras columnas');
END;
$$;

-- ── E. Autoridad de escritura ───────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.comprobantes', 'fecha_comprobante_fiscal', 'UPDATE'),
    'E1 authenticated NO puede UPDATE la fecha fiscal');
  PERFORM pg_temp.assert(NOT has_column_privilege('anon', 'public.comprobantes', 'fecha_comprobante_fiscal', 'UPDATE'),
    'E2 anon tampoco');
  PERFORM pg_temp.assert(NOT has_column_privilege('authenticated', 'public.comprobantes', 'fecha_comprobante_fiscal', 'INSERT'),
    'E3 authenticated no puede sembrarla en un INSERT');
  PERFORM pg_temp.assert(has_column_privilege('authenticated', 'public.comprobantes', 'fecha_comprobante_fiscal', 'SELECT'),
    'E4 pero authenticated SÍ puede leerla (la UI la necesita)');
  PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', 'public.arca_parse_cbte_fch(text)', 'EXECUTE'),
    'E5 el parser no es callable por el cliente');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon', 'public.arca_parse_cbte_fch(text)', 'EXECUTE'),
    'E6 ni por anon');
END;
$$;

ROLLBACK;
