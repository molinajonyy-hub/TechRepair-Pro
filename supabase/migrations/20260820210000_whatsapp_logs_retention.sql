-- ============================================================================
-- Retención de `whatsapp_logs` — el contrato de privacidad de los mensajes.
--
-- POR QUÉ
-- `whatsapp_logs` guarda el teléfono del cliente y el CUERPO ÍNTEGRO de cada
-- mensaje preparado. Ese contenido lleva nombre, equipo, número de orden e
-- importes. Hasta ahora se conservaba indefinidamente y sin política.
--
-- EL CONTRATO
--   · 0 – 90 días   : intacto. Es el historial que el negocio usa a diario.
--   · 90 d – 12 mes : se REDACTA el teléfono, el cuerpo del mensaje y el detalle
--                     de error. Sobrevive la metadata operacional — cuándo, a qué
--                     orden, con qué plantilla, con qué resultado — así que el
--                     historial sigue contando que hubo un contacto.
--   · > 12 meses    : se ELIMINA la fila. La metadata tampoco se guarda para
--                     siempre.
--
-- POR QUÉ NO SE PONE `message` EN NULL
-- Es `NOT NULL` sin default (verificado contra la base productiva), así que un
-- UPDATE a NULL falla con 23502 en todas las filas. Se escribe un centinela
-- fijo, sin PII y sin nada del contenido original. NO se guarda un hash: un
-- hash de un mensaje corto es reversible por fuerza bruta, así que sería
-- conservar el dato con otro nombre.
--
-- SEGURIDAD
-- Se replica EXACTAMENTE el patrón que el proyecto ya tiene vivo para
-- `expire_trials()` y `enforce_grace_period()`: función SECURITY DEFINER en
-- `public`, `search_path` fijo terminando en `pg_temp`, owner `postgres`,
-- EXECUTE revocado a PUBLIC/anon/authenticated y otorgado sólo a
-- `service_role`. Verificado en producción: esas tres funciones tienen
-- exactamente `postgres=X/postgres | service_role=X/postgres`.
--
-- `pg_temp` va AL FINAL de search_path a propósito: omitirlo lo pone PRIMERO y
-- deja abierto el secuestro de nombres por una tabla temporal del llamador.
-- ============================================================================

BEGIN;

-- ── 0. Precondición fail-closed ─────────────────────────────────────────────
-- Si el esquema no es el que esta migración cree que es, aborta. Una retención
-- que redacta la columna equivocada —o que no redacta nada porque una columna
-- se renombró— es peor que no tener retención: da por cumplido un contrato de
-- privacidad que no se está cumpliendo.
DO $precheck$
DECLARE
  v_faltantes text;
  v_message_nullable boolean;
BEGIN
  SELECT string_agg(c.col, ', ')
    INTO v_faltantes
  FROM (VALUES ('id'),('business_id'),('order_id'),('customer_id'),('phone'),
               ('status_key'),('message'),('send_mode'),('send_result'),
               ('error_message'),('created_at')) AS c(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='whatsapp_logs' AND column_name=c.col);

  IF v_faltantes IS NOT NULL THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: whatsapp_logs no tiene la(s) columna(s) esperada(s): %', v_faltantes;
  END IF;

  SELECT is_nullable = 'YES' INTO v_message_nullable
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='whatsapp_logs' AND column_name='message';

  -- No es un problema si cambia, pero la estrategia del centinela existe
  -- PORQUE es NOT NULL. Si dejara de serlo hay que revisar esta decisión.
  IF v_message_nullable THEN
    RAISE NOTICE 'RETENCIÓN: whatsapp_logs.message ya es nullable; el centinela se mantiene igual por compatibilidad con la UI.';
  END IF;
END $precheck$;

-- ── 1. Índice para el barrido por fecha ─────────────────────────────────────
-- No existía: los índices eran por business_id y order_id. Sin éste, el job
-- haría un seq scan cada día, y crece con la tabla.
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_created_at
  ON public.whatsapp_logs USING btree (created_at);

-- ── 2. El centinela ─────────────────────────────────────────────────────────
-- Función IMMUTABLE para tener UN solo lugar donde vive el texto: lo usan la
-- retención, los tests y —por su valor literal— la UI.
CREATE OR REPLACE FUNCTION public.whatsapp_log_redaction_marker()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT '[contenido eliminado por política de retención]'::text $$;

