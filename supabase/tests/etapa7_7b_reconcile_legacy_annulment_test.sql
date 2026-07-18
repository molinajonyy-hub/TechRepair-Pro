-- ============================================================================
-- M7 Lote 7B — Simulacion local de la reconciliacion historica puntual.
--
-- Reproduce el estado PRODUCTIVO exacto de los dos comprobantes anulados del
-- informe 7A y ejecuta la propuesta dentro de una transaccion:
--   #1 remito  ac3b00ef… 2026-05-08 · 1.235.580 / COGS 1.097.006 · anulado por
--      la via client-side: stock restaurado, SIN FM, SIN BFE, SIN NC.
--   #2 factura_c 95cbf330… 2026-05-21 · 13.050 / COGS 2.186 · con CAE y NOTA DE
--      CREDITO: NO recibe registro; se revierte por la via fiscal.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
CREATE OR REPLACE FUNCTION pg_temp.pnl(b uuid, d date, col text) RETURNS numeric LANGUAGE plpgsql AS $$
DECLARE v numeric;
BEGIN
  EXECUTE format('SELECT COALESCE((SELECT %I FROM v_finance_pnl WHERE business_id=$1 AND period_date=$2),0)', col)
    INTO v USING b, d; RETURN v;
END; $$;

\set BIZ  '00000000-0000-0000-0000-0000007b7101'
\set OWN  '00000000-0000-0000-0000-0000007b7109'
\set CLI  '00000000-0000-0000-0000-0000007b7c01'
-- C1 = remito legacy (se reconcilia) · C2 = factura_c con NC (NO se toca) · NC2 = su nota de credito
\set C1   '00000000-0000-0000-0000-0000007b7001'
\set C2   '00000000-0000-0000-0000-0000007b7002'
\set NC2  '00000000-0000-0000-0000-0000007b7003'
\set I1   '00000000-0000-0000-0000-0000007bd001'
\set I2   '00000000-0000-0000-0000-0000007bd002'
\set I3   '00000000-0000-0000-0000-0000007bd003'
\set I4   '00000000-0000-0000-0000-0000007bd004'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'BIZ','7B SIM',:'OWN');
INSERT INTO profiles(id,business_id,user_id,role,is_active) VALUES (:'OWN',:'BIZ',:'OWN','owner',true);
INSERT INTO customers(id,business_id,name,phone) VALUES (:'CLI',:'BIZ','Cliente','555');
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'I1',:'BIZ','P1','7B-1','Rep',10,10,400000,450000,450000,'ARS',false,1,true),
         (:'I2',:'BIZ','P2','7B-2','Rep',10,10,400000,450000,450000,'ARS',false,1,true),
         (:'I3',:'BIZ','P3','7B-3','Rep',10,10,297006,335580,335580,'ARS',false,1,true),
         (:'I4',:'BIZ','P4','7B-4','Rep',10,10,2186,13050,13050,'ARS',false,1,true);

-- ── #1: remito ANULADO por la via legacy (estado del 2026-05-08) ───────────
INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,
                         fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,created_by,created_at,updated_at)
VALUES (:'C1',:'BIZ',:'CLI','remito','remito','cancelled','anulado','anulado','anulado_fiscal',
        '2026-05-08 14:11:46.431+00','2026-05-08 14:11:46.431+00',1235580,1235580,1235580,0,'ARS',1,:'OWN',
        '2026-05-08 14:11:46.365+00','2026-05-12 15:03:21.636+00');
