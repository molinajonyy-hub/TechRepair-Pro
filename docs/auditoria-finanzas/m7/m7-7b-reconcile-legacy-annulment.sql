-- ============================================================================
-- M7 Lote 7B — Reconciliación histórica puntual de UNA anulación legacy.
--
-- OBJETIVO: crear la EVIDENCIA CANÓNICA que falta para el remito
-- 0001-00000003, anulado el 2026-05-08 por la vía client-side (que no dejó
-- registro en comprobante_annulments). Sin ese registro, v_finance_sales_ledger
-- no puede derivar el evento 'annulment' y la venta reaparece en 2026-05 sin
-- compensación (+1.235.580 ventas / +1.097.006 COGS / +138.574 resultado).
--
-- NO crea NINGÚN efecto económico nuevo: ni financial_movements, ni
-- business_finance_entries, ni account_movements, ni inventory_movements, ni
-- pagos, ni ítems, ni cambios de stock, ni cambios en el comprobante.
-- El stock YA fue restaurado el 2026-05-08 y nunca existió impacto financiero.
--
-- La factura C 95cbf330-0714-412a-9d5d-f6aa85123a62 NO se toca: tiene nota de
-- crédito y se sigue revirtiendo por el mecanismo fiscal existente.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ ORDEN DE EJECUCIÓN OBLIGATORIO                                           │
-- │   1. Desplegar las migraciones M7 (crean comprobante_annulments.         │
-- │      annulment_date y finance_ledger_reconciliation).                    │
-- │   2. Recién entonces ejecutar este script.                               │
-- │ Motivo: el registro DEBE llevar annulment_date='2026-05-08' explícita.   │
-- │ Insertado antes del deploy, el ledger derivaría la fecha de created_at   │
-- │ (= hoy) y pondría la compensación en el mes equivocado.                  │
-- │ Ejecutar ambos pasos en la MISMA ventana: entre 1 y 2 el P&L de 2026-05  │
-- │ muestra el restatement de +138.574.                                      │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- MODOS: este archivo tiene DOS secciones. La sección APPLY termina en
-- ROLLBACK y así debe quedar en el repositorio. Cambiar a COMMIT sólo tras
-- aprobación humana explícita.
--
-- Referencia: docs/auditoria-finanzas/m7/m7-lote-7a-dry-run-preflight-report.md
-- ============================================================================


-- ############################################################################
-- ## SECCIÓN 1 — DRY-RUN (sólo SELECT; no escribe nada)                     ##
-- ############################################################################
-- Ejecutar dentro de:
--   BEGIN; SET TRANSACTION READ ONLY;
--   SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='3s';
--   \i m7-7b-reconcile-legacy-annulment.sql   -- (sólo esta sección)
--   ROLLBACK;

\echo '=== 7B DRY-RUN — precondiciones (TODAS deben decir OK) ==========='

SELECT chequeo, resultado,
       CASE WHEN resultado THEN 'OK' ELSE '*** ABORTA ***' END AS veredicto
