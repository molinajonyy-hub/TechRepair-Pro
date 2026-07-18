-- ============================================================================
-- M7 — PREFLIGHT PRODUCTIVO CONJUNTO (Lote 7A)
--
-- SOLO LECTURA. Este archivo no contiene una sola sentencia de escritura.
-- Consolida los preflights de: auditoria, periodos, owner flows, gastos y caja,
-- pagos de clientes y ordenes, proveedores, compra rapida, checkout, reversas,
-- reemplazo de cobros (6F.3), anulaciones (6f4-preflight-anulaciones.sql) e
-- invariantes de anulado (6F.4a). Duplicados conceptuales unificados; cobertura
-- preservada.
--
-- USO OBLIGATORIO (envoltura read-only; verificada: transaction_read_only='on'):
--   BEGIN;
--   SET TRANSACTION READ ONLY;
--   SET LOCAL statement_timeout = '60s';
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL idle_in_transaction_session_timeout = '120s';
--   \i m7-preflight-productivo-conjunto.sql
--   ROLLBACK;
--
-- COMPATIBILIDAD: M7 todavia no esta desplegado, asi que varias columnas y
-- objetos no existen aun en produccion. Todo chequeo que dependa de un objeto
-- M7 se protege con to_regclass()/information_schema y devuelve 'n/a (M7 no
-- desplegado)' en vez de fallar. Ningun SELECT referencia directamente una
-- columna inexistente.
--
-- SEVERIDADES: BLOCKER impide desplegar; WARN exige decision; INFO es esperado.
-- ============================================================================

\echo '=== 0. ENTORNO ==============================================='
SELECT current_database() AS db, current_user AS usuario,
       current_setting('transaction_read_only') AS read_only,
       pg_is_in_recovery() AS es_replica,
       now() AS hora_servidor, version() AS pg_version;

\echo '=== 1. ESTADO DE DESPLIEGUE M7 ==============================='
SELECT 'finance_audit_log'        AS objeto, (to_regclass('public.finance_audit_log') IS NOT NULL) AS presente
UNION ALL SELECT 'finance_period_locks',      to_regclass('public.finance_period_locks') IS NOT NULL
UNION ALL SELECT 'v_finance_sales_ledger',    to_regclass('public.v_finance_sales_ledger') IS NOT NULL
UNION ALL SELECT 'fn assert_period_open',     to_regproc('public.assert_period_open') IS NOT NULL
UNION ALL SELECT 'fn is_comprobante_annulled',to_regproc('public.is_comprobante_annulled') IS NOT NULL
UNION ALL SELECT 'col comprobante_payments.replaced_at',
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_payments' AND column_name='replaced_at')
UNION ALL SELECT 'col comprobante_annulments.annulment_date',
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_annulments' AND column_name='annulment_date')
UNION ALL SELECT 'trg_comprobante_annulment_transition',
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_comprobante_annulment_transition')
UNION ALL SELECT 'trg_cp_annulled_guard',
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_cp_annulled_guard')
ORDER BY 2 DESC, 1;

\echo '=== 2. VOLUMEN ==============================================='
SELECT 'comprobantes' AS tabla, count(*) AS filas FROM comprobantes
UNION ALL SELECT 'comprobante_items',        count(*) FROM comprobante_items
UNION ALL SELECT 'comprobante_payments',     count(*) FROM comprobante_payments
UNION ALL SELECT 'comprobante_annulments',   count(*) FROM comprobante_annulments
UNION ALL SELECT 'financial_movements',      count(*) FROM financial_movements
UNION ALL SELECT 'business_finance_entries', count(*) FROM business_finance_entries
UNION ALL SELECT 'account_movements',        count(*) FROM account_movements
UNION ALL SELECT 'inventory_movements',      count(*) FROM inventory_movements
ORDER BY filas DESC;

-- ============================================================================
-- 3. MULTI-TENANT — cualquier fila devuelta es BLOCKER
-- ============================================================================
\echo '=== 3. MULTI-TENANT (todo debe dar 0) ========================'
SELECT 'MT1 comprobante<->cliente' AS check, count(*) AS n
  FROM comprobantes c JOIN customers k ON k.id=c.customer_id WHERE k.business_id<>c.business_id
UNION ALL SELECT 'MT2 comprobante<->orden', count(*)
  FROM comprobantes c JOIN orders o ON o.id=c.order_id WHERE o.business_id<>c.business_id