INSERT INTO comprobante_items(id,comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
VALUES (gen_random_uuid(),:'C1',:'BIZ',:'I1','P1',1,450000,450000,400000,400000,'producto',true),
       (gen_random_uuid(),:'C1',:'BIZ',:'I2','P2',1,450000,450000,400000,400000,'producto',true),
       (gen_random_uuid(),:'C1',:'BIZ',:'I3','P3',1,335580,335580,297006,297006,'producto',true);
-- pago registrado, PERO sin financial_movement (asi esta en produccion)
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date,created_at)
VALUES (:'C1',:'BIZ',1235580,'ARS',1235580,1,'transferencia','2026-05-08','2026-05-08 14:11:48.894+00');
-- 3 salidas de stock y 3 restauraciones 81 segundos despues (la anulacion legacy)
INSERT INTO inventory_movements(business_id,inventory_item_id,movement_type,quantity,previous_stock,new_stock,reference_type,reference_id,created_by,created_at)
VALUES (:'BIZ',:'I1','sale',-1,10,9,'comprobante',:'C1',:'OWN','2026-05-08 14:11:47.357+00'),
       (:'BIZ',:'I2','sale',-1,10,9,'comprobante',:'C1',:'OWN','2026-05-08 14:11:48.053+00'),
       (:'BIZ',:'I3','sale',-1,10,9,'comprobante',:'C1',:'OWN','2026-05-08 14:11:48.673+00'),
       (:'BIZ',:'I1','return',1,9,10,'comprobante',:'C1',:'OWN','2026-05-08 14:13:06.995+00'),
       (:'BIZ',:'I2','return',1,9,10,'comprobante',:'C1',:'OWN','2026-05-08 14:13:07.591+00'),
       (:'BIZ',:'I3','return',1,9,10,'comprobante',:'C1',:'OWN','2026-05-08 14:13:08.138+00');

-- ── #2: factura_c con CAE y NOTA DE CREDITO (via fiscal, NO se reconcilia) ──
INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,
                         fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,cae,created_by,created_at,updated_at)
VALUES (:'C2',:'BIZ',:'CLI','factura_c','factura_c','cancelled','anulado','anulado','anulado_fiscal',
        '2026-05-21 14:01:13+00','2026-05-21 14:01:13+00',13050,13050,13050,0,'ARS',1,'75123456789012',:'OWN',
        '2026-05-21 14:01:13+00','2026-05-21 21:02:09+00');
INSERT INTO comprobante_items(id,comprobante_id,business_id,inventory_id,descripcion,cantidad,precio_unitario,subtotal,costo_unitario,costo_total,tipo_linea,stock_processed)
VALUES (gen_random_uuid(),:'C2',:'BIZ',:'I4','P4',1,13050,13050,2186,2186,'producto',true);
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,date,created_at)
VALUES (:'C2',:'BIZ',13050,'ARS',13050,1,'transferencia','2026-05-21','2026-05-21 14:01:13+00');
INSERT INTO financial_movements(business_id,date,type,currency,amount,amount_ars,exchange_rate,source,comprobante_id,description,created_by,sign,metodo_pago,created_at)
VALUES (:'BIZ','2026-05-21','income','ARS',13050,13050,1,'comprobante',:'C2','Cobro',:'OWN',1,'transferencia','2026-05-21 14:01:13+00');
INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,reference_comprobante_id,source,created_by,economic_class)
VALUES (:'BIZ','2026-05-21','income','ventas_productos','Venta',13050,'ARS',13050,1,:'C2','comprobante',:'OWN','revenue_collection_mirror');
-- la nota de credito que revierte a #2 por la via fiscal
INSERT INTO comprobantes(id,business_id,customer_id,tipo,type,status,estado,estado_comercial,estado_fiscal,
                         fecha,date,total,total_bruto,total_cobrado,saldo_pendiente,currency,exchange_rate,cae,comprobante_original_id,created_by,created_at)
VALUES (:'NC2',:'BIZ',:'CLI','nota_credito','nota_credito','issued','emitido','pendiente','emitido',
        '2026-05-21 21:02:03+00','2026-05-21 21:02:03+00',13050,13050,0,0,'ARS',1,'75123456789013',:'C2',:'OWN','2026-05-21 21:02:03+00');
SET LOCAL session_replication_role='origin';

