-- ============================================================================
-- M7 Lote 7C — Health Check Financiero v2.
--
-- READ-ONLY POR DISEÑO, ENFORCEADO POR POSTGRES: la funcion es STABLE. Una
-- funcion no-VOLATILE no puede ejecutar INSERT/UPDATE/DELETE — Postgres aborta
-- con "INSERT is not allowed in a non-volatile function". No es disciplina:
-- es el motor. No inserta resultados, no corrige saldos, no crea
-- reconciliaciones, no abre ni cierra periodos.
--
-- CONTRATO: superset ADITIVO del de finance_health_check (v1). Los campos que
-- consume src/pages/FinanceHealthCheck.tsx (id, title, severity, status, count,
-- description, rows / ok, critical_count, warning_count, low_count,
-- total_issues, business_id, checked_at) se emiten IDENTICOS. El frontend puede
-- migrar cambiando solo el nombre de la RPC. v1 queda intacta.
--
-- SEMANTICA DE NOTAS DE CREDITO (definida por el dueño del producto, 7B.1):
--   · la NC revierte ingreso/cobro;
--   · el COGS se revierte SOLO si hubo devolucion fisica / restauracion de stock;
--   · una NC total sin retorno de mercaderia puede producir legitimamente
--     ventas netas cero, COGS positivo y perdida.
--   Por eso credit_reversal e inventory_return son dimensiones SEPARADAS y la
--   ausencia de retorno en una NC financiera pura es INFO, nunca fail.
-- ============================================================================

-- ── Constructor de check (puro) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."finance_hc_mk"(
  p_id text, p_category text, p_title text, p_result text, p_severity text,
  p_count bigint, p_amount numeric, p_message text,
  p_details jsonb DEFAULT '{}'::jsonb, p_rows jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    -- ── contrato v1 (frontend actual) — NO TOCAR ──
    'id',          p_id,
    'title',       p_title,
    'status',      CASE p_result WHEN 'pass' THEN 'ok' WHEN 'fail' THEN 'critical'
                                 WHEN 'warn' THEN 'warning' ELSE 'low' END,
    'severity',    CASE WHEN p_severity IN ('critical','high') THEN 'critical'
                        WHEN p_severity = 'medium' THEN 'warning' ELSE 'low' END,
    'count',       p_count,
    'description', p_message,
    'rows',        COALESCE(p_rows, '[]'::jsonb),
    -- ── v2 aditivo ──
    'check_id',       p_id,
    'category',       p_category,
    'result',         p_result,          -- pass | warn | fail | info
    'severity_level', p_severity,        -- critical | high | medium | low | info
    'amount_ars',     round(COALESCE(p_amount, 0), 2),
    'message',        p_message,
    'details',        COALESCE(p_details, '{}'::jsonb),
    'version',        'm7_health_v2'
  );
$$;
ALTER FUNCTION "public"."finance_hc_mk"(text,text,text,text,text,bigint,numeric,text,jsonb,jsonb) OWNER TO "postgres";

-- ── Gate de operador para los checks GLOBALES (7C.1 §8) ─────────────────────
-- p_include_global es un parametro del CLIENTE: por si solo no autoriza nada.
-- Los checks globales revelan nombres de funciones, grants y configuracion de
-- seguridad de la plataforma, asi que se exige una condicion REAL: ser owner
-- del negocio, verificado server-side contra businesses.owner_user_id.
CREATE OR REPLACE FUNCTION "public"."finance_hc_can_see_global"(p_business_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.businesses b
                  WHERE b.id = p_business_id AND b.owner_user_id = auth.uid());
$$;
ALTER FUNCTION "public"."finance_hc_can_see_global"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_hc_can_see_global"(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."finance_hc_can_see_global"(uuid) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."finance_hc_can_see_global"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_hc_can_see_global"(uuid) TO "service_role";

-- ── Health check v2 ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."finance_health_check_v2"(
  "p_business_id" uuid DEFAULT NULL,
  "p_include_global" boolean DEFAULT false
) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_t0      timestamptz := clock_timestamp();
  v_actor   uuid := auth.uid();
  v_biz     uuid := p_business_id;
  v_access  boolean := false;
  v_c       jsonb := '[]'::jsonb;   -- acumulador de checks
  n         bigint;
  m         numeric;
  d         jsonb;
  v_has_ledger  boolean := to_regclass('public.v_finance_sales_ledger') IS NOT NULL;
  v_has_audit   boolean := to_regclass('public.finance_audit_log') IS NOT NULL;
  v_has_locks   boolean := to_regclass('public.finance_period_locks') IS NOT NULL;
  v_has_recon   boolean := to_regclass('public.finance_ledger_reconciliation') IS NOT NULL;
  v_has_repl    boolean := EXISTS(SELECT 1 FROM information_schema.columns
                                   WHERE table_name='comprobante_payments' AND column_name='replaced_at');
  v_has_anndate boolean := EXISTS(SELECT 1 FROM information_schema.columns
                                   WHERE table_name='comprobante_annulments' AND column_name='annulment_date');