UNION ALL SELECT 'MT3 pago<->comprobante', count(*)
  FROM comprobante_payments p JOIN comprobantes c ON c.id=p.comprobante_id WHERE c.business_id<>p.business_id
UNION ALL SELECT 'MT4 FM<->comprobante', count(*)
  FROM financial_movements f JOIN comprobantes c ON c.id=f.comprobante_id WHERE c.business_id<>f.business_id
UNION ALL SELECT 'MT5 BFE<->comprobante', count(*)
  FROM business_finance_entries b JOIN comprobantes c ON c.id=b.reference_comprobante_id WHERE c.business_id<>b.business_id
UNION ALL SELECT 'MT6 item<->inventory', count(*)
  FROM comprobante_items ci JOIN inventory i ON i.id=ci.inventory_id WHERE i.business_id<>ci.business_id
UNION ALL SELECT 'MT7 account_movement<->account', count(*)
  FROM account_movements am JOIN accounts a ON a.id=am.account_id WHERE a.business_id<>am.business_id
UNION ALL SELECT 'MT8 inventory_movement<->inventory', count(*)
  FROM inventory_movements m JOIN inventory i ON i.id=m.inventory_item_id WHERE i.business_id<>m.business_id
UNION ALL SELECT 'MT9 FM<->caja', count(*)
  FROM financial_movements f JOIN cajas j ON j.id=f.caja_id WHERE j.business_id<>f.business_id
UNION ALL SELECT 'MT10 item<->comprobante', count(*)
  FROM comprobante_items ci JOIN comprobantes c ON c.id=ci.comprobante_id WHERE c.business_id<>ci.business_id
ORDER BY 1;

-- ============================================================================
-- 4. REFERENCIAS ROTAS / COMPATIBILIDAD DE CONSTRAINTS M7
-- ============================================================================
\echo '=== 4. REFERENCIAS Y CONSTRAINTS ============================='
SELECT 'RF1 pagos sin comprobante' AS check, count(*) AS n
  FROM comprobante_payments p WHERE NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.id=p.comprobante_id)
UNION ALL SELECT 'RF2 items sin comprobante', count(*)
  FROM comprobante_items ci WHERE NOT EXISTS(SELECT 1 FROM comprobantes c WHERE c.id=ci.comprobante_id)
UNION ALL SELECT 'RF3 items con inventory_id inexistente', count(*)
  FROM comprobante_items ci WHERE ci.inventory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory i WHERE i.id=ci.inventory_id)
UNION ALL SELECT 'RF4 NC con original inexistente', count(*)
  FROM comprobantes nc WHERE nc.comprobante_original_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM comprobantes o WHERE o.id=nc.comprobante_original_id)
-- 6E.1a: TechRepair Pro maneja SOLO unidades enteras. Una sola fila decimal
-- rompe la validacion de la compra rapida y el agrupado de restauracion.
UNION ALL SELECT 'CN1 items con cantidad DECIMAL (BLOCKER si >0)', count(*)
  FROM comprobante_items WHERE cantidad IS NOT NULL AND cantidad <> floor(cantidad)
UNION ALL SELECT 'CN2 items con cantidad <= 0', count(*)
  FROM comprobante_items WHERE COALESCE(cantidad,0) <= 0
UNION ALL SELECT 'CN3 items con subtotal/costo/precio NULL', count(*)
  FROM comprobante_items WHERE subtotal IS NULL OR costo_total IS NULL OR precio_unitario IS NULL
-- CHECK de comprobante_payments (catalogo del checkout)
UNION ALL SELECT 'CN4 metodo de pago fuera de catalogo', count(*)
  FROM comprobante_payments
  WHERE payment_method NOT IN ('efectivo','transferencia','tarjeta_debito','tarjeta_credito','qr','mixto','otro')
UNION ALL SELECT 'CN5 amount_ars nulo o <= 0', count(*)
  FROM comprobante_payments WHERE COALESCE(amount_ars,0) <= 0
ORDER BY 1;