-- ============ ANTES ========================================================
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=:'C1')=0, 'A1 #1 sin registro de anulacion');
SELECT pg_temp.assert((SELECT estado FROM comprobantes WHERE id=:'C1')='anulado', 'A2 #1 esta anulado');
-- el ledger YA cuenta la venta (append-only) pero NO tiene compensacion -> no netea
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1')=3, 'A3 #1 emite 3 eventos sale (uno por item) y NINGUN annulment');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1' AND event_type='annulment')=0, 'A4 #1 sin evento de anulacion derivable');
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1')=1235580, 'A5 ANTES: la venta de #1 NO netea (queda 1.235.580)');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-08','gross_sales')=1235580, 'A6 ANTES: P&L del 2026-05-08 muestra la venta sin compensar');
CREATE TEMP TABLE pg_temp_antes AS
  SELECT (SELECT stock_quantity FROM inventory WHERE id='00000000-0000-0000-0000-0000007bd001') AS stock1,
         (SELECT count(*) FROM financial_movements WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS fms,
         (SELECT count(*) FROM business_finance_entries WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS bfes,
         (SELECT count(*) FROM account_movements WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS ams,
         (SELECT count(*) FROM inventory_movements WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS invmovs,
         (SELECT count(*) FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS pagos,
         (SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id='00000000-0000-0000-0000-0000007b7101') AS cashflow,
         (SELECT updated_at FROM comprobantes WHERE id='00000000-0000-0000-0000-0000007b7001') AS c1_updated_at;

-- ============ APPLY (la MISMA escritura del script productivo) =============
SELECT id FROM comprobantes WHERE id=:'C1' FOR UPDATE;

INSERT INTO comprobante_annulments (
  business_id, comprobante_id, user_id, idempotency_key, request_hash, op,
  mode, motivo, restore_stock, stock_restored_count, annulment_date,
  original_caja_ids, refund_caja_id,
  reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars,
  original_fm_ids, fm_reversal_ids, bfe_reversal_ids, cc_reversal_movement_id, status)
SELECT c.business_id, c.id, c.created_by,
       'm7-7b-reconcile-'||c.id::text,
       encode(extensions.digest(jsonb_build_object(
         'op','comprobante_annulment','business_id',c.business_id,'comprobante_id',c.id,
         'mode','commercial_annulment','restore_stock',true,
         'reason','Reconciliación M7 de anulación legacy realizada por vía client-side')::text,'sha256'),'hex'),
       'comprobante_annulment','commercial_annulment',
       'Reconciliación M7 de anulación legacy realizada por vía client-side',
       true, 3, DATE '2026-05-08',
       '{}'::uuid[], NULL, 0, 0, 0, 0, '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, 'completed'
FROM comprobantes c
WHERE c.id = :'C1'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');

INSERT INTO finance_ledger_reconciliation (
  business_id, entity_table, entity_id, issue_type, legacy,
  reconciliation_status, reconciliation_reason, evidence, reconciled_by)
SELECT c.business_id, 'comprobantes', c.id, 'annulment_sin_registro_canonico', true, 'corrected',
       'Lote 7B — anulacion legacy sin registro canonico; evidencia creada con fecha 2026-05-08.',
       jsonb_build_object('informe','m7-lote-7a-dry-run-preflight-report.md','movimientos_creados',0),
       c.created_by
FROM comprobantes c WHERE c.id = :'C1'
  AND NOT EXISTS (SELECT 1 FROM finance_ledger_reconciliation r
                   WHERE r.entity_id=c.id AND r.issue_type='annulment_sin_registro_canonico'
                     AND r.reconciliation_status='corrected');

-- ============ DESPUES ======================================================
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=:'C1')=1, 'D1 exactamente 1 registro de anulacion');
SELECT pg_temp.assert((SELECT annulment_date FROM comprobante_annulments WHERE comprobante_id=:'C1')='2026-05-08', 'D2 annulment_date = 2026-05-08');
SELECT pg_temp.assert((SELECT status FROM comprobante_annulments WHERE comprobante_id=:'C1')='completed', 'D3 status = completed');
SELECT pg_temp.assert((SELECT mode FROM comprobante_annulments WHERE comprobante_id=:'C1')='commercial_annulment', 'D4 mode = commercial_annulment (no implica devolucion)');
SELECT pg_temp.assert((SELECT reverted_cash_ars FROM comprobante_annulments WHERE comprobante_id=:'C1')=0, 'D5 reverted_cash_ars = 0 (no habia nada que revertir)');
SELECT pg_temp.assert((SELECT user_id FROM comprobante_annulments WHERE comprobante_id=:'C1')=:'OWN', 'D6 actor = created_by del comprobante');
-- la VENTA ORIGINAL se conserva en su fecha
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1' AND event_type='sale')=1235580, 'D7 la venta original se CONSERVA en su fecha');
SELECT pg_temp.assert((SELECT DISTINCT period_date FROM v_finance_sales_ledger WHERE comprobante_id=:'C1' AND event_type='sale')='2026-05-08', 'D8 la venta sigue fechada 2026-05-08');
-- la compensacion aparece el MISMO dia
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1' AND event_type='annulment')=-1235580, 'D9 compensacion derivada = -1.235.580');
SELECT pg_temp.assert((SELECT DISTINCT period_date FROM v_finance_sales_ledger WHERE comprobante_id=:'C1' AND event_type='annulment')='2026-05-08', 'D10 la compensacion cae el 2026-05-08 (mismo dia que la venta)');
-- efecto neto CERO
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1')=0, 'D11 efecto neto de la operacion: ventas = 0');
SELECT pg_temp.assert((SELECT SUM(cogs_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1')=0, 'D12 efecto neto de la operacion: COGS = 0');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-08','gross_sales')=0, 'D13 DESPUES: el P&L del 2026-05-08 vuelve a 0 (no introduce restatement)');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-08','gross_profit')=0, 'D14 DESPUES: resultado del 2026-05-08 = 0');
-- NADA MAS cambio
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'I1')=(SELECT stock1 FROM pg_temp_antes), 'D15 stock SIN cambios');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'BIZ')=(SELECT fms FROM pg_temp_antes), 'D16 cashflow: CERO financial_movements nuevos');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'BIZ')=(SELECT bfes FROM pg_temp_antes), 'D17 CERO BFE nuevos');
SELECT pg_temp.assert((SELECT count(*) FROM account_movements WHERE business_id=:'BIZ')=(SELECT ams FROM pg_temp_antes), 'D18 cuenta corriente SIN cambios');
SELECT pg_temp.assert((SELECT count(*) FROM inventory_movements WHERE business_id=:'BIZ')=(SELECT invmovs FROM pg_temp_antes), 'D19 CERO inventory_movements nuevos');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE business_id=:'BIZ')=(SELECT pagos FROM pg_temp_antes), 'D20 CERO pagos nuevos');
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=:'BIZ')=(SELECT cashflow FROM pg_temp_antes), 'D21 cashflow acumulado SIN cambios');
SELECT pg_temp.assert((SELECT updated_at FROM comprobantes WHERE id=:'C1')=(SELECT c1_updated_at FROM pg_temp_antes), 'D22 el comprobante NO fue modificado');