FROM (
  WITH c AS (
    SELECT * FROM comprobantes WHERE id = 'ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
  )
  SELECT 'P01 el comprobante existe'                        AS chequeo, (SELECT count(*) FROM c) = 1 AS resultado
  UNION ALL SELECT 'P02 pertenece al negocio esperado',      (SELECT business_id FROM c) = 'aa930802-0861-46ce-896c-7f68b181cb39'::uuid
  UNION ALL SELECT 'P03 es el remito esperado (tipo)',       (SELECT COALESCE(tipo,type) FROM c) = 'remito'
  UNION ALL SELECT 'P04 es el numero esperado',              (SELECT COALESCE(numero_fiscal,numero,number) FROM c) = '0001-00000003'
  UNION ALL SELECT 'P05 fecha original AR = 2026-05-08',     (SELECT (COALESCE(fecha,date,created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date FROM c) = DATE '2026-05-08'
  UNION ALL SELECT 'P06 estado = anulado',                   (SELECT estado FROM c) = 'anulado'
  UNION ALL SELECT 'P07 estado_comercial = anulado',         (SELECT estado_comercial FROM c) = 'anulado'
  UNION ALL SELECT 'P08 status = cancelled',                 (SELECT status FROM c) = 'cancelled'
  UNION ALL SELECT 'P09 total = 1235580.00',                 (SELECT total FROM c) = 1235580.00
  UNION ALL SELECT 'P10 venta de items = 1235580.00',        (SELECT COALESCE(SUM(i.subtotal),0) FROM comprobante_items i WHERE i.comprobante_id=(SELECT id FROM c)) = 1235580.00
  UNION ALL SELECT 'P11 costo historico de items = 1097006.00', (SELECT COALESCE(SUM(i.costo_total),0) FROM comprobante_items i WHERE i.comprobante_id=(SELECT id FROM c)) = 1097006.00
  UNION ALL SELECT 'P12 SIN registro en comprobante_annulments', (SELECT count(*) FROM comprobante_annulments a WHERE a.comprobante_id=(SELECT id FROM c)) = 0
  UNION ALL SELECT 'P13 SIN nota de credito',                (SELECT count(*) FROM comprobantes nc WHERE nc.comprobante_original_id=(SELECT id FROM c)) = 0
  UNION ALL SELECT 'P14 SIN CAE',                            (SELECT cae FROM c) IS NULL
  UNION ALL SELECT 'P15 SIN numero fiscal',                  (SELECT numero_fiscal FROM c) IS NULL
  UNION ALL SELECT 'P16 SIN financial_movements (nada que compensar)', (SELECT count(*) FROM financial_movements f WHERE f.comprobante_id=(SELECT id FROM c)) = 0
  UNION ALL SELECT 'P17 SIN business_finance_entries',       (SELECT count(*) FROM business_finance_entries b WHERE b.reference_comprobante_id=(SELECT id FROM c)) = 0
  UNION ALL SELECT 'P18 SIN movimientos de cuenta corriente', (SELECT count(*) FROM account_movements m WHERE m.reference_id=(SELECT id FROM c)) = 0
  UNION ALL SELECT 'P19 3 items',                            (SELECT count(*) FROM comprobante_items i WHERE i.comprobante_id=(SELECT id FROM c)) = 3
  UNION ALL SELECT 'P20 3 inventarios distintos',            (SELECT count(DISTINCT i.inventory_id) FROM comprobante_items i WHERE i.comprobante_id=(SELECT id FROM c)) = 3
  UNION ALL SELECT 'P21 stock restaurado EXACTAMENTE una vez por inventario',
    NOT EXISTS (SELECT 1 FROM inventory_movements m
                 WHERE m.reference_id=(SELECT id FROM c) AND m.movement_type='return'
                 GROUP BY m.inventory_item_id HAVING count(*) > 1)
  UNION ALL SELECT 'P22 hay 3 restauraciones de stock',      (SELECT count(*) FROM inventory_movements m WHERE m.reference_id=(SELECT id FROM c) AND m.movement_type='return') = 3
  UNION ALL SELECT 'P23 fecha de anulacion reconstruida = 2026-05-08 (por los movs de restauracion)',
    (SELECT max((m.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date)
       FROM inventory_movements m WHERE m.reference_id=(SELECT id FROM c) AND m.movement_type='return') = DATE '2026-05-08'
  UNION ALL SELECT 'P24 el actor existe (created_by del comprobante)', (SELECT created_by FROM c) IS NOT NULL
  UNION ALL SELECT 'P25 M7 desplegado: existe annulment_date',
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='comprobante_annulments' AND column_name='annulment_date')
) t
ORDER BY chequeo;

\echo '--- Evidencia de la anulacion legacy (ventana de ~81 segundos) ---'
SELECT m.movement_type, count(*) AS movimientos,
       min(m.created_at) AS primero, max(m.created_at) AS ultimo
FROM inventory_movements m
WHERE m.reference_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
GROUP BY m.movement_type ORDER BY 3;

\echo '--- Fila que se propondria insertar ---'
SELECT c.business_id, c.id AS comprobante_id, c.created_by AS user_id,
       'm7-7b-reconcile-ac3b00ef-44c4-4978-b51b-289797f7fbe1' AS idempotency_key,
       'comprobante_annulment' AS op,
       'commercial_annulment'  AS mode,
       'Reconciliación M7 de anulación legacy realizada por vía client-side' AS motivo,
       true      AS restore_stock,
       3         AS stock_restored_count,
       DATE '2026-05-08' AS annulment_date,
       0::numeric AS reverted_cash_ars, 0::numeric AS reverted_cc_ars,
       0::numeric AS reverted_commissions_ars, 0::numeric AS reverted_cogs_ars,
       'completed' AS status
FROM comprobantes c WHERE c.id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid;

\echo '--- Efecto esperado en el ledger devengado (post-apply) ---'
-- venta +1.235.580 el 2026-05-08  y  anulacion -1.235.580 el 2026-05-08  => 0
SELECT '2026-05-08' AS periodo,
       (SELECT COALESCE(SUM(i.subtotal),0) FROM comprobante_items i
         WHERE i.comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) AS venta_que_reaparece,
       -(SELECT COALESCE(SUM(i.subtotal),0) FROM comprobante_items i
          WHERE i.comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) AS compensacion_derivada,
       0::numeric AS efecto_neto;


-- ############################################################################
-- ## SECCIÓN 2 — APPLY (termina en ROLLBACK; NO cambiar sin aprobación)     ##
-- ############################################################################

BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout      = '3s';

-- Lock explícito del comprobante: serializa contra cualquier operación
-- concurrente sobre él mientras revalidamos y escribimos.
SELECT id, estado, status, estado_comercial
  FROM comprobantes
 WHERE id = 'ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
   FOR UPDATE;

-- Revalidación COMPLETA bajo lock. Fail-closed: cualquier desvío aborta sin
-- escribir (RAISE revierte toda la transacción).
DO $$
DECLARE
  k_comp      constant uuid := 'ac3b00ef-44c4-4978-b51b-289797f7fbe1';
  k_biz       constant uuid := 'aa930802-0861-46ce-896c-7f68b181cb39';
  k_fecha     constant date := DATE '2026-05-08';
  k_total     constant numeric := 1235580.00;
  k_cogs      constant numeric := 1097006.00;
  v_c         comprobantes%ROWTYPE;
  v_n         integer;
  v_venta     numeric;
  v_costo     numeric;
BEGIN
  SELECT * INTO v_c FROM comprobantes WHERE id = k_comp;
  IF NOT FOUND                                   THEN RAISE EXCEPTION '7B ABORTA P01: el comprobante no existe'; END IF;
  IF v_c.business_id <> k_biz                    THEN RAISE EXCEPTION '7B ABORTA P02: negocio inesperado (%)', v_c.business_id; END IF;
  IF COALESCE(v_c.tipo, v_c.type) <> 'remito'    THEN RAISE EXCEPTION '7B ABORTA P03: tipo inesperado (%)', COALESCE(v_c.tipo,v_c.type); END IF;
  IF COALESCE(v_c.numero_fiscal, v_c.numero, v_c.number) <> '0001-00000003'
                                                 THEN RAISE EXCEPTION '7B ABORTA P04: numero inesperado'; END IF;
  IF (COALESCE(v_c.fecha, v_c.date, v_c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date <> k_fecha
                                                 THEN RAISE EXCEPTION '7B ABORTA P05: fecha original inesperada'; END IF;
  IF v_c.estado <> 'anulado'                     THEN RAISE EXCEPTION '7B ABORTA P06: estado no es anulado (%)', v_c.estado; END IF;
  IF v_c.estado_comercial <> 'anulado'           THEN RAISE EXCEPTION '7B ABORTA P07: estado_comercial no es anulado'; END IF;
  IF v_c.status <> 'cancelled'                   THEN RAISE EXCEPTION '7B ABORTA P08: status no es cancelled'; END IF;
  IF v_c.total <> k_total                        THEN RAISE EXCEPTION '7B ABORTA P09: total inesperado (%)', v_c.total; END IF;
  IF v_c.cae IS NOT NULL                         THEN RAISE EXCEPTION '7B ABORTA P14: tiene CAE — corresponde nota de credito'; END IF;
  IF v_c.numero_fiscal IS NOT NULL               THEN RAISE EXCEPTION '7B ABORTA P15: tiene numero fiscal'; END IF;
  IF v_c.created_by IS NULL                      THEN RAISE EXCEPTION '7B ABORTA P24: sin actor atribuible'; END IF;

  SELECT COALESCE(SUM(i.subtotal),0), COALESCE(SUM(i.costo_total),0), count(*)
    INTO v_venta, v_costo, v_n
    FROM comprobante_items i WHERE i.comprobante_id = k_comp;
  IF v_venta <> k_total  THEN RAISE EXCEPTION '7B ABORTA P10: venta de items inesperada (%)', v_venta; END IF;
  IF v_costo <> k_cogs   THEN RAISE EXCEPTION '7B ABORTA P11: costo historico inesperado (%)', v_costo; END IF;
  IF v_n <> 3            THEN RAISE EXCEPTION '7B ABORTA P19: cantidad de items inesperada (%)', v_n; END IF;

  -- Idempotencia real: si ya existe un registro, no-op controlado.
  SELECT count(*) INTO v_n FROM comprobante_annulments WHERE comprobante_id = k_comp;
  IF v_n > 0 THEN RAISE EXCEPTION '7B ABORTA P12: YA existe registro de anulacion (% filas) — nada que reconciliar', v_n; END IF;

  SELECT count(*) INTO v_n FROM comprobantes nc WHERE nc.comprobante_original_id = k_comp;
  IF v_n > 0 THEN RAISE EXCEPTION '7B ABORTA P13: tiene nota de credito — no corresponde registro interno'; END IF;

  -- Nada que compensar: si apareciera impacto financiero, este caso ya no es el
  -- que se aprobó y hay que re-analizarlo.
  SELECT count(*) INTO v_n FROM financial_movements f WHERE f.comprobante_id = k_comp;
  IF v_n > 0 THEN RAISE EXCEPTION '7B ABORTA P16: existen % financial_movements — habria que compensar', v_n; END IF;
  SELECT count(*) INTO v_n FROM business_finance_entries b WHERE b.reference_comprobante_id = k_comp;
  IF v_n > 0 THEN RAISE EXCEPTION '7B ABORTA P17: existen % BFE — podrian duplicarse', v_n; END IF;
  SELECT count(*) INTO v_n FROM account_movements m WHERE m.reference_id = k_comp;
  IF v_n > 0 THEN RAISE EXCEPTION '7B ABORTA P18: existen % movimientos de CC', v_n; END IF;

  -- El stock ya fue restaurado EXACTAMENTE una vez por inventario.
  SELECT count(*) INTO v_n FROM inventory_movements m
   WHERE m.reference_id = k_comp AND m.movement_type = 'return';
  IF v_n <> 3 THEN RAISE EXCEPTION '7B ABORTA P22: se esperaban 3 restauraciones, hay %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM inventory_movements m
              WHERE m.reference_id = k_comp AND m.movement_type='return'
              GROUP BY m.inventory_item_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '7B ABORTA P21: hay restauraciones DUPLICADAS de stock';
  END IF;
  IF (SELECT max((m.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date)
        FROM inventory_movements m WHERE m.reference_id=k_comp AND m.movement_type='return') <> k_fecha THEN
    RAISE EXCEPTION '7B ABORTA P23: la fecha reconstruida de anulacion no es 2026-05-08';
  END IF;

  -- M7 debe estar desplegado: sin annulment_date el registro fecharia la
  -- compensacion en el mes equivocado.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='comprobante_annulments' AND column_name='annulment_date') THEN
    RAISE EXCEPTION '7B ABORTA P25: falta comprobante_annulments.annulment_date — desplegar M7 ANTES';
  END IF;

  RAISE NOTICE '7B: las 25 precondiciones pasaron bajo lock. Procediendo al INSERT minimo.';
END $$;

-- ── ESCRITURA MÍNIMA 1/2: la evidencia canónica ─────────────────────────────
-- Única fila que esta reconciliación crea en el modelo económico.
-- Justificación campo por campo:
--   mode='commercial_annulment' → es el único de los tres modos que NO implica
--     devolución de dinero, y no existe ni un financial_movement que reversar.
--     (La RPC habría rechazado este modo en vivo porque hay una fila de pago;
--      por eso esto es una reconciliación documental y no una llamada a la RPC.)
--   restore_stock=true / stock_restored_count=3 → reconstruye el hecho: el
--     stock SÍ se restauró el 2026-05-08 (3 movimientos 'return').
--   reverted_*=0 → este registro no revierte nada: no había nada que revertir.
--   annulment_date='2026-05-08' → fecha económica canónica; hace que la
--     compensación caiga el MISMO día que la venta ⇒ efecto neto 0.
--   request_hash → mismo formato canónico que calcula annul_comprobante_atomic,
--     para que la fila sea indistinguible en forma de una real.
INSERT INTO comprobante_annulments (
  business_id, comprobante_id, user_id, idempotency_key, request_hash, op,
  mode, motivo, restore_stock, stock_restored_count, annulment_date,
  original_caja_ids, refund_caja_id,
  reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars,
  original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id,
  status
)
SELECT c.business_id, c.id, c.created_by,
       'm7-7b-reconcile-ac3b00ef-44c4-4978-b51b-289797f7fbe1',
       encode(extensions.digest(jsonb_build_object(
         'op','comprobante_annulment', 'business_id', c.business_id, 'comprobante_id', c.id,
         'mode','commercial_annulment', 'restore_stock', true,
         'reason','Reconciliación M7 de anulación legacy realizada por vía client-side')::text,'sha256'),'hex'),
       'comprobante_annulment',
       'commercial_annulment',
       'Reconciliación M7 de anulación legacy realizada por vía client-side',
       true, 3, DATE '2026-05-08',
       '{}'::uuid[], NULL,
       0, 0, 0, 0,
       '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL,
       'completed'
FROM comprobantes c
WHERE c.id = 'ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
  -- Idempotencia declarativa: si ya existe un registro completado, no inserta.
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a
                   WHERE a.comprobante_id = c.id AND a.status = 'completed');

-- ── ESCRITURA MÍNIMA 2/2: la explicación auditable ──────────────────────────
-- finance_ledger_reconciliation no tiene estado 'proposed' (su CHECK admite
-- corrected|legacy_accepted|active_inconsistency|indeterminate). Se usa
-- 'corrected' porque, al aplicarse, la inconsistencia queda efectivamente
-- corregida. No genera ningún movimiento.
INSERT INTO finance_ledger_reconciliation (
  business_id, entity_table, entity_id, issue_type, legacy,
  reconciliation_status, reconciliation_reason, evidence, reconciled_by
)
SELECT c.business_id, 'comprobantes', c.id,
       'annulment_sin_registro_canonico', true,
       'corrected',
       'Lote 7B — Anulación legacy por vía client-side sin registro en comprobante_annulments. '
       'Se crea la evidencia canónica con fecha económica 2026-05-08 para que v_finance_sales_ledger '
       'derive la compensación en el mismo período de la venta (efecto neto 0). '
       'No se generaron movimientos financieros ni de inventario: el stock ya había sido restaurado '
       'y nunca existió impacto financiero.',
       jsonb_build_object(
         'informe', 'docs/auditoria-finanzas/m7/m7-lote-7a-dry-run-preflight-report.md',
         'comprobante_id', c.id, 'tipo', COALESCE(c.tipo,c.type),
         'numero', COALESCE(c.numero_fiscal,c.numero,c.number),
         'fecha_original', (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,
         'fecha_anulacion_reconstruida', DATE '2026-05-08',
         'evidencia_fecha', 'movimientos inventory_movements.movement_type=return del 2026-05-08 14:13:06-08 UTC, 81s despues de la venta',
         'total', c.total,
         'venta_items', (SELECT COALESCE(SUM(i.subtotal),0)    FROM comprobante_items i WHERE i.comprobante_id=c.id),
         'cogs_items',  (SELECT COALESCE(SUM(i.costo_total),0) FROM comprobante_items i WHERE i.comprobante_id=c.id),
         'financial_movements', 0, 'business_finance_entries', 0, 'account_movements', 0,
         'notas_credito', 0, 'cae', NULL,
         'stock_restaurado_previamente', true, 'restauraciones', 3,
         'movimientos_creados_por_esta_reconciliacion', jsonb_build_object(
           'financial_movements', 0, 'business_finance_entries', 0,
           'account_movements', 0, 'inventory_movements', 0, 'comprobante_payments', 0,
           'cambios_en_comprobantes', 0),
         'decision', 'Registrar SOLO este remito. La factura C 95cbf330-0714-412a-9d5d-f6aa85123a62 '
                     'NO recibe registro interno: tiene nota de crédito y se revierte por la vía fiscal.'),
       c.created_by
FROM comprobantes c
WHERE c.id = 'ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
  AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
                   WHERE r.entity_id = c.id AND r.issue_type = 'annulment_sin_registro_canonico'
                     AND r.reconciliation_status = 'corrected');

-- ── VERIFICACIONES POSTERIORES (dentro de la misma transacción) ─────────────
\echo '=== 7B POST-APPLY (antes del ROLLBACK) =========================='

SELECT 'V1 exactamente 1 registro de anulacion' AS verificacion,
       (SELECT count(*) FROM comprobante_annulments WHERE comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 1 AS ok
UNION ALL SELECT 'V2 annulment_date = 2026-05-08',
       (SELECT annulment_date FROM comprobante_annulments WHERE comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = DATE '2026-05-08'
UNION ALL SELECT 'V3 status = completed',
       (SELECT status FROM comprobante_annulments WHERE comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 'completed'
UNION ALL SELECT 'V4 CERO financial_movements creados',
       (SELECT count(*) FROM financial_movements WHERE comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 0
UNION ALL SELECT 'V5 CERO BFE creados',
       (SELECT count(*) FROM business_finance_entries WHERE reference_comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 0
UNION ALL SELECT 'V6 CERO movimientos de CC creados',
       (SELECT count(*) FROM account_movements WHERE reference_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 0
UNION ALL SELECT 'V7 movimientos de inventario sin cambios (3 return)',
       (SELECT count(*) FROM inventory_movements WHERE reference_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid AND movement_type='return') = 3
UNION ALL SELECT 'V8 pagos sin cambios (1)',
       (SELECT count(*) FROM comprobante_payments WHERE comprobante_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid) = 1
UNION ALL SELECT 'V9 la factura C NO recibio registro',
       (SELECT count(*) FROM comprobante_annulments WHERE comprobante_id='95cbf330-0714-412a-9d5d-f6aa85123a62'::uuid) = 0
UNION ALL SELECT 'V10 1 fila de reconciliacion explicativa',
       (SELECT count(*) FROM finance_ledger_reconciliation
         WHERE entity_id='ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid AND issue_type='annulment_sin_registro_canonico') = 1
ORDER BY 1;

\echo '--- Efecto neto en el ledger devengado: debe ser 0 ---'
SELECT l.period_date,
       SUM(l.sales_amount_ars) AS ventas,
       SUM(l.cogs_amount_ars)  AS cogs,
       SUM(l.sales_amount_ars) - SUM(l.cogs_amount_ars) AS resultado
FROM v_finance_sales_ledger l
WHERE l.comprobante_id = 'ac3b00ef-44c4-4978-b51b-289797f7fbe1'::uuid
GROUP BY ROLLUP (l.period_date)
ORDER BY 1 NULLS LAST;

-- ############################################################################
-- ## ROLLBACK POR DEFECTO — no tocar sin aprobación humana explícita.       ##
-- ## Para aplicar de verdad: reemplazar por COMMIT, con testigo, tras leer  ##
-- ## el POST-APPLY de arriba en la misma sesión.                            ##
-- ############################################################################
ROLLBACK;
