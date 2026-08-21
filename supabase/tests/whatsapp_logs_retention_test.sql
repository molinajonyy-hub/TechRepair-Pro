-- ============================================================================
-- Retención de whatsapp_logs — test determinista.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/whatsapp_logs_retention_test.sql
--
-- Corre entero dentro de una transacción que hace ROLLBACK: no deja nada, ni
-- siquiera si falla. Los datos son ficticios y las fechas se fabrican con
-- offsets sobre now(), así que el resultado no depende del día en que se corra.
--
-- Cubre los diez casos del contrato: A 89d intacto · B 91d redactado ·
-- C metadata preservada · D 364d redactado y vivo · E >12m eliminado ·
-- F idempotencia · G anon no ejecuta · H authenticated no ejecuta ·
-- I service_role sí · J la UI no revienta (contrato de datos que consume).
-- ============================================================================

BEGIN;

\set ON_ERROR_STOP on

-- ── Andamiaje ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.chequear(p_nombre text, p_ok boolean, p_detalle text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok THEN
    RAISE NOTICE '  OK    %', p_nombre;
  ELSE
    RAISE EXCEPTION 'FALLA: % %', p_nombre, coalesce(' · ' || p_detalle, '');
  END IF;
END $$;

-- Un negocio ficticio propio, REAL — no se desactivan las FKs.
--
-- Importa: la redacción es un UPDATE, y un UPDATE revalida
-- `whatsapp_logs_business_id_fkey`. Sembrar con las FKs apagadas y después
-- correr la retención con ellas prendidas hacía fallar el test — que es
-- exactamente lo que pasaría en producción con una fila huérfana. Con el
-- negocio de verdad se ejercita el camino real.
DO $seed$
DECLARE
  v_biz uuid := '00000000-0000-0000-0000-0000e7e57e57';
  v_marca text := public.whatsapp_log_redaction_marker();
BEGIN
  DELETE FROM public.whatsapp_logs WHERE business_id = v_biz;
  DELETE FROM public.businesses    WHERE id = v_biz;
  INSERT INTO public.businesses (id, name) VALUES (v_biz, 'Negocio de prueba · retención');

  -- Los cinco casos de edad. `phone` y `message` llevan datos ficticios
  -- reconocibles para poder aseverar que desaparecen.
  INSERT INTO public.whatsapp_logs
    (id, business_id, phone, status_key, message, send_mode, send_result, error_message, created_at)
  VALUES
    ('00000000-0000-0000-0000-00000000a089', v_biz, '5490000000089', 'ready_pickup',
     'PII-89-DIAS Hola Ana, tu equipo esta listo.', 'manual', 'opened', NULL,
     now() - interval '89 days'),

    ('00000000-0000-0000-0000-00000000a091', v_biz, '5490000000091', 'ready_pickup',
     'PII-91-DIAS Hola Beto, tu equipo esta listo.', 'manual', 'opened', 'PII-91-ERROR 5490000000091',
     now() - interval '91 days'),

    ('00000000-0000-0000-0000-00000000a364', v_biz, '5490000000364', 'received',
     'PII-364-DIAS Hola Carla, recibimos tu equipo.', 'api', 'sent_api', NULL,
     now() - interval '364 days'),

    ('00000000-0000-0000-0000-00000000a400', v_biz, '5490000000400', 'received',
     'PII-400-DIAS Hola Dario.', 'manual', 'copied', NULL,
     now() - interval '400 days'),

    ('00000000-0000-0000-0000-00000000a001', v_biz, '5490000000001', 'free_message',
     'PII-HOY Hola Elena.', 'manual', 'opened', NULL,
     now() - interval '1 day');

  PERFORM pg_temp.chequear('seed: 5 filas sembradas',
    (SELECT count(*) FROM public.whatsapp_logs WHERE business_id = v_biz) = 5);
  PERFORM v_marca;
END $seed$;

-- ── Primera ejecución ───────────────────────────────────────────────────────
DO $ejecutar$
DECLARE v_r jsonb;
BEGIN
  SELECT public.apply_whatsapp_logs_retention() INTO v_r;
  RAISE NOTICE 'retención devolvió: %', v_r;
  PERFORM pg_temp.chequear('la función devuelve conteos',
    (v_r ? 'borradas') AND (v_r ? 'redactadas'), v_r::text);
END $ejecutar$;

-- ── A · 89 días: intacto ────────────────────────────────────────────────────
DO $a$
DECLARE r public.whatsapp_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a089';
  PERFORM pg_temp.chequear('A · 89 días: la fila sigue', r.id IS NOT NULL);
  PERFORM pg_temp.chequear('A · 89 días: teléfono INTACTO', r.phone = '5490000000089', coalesce(r.phone,'NULL'));
  PERFORM pg_temp.chequear('A · 89 días: mensaje INTACTO', r.message LIKE 'PII-89-DIAS%');
END $a$;

-- ── B · 91 días: redactado ──────────────────────────────────────────────────
DO $b$
DECLARE r public.whatsapp_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a091';
  PERFORM pg_temp.chequear('B · 91 días: la fila sigue existiendo', r.id IS NOT NULL);
  PERFORM pg_temp.chequear('B · 91 días: teléfono REDACTADO', r.phone IS NULL, coalesce(r.phone,'NULL'));
  PERFORM pg_temp.chequear('B · 91 días: mensaje REDACTADO',
    r.message = public.whatsapp_log_redaction_marker(), r.message);
  PERFORM pg_temp.chequear('B · 91 días: no queda rastro del contenido original',
    r.message NOT LIKE '%PII-91%');
  PERFORM pg_temp.chequear('B · 91 días: error_message REDACTADO',
    r.error_message IS NULL, coalesce(r.error_message,'NULL'));
  -- Ni hash ni copia parcial: el dato no puede quedar de ninguna forma.
  PERFORM pg_temp.chequear('B · 91 días: el teléfono no sobrevive en ninguna columna de texto',
    coalesce(r.message,'') || coalesce(r.phone,'') || coalesce(r.error_message,'') || coalesce(r.status_key,'')
      NOT LIKE '%5490000000091%');
END $b$;

-- ── C · metadata operacional preservada ─────────────────────────────────────
DO $c$
DECLARE r public.whatsapp_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a091';
  PERFORM pg_temp.chequear('C · business_id preservado', r.business_id = '00000000-0000-0000-0000-0000e7e57e57');
  PERFORM pg_temp.chequear('C · created_at preservado', r.created_at IS NOT NULL);
  PERFORM pg_temp.chequear('C · send_result preservado', r.send_result = 'opened', r.send_result);
  PERFORM pg_temp.chequear('C · send_mode preservado', r.send_mode = 'manual', r.send_mode);
  PERFORM pg_temp.chequear('C · status_key preservado', r.status_key = 'ready_pickup', coalesce(r.status_key,'NULL'));
END $c$;

-- ── D · 364 días: redactado pero VIVO ───────────────────────────────────────
DO $d$
DECLARE r public.whatsapp_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a364';
  PERFORM pg_temp.chequear('D · 364 días: la fila NO se borra todavía', r.id IS NOT NULL);
  PERFORM pg_temp.chequear('D · 364 días: payload redactado',
    r.phone IS NULL AND r.message = public.whatsapp_log_redaction_marker());
  PERFORM pg_temp.chequear('D · 364 días: metadata intacta',
    r.send_result = 'sent_api' AND r.send_mode = 'api');
END $d$;

-- ── E · más de 12 meses: eliminada ──────────────────────────────────────────
DO $e$
BEGIN
  PERFORM pg_temp.chequear('E · 400 días: la fila fue ELIMINADA',
    NOT EXISTS (SELECT 1 FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a400'));
  PERFORM pg_temp.chequear('E · quedan 4 de las 5 sembradas',
    (SELECT count(*) FROM public.whatsapp_logs WHERE business_id='00000000-0000-0000-0000-0000e7e57e57') = 4);
  -- La de ayer no se tocó: la retención no puede comerse el historial vivo.
  PERFORM pg_temp.chequear('E · la fila de ayer sigue intacta',
    (SELECT message FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a001') LIKE 'PII-HOY%');
END $e$;

-- ── F · idempotencia ────────────────────────────────────────────────────────
DO $f$
DECLARE v_r jsonb;
BEGIN
  SELECT public.apply_whatsapp_logs_retention() INTO v_r;
  PERFORM pg_temp.chequear('F · segunda corrida: 0 borradas',
    (v_r->>'borradas')::int = 0, v_r::text);
  PERFORM pg_temp.chequear('F · segunda corrida: 0 redactadas',
    (v_r->>'redactadas')::int = 0, v_r::text);

  -- Y una tercera, por si la idempotencia dependiera de la paridad.
  SELECT public.apply_whatsapp_logs_retention() INTO v_r;
  PERFORM pg_temp.chequear('F · tercera corrida: sigue en 0',
    (v_r->>'borradas')::int = 0 AND (v_r->>'redactadas')::int = 0, v_r::text);
END $f$;

-- ── G/H/I · privilegios ─────────────────────────────────────────────────────
DO $ghi$
BEGIN
  PERFORM pg_temp.chequear('G · anon NO puede ejecutar el mantenimiento',
    NOT has_function_privilege('anon', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE'));
  PERFORM pg_temp.chequear('H · authenticated NO puede ejecutar el mantenimiento',
    NOT has_function_privilege('authenticated', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE'));
  PERFORM pg_temp.chequear('I · service_role SÍ puede ejecutarlo',
    has_function_privilege('service_role', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE'));

  -- EXECUTE a PUBLIC es el default de PostgreSQL: si alguien recreara la
  -- función sin el REVOKE, esto lo caza.
  PERFORM pg_temp.chequear('G/H · PUBLIC no tiene EXECUTE',
    NOT has_function_privilege('public', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE'));

  -- El search_path tiene que terminar en pg_temp, no empezar.
  PERFORM pg_temp.chequear('search_path fijo y con pg_temp AL FINAL',
    (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='apply_whatsapp_logs_retention') = 'search_path=public, pg_temp',
    (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='apply_whatsapp_logs_retention'));

  PERFORM pg_temp.chequear('la función es SECURITY DEFINER',
    (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='apply_whatsapp_logs_retention'));
END $ghi$;

-- ── J · contrato de datos que consume la UI ─────────────────────────────────
-- Las dos pantallas que leen esta tabla hacen `select('*')`. Lo que tiene que
-- sostenerse es que una fila redactada siga siendo una fila válida: sin NULLs
-- donde el tipo de TypeScript declara string, y con el centinela reconocible
-- para poder mostrar el aviso en vez del texto crudo.
DO $j$
DECLARE r public.whatsapp_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.whatsapp_logs WHERE id='00000000-0000-0000-0000-00000000a091';
  PERFORM pg_temp.chequear('J · message sigue siendo NOT NULL (el tipo TS dice string)',
    r.message IS NOT NULL);
  PERFORM pg_temp.chequear('J · message no queda vacío: la UI mostraría una caja en blanco',
    length(btrim(r.message)) > 0);
  PERFORM pg_temp.chequear('J · el centinela es reconocible desde el frontend',
    r.message = public.whatsapp_log_redaction_marker());
  PERFORM pg_temp.chequear('J · send_result sigue dentro del CHECK que la UI mapea',
    r.send_result IN ('opened','copied','failed','skipped','sent_api'), r.send_result);
  PERFORM pg_temp.chequear('J · la fila redactada sobrevive a un SELECT * completo',
    (SELECT count(*) FROM public.whatsapp_logs WHERE id = r.id) = 1);
END $j$;

-- ── Extra · el índice existe ────────────────────────────────────────────────
DO $idx$
BEGIN
  PERFORM pg_temp.chequear('índice por created_at presente',
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND tablename='whatsapp_logs' AND indexname='idx_whatsapp_logs_created_at'));
END $idx$;

DO $fin$ BEGIN RAISE NOTICE '✓ retención de whatsapp_logs: todos los chequeos pasaron'; END $fin$;

-- No deja nada.
ROLLBACK;