-- ============ LA FACTURA C NO SE TOCA ======================================
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=:'C2')=0, 'F1 #2 NO recibe registro de anulacion');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger WHERE comprobante_id=:'C2' AND event_type='annulment')=0, 'F2 #2 sin evento de anulacion (se revierte por la NC)');
-- se sigue compensando por la nota de credito: venta +13.050 y returns -13.050
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C2')=13050, 'F3 #2 conserva su venta en el ledger');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-21','sales_returns')=13050, 'F4 la nota de credito resta 13.050 en returns');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-21','net_sales')=0, 'F5 #2 netea a 0 via NC (sin doble reversion)');
SELECT pg_temp.assert(pg_temp.pnl(:'BIZ','2026-05-21','cogs')=2186, 'F6 residuo conocido: la via NC no revierte COGS (+2.186)');
SELECT pg_temp.assert((SELECT count(*) FROM v_finance_sales_ledger WHERE comprobante_id=:'C2' AND event_type='sale')=1, 'F7 #2 emite UN solo evento de venta (no hay doble conteo)');

-- ============ IDEMPOTENCIA =================================================
-- Segunda ejecucion del MISMO INSERT: no-op explicito, nunca dos registros.
INSERT INTO comprobante_annulments (
  business_id, comprobante_id, user_id, idempotency_key, request_hash, op,
  mode, motivo, restore_stock, stock_restored_count, annulment_date,
  reverted_cash_ars, reverted_cc_ars, reverted_commissions_ars, reverted_cogs_ars, status)