-- ============================================================================
-- 5. ANULACIONES — el nucleo del restatement de 6F.4
-- ============================================================================
\echo '=== 5. ANULACIONES ==========================================='
-- A1 (BLOCKER) anulados SIN registro canonico: la vista no puede derivar su
-- compensacion -> su venta reaparece en el periodo original y NO netea.
SELECT 'A1 anulados SIN registro canonico (BLOCKER)' AS check, count(*) AS n
  FROM comprobantes c
 WHERE (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')
   AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed')
UNION ALL SELECT 'A2 registros sin comprobante', count(*)
  FROM comprobante_annulments a WHERE NOT EXISTS (SELECT 1 FROM comprobantes c WHERE c.id=a.comprobante_id)
UNION ALL SELECT 'A3 multiples registros por comprobante', (SELECT count(*) FROM (
  SELECT comprobante_id FROM comprobante_annulments WHERE status='completed'
  GROUP BY comprobante_id HAVING count(*)>1) d)
UNION ALL SELECT 'A4 anulacion cross-business', count(*)
  FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id WHERE c.business_id<>a.business_id
UNION ALL SELECT 'A5 fecha de anulacion ANTERIOR a la venta', count(*)
  FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
  WHERE (a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date
      < (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date
UNION ALL SELECT 'A6 DOBLE REVERSION: anulacion interna + nota de credito (BLOCKER)', count(*)
  FROM comprobante_annulments a
  WHERE EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=a.comprobante_id
                  AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado <> 'anulado')
UNION ALL SELECT 'A7 senales PARCIALES (una columna dice anulado y otra no)', count(*)
  FROM comprobantes c
  WHERE (COALESCE(c.estado,'')='anulado' OR COALESCE(c.estado_comercial,'')='anulado' OR COALESCE(c.status,'')='cancelled')
    AND NOT (COALESCE(c.estado,'')='anulado' AND COALESCE(c.estado_comercial,'')='anulado' AND COALESCE(c.status,'')='cancelled')
UNION ALL SELECT 'A8 compensaciones de anulacion sin registro', count(*)
  FROM financial_movements f WHERE f.reference_type='annulment_reversal'
    AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=f.comprobante_id AND a.status='completed')
UNION ALL SELECT 'A9 DOBLE DEVOLUCION: >1 compensacion por FM original (BLOCKER)', (SELECT count(*) FROM (
  SELECT f.reference_id FROM financial_movements f
  WHERE f.reference_type='annulment_reversal' AND f.reference_id IS NOT NULL
  GROUP BY f.reference_id HAVING count(*)>1) d)
UNION ALL SELECT 'A10 restauracion de stock DUPLICADA', (SELECT count(*) FROM (
  SELECT reference_id, inventory_item_id FROM inventory_movements
  WHERE reference_type='comprobante' AND movement_type='return'
  GROUP BY reference_id, inventory_item_id HAVING count(*)>1) d)
ORDER BY 1;

\echo '--- 5b. Detalle de CADA anulado (insumo del restatement) ---'
SELECT c.id, c.business_id, COALESCE(c.tipo,c.type) AS tipo,
       COALESCE(c.numero_fiscal,c.numero,c.number) AS numero,
       (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS fecha_original,
       c.total, c.cae IS NOT NULL AS tiene_cae,
       (SELECT COALESCE(SUM(i.subtotal),0)    FROM comprobante_items i WHERE i.comprobante_id=c.id) AS venta,
       (SELECT COALESCE(SUM(i.costo_total),0) FROM comprobante_items i WHERE i.comprobante_id=c.id) AS cogs,
       (SELECT COALESCE(SUM(i.subtotal-i.costo_total),0) FROM comprobante_items i WHERE i.comprobante_id=c.id) AS resultado,
       (SELECT count(*) FROM comprobante_payments p WHERE p.comprobante_id=c.id)  AS pagos,
       (SELECT count(*) FROM financial_movements f WHERE f.comprobante_id=c.id)   AS fms,
       (SELECT count(*) FROM business_finance_entries b WHERE b.reference_comprobante_id=c.id) AS bfes,
       (SELECT count(*) FROM comprobantes nc WHERE nc.comprobante_original_id=c.id) AS notas_credito,
       EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed') AS tiene_registro_canonico,
       CASE WHEN EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed')
            THEN 'derivada de created_at (M6)' ELSE 'SIN FECHA — no hay registro' END AS calidad_fecha_anulacion,
       to_char((COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date,'YYYY-MM') AS periodo_que_hoy_pierde_la_venta
FROM comprobantes c
WHERE c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado'
ORDER BY c.business_id, fecha_original;

-- ============================================================================
-- 6. DRY-RUN DEL RESTATEMENT — P&L actual vs corregido (CTEs, sin crear vistas)
-- ============================================================================
\echo '=== 6. RESTATEMENT por negocio y mes ========================='
WITH efectivo AS (
  SELECT c.id, c.business_id,
         (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date AS period_date,
         COALESCE(c.tipo,c.type)='nota_credito' AS is_credit_note,
         (c.estado <> 'anulado' AND COALESCE(c.estado_comercial,'') <> 'anulado') AS vigente
  FROM comprobantes c
  WHERE ((COALESCE(c.status,c.estado) = ANY (ARRAY['issued','emitido']))
      OR EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id=c.id)
      OR EXISTS (SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id=c.id AND ci.stock_processed=true)
      OR EXISTS (SELECT 1 FROM account_movements am WHERE am.reference_type='comprobante' AND am.reference_id=c.id AND am.type='venta'))
),
actual AS (      -- modelo HOY: el anulado desaparece de su periodo original
  SELECT e.business_id, to_char(e.period_date,'YYYY-MM') AS mes,
         SUM(ci.subtotal) AS ventas, SUM(ci.costo_total) AS cogs
  FROM efectivo e JOIN comprobante_items ci ON ci.comprobante_id=e.id
  WHERE e.vigente AND NOT e.is_credit_note GROUP BY 1,2
),
corregido AS (   -- modelo M7: venta en su periodo + compensacion desde comprobante_annulments
  SELECT e.business_id, to_char(e.period_date,'YYYY-MM') AS mes,
         SUM(ci.subtotal) AS ventas, SUM(ci.costo_total) AS cogs
  FROM efectivo e JOIN comprobante_items ci ON ci.comprobante_id=e.id
  WHERE NOT e.is_credit_note GROUP BY 1,2
),
compensacion AS (  -- eventos de anulacion que M7 derivaria (vacio si no hay registros)
  SELECT a.business_id,
         to_char((a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date,'YYYY-MM') AS mes,
         -SUM(ci.subtotal) AS ventas, -SUM(ci.costo_total) AS cogs
  FROM comprobante_annulments a JOIN comprobante_items ci ON ci.comprobante_id=a.comprobante_id
  WHERE a.status='completed' GROUP BY 1,2
)
SELECT COALESCE(a.business_id,n.business_id) AS business_id,
       COALESCE(a.mes,n.mes) AS mes,
       COALESCE(a.ventas,0) AS ventas_actual,
       COALESCE(n.ventas,0)+COALESCE(k.ventas,0) AS ventas_corregida,
       COALESCE(n.ventas,0)+COALESCE(k.ventas,0)-COALESCE(a.ventas,0) AS delta_ventas,
       COALESCE(a.cogs,0) AS cogs_actual,
       COALESCE(n.cogs,0)+COALESCE(k.cogs,0) AS cogs_corregido,
       COALESCE(n.cogs,0)+COALESCE(k.cogs,0)-COALESCE(a.cogs,0) AS delta_cogs,
       (COALESCE(n.ventas,0)+COALESCE(k.ventas,0)-COALESCE(n.cogs,0)-COALESCE(k.cogs,0))
         - (COALESCE(a.ventas,0)-COALESCE(a.cogs,0)) AS delta_resultado,
       (SELECT count(*) FROM comprobante_annulments z WHERE z.business_id=COALESCE(a.business_id,n.business_id)) AS anulaciones
FROM actual a
FULL OUTER JOIN corregido n ON n.business_id=a.business_id AND n.mes=a.mes
LEFT JOIN compensacion k ON k.business_id=COALESCE(a.business_id,n.business_id) AND k.mes=COALESCE(a.mes,n.mes)
WHERE COALESCE(a.ventas,0) <> COALESCE(n.ventas,0)+COALESCE(k.ventas,0)
   OR COALESCE(a.cogs,0)   <> COALESCE(n.cogs,0)+COALESCE(k.cogs,0)
ORDER BY 1,2;

\echo '--- 6b. Delta ACUMULADO: debe dar 0. Distinto de 0 = BLOCKER ---'
WITH efectivo AS (
  SELECT c.id, c.business_id, COALESCE(c.tipo,c.type)='nota_credito' AS is_credit_note,
         (c.estado <> 'anulado' AND COALESCE(c.estado_comercial,'') <> 'anulado') AS vigente
  FROM comprobantes c
  WHERE ((COALESCE(c.status,c.estado) = ANY (ARRAY['issued','emitido']))
      OR EXISTS (SELECT 1 FROM comprobante_payments p WHERE p.comprobante_id=c.id)
      OR EXISTS (SELECT 1 FROM comprobante_items ci WHERE ci.comprobante_id=c.id AND ci.stock_processed=true)
      OR EXISTS (SELECT 1 FROM account_movements am WHERE am.reference_type='comprobante' AND am.reference_id=c.id AND am.type='venta'))
)
SELECT e.business_id,
       SUM(ci.subtotal)    FILTER (WHERE NOT e.vigente) AS ventas_que_reaparecen,
       SUM(ci.costo_total) FILTER (WHERE NOT e.vigente) AS cogs_que_reaparece,
       COALESCE((SELECT SUM(ci2.subtotal) FROM comprobante_annulments a
                  JOIN comprobante_items ci2 ON ci2.comprobante_id=a.comprobante_id
                 WHERE a.business_id=e.business_id AND a.status='completed'),0) AS ventas_compensadas,
       SUM(ci.subtotal) FILTER (WHERE NOT e.vigente)
         - COALESCE((SELECT SUM(ci2.subtotal) FROM comprobante_annulments a
                      JOIN comprobante_items ci2 ON ci2.comprobante_id=a.comprobante_id
                     WHERE a.business_id=e.business_id AND a.status='completed'),0) AS delta_neto_ventas
FROM efectivo e JOIN comprobante_items ci ON ci.comprobante_id=e.id
WHERE NOT e.is_credit_note
GROUP BY e.business_id
HAVING SUM(ci.subtotal) FILTER (WHERE NOT e.vigente) IS NOT NULL
ORDER BY 1;

-- ============================================================================
-- 7. PAGOS: vigentes vs reemplazados (replaced_at puede no existir aun)
-- ============================================================================
\echo '=== 7. PAGOS ================================================='
SELECT 'P1 comprobantes ANULADOS con pagos (append-only: esperado)' AS check, count(*)::text AS n
  FROM comprobante_payments p JOIN comprobantes c ON c.id=p.comprobante_id
  WHERE c.estado='anulado' OR c.estado_comercial='anulado' OR c.status='cancelled'
UNION ALL SELECT 'P2 header total_cobrado <> suma de pagos', (SELECT count(*)::text FROM (
  SELECT c.id FROM comprobantes c LEFT JOIN comprobante_payments p ON p.comprobante_id=c.id
  GROUP BY c.id, c.total_cobrado HAVING COALESCE(SUM(p.amount_ars),0) <> COALESCE(c.total_cobrado,0)) d)
UNION ALL SELECT 'P3 requests de reemplazo existentes', (SELECT count(*)::text FROM comprobante_payment_replace_requests)
UNION ALL SELECT 'P4 comprobantes con >1 pago (mixto o reemplazo M6)', (SELECT count(*)::text FROM (
  SELECT comprobante_id FROM comprobante_payments GROUP BY comprobante_id HAVING count(*)>1) d)
-- LIMITACION HISTORICA IRREVERSIBLE: el replace M6 BORRABA la fila original. Si
-- hay requests con new_payment_id pero el comprobante tiene una sola fila, la
-- historia previa YA no existe y M7 no puede reconstruirla. No bloquea el deploy.
UNION ALL SELECT 'P5 requests M6 cuyo historial fue borrado (WARN, irreversible)', (
  SELECT count(*)::text FROM comprobante_payment_replace_requests q
  WHERE q.new_payment_id IS NOT NULL
    AND (SELECT count(*) FROM comprobante_payments p WHERE p.comprobante_id=q.comprobante_id) <= 1)
UNION ALL SELECT 'P6 replaced_at ya existe en produccion',
  (EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_name='comprobante_payments' AND column_name='replaced_at'))::text
ORDER BY 1;

-- ============================================================================
-- 8. CUENTA CORRIENTE
-- ============================================================================
\echo '=== 8. CUENTA CORRIENTE ======================================'
SELECT 'CC1 saldo persistido <> suma canonica' AS check, count(*) AS n
  FROM accounts a
  WHERE COALESCE(a.balance,0) <> COALESCE((SELECT SUM(m.debit-m.credit) FROM account_movements m WHERE m.account_id=a.id),0)
UNION ALL SELECT 'CC2 movimientos sin cuenta', count(*)
  FROM account_movements m WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=m.account_id)
UNION ALL SELECT 'CC3 anulados sin movimiento compensatorio', count(*)
  FROM comprobantes c
  WHERE (c.estado='anulado' OR c.status='cancelled')
    AND EXISTS(SELECT 1 FROM account_movements m WHERE m.reference_id=c.id AND m.type='venta')
    AND NOT EXISTS(SELECT 1 FROM account_movements m WHERE m.reference_id=c.id AND m.type='ajuste')
UNION ALL SELECT 'CC4 movimientos duplicados por referencia', (SELECT count(*) FROM (
  SELECT reference_id, type FROM account_movements WHERE reference_type='comprobante'
  GROUP BY reference_id, type HAVING count(*)>1) d)
ORDER BY 1;

-- ============================================================================
-- 9. CAJA Y CASHFLOW
-- ============================================================================
\echo '=== 9. CAJA Y CASHFLOW ======================================='
SELECT 'CJ1 mas de una caja ABIERTA por negocio (BLOCKER)' AS check, (SELECT count(*) FROM (
  SELECT business_id FROM cajas WHERE status='abierta' GROUP BY business_id HAVING count(*)>1) d) AS n
UNION ALL SELECT 'CJ2 FM efectivo sin caja (WARN legacy)', (
  SELECT count(*) FROM financial_movements WHERE metodo_pago='efectivo' AND caja_id IS NULL)
UNION ALL SELECT 'CJ3 FM en caja de otro negocio', (
  SELECT count(*) FROM financial_movements f JOIN cajas j ON j.id=f.caja_id WHERE j.business_id<>f.business_id)
UNION ALL SELECT 'CJ4 FM sin referencia a entidad', (
  SELECT count(*) FROM financial_movements WHERE comprobante_id IS NULL AND reference_id IS NULL AND source_id IS NULL)
UNION ALL SELECT 'CJ5 FM de anulacion duplicados', (SELECT count(*) FROM (
  SELECT reference_id FROM financial_movements WHERE reference_type='annulment_reversal' AND reference_id IS NOT NULL
  GROUP BY reference_id HAVING count(*)>1) d)
UNION ALL SELECT 'CJ6 FM con reversed_at seteado', (
  SELECT count(*) FROM financial_movements WHERE reversed_at IS NOT NULL)
ORDER BY 1;

-- ============================================================================
-- 10. P&L Y BFE LEGACY
-- ============================================================================
\echo '=== 10. BFE / P&L ============================================'
SELECT 'BF1 BFE sin economic_class' AS check, count(*) AS n, 0::numeric AS monto
  FROM business_finance_entries WHERE economic_class IS NULL
UNION ALL SELECT 'BF2 legacy_unclassified TOTAL', count(*), COALESCE(SUM(amount_ars),0)
  FROM business_finance_entries WHERE economic_class='legacy_unclassified'
-- Mirrors historicos de anulacion: deuda de clasificacion EXPLICADA, fuera del
-- operating result. No es blocker si cada fila corresponde a una anulacion.
-- Ver 6f4a-nota-health-check-v2.md
UNION ALL SELECT 'BF3 legacy_unclassified que SON mirrors de anulacion (INFO)', count(*), COALESCE(SUM(amount_ars),0)
  FROM business_finance_entries WHERE economic_class='legacy_unclassified' AND source='annulment'
UNION ALL SELECT 'BF4 legacy_unclassified de OTRO origen (WARN/BLOCKER segun monto)', count(*), COALESCE(SUM(amount_ars),0)
  FROM business_finance_entries WHERE economic_class='legacy_unclassified' AND COALESCE(source,'') <> 'annulment'
UNION ALL SELECT 'BF5 BFE source=annulment (total)', count(*), COALESCE(SUM(amount_ars),0)
  FROM business_finance_entries WHERE source='annulment'
UNION ALL SELECT 'BF6 COGS mirror duplicado por comprobante', (SELECT count(*) FROM (
  SELECT reference_comprobante_id FROM business_finance_entries
  WHERE category='mercaderia' AND amount_ars > 0 AND reference_comprobante_id IS NOT NULL
  GROUP BY reference_comprobante_id HAVING count(*)>1) d), 0
UNION ALL SELECT 'BF7 ingreso mirror duplicado por comprobante', (SELECT count(*) FROM (
  SELECT reference_comprobante_id FROM business_finance_entries
  WHERE type='income' AND amount_ars > 0 AND reference_comprobante_id IS NOT NULL
  GROUP BY reference_comprobante_id HAVING count(*)>1) d), 0
ORDER BY 1;

-- ============================================================================
-- 11. REQUEST TABLES E IDEMPOTENCIA
-- ============================================================================
\echo '=== 11. REQUEST TABLES ======================================='
SELECT 'comprobante_annulments' AS tabla, count(*) AS total,
       count(*) FILTER (WHERE COALESCE(idempotency_key,'')='') AS keys_vacias,
       count(*) FILTER (WHERE COALESCE(request_hash,'')='')    AS hashes_vacios,
       count(*) FILTER (WHERE length(request_hash)=32)         AS hash_md5_legacy,
       count(*) FILTER (WHERE length(request_hash)=64)         AS hash_sha256,
       (SELECT count(*) FROM (SELECT business_id, idempotency_key FROM comprobante_annulments
         GROUP BY 1,2 HAVING count(*)>1) d)                    AS keys_duplicadas,
       min(created_at)::date AS mas_antigua
FROM comprobante_annulments
UNION ALL
SELECT 'comprobante_payment_replace_requests', count(*),
       count(*) FILTER (WHERE COALESCE(idempotency_key,'')=''),
       count(*) FILTER (WHERE COALESCE(request_hash,'')=''),
       count(*) FILTER (WHERE length(request_hash)=32),
       count(*) FILTER (WHERE length(request_hash)=64),
       (SELECT count(*) FROM (SELECT business_id, idempotency_key FROM comprobante_payment_replace_requests
         GROUP BY 1,2 HAVING count(*)>1) d),
       min(created_at)::date
FROM comprobante_payment_replace_requests
UNION ALL
SELECT 'operating_expense_reversals', count(*),
       count(*) FILTER (WHERE COALESCE(idempotency_key,'')=''),
       count(*) FILTER (WHERE COALESCE(request_hash,'')=''),
       count(*) FILTER (WHERE length(request_hash)=32),
       count(*) FILTER (WHERE length(request_hash)=64),
       (SELECT count(*) FROM (SELECT business_id, idempotency_key FROM operating_expense_reversals
         GROUP BY 1,2 HAVING count(*)>1) d),
       min(created_at)::date
FROM operating_expense_reversals;

-- ============================================================================
-- 12. SEGURIDAD — vias alternativas de escritura (BLOCKER si existen post-M7)
-- ============================================================================
\echo '=== 12. SEGURIDAD ============================================'
SELECT 'authenticated INSERT comprobante_payments' AS via,
       has_table_privilege('authenticated','public.comprobante_payments','INSERT')::text AS habilitada
UNION ALL SELECT 'authenticated UPDATE comprobantes',
       has_table_privilege('authenticated','public.comprobantes','UPDATE')::text
UNION ALL SELECT 'authenticated UPDATE comprobante_payments',
       has_table_privilege('authenticated','public.comprobante_payments','UPDATE')::text
UNION ALL SELECT 'authenticated DELETE comprobante_payments',
       has_table_privilege('authenticated','public.comprobante_payments','DELETE')::text
UNION ALL SELECT 'anon INSERT comprobante_payments',
       has_table_privilege('anon','public.comprobante_payments','INSERT')::text
ORDER BY 1;

\echo '--- 12b. SECURITY DEFINER que tocan comprobantes/pagos/GUC m7 ---'
SELECT p.proname AS funcion, pg_get_userbyid(p.proowner) AS owner,
       COALESCE(array_to_string(p.proconfig,','),'SIN search_path (RIESGO)') AS config,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       (pg_get_functiondef(p.oid) ~* 'UPDATE\s+comprobantes')    AS toca_comprobantes,
       (pg_get_functiondef(p.oid) ~* 'set_config\s*\(\s*''m7\.') AS setea_guc_m7
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND p.prokind='f'
  AND pg_get_functiondef(p.oid) ~* '(UPDATE\s+comprobantes|INSERT\s+INTO\s+"?public"?\.?"?comprobante_payments|set_config\s*\(\s*''m7\.)'
ORDER BY 1;

\echo '=== FIN — recorda ejecutar ROLLBACK ==========================='