BEGIN
  -- ── Autenticacion y aislamiento por negocio ───────────────────────────────
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No autenticado');
  END IF;
  IF v_biz IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_id requerido');
  END IF;
  SELECT (EXISTS (SELECT 1 FROM businesses WHERE id=v_biz AND owner_user_id=v_actor)
       OR EXISTS (SELECT 1 FROM profiles WHERE business_id=v_biz AND COALESCE(user_id,id)=v_actor
                    AND COALESCE(is_active,true))) INTO v_access;
  IF NOT v_access THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sin acceso a este negocio');
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: periods
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_has_locks THEN
    SELECT count(*) INTO n FROM finance_period_locks a JOIN finance_period_locks b
      ON a.business_id=b.business_id AND a.id<>b.id AND a.status='closed' AND b.status='closed'
     AND a.period_start <= b.period_end AND b.period_start <= a.period_end
     WHERE a.business_id=v_biz;
    v_c := v_c || finance_hc_mk('period_locks_overlapping','periods','Períodos cerrados superpuestos',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Sin solapamientos entre períodos cerrados'
           ELSE n||' par(es) de períodos cerrados se superponen: una fecha puede caer en dos locks' END);

    SELECT count(*) INTO n FROM finance_period_locks
     WHERE business_id=v_biz AND reopened_at IS NOT NULL AND COALESCE(btrim(reopen_reason),'')='';
    v_c := v_c || finance_hc_mk('period_reopened_without_reason','periods','Reaperturas sin motivo',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Toda reapertura tiene motivo' ELSE n||' reapertura(s) sin motivo documentado' END);

    SELECT count(*) INTO n FROM finance_period_locks
     WHERE business_id=v_biz AND reopened_at IS NOT NULL AND closed_at IS NOT NULL AND reopened_at < closed_at;
    v_c := v_c || finance_hc_mk('period_reopen_out_of_order','periods','Reapertura anterior al cierre',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Cierres y reaperturas en orden' ELSE n||' período(s) reabiertos antes de cerrarse' END);

    -- Escrituras economicas fechadas DENTRO de un periodo cerrado pero creadas
    -- DESPUES del cierre. Una compensacion de HOY que referencia un asiento de
    -- un periodo cerrado NO cuenta: su `date` es de hoy, no del período cerrado.
    SELECT count(*), COALESCE(SUM(f.amount_ars),0) INTO n, m
      FROM financial_movements f JOIN finance_period_locks l
        ON l.business_id=f.business_id AND l.status='closed'
       AND (f.date AT TIME ZONE 'America/Argentina/Cordoba')::date BETWEEN l.period_start AND l.period_end
     WHERE f.business_id=v_biz AND f.created_at > l.closed_at;
    v_c := v_c || finance_hc_mk('writes_after_period_close','periods','Escrituras dentro de un período cerrado',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
      CASE WHEN n=0 THEN 'Ningún movimiento se escribió dentro de un período ya cerrado'
           ELSE n||' movimiento(s) fechados en un período cerrado fueron creados DESPUÉS del cierre' END);
  END IF;

  SELECT count(*) INTO n FROM financial_movements WHERE business_id=v_biz AND date IS NULL;
  v_c := v_c || finance_hc_mk('entities_null_economic_date','periods','Movimientos sin fecha económica',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Toda entidad económica tiene fecha' ELSE n||' movimiento(s) sin fecha económica' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: audit
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_has_audit THEN
    SELECT count(*) INTO n FROM finance_audit_log WHERE business_id=v_biz AND actor_user_id IS NULL;
    v_c := v_c || finance_hc_mk('audit_without_actor','audit','Eventos de auditoría sin actor',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Todo evento tiene actor' ELSE n||' evento(s) sin actor' END);

    SELECT count(*) INTO n FROM finance_audit_log l
     WHERE l.business_id=v_biz AND l.entity_table='comprobantes'
       AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=l.entity_id);
    v_c := v_c || finance_hc_mk('audit_entity_missing','audit','Eventos que apuntan a entidades inexistentes',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Todas las referencias de auditoría resuelven' ELSE n||' evento(s) apuntan a un comprobante inexistente' END);

    SELECT count(*) INTO n FROM finance_audit_log l JOIN comprobantes c ON c.id=l.entity_id
     WHERE l.business_id=v_biz AND l.entity_table='comprobantes' AND c.business_id <> l.business_id;
    v_c := v_c || finance_hc_mk('audit_cross_business','audit','Auditoría cross-business',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Sin referencias cross-business en la auditoría' ELSE n||' evento(s) referencian entidades de otro negocio' END);

    -- Una anulacion canonica DEBE tener su evento explicito (uno solo).
    SELECT count(*) INTO n FROM comprobante_annulments a
     WHERE a.business_id=v_biz AND a.status='completed'
       AND NOT EXISTS (SELECT 1 FROM finance_audit_log l
                        WHERE l.entity_id=a.comprobante_id AND l.source_rpc='annul_comprobante_atomic');
    v_c := v_c || finance_hc_mk('annulment_without_audit_event','audit','Anulaciones sin evento de auditoría',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Toda anulación canónica tiene su evento'
           ELSE n||' anulación(es) sin evento. Las reconciliaciones históricas (7B) y las anulaciones M6 previas a M7 no lo tienen: revisar contra finance_ledger_reconciliation' END);

    SELECT count(*) INTO n FROM (
      SELECT l.entity_id, l.request_id FROM finance_audit_log l
       WHERE l.business_id=v_biz AND l.request_id IS NOT NULL
       GROUP BY 1,2 HAVING count(*)>1) x;
    v_c := v_c || finance_hc_mk('audit_duplicated_per_request','audit','Más de un evento por request',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Un evento de negocio por request' ELSE n||' request(s) con más de un evento de negocio' END);

    -- §5: la fecha economica del evento debe coincidir con la del asiento que creo.
    SELECT count(*) INTO n FROM finance_audit_log l
     WHERE l.business_id=v_biz AND l.economic_date IS NULL AND l.source_rpc IS NOT NULL;
    v_c := v_c || finance_hc_mk('audit_without_economic_date','audit','Eventos sin fecha económica',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Todo evento de una RPC lleva su fecha económica' ELSE n||' evento(s) sin economic_date' END);

    -- La compensacion de una anulacion debe fecharse el dia de la anulacion, no
    -- en el periodo original. (Una compensacion que REFERENCIA un asiento de un
    -- periodo cerrado es correcta y NO se marca: lo que importa es su propia fecha.)
    SELECT count(*) INTO n FROM finance_audit_log l JOIN comprobante_annulments a
        ON a.comprobante_id=l.entity_id AND a.status='completed'
     WHERE l.business_id=v_biz AND l.source_rpc='annul_comprobante_atomic'
       AND v_has_anndate AND a.annulment_date IS NOT NULL
       AND l.economic_date IS DISTINCT FROM a.annulment_date;
    v_c := v_c || finance_hc_mk('audit_date_vs_entry','audit','Fecha del evento vs fecha del asiento',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'La fecha de cada evento coincide con la del asiento que creó'
           ELSE n||' evento(s) con fecha distinta a la de su anulación' END);

    SELECT count(*) INTO n FROM finance_audit_log
     WHERE business_id=v_biz AND source_rpc='finance_audit_backstop';
    v_c := v_c || finance_hc_mk('backstop_events','audit','Escrituras E1 capturadas por el backstop',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Ninguna escritura directa a tablas E1 fuera de una RPC gestionada'
           ELSE n||' escritura(s) E1 sin evento explícito: alguien escribió fuera de las RPC canónicas' END);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: idempotency  (tabla vacia => pass, no warn)
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*) INTO n FROM (
    SELECT business_id, idempotency_key FROM comprobante_annulments
     WHERE business_id=v_biz AND idempotency_key IS NOT NULL
     GROUP BY 1,2 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('request_keys_duplicated','idempotency','Claves de idempotencia duplicadas',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Sin claves duplicadas' ELSE n||' clave(s) repetidas: el índice único debería impedirlo' END);

  SELECT count(*) INTO n FROM comprobante_annulments
   WHERE business_id=v_biz AND (COALESCE(btrim(idempotency_key),'')='' OR COALESCE(btrim(request_hash),'')='');
  v_c := v_c || finance_hc_mk('request_key_or_hash_empty','idempotency','Requests sin clave o sin hash',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Toda request tiene clave y hash' ELSE n||' request(s) sin clave o sin hash' END);

  SELECT count(*) INTO n FROM comprobante_annulments
   WHERE business_id=v_biz AND status IS NOT NULL AND status NOT IN ('completed','processing');
  v_c := v_c || finance_hc_mk('request_unknown_status','idempotency','Estados de request desconocidos',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todos los estados son conocidos (status NULL = legacy M6 compatible)'
         ELSE n||' request(s) con estado no reconocido' END);

  -- MD5 (32 hex) = M6; SHA-256 (64 hex) = M7. Ambos coexisten: es info.
  SELECT count(*) INTO n FROM comprobante_annulments
   WHERE business_id=v_biz AND length(request_hash)=32;
  v_c := v_c || finance_hc_mk('request_hash_legacy_md5','idempotency','Requests con hash MD5 (pre-M7)',
    CASE WHEN n=0 THEN 'pass' ELSE 'info' END, 'info', n, 0,
    CASE WHEN n=0 THEN 'Todos los hashes son SHA-256 (algoritmo declarado por M7)'
         ELSE n||' request(s) con hash MD5 heredado de M6. Un reintento de esas claves daría IDEMPOTENCY_CONFLICT en vez de replay; el índice único por comprobante impide la doble anulación igual' END);

  IF v_has_repl THEN
    SELECT count(*) INTO n FROM comprobante_payment_replace_requests q
     WHERE q.business_id=v_biz AND q.status='completed' AND q.new_payment_id IS NULL;
    v_c := v_c || finance_hc_mk('request_completed_without_entity','idempotency','Requests completadas sin entidad',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Toda request completada tiene su entidad resultante' ELSE n||' completadas sin pago resultante' END);

    SELECT count(*) INTO n FROM comprobante_payment_replace_requests q
     WHERE q.business_id=v_biz AND q.status='stale_source' AND q.new_payment_id IS NOT NULL;
    v_c := v_c || finance_hc_mk('request_stale_with_entity','idempotency','Requests stale con entidad',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Ninguna request rechazada produjo entidad' ELSE n||' stale_source con new_payment_id: reemplazó pese a ser rechazada' END);

    SELECT count(*) INTO n FROM comprobante_payment_replace_requests q
     WHERE q.business_id=v_biz AND q.status='processing' AND q.created_at < now() - interval '1 hour';
    v_c := v_c || finance_hc_mk('request_processing_stale','idempotency','Reservas colgadas',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Sin reservas colgadas' ELSE n||' request(s) en processing hace más de una hora' END);

    SELECT count(*) INTO n FROM comprobante_payment_replace_requests q
      JOIN comprobantes c ON c.id=q.comprobante_id
     WHERE q.business_id=v_biz AND c.business_id <> q.business_id;
    v_c := v_c || finance_hc_mk('request_cross_business','idempotency','Requests cross-business',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Sin requests cruzadas de negocio' ELSE n||' request(s) apuntan a otro negocio' END);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: payments (append-only)
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_has_repl THEN
    SELECT count(*) INTO n FROM comprobante_payments
     WHERE business_id=v_biz AND num_nonnulls(replaced_at, replaced_by, replacement_payment_id) NOT IN (0,3);
    v_c := v_c || finance_hc_mk('replacement_metadata_partial','payments','Metadata de reemplazo parcial',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'La metadata de reemplazo está completa o ausente' ELSE n||' pago(s) con metadata parcial' END);

    SELECT count(*) INTO n FROM comprobante_payments
     WHERE business_id=v_biz AND replacement_payment_id = id;
    v_c := v_c || finance_hc_mk('replacement_self_reference','payments','Pago que se sustituye a sí mismo',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Sin auto-referencias' ELSE n||' pago(s) apuntan a sí mismos' END);

    SELECT count(*) INTO n FROM comprobante_payments p LEFT JOIN comprobante_payments s ON s.id=p.replacement_payment_id
     WHERE p.business_id=v_biz AND p.replacement_payment_id IS NOT NULL
       AND (s.id IS NULL OR s.comprobante_id <> p.comprobante_id OR s.business_id <> p.business_id);
    v_c := v_c || finance_hc_mk('replacement_chain_broken','payments','Cadena de reemplazo rota',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Toda cadena de reemplazo resuelve dentro del mismo comprobante y negocio'
           ELSE n||' sustituto(s) inexistentes o de otro comprobante/negocio' END);

    -- Header vs suma de pagos VIVOS. Un cobro mixto con varias filas vivas es
    -- VALIDO: no se marca por tener mas de una linea, solo si el total no cuadra.
    SELECT count(*), COALESCE(SUM(abs(dif)),0) INTO n, m FROM (
      SELECT c.id, COALESCE(c.total_cobrado,0) - COALESCE(SUM(p.amount_ars) FILTER (WHERE p.replaced_at IS NULL),0) AS dif
        FROM comprobantes c LEFT JOIN comprobante_payments p ON p.comprobante_id=c.id
       WHERE c.business_id=v_biz GROUP BY c.id, c.total_cobrado
      HAVING COALESCE(c.total_cobrado,0) <> COALESCE(SUM(p.amount_ars) FILTER (WHERE p.replaced_at IS NULL),0)) x;
    v_c := v_c || finance_hc_mk('header_vs_live_payments','payments','Header vs suma de cobros vigentes',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, m,
      CASE WHEN n=0 THEN 'total_cobrado coincide con la suma de los pagos vigentes'
           ELSE n||' comprobante(s) con header distinto de sus pagos vivos (los cobros mixtos con varias filas vivas son válidos y no se cuentan acá)' END);

    SELECT count(*) INTO n FROM comprobante_payment_replace_requests q
     WHERE q.business_id=v_biz AND q.status='completed'
       AND NOT EXISTS (SELECT 1 FROM financial_movements f
                        WHERE f.comprobante_id=q.comprobante_id AND f.reference_type='comprobante_payment_replace');
    v_c := v_c || finance_hc_mk('replacement_without_compensation','payments','Reemplazos sin compensación',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Todo reemplazo completado tiene su compensación de caja'
           ELSE n||' reemplazo(s) sin FM compensatorio: el cobro viejo sigue contado' END);

    SELECT count(*) INTO n FROM financial_movements f
     WHERE f.business_id=v_biz AND f.reference_type='comprobante_payment_replace'
       AND NOT EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.id=f.reference_id AND p.replaced_at IS NOT NULL);
    v_c := v_c || finance_hc_mk('compensation_without_replacement','payments','Compensación sin reemplazo',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Toda compensación de reemplazo corresponde a un pago reemplazado'
           ELSE n||' compensación(es) sin pago reemplazado detrás' END);
  END IF;

  -- Pagos creados DESPUES de la anulacion del comprobante.
  IF v_has_anndate THEN
    SELECT count(*), COALESCE(SUM(p.amount_ars),0) INTO n, m
      FROM comprobante_payments p JOIN comprobante_annulments a
        ON a.comprobante_id=p.comprobante_id AND a.status='completed'
     WHERE p.business_id=v_biz AND p.created_at > a.created_at;
    v_c := v_c || finance_hc_mk('payment_after_annulment','payments','Cobros posteriores a la anulación',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
      CASE WHEN n=0 THEN 'Ningún cobro se registró después de anular su comprobante'
           ELSE n||' cobro(s) creados después de la anulación' END);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: annulments
  -- ══════════════════════════════════════════════════════════════════════════
  -- Un anulado con NOTA DE CREDITO no necesita registro interno: es la via
  -- fiscal. Solo se marca el que no tiene ni registro ni NC.
  SELECT count(*), COALESCE(SUM(c.total),0),
         COALESCE(jsonb_agg(jsonb_build_object('comprobante_id',c.id,'numero',COALESCE(c.numero_fiscal,c.numero,c.number),
                  'fecha',(COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,
                  'total',c.total)),'[]'::jsonb)
    INTO n, m, d
    FROM comprobantes c
   WHERE c.business_id=v_biz
     AND (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')
     AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed')
     AND NOT EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=c.id
                       AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado');
  v_c := v_c || finance_hc_mk('annulled_without_record','annulments','Anulados sin registro canónico',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
    CASE WHEN n=0 THEN 'Toda anulación tiene registro canónico o nota de crédito'
         ELSE n||' comprobante(s) anulados sin registro ni NC: el ledger no puede derivar su compensación y su venta reaparece en el período original' END,
    '{}'::jsonb, d);

  SELECT count(*) INTO n FROM comprobante_annulments a
   WHERE a.business_id=v_biz AND NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=a.comprobante_id);
  v_c := v_c || finance_hc_mk('annulment_record_orphan','annulments','Registros de anulación huérfanos',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todo registro resuelve a un comprobante' ELSE n||' registro(s) sin comprobante' END);

  SELECT count(*) INTO n FROM (
    SELECT comprobante_id FROM comprobante_annulments
     WHERE business_id=v_biz AND status='completed' GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('annulment_multiple_records','annulments','Anulaciones múltiples por comprobante',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Una sola anulación por comprobante' ELSE n||' comprobante(s) con más de una anulación: doble compensación' END);

  SELECT count(*) INTO n FROM comprobantes c
   WHERE c.business_id=v_biz
     AND (COALESCE(c.estado,'')='anulado' OR COALESCE(c.estado_comercial,'')='anulado' OR COALESCE(c.status,'')='cancelled')
     AND NOT (COALESCE(c.estado,'')='anulado' AND COALESCE(c.estado_comercial,'')='anulado' AND COALESCE(c.status,'')='cancelled');
  v_c := v_c || finance_hc_mk('annulment_signals_partial','annulments','Señales de anulación contradictorias',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'estado, estado_comercial y status coinciden'
         ELSE n||' comprobante(s) con una señal diciendo anulado y otra no' END);

  SELECT count(*) INTO n FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
   WHERE a.business_id=v_biz AND a.status='completed'
     AND COALESCE(c.estado,'') <> 'anulado' AND COALESCE(c.estado_comercial,'') <> 'anulado'
     AND COALESCE(c.status,'') <> 'cancelled';
  v_c := v_c || finance_hc_mk('annulment_resurrected','annulments','Comprobantes resucitados',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Ningún anulado volvió a estar activo'
         ELSE n||' comprobante(s) con registro de anulación pero operativamente activos' END);

  SELECT count(*) INTO n FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
   WHERE a.business_id=v_biz
     AND COALESCE(CASE WHEN v_has_anndate THEN a.annulment_date ELSE NULL END,
                  (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date)
       < (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date;
  v_c := v_c || finance_hc_mk('annulment_date_impossible','annulments','Anulación anterior a la venta',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Ninguna anulación precede a su venta' ELSE n||' anulación(es) fechadas antes de la venta' END);

  SELECT count(*) INTO n FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
   WHERE a.business_id=v_biz AND c.business_id <> a.business_id;
  v_c := v_c || finance_hc_mk('annulment_cross_business','annulments','Anulaciones cross-business',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Sin anulaciones cruzadas de negocio' ELSE n||' anulación(es) de otro negocio' END);

  -- Restauracion de stock duplicada: se AGRUPA por inventory_id, porque las
  -- lineas repetidas del mismo producto son validas.
  SELECT count(*) INTO n FROM (
    SELECT m2.reference_id, m2.inventory_item_id FROM inventory_movements m2
     WHERE m2.business_id=v_biz AND m2.reference_type='comprobante' AND m2.movement_type='return'
     GROUP BY 1,2 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('annulment_stock_restored_twice','annulments','Stock restaurado dos veces',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Ningún inventario se restauró más de una vez por comprobante'
         ELSE n||' inventario(s) restaurados dos veces: stock inflado' END);

  SELECT count(*) INTO n FROM (
    SELECT f.reference_id FROM financial_movements f
     WHERE f.business_id=v_biz AND f.reference_type='annulment_reversal' AND f.reference_id IS NOT NULL
     GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('annulment_cashflow_double_reversal','annulments','Caja revertida dos veces',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Una devolución por cada cobro' ELSE n||' cobro(s) devueltos más de una vez' END);

  SELECT count(*) INTO n FROM (
    SELECT b.reference_comprobante_id FROM business_finance_entries b
     WHERE b.business_id=v_biz AND b.source='annulment' AND b.category='mercaderia' AND b.amount_ars < 0
     GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('annulment_cogs_double_reversal','annulments','COGS revertido dos veces',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'El COGS se revierte una sola vez por anulación' ELSE n||' comprobante(s) con COGS revertido dos veces' END);

  SELECT count(*) INTO n FROM comprobante_annulments a
   WHERE a.business_id=v_biz AND a.status='completed'
     AND EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=a.comprobante_id
                   AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado');
  v_c := v_c || finance_hc_mk('annulment_and_credit_note','annulments','Anulación interna + nota de crédito',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Las dos vías son mutuamente excluyentes (la NC exige CAE y la anulación lo rechaza)'
         ELSE n||' comprobante(s) revertidos por AMBAS vías: doble reversión' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: credit_notes — credit_reversal e inventory_return SEPARADOS
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*), COALESCE(SUM(nc.total),0) INTO n, m FROM comprobantes nc
   WHERE nc.business_id=v_biz AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado='emitido'
     AND NOT EXISTS (SELECT 1 FROM financial_movements f
                      WHERE f.comprobante_id=nc.id AND f.type='expense');
  v_c := v_c || finance_hc_mk('credit_note_cash_not_compensated','credit_notes','NC sin compensación de caja',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, m,
    CASE WHEN n=0 THEN 'Toda NC emitida compensó su cobro (dimensión credit_reversal)'
         ELSE n||' NC sin movimiento compensatorio: el ingreso sigue contado' END);

  SELECT count(*) INTO n FROM comprobantes nc
   WHERE nc.business_id=v_biz AND COALESCE(nc.tipo,nc.type)='nota_credito'
     AND (nc.comprobante_original_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM comprobantes o WHERE o.id=nc.comprobante_original_id));
  v_c := v_c || finance_hc_mk('credit_note_without_original','credit_notes','NC sin comprobante original',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Toda NC referencia su original' ELSE n||' NC sin original válido' END);

  SELECT count(*) INTO n FROM (
    SELECT nc.comprobante_original_id FROM comprobantes nc
     WHERE nc.business_id=v_biz AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado'
       AND nc.comprobante_original_id IS NOT NULL GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('credit_note_duplicated','credit_notes','NC duplicadas por comprobante',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Una NC activa por comprobante' ELSE n||' comprobante(s) con más de una NC activa: doble reversión' END);

  -- NC que dice restaurar stock (copia inventory_id) pero no dejo movimiento.
  SELECT count(*) INTO n FROM comprobantes nc
   WHERE nc.business_id=v_biz AND COALESCE(nc.tipo,nc.type)='nota_credito'
     AND EXISTS (SELECT 1 FROM comprobante_items i WHERE i.comprobante_id=nc.id AND i.inventory_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM inventory_movements m2 WHERE m2.reference_id=nc.id AND m2.movement_type='return');
  v_c := v_c || finance_hc_mk('credit_note_claims_stock_without_movement','credit_notes','NC con inventario pero sin devolución',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Ninguna NC declara inventario sin registrar la devolución'
         ELSE n||' NC con inventory_id en sus ítems pero sin inventory_movement de entrada' END);

  -- SEMANTICA APROBADA: una NC financiera pura (sin retorno fisico) es INFO.
  SELECT count(*), COALESCE(SUM(i.costo_total),0) INTO n, m
    FROM comprobantes nc JOIN comprobantes o ON o.id=nc.comprobante_original_id
    JOIN comprobante_items i ON i.comprobante_id=o.id
   WHERE nc.business_id=v_biz AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado='emitido'
     AND i.costo_total > 0
     AND NOT EXISTS (SELECT 1 FROM inventory_movements m2 WHERE m2.reference_id=o.id AND m2.movement_type='return');
  v_c := v_c || finance_hc_mk('credit_note_without_physical_return','credit_notes','NC sin retorno físico (COGS retenido)',
    CASE WHEN n=0 THEN 'pass' ELSE 'info' END, 'info', n, m,
    CASE WHEN n=0 THEN 'Sin NC con COGS retenido'
         ELSE n||' NC revirtieron ingreso/cobro sin devolución física: el COGS ('||round(m,2)||') permanece y produce pérdida. COMPORTAMIENTO ECONÓMICO VÁLIDO: la NC revierte dinero, no mercadería. El COGS solo se revierte si hubo devolución física. No es un fallo' END,
    jsonb_build_object('semantica','credit_reversal e inventory_return son dimensiones separadas',
                       'politica','NC total sin retorno => ventas netas 0, COGS positivo, pérdida legítima'));

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: accounting_classification (BFE)
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*) INTO n FROM business_finance_entries WHERE business_id=v_biz AND economic_class IS NULL;
  v_c := v_c || finance_hc_mk('bfe_null_class','accounting_classification','Asientos sin clase económica',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todo asiento tiene clase económica' ELSE n||' asiento(s) sin clasificar' END);

  -- Mirrors historicos de anulacion: deuda de clasificacion EXPLICADA.
  -- Requisitos para degradar a info: vinculados 1-a-1 con una anulacion y fuera
  -- del operating result (revenue_collection_mirror/cogs_mirror lo estan; el
  -- legacy_unclassified solo alimenta data_quality_flags).
  SELECT count(*), COALESCE(SUM(b.amount_ars),0) INTO n, m
    FROM business_finance_entries b
   WHERE b.business_id=v_biz AND b.economic_class='legacy_unclassified' AND b.source='annulment'
     AND EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=b.reference_comprobante_id
                   AND (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado'));
  v_c := v_c || finance_hc_mk('bfe_legacy_annulment_mirrors','accounting_classification','Mirrors históricos de anulación',
    CASE WHEN n=0 THEN 'pass' ELSE 'info' END, 'info', n, m,
    CASE WHEN n=0 THEN 'Sin deuda de clasificación por mirrors de anulación'
         ELSE n||' mirror(s) de anulación con clase legacy_unclassified, vinculados uno a uno con su anulación. NO alimentan operating_result (solo data_quality_flags). Deuda de clasificación explicada, no un error' END,
    jsonb_build_object('tipo','legacy_classification_debt','remediacion','ninguna: reclasificar seria un backfill sobre asientos historicos'));

  -- El resto de legacy_unclassified SI conserva alerta.
  SELECT count(*), COALESCE(SUM(b.amount_ars),0) INTO n, m
    FROM business_finance_entries b
   WHERE b.business_id=v_biz AND b.economic_class='legacy_unclassified'
     AND NOT (b.source='annulment' AND EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=b.reference_comprobante_id
                AND (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')));
  v_c := v_c || finance_hc_mk('bfe_legacy_unclassified_other','accounting_classification','Asientos sin clasificar (otro origen)',
    CASE WHEN n=0 THEN 'pass' WHEN abs(m) > 100000 THEN 'fail' ELSE 'warn' END,
    CASE WHEN n=0 THEN 'info' WHEN abs(m) > 100000 THEN 'high' ELSE 'medium' END, n, m,
    CASE WHEN n=0 THEN 'Sin asientos legacy_unclassified de origen desconocido'
         ELSE n||' asiento(s) sin clasificar por '||round(m,2)||' ARS, de origen distinto a un mirror de anulación conocido' END);

  SELECT count(*) INTO n FROM (
    SELECT reference_comprobante_id FROM business_finance_entries
     WHERE business_id=v_biz AND category='mercaderia' AND amount_ars > 0 AND reference_comprobante_id IS NOT NULL
     GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('bfe_cogs_duplicated','accounting_classification','COGS duplicado',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Un asiento de COGS por comprobante' ELSE n||' comprobante(s) con COGS duplicado' END);

  SELECT count(*) INTO n FROM (
    SELECT reference_comprobante_id FROM business_finance_entries
     WHERE business_id=v_biz AND type='income' AND amount_ars > 0 AND reference_comprobante_id IS NOT NULL
     GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('bfe_income_duplicated','accounting_classification','Ingreso duplicado',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Un espejo de ingreso por comprobante' ELSE n||' comprobante(s) con ingreso duplicado' END);

  SELECT count(*) INTO n FROM (
    SELECT reference_comprobante_id FROM business_finance_entries
     WHERE business_id=v_biz AND category='comisiones_cobro' AND amount_ars > 0 AND reference_comprobante_id IS NOT NULL
     GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('bfe_commission_duplicated','accounting_classification','Comisión duplicada',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Una comisión por comprobante' ELSE n||' comprobante(s) con comisión duplicada' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: cashflow
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*) INTO n FROM (
    SELECT business_id FROM cajas WHERE business_id=v_biz AND status='abierta' GROUP BY 1 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('multiple_open_cajas','cashflow','Más de una caja abierta',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'A lo sumo una caja abierta' ELSE 'Hay más de una caja abierta: los cobros pueden caer en la equivocada' END);

  SELECT count(*), COALESCE(SUM(amount_ars),0) INTO n, m FROM financial_movements
   WHERE business_id=v_biz AND metodo_pago='efectivo' AND caja_id IS NULL;
  v_c := v_c || finance_hc_mk('cash_without_caja','cashflow','Efectivo sin caja',
    CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, m,
    CASE WHEN n=0 THEN 'Todo movimiento en efectivo tiene caja'
         ELSE n||' movimiento(s) en efectivo sin caja por '||round(m,2)||' ARS. Clasificación M6 heredada: el neto y las referencias son correctos, solo falta la sesión' END);

  SELECT count(*) INTO n FROM financial_movements f JOIN cajas j ON j.id=f.caja_id
   WHERE f.business_id=v_biz AND j.business_id <> f.business_id;
  v_c := v_c || finance_hc_mk('caja_cross_business','cashflow','Movimientos en caja de otro negocio',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Sin movimientos en cajas ajenas' ELSE n||' movimiento(s) en la caja de otro negocio' END);

  SELECT count(*) INTO n FROM financial_movements f JOIN cajas j ON j.id=f.caja_id
   WHERE f.business_id=v_biz AND j.closed_at IS NOT NULL AND f.created_at > j.closed_at;
  v_c := v_c || finance_hc_mk('fm_after_caja_close','cashflow','Movimientos posteriores al cierre de caja',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Ninguna caja cerrada recibió movimientos después'
         ELSE n||' movimiento(s) agregados a una caja ya cerrada' END);

  SELECT count(*) INTO n FROM financial_movements f
   WHERE f.business_id=v_biz AND f.reference_type IN ('annulment_reversal','comprobante_payment_replace')
     AND f.reference_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM financial_movements o WHERE o.id=f.reference_id);
  v_c := v_c || finance_hc_mk('reversal_without_original','cashflow','Reversas sin movimiento original',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Toda reversa referencia un original existente' ELSE n||' reversa(s) sin original' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: pnl_ledger
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_has_ledger THEN
    SELECT count(*) INTO n FROM comprobante_annulments a
     WHERE a.business_id=v_biz AND a.status='completed'
       AND NOT EXISTS (SELECT 1 FROM v_finance_sales_ledger l
                        WHERE l.comprobante_id=a.comprobante_id AND l.event_type='annulment');
    v_c := v_c || finance_hc_mk('annulment_without_ledger_event','pnl_ledger','Anulaciones sin evento en el ledger',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
      CASE WHEN n=0 THEN 'Toda anulación canónica produce su evento compensatorio'
           ELSE n||' anulación(es) sin evento en el ledger: su venta no se compensa' END);

    -- El neto de un comprobante ANULADO con registro debe ser 0 en el ledger.
    SELECT count(*), COALESCE(SUM(abs(neto)),0) INTO n, m FROM (
      SELECT l.comprobante_id, SUM(l.sales_amount_ars) AS neto
        FROM v_finance_sales_ledger l
       WHERE l.business_id=v_biz AND l.is_credit_note=false
         AND EXISTS (SELECT 1 FROM comprobante_annulments a
                      WHERE a.comprobante_id=l.comprobante_id AND a.status='completed')
       GROUP BY 1 HAVING SUM(l.sales_amount_ars) <> 0) x;
    v_c := v_c || finance_hc_mk('annulled_ledger_not_netting','pnl_ledger','Anulados que no netean a cero',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
      CASE WHEN n=0 THEN 'Todo comprobante anulado con registro netea a cero en el ledger'
           ELSE n||' anulado(s) no netean: quedan '||round(m,2)||' ARS sin compensar' END);

    -- v_finance_pnl debe coincidir EXACTAMENTE con la agregacion del ledger.
    SELECT count(*), COALESCE(SUM(abs(dif)),0) INTO n, m FROM (
      SELECT p.period_date, p.gross_sales - COALESCE(l.s,0) AS dif
        FROM v_finance_pnl p
        LEFT JOIN (SELECT period_date, SUM(gross_amount_ars) AS s FROM v_finance_sales_ledger
                    WHERE business_id=v_biz AND is_credit_note=false GROUP BY 1) l
          ON l.period_date=p.period_date
       WHERE p.business_id=v_biz AND round(p.gross_sales,2) <> round(COALESCE(l.s,0),2)) x;
    v_c := v_c || finance_hc_mk('pnl_vs_ledger_mismatch','pnl_ledger','P&L vs agregación del ledger',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
      CASE WHEN n=0 THEN 'v_finance_pnl coincide con la agregación del ledger en todos los períodos'
           ELSE n||' período(s) donde el P&L no coincide con el ledger, por '||round(m,2)||' ARS' END);

    -- Servicios: no deben inventar COGS.
    SELECT count(*) INTO n FROM v_finance_sales_ledger l
     WHERE l.business_id=v_biz AND l.tipo_linea='servicio' AND COALESCE(l.cogs_amount_ars,0) <> 0;
    v_c := v_c || finance_hc_mk('service_with_cogs','pnl_ledger','Servicios con COGS',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Los servicios no inventan COGS' ELSE n||' línea(s) de servicio con costo de mercadería' END);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: accounts_receivable
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*), COALESCE(SUM(abs(dif)),0) INTO n, m FROM (
    SELECT a.id, COALESCE(a.balance,0) - COALESCE((SELECT SUM(mm.debit-mm.credit) FROM account_movements mm
                                                    WHERE mm.account_id=a.id),0) AS dif
      FROM accounts a WHERE a.business_id=v_biz
     ) x WHERE dif <> 0;
  v_c := v_c || finance_hc_mk('account_balance_mismatch','accounts_receivable','Saldo distinto de sus movimientos',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
    CASE WHEN n=0 THEN 'Todo saldo persistido coincide con la suma canónica de movimientos'
         ELSE n||' cuenta(s) con saldo desalineado por '||round(m,2)||' ARS' END);

  SELECT count(*) INTO n FROM account_movements mm JOIN accounts a ON a.id=mm.account_id
   WHERE mm.business_id=v_biz AND a.business_id <> mm.business_id;
  v_c := v_c || finance_hc_mk('account_cross_business','accounts_receivable','Cuentas corrientes cross-business',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Sin cuentas cruzadas de negocio' ELSE n||' movimiento(s) sobre una cuenta de otro negocio' END);

  SELECT count(*) INTO n FROM account_movements mm
   WHERE mm.business_id=v_biz AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=mm.account_id);
  v_c := v_c || finance_hc_mk('account_movement_orphan','accounts_receivable','Movimientos de CC huérfanos',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todo movimiento resuelve a una cuenta' ELSE n||' movimiento(s) sin cuenta' END);

  SELECT count(*) INTO n FROM (
    SELECT reference_id, type FROM account_movements
     WHERE business_id=v_biz AND reference_type='comprobante' AND reference_id IS NOT NULL
     GROUP BY 1,2 HAVING count(*)>1) x;
  v_c := v_c || finance_hc_mk('account_movement_duplicated','accounts_receivable','Movimientos de CC duplicados',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Sin movimientos duplicados por comprobante' ELSE n||' referencia(s) con movimiento duplicado' END);

  SELECT count(*), COALESCE(SUM(x.deuda),0) INTO n, m FROM (
    SELECT c.id, SUM(mm.debit-mm.credit) AS deuda FROM comprobantes c
      JOIN account_movements mm ON mm.reference_id=c.id AND mm.reference_type='comprobante'
     WHERE c.business_id=v_biz AND (c.estado='anulado' OR c.status='cancelled')
     GROUP BY c.id HAVING SUM(mm.debit-mm.credit) > 0.01) x;
  v_c := v_c || finance_hc_mk('annulled_cc_without_compensation','accounts_receivable','Anulados con deuda de CC vigente',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, m,
    CASE WHEN n=0 THEN 'Ningún anulado dejó deuda de cuenta corriente viva'
         ELSE n||' comprobante(s) anulados con '||round(m,2)||' ARS de deuda sin compensar' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: inventory
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*) INTO n FROM comprobante_items
   WHERE business_id=v_biz AND cantidad IS NOT NULL AND cantidad <> floor(cantidad);
  v_c := v_c || finance_hc_mk('item_decimal_quantity','inventory','Cantidades decimales',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todas las cantidades son enteras (TechRepair Pro maneja solo unidades enteras)'
         ELSE n||' ítem(s) con cantidad decimal' END);

  SELECT count(*) INTO n FROM comprobante_items WHERE business_id=v_biz AND COALESCE(cantidad,0) <= 0;
  v_c := v_c || finance_hc_mk('item_non_positive_quantity','inventory','Cantidades no positivas',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todas las cantidades son positivas' ELSE n||' ítem(s) con cantidad <= 0' END);

  SELECT count(*) INTO n FROM comprobante_items ci
   WHERE ci.business_id=v_biz AND ci.inventory_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.id=ci.inventory_id);
  v_c := v_c || finance_hc_mk('item_inventory_missing','inventory','Ítems con inventario inexistente',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
    CASE WHEN n=0 THEN 'Todo ítem resuelve a su inventario' ELSE n||' ítem(s) apuntan a un inventario inexistente' END);

  SELECT count(*) INTO n FROM inventory_movements m2 JOIN inventory i ON i.id=m2.inventory_item_id
   WHERE m2.business_id=v_biz AND i.business_id <> m2.business_id;
  v_c := v_c || finance_hc_mk('inventory_cross_business','inventory','Inventario cross-business',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Sin movimientos sobre inventario de otro negocio' ELSE n||' movimiento(s) cruzados' END);

  SELECT count(*) INTO n FROM inventory_movements
   WHERE business_id=v_biz AND reference_id IS NULL;
  v_c := v_c || finance_hc_mk('inventory_movement_orphan','inventory','Movimientos de stock sin entidad',
    CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
    CASE WHEN n=0 THEN 'Todo movimiento referencia su entidad'
         ELSE n||' movimiento(s) sin referencia: ajustes manuales legacy, sin impacto económico' END);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: multi_tenant  (cualquier fila => fail/critical)
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT count(*), jsonb_build_object(
      'comprobante_cliente', (SELECT count(*) FROM comprobantes c JOIN customers k ON k.id=c.customer_id
                               WHERE c.business_id=v_biz AND k.business_id<>c.business_id),
      'comprobante_orden',   (SELECT count(*) FROM comprobantes c JOIN orders o ON o.id=c.order_id
                               WHERE c.business_id=v_biz AND o.business_id<>c.business_id),
      'pago_comprobante',    (SELECT count(*) FROM comprobante_payments p JOIN comprobantes c ON c.id=p.comprobante_id
                               WHERE p.business_id=v_biz AND c.business_id<>p.business_id),
      'fm_comprobante',      (SELECT count(*) FROM financial_movements f JOIN comprobantes c ON c.id=f.comprobante_id
                               WHERE f.business_id=v_biz AND c.business_id<>f.business_id),
      'bfe_comprobante',     (SELECT count(*) FROM business_finance_entries b JOIN comprobantes c ON c.id=b.reference_comprobante_id
                               WHERE b.business_id=v_biz AND c.business_id<>b.business_id),
      'item_comprobante',    (SELECT count(*) FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id
                               WHERE ci.business_id=v_biz AND c.business_id<>ci.business_id)
    ) INTO n, d
    FROM (SELECT 1) z;
  SELECT (SELECT count(*) FROM comprobantes c JOIN customers k ON k.id=c.customer_id WHERE c.business_id=v_biz AND k.business_id<>c.business_id)
       + (SELECT count(*) FROM comprobantes c JOIN orders o ON o.id=c.order_id WHERE c.business_id=v_biz AND o.business_id<>c.business_id)
       + (SELECT count(*) FROM comprobante_payments p JOIN comprobantes c ON c.id=p.comprobante_id WHERE p.business_id=v_biz AND c.business_id<>p.business_id)
       + (SELECT count(*) FROM financial_movements f JOIN comprobantes c ON c.id=f.comprobante_id WHERE f.business_id=v_biz AND c.business_id<>f.business_id)
       + (SELECT count(*) FROM business_finance_entries b JOIN comprobantes c ON c.id=b.reference_comprobante_id WHERE b.business_id=v_biz AND c.business_id<>b.business_id)
       + (SELECT count(*) FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id WHERE ci.business_id=v_biz AND c.business_id<>ci.business_id)
    INTO n;
  v_c := v_c || finance_hc_mk('cross_business_references','multi_tenant','Referencias cross-business',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Aislamiento multi-tenant íntegro en todos los cruces financieros'
         ELSE n||' referencia(s) apuntan a entidades de otro negocio' END, d);

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: security
  -- GLOBALES: miran catalogo/grants, no filas del negocio. Un hallazgo de
  -- plataforma NO debe pintar de rojo el health check de cada comercio, asi que
  -- solo se incluyen con p_include_global=true (auditoria operativa, no el
  -- endpoint interactivo). §17.
  --
  -- 7C.1 §8: ademas revelan nombres de funciones, grants y configuracion de
  -- seguridad de la PLATAFORMA. p_include_global es un parametro del CLIENTE:
  -- por si solo no autoriza nada. Se exige una condicion REAL de operador —
  -- ser owner del negocio, verificado server-side. Si no lo es, los checks se
  -- reportan como OMITIDOS sin detalles sensibles, en vez de fallar: el
  -- contrato del frontend no se rompe.
  -- ══════════════════════════════════════════════════════════════════════════
  IF p_include_global AND NOT public.finance_hc_can_see_global(v_biz) THEN
    v_c := v_c || finance_hc_mk('global_checks_restricted','security','Diagnóstico de plataforma restringido',
      'info', 'info', 0, 0,
      'Los checks globales (configuración de seguridad y vías de escritura de la plataforma) '
      'requieren ser owner del negocio. Se omitieron sin exponer detalles.',
      jsonb_build_object('omitidos', jsonb_build_array('secdef_without_search_path','alternative_write_paths'),
                         'motivo','requiere_operador'));
  END IF;

  IF p_include_global AND public.finance_hc_can_see_global(v_biz) THEN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.prosecdef AND p.prokind='f'
     AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'));
  v_c := v_c || finance_hc_mk('secdef_without_search_path','security','SECURITY DEFINER sin search_path',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Toda función SECURITY DEFINER fija su search_path'
         ELSE n||' función(es) SECURITY DEFINER sin search_path fijo: vulnerables a secuestro de esquema' END);

  -- 7C.1a §9 — SECURITY DEFINER con schema NO CONFIABLE en el search_path.
  -- Un schema es no confiable si algun rol no confiable puede CREATE en el.
  -- Tambien falla por "$user" y por pg_temp en posicion insegura (omitido =
  -- se busca PRIMERO, doc PG 5.9.3).
  SELECT count(*) INTO n FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.prosecdef AND p.prokind IN ('f','p')
     AND p.proconfig IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
     AND (
       -- schema escribible por anon/authenticated/PUBLIC dentro del path
       EXISTS (SELECT 1 FROM unnest(string_to_array(
                 replace((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'),'search_path=',''), ', ')) AS s
                WHERE btrim(s, '"') NOT IN ('pg_catalog','pg_temp','extensions')
                  AND (has_schema_privilege('anon', btrim(s,'"'), 'CREATE')
                    OR has_schema_privilege('authenticated', btrim(s,'"'), 'CREATE')
                    OR has_schema_privilege('public', btrim(s,'"'), 'CREATE')))
       -- "$user"
       OR EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%$user%')
       -- pg_temp omitido => se busca primero
       OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%pg_temp%')
     );
  v_c := v_c || finance_hc_mk('secdef_untrusted_search_path','security','SECURITY DEFINER con schema no confiable en el path',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Ninguna funcion privilegiada depende de un schema escribible por roles no confiables'
         ELSE n||' funcion(es) SECURITY DEFINER tienen en su search_path un schema escribible por anon/authenticated/PUBLIC, o "$user", o omiten pg_temp (que entonces se busca PRIMERO). Vector de shadowing.' END,
    jsonb_build_object('regla','un schema es confiable solo si ningun rol no confiable puede CREATE en el',
                       'pg_temp','debe ir explicito y al final: omitirlo lo pone primero (doc PostgreSQL 5.9.3)'));

  -- Vias alternativas de escritura. NO se considera seguro un flujo por sus
  -- permisos de frontend: se miran los grants reales de la base.
  SELECT (CASE WHEN has_table_privilege('authenticated','public.comprobante_payments','INSERT')
               AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_cp_annulled_guard') THEN 1 ELSE 0 END)
       + (CASE WHEN has_table_privilege('authenticated','public.comprobantes','UPDATE')
               AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_comprobante_annulment_transition') THEN 1 ELSE 0 END)
       + (CASE WHEN has_table_privilege('anon','public.comprobante_payments','INSERT') THEN 1 ELSE 0 END)
       + (CASE WHEN has_table_privilege('authenticated','public.comprobante_payments','DELETE') THEN 1 ELSE 0 END)
    INTO n;
  v_c := v_c || finance_hc_mk('alternative_write_paths','security','Vías alternativas de anulación o cobro',
    CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'critical', n, 0,
    CASE WHEN n=0 THEN 'Toda anulación y todo cobro pasan por su RPC canónica o su guard'
         ELSE n||' vía(s) permiten anular o cobrar sin la RPC canónica' END,
    jsonb_build_object(
      'authenticated_insert_pagos', has_table_privilege('authenticated','public.comprobante_payments','INSERT'),
      'guard_pagos_anulados',       EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_cp_annulled_guard'),
      'authenticated_update_comprobantes', has_table_privilege('authenticated','public.comprobantes','UPDATE'),
      'guard_transicion_anulacion', EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_comprobante_annulment_transition')));
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- CATEGORIA: reconciliation  (informativa; nunca modifica estados)
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_has_recon THEN
    SELECT count(*) INTO n FROM finance_ledger_reconciliation r
     WHERE r.business_id=v_biz AND r.reconciliation_status='active_inconsistency';
    v_c := v_c || finance_hc_mk('reconciliation_active','reconciliation','Inconsistencias activas registradas',
      CASE WHEN n=0 THEN 'pass' ELSE 'fail' END, 'high', n, 0,
      CASE WHEN n=0 THEN 'Sin inconsistencias activas' ELSE n||' inconsistencia(s) marcadas como activas' END);

    SELECT count(*) INTO n FROM finance_ledger_reconciliation r
     WHERE r.business_id=v_biz AND r.reconciliation_status='indeterminate';
    v_c := v_c || finance_hc_mk('reconciliation_indeterminate','reconciliation','Reconciliaciones indeterminadas',
      CASE WHEN n=0 THEN 'pass' ELSE 'warn' END, 'medium', n, 0,
      CASE WHEN n=0 THEN 'Sin casos indeterminados' ELSE n||' caso(s) sin resolución determinada' END);

    SELECT count(*) INTO n FROM finance_ledger_reconciliation r
     WHERE r.business_id=v_biz AND r.reconciliation_status='corrected';
    v_c := v_c || finance_hc_mk('reconciliation_corrected','reconciliation','Reconciliaciones corregidas',
      CASE WHEN n=0 THEN 'pass' ELSE 'info' END, 'info', n, 0,
      CASE WHEN n=0 THEN 'Sin correcciones registradas'
           ELSE n||' inconsistencia(s) histórica(s) corregidas y explicadas (p. ej. la reconciliación 7B del remito legacy)' END);

    SELECT count(*) INTO n FROM finance_ledger_reconciliation r
     WHERE r.business_id=v_biz AND r.reconciliation_status='legacy_accepted';
    v_c := v_c || finance_hc_mk('reconciliation_legacy_accepted','reconciliation','Legacy aceptado',
      CASE WHEN n=0 THEN 'pass' ELSE 'info' END, 'info', n, 0,
      CASE WHEN n=0 THEN 'Sin deuda legacy aceptada' ELSE n||' caso(s) legacy aceptados y documentados' END);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Resumen  (contrato v1 + campos v2 aditivos)
  -- ══════════════════════════════════════════════════════════════════════════
  RETURN jsonb_build_object(
    -- v1 (frontend actual)
    'ok',             true,
    'business_id',    v_biz,
    'checked_at',     now(),
    'critical_count', (SELECT count(*) FROM jsonb_array_elements(v_c) e WHERE e->>'status'='critical'),
    'warning_count',  (SELECT count(*) FROM jsonb_array_elements(v_c) e WHERE e->>'status'='warning'),
    'low_count',      (SELECT count(*) FROM jsonb_array_elements(v_c) e WHERE e->>'status'='low'),
    'total_issues',   (SELECT COALESCE(SUM((e->>'count')::bigint),0) FROM jsonb_array_elements(v_c) e WHERE e->>'status'<>'ok'),
    'checks',         v_c,
    -- v2 aditivo
    'version',        'm7_health_v2',
    'overall_status', CASE
                        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_c) e WHERE e->>'result'='fail') THEN 'fail'
                        WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_c) e WHERE e->>'result'='warn') THEN 'warn'
                        ELSE 'pass' END,
    'info_count',     (SELECT count(*) FROM jsonb_array_elements(v_c) e WHERE e->>'result'='info'),
    'pass_count',     (SELECT count(*) FROM jsonb_array_elements(v_c) e WHERE e->>'result'='pass'),
    'checks_total',   jsonb_array_length(v_c),
    'duration_ms',    round(EXTRACT(epoch FROM (clock_timestamp()-v_t0))*1000)::int,
    'amount_at_risk', (SELECT COALESCE(SUM((e->>'amount_ars')::numeric),0) FROM jsonb_array_elements(v_c) e WHERE e->>'result'='fail'),
    'schema_state',   jsonb_build_object('ledger', v_has_ledger, 'audit_log', v_has_audit,
                                         'period_locks', v_has_locks, 'reconciliation', v_has_recon,
                                         'payment_replacement', v_has_repl, 'annulment_date', v_has_anndate),
    'semantics',      jsonb_build_object(
        'credit_note', 'La NC revierte ingreso/cobro. El COGS se revierte SOLO si hubo devolucion fisica o restauracion de inventario. Una NC total sin retorno de mercaderia puede producir legitimamente ventas netas cero, COGS positivo y perdida.',
        'legacy_debt', 'Los mirrors de anulacion con clase legacy_unclassified, vinculados uno a uno con su anulacion y fuera del operating result, son deuda de clasificacion explicada (info), no un error activo.')
  );
END;
$$;

ALTER FUNCTION "public"."finance_health_check_v2"(uuid, boolean) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."finance_health_check_v2"(uuid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "public"."finance_health_check_v2"(uuid, boolean) FROM "anon";
GRANT EXECUTE ON FUNCTION "public"."finance_health_check_v2"(uuid, boolean) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finance_health_check_v2"(uuid, boolean) TO "service_role";

COMMENT ON FUNCTION "public"."finance_health_check_v2"(uuid, boolean) IS
  'M7 7C — Health check financiero canonico. READ-ONLY enforceado por Postgres '
  '(STABLE: una funcion no-VOLATILE no puede escribir). Contrato: superset '
  'ADITIVO de finance_health_check v1 — el frontend puede migrar cambiando solo '
  'el nombre de la RPC. Aislado por business_id con verificacion de pertenencia.';

-- ============================================================================
-- ROLLBACK (documentado): DROP FUNCTION finance_health_check_v2(uuid, boolean);
--                         DROP FUNCTION finance_hc_mk(...);
-- v1 (finance_health_check) queda intacta en todo momento.
-- ============================================================================