SELECT c.business_id, c.id, c.created_by, 'm7-7b-reconcile-'||c.id::text, 'h','comprobante_annulment',
       'commercial_annulment','Reconciliación M7 de anulación legacy realizada por vía client-side',
       true, 3, DATE '2026-05-08', 0,0,0,0,'completed'
FROM comprobantes c WHERE c.id = :'C1'
  AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments WHERE comprobante_id=:'C1')=1, 'ID1 segunda ejecucion: no-op, sigue habiendo 1 registro');
SELECT pg_temp.assert((SELECT SUM(sales_amount_ars) FROM v_finance_sales_ledger WHERE comprobante_id=:'C1')=0, 'ID2 el efecto neto sigue siendo 0 (sin doble compensacion)');
-- y el indice unico parcial lo impide aunque se fuerce
DO $$
DECLARE e text; v_biz uuid := '00000000-0000-0000-0000-0000007b7101'; v_c1 uuid := '00000000-0000-0000-0000-0000007b7001';
BEGIN
  e:='';
  BEGIN
    INSERT INTO comprobante_annulments(business_id,comprobante_id,user_id,idempotency_key,request_hash,mode,motivo,restore_stock,status,annulment_date)
      VALUES (v_biz, v_c1, '00000000-0000-0000-0000-0000007b7109','otra-key','h2','commercial_annulment','x',true,'completed','2026-05-08');
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'ID3 el indice unico parcial impide una SEGUNDA anulacion completed aunque cambie la key');
END $$;

-- ============ PREFLIGHT POSTERIOR (§8) =====================================
SELECT pg_temp.assert((SELECT count(*) FROM comprobantes c
  WHERE c.business_id=:'BIZ'
    AND (c.estado='anulado' OR c.status='cancelled' OR c.estado_comercial='anulado')
    AND NOT EXISTS (SELECT 1 FROM comprobante_annulments a WHERE a.comprobante_id=c.id AND a.status='completed')
    AND NOT EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=c.id))=0,
  'PF1 blockers "anulado sin registro canonico y sin NC": 0');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments a
  WHERE EXISTS (SELECT 1 FROM comprobantes nc WHERE nc.comprobante_original_id=a.comprobante_id
                  AND COALESCE(nc.tipo,nc.type)='nota_credito' AND nc.estado<>'anulado'))=0,
  'PF2 doble reversion (registro interno + NC): 0');
SELECT pg_temp.assert((SELECT count(*) FROM (
  SELECT comprobante_id FROM comprobante_annulments WHERE status='completed'
  GROUP BY comprobante_id HAVING count(*)>1) d)=0, 'PF3 registros duplicados por comprobante: 0');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
  WHERE c.business_id<>a.business_id)=0, 'PF4 anulaciones cross-business: 0');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_annulments a JOIN comprobantes c ON c.id=a.comprobante_id
  WHERE COALESCE(a.annulment_date,(a.created_at AT TIME ZONE 'America/Argentina/Cordoba')::date)
      < (COALESCE(c.fecha,c.date,c.created_at) AT TIME ZONE 'America/Argentina/Cordoba')::date)=0,
  'PF5 fecha de anulacion anterior a la venta: 0');
-- el remito #1 ya NO introduce delta; el unico restatement restante es el fiscal de #2
SELECT pg_temp.assert((SELECT COALESCE(SUM(sales_amount_ars),0) FROM v_finance_sales_ledger l
  WHERE l.business_id=:'BIZ' AND l.comprobante_id=:'C1')=0, 'PF6 el remito #1 NO introduce delta acumulado');
SELECT pg_temp.assert((SELECT COALESCE(SUM(net_sales),0) FROM v_finance_pnl WHERE business_id=:'BIZ')=0,
  'PF7 net_sales acumulado del negocio = 0 (todo explicado: #1 por su registro, #2 por su NC)');
SELECT pg_temp.assert((SELECT COALESCE(SUM(cogs),0) FROM v_finance_pnl WHERE business_id=:'BIZ')=2186,
  'PF8 unica diferencia restante = +2.186 de COGS de #2, explicada uno a uno (la via NC no revierte COGS)');

SELECT pg_temp.assert(true, '=== etapa7_7b_reconcile_legacy_annulment_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