COMMENT ON FUNCTION public.whatsapp_log_redaction_marker() IS
  'Centinela que reemplaza el cuerpo del mensaje al vencer la retención de 90 días. No se expone al cliente: el frontend compara contra su propia constante en src/services/whatsappRetention.ts, y un test asevera que coincidan.';

-- ── 3. El mantenimiento ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_whatsapp_logs_retention(p_limite integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_marca      text := public.whatsapp_log_redaction_marker();
  v_borradas   integer := 0;
  v_redactadas integer := 0;
  v_limite     integer := greatest(1, least(coalesce(p_limite, 5000), 100000));
BEGIN
  -- ACOTADO: se procesa de a lotes para no tomar la tabla entera en una sola
  -- transacción si algún día crece. Con el job diario, un backlog se drena solo.
  --
  -- SIN business_id: es mantenimiento por EDAD, igual para todos los negocios.
  -- No hay forma de que un llamador apunte a los datos de un tenant en
  -- particular, porque no hay ningún parámetro con el que hacerlo.

  -- Toda relación va calificada con `public.`, incluidas las subconsultas. No
  -- se usan CTEs a propósito: con `public` en el search_path, cualquier nombre
  -- sin calificar dentro de una SECURITY DEFINER es exactamente el patrón que
  -- el guard del repo vigila, y un CTE se le parece lo suficiente como para
  -- que no valga la pena discutirlo.

  -- 3.a — Borrado a los 12 meses. Va PRIMERO: redactar una fila que se va a
  -- borrar en el mismo pase sería trabajo perdido.
  DELETE FROM public.whatsapp_logs l
   WHERE l.id IN (
     SELECT w.id FROM public.whatsapp_logs w
      WHERE w.created_at <= now() - interval '12 months'
      ORDER BY w.created_at
      LIMIT v_limite);
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  -- 3.b — Redacción a los 90 días.
  --
  -- IDEMPOTENTE: el filtro exige que quede algo por redactar. En la segunda
  -- corrida, `phone` y `error_message` ya son NULL y `message` ya es el
  -- centinela, así que no matchea ninguna fila y el UPDATE toca 0.
  UPDATE public.whatsapp_logs l
     SET phone         = NULL,
         message       = v_marca,
         error_message = NULL
   WHERE l.id IN (
     SELECT w.id FROM public.whatsapp_logs w
      WHERE w.created_at <= now() - interval '90 days'
        AND (w.phone IS NOT NULL OR w.error_message IS NOT NULL OR w.message <> v_marca)
      ORDER BY w.created_at
      LIMIT v_limite);
  GET DIAGNOSTICS v_redactadas = ROW_COUNT;

  -- AUDITABLE: queda en el log de Postgres, que es donde se puede mirar qué
  -- hizo el job de anoche. No se registra ningún dato de los que se purgaron.
  IF v_borradas > 0 OR v_redactadas > 0 THEN
    RAISE NOTICE 'whatsapp_logs retention: % fila(s) borrada(s) (>12m), % redactada(s) (>90d)', v_borradas, v_redactadas;
  END IF;

  RETURN jsonb_build_object(
    'borradas',   v_borradas,
    'redactadas', v_redactadas,
    'limite',     v_limite,
    'ejecutado',  now()
  );
END;
$fn$;

COMMENT ON FUNCTION public.apply_whatsapp_logs_retention(integer) IS
  'Retención de whatsapp_logs: redacta teléfono, mensaje y error a los 90 días; borra la fila a los 12 meses. Idempotente y acotada. La corre pg_cron a diario.';

-- ── 4. Privilegios ──────────────────────────────────────────────────────────
-- EXECUTE a PUBLIC es el DEFAULT de PostgreSQL para toda función nueva, así que
-- revocarlo no es opcional: sin esto, cualquier usuario autenticado podría
-- disparar la purga de todos los negocios.
ALTER FUNCTION public.apply_whatsapp_logs_retention(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_whatsapp_logs_retention(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_logs_retention(integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_whatsapp_logs_retention(integer) TO service_role;

-- El centinela tampoco se expone al cliente. La primera versión de esta
-- migración le daba EXECUTE a `anon` «porque la UI lo compara», y era falso: el
-- frontend compara contra su propia constante en
-- `src/services/whatsappRetention.ts`, y hay un test que asevera que los dos
-- literales coincidan. Nadie lo llama por RPC, así que no hay razón para que
-- exista esa superficie. Lo cazó `guard:secdef-exposure`.
REVOKE ALL ON FUNCTION public.whatsapp_log_redaction_marker() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_log_redaction_marker() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.whatsapp_log_redaction_marker() TO service_role;

-- ── 5. Backfill de los históricos ───────────────────────────────────────────
-- El mismo contrato, aplicado de una vez a lo que ya está. Se reporta sólo el
-- conteo: nunca un teléfono ni un mensaje.
DO $backfill$
DECLARE
  v_antes  jsonb;
  v_r      jsonb;
  v_despues jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total', count(*),
    'vigentes_0_90d', count(*) FILTER (WHERE created_at > now() - interval '90 days'),
    'con_pii_vencida', count(*) FILTER (WHERE created_at <= now() - interval '90 days'
                                          AND (phone IS NOT NULL OR error_message IS NOT NULL
                                               OR message <> public.whatsapp_log_redaction_marker())),
    'mas_12m', count(*) FILTER (WHERE created_at <= now() - interval '12 months'))
    INTO v_antes FROM public.whatsapp_logs;
  RAISE NOTICE 'RETENCIÓN · antes: %', v_antes;

  -- Lote amplio a propósito: es una sola vez y la tabla es chica.
  SELECT public.apply_whatsapp_logs_retention(100000) INTO v_r;
  RAISE NOTICE 'RETENCIÓN · aplicada: %', v_r;

  SELECT jsonb_build_object(
    'total', count(*),
    'con_pii_vencida', count(*) FILTER (WHERE created_at <= now() - interval '90 days'
                                          AND (phone IS NOT NULL OR error_message IS NOT NULL
                                               OR message <> public.whatsapp_log_redaction_marker())),
    'mas_12m', count(*) FILTER (WHERE created_at <= now() - interval '12 months'))
    INTO v_despues FROM public.whatsapp_logs;
  RAISE NOTICE 'RETENCIÓN · después: %', v_despues;

  -- Postcondición: después del backfill no puede quedar PII vencida.
  IF (v_despues->>'con_pii_vencida')::int <> 0 THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: quedaron % fila(s) con PII vencida después del backfill', v_despues->>'con_pii_vencida';
  END IF;
  IF (v_despues->>'mas_12m')::int <> 0 THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: quedaron % fila(s) de más de 12 meses', v_despues->>'mas_12m';
  END IF;
END $backfill$;

-- ── 6. Postcondiciones de privilegio ────────────────────────────────────────
DO $post$
BEGIN
  IF has_function_privilege('anon', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: anon puede ejecutar el mantenimiento';
  END IF;
  IF has_function_privilege('authenticated', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: authenticated puede ejecutar el mantenimiento';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.apply_whatsapp_logs_retention(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: service_role NO puede ejecutar el mantenimiento; el job de cron no correría';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND tablename='whatsapp_logs'
                    AND indexname='idx_whatsapp_logs_created_at') THEN
    RAISE EXCEPTION 'RETENCIÓN ABORTA: falta el índice por created_at';
  END IF;
END $post$;

COMMIT;

-- ── 7. Programación ─────────────────────────────────────────────────────────
-- EL JOB NO SE CREA DESDE ACÁ, y no es un olvido: es el patrón del proyecto.
-- `pg_cron` ya corre dos jobs en producción (`billing-expire-trials` a las 03:00
-- y `billing-enforce-grace` a las 03:05), y ninguno se creó desde una migración
-- —se documentan y se aplican a mano contra el proyecto. Meterlo acá haría que
-- cada `db reset` local intente crear un job de cron que en local no aplica.
--
-- Ejecutar UNA vez contra el proyecto productivo, con el rol postgres:
--
--   SELECT cron.schedule(
--     'whatsapp-logs-retention',
--     '20 3 * * *',                                   -- diario 03:20, después de los de billing
--     $cron$ SELECT public.apply_whatsapp_logs_retention(); $cron$
--   );
--
-- Para verificarlo:
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'whatsapp-logs-retention';
--   SELECT status, return_message, start_time
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='whatsapp-logs-retention')
--    ORDER BY start_time DESC LIMIT 5;
--
-- Diario alcanza: la ventana es de 90 días, así que un día de atraso no mueve
-- la aguja. Y como es idempotente, correrlo de más no hace nada.
