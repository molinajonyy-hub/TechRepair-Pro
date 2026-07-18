-- ============================================================================
-- M7 Bloque 6F.3 -- replace_comprobante_payment APPEND-ONLY.
-- Las filas originales de comprobante_payments NUNCA se borran: quedan marcadas
-- (replaced_at/replaced_by/replacement_payment_id) y solo el conjunto VIVO
-- (replaced_at IS NULL) cuenta para el estado actual. Cadena auditable.
--   Esquema · pago unico · pago mixto · reemplazos encadenados · periodo (guard
--   con excepcion de metadata) · idempotencia durable · source set hash ·
--   audit scope E1 + evento unico · rollback · dependencias.
-- Concurrencia (PAYMENT_SET_CHANGED): harness aparte.
-- RUN: docker cp ... && psql -X -f (BEGIN + ROLLBACK)
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;
CREATE OR REPLACE FUNCTION pg_temp.cf(b uuid, d1 date, d2 date) RETURNS numeric LANGUAGE sql AS $$
  SELECT COALESCE(SUM(net_ars),0) FROM v_finance_cashflow WHERE business_id=b AND movement_date_ar BETWEEN d1 AND d2 $$;

\set biz  '00000000-0000-0000-0000-0000005d7101'
\set OA   '00000000-0000-0000-0000-0000005d7109'
\set biz2 '00000000-0000-0000-0000-0000005d7201'
\set OB   '00000000-0000-0000-0000-0000005d7209'
\set INV  '00000000-0000-0000-0000-0000005d7d01'
\set CAJA '00000000-0000-0000-0000-0000005d7601'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','6F3 A',:'OA'),(:'biz2','6F3 B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'biz',:'OA','owner',true),(:'biz2',:'OB','owner',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_price,base_currency,auto_update_price,exchange_rate_used,is_active)
  VALUES (:'INV',:'biz','P','F3-1','Rep',1000,1000,600,1000,1000,'ARS',false,1,true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OA','abierta');
SET LOCAL session_replication_role='origin';

-- ============ Esquema append-only ==========================================
SELECT pg_temp.assert((SELECT count(*) FROM information_schema.columns WHERE table_name='comprobante_payments'
  AND column_name IN ('replaced_at','replaced_by','replacement_payment_id'))=3, 'SC1 columnas append-only presentes');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE tablename='comprobante_payments' AND indexname='idx_comprobante_payments_live'), 'SC2 indice parcial de pagos vivos');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_fk'), 'SC3 FK replacement_payment_id -> comprobante_payments');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_not_self'), 'SC4 CHECK no auto-referencia');
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conname='comprobante_payments_replacement_consistency'), 'SC5 CHECK viva(3 NULL) / reemplazada(3 NOT NULL)');
SELECT pg_temp.assert(NOT EXISTS(SELECT 1 FROM pg_indexes WHERE tablename='comprobante_payments' AND indexdef ilike '%UNIQUE%replacement_payment_id%'), 'SC6 SIN unique sobre replacement_payment_id (cobro mixto apunta al mismo sustituto)');

-- ============ PAGO UNICO: efectivo -> transferencia =========================
-- (todos los comprobantes comparten created_at dentro de la tx -> se guardan los
--  IDs explicitamente en vez de usar ORDER BY created_at)
CREATE TEMP TABLE pg_temp_c(kind text PRIMARY KEY, id uuid);
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000005d7101'::uuid,'S1','h1',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000005d7d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos',jsonb_build_array(jsonb_build_object('amount',1000,'amount_ars',1000,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'U0 venta contado efectivo -> created ('||COALESCE(r->>'error','')||')');
  INSERT INTO pg_temp_c VALUES ('U', (r->>'comprobante_id')::uuid);
END $$;
-- backdate del cobro al MES ANTERIOR (simula historia)
SET LOCAL session_replication_role='replica';
UPDATE financial_movements SET date=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5) WHERE business_id=:'biz' AND source='comprobante';
UPDATE comprobante_payments SET date=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5) WHERE business_id=:'biz';
UPDATE business_finance_entries SET date=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5) WHERE business_id=:'biz' AND source='comprobante';
SET LOCAL session_replication_role='origin';
CREATE TEMP TABLE pg_temp_snap AS SELECT pg_temp.cf(:'biz', date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1)) AS cf_prev;
SELECT pg_temp.assert((SELECT cf_prev FROM pg_temp_snap)=1000, 'U1 mes anterior arranca con cashflow +1000');

DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SELECT id INTO v_comp FROM comprobantes WHERE business_id='00000000-0000-0000-0000-0000005d7101';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',1000,1000,'ARS',1,'cambio',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK1');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'new_payment_id') IS NOT NULL, 'U2 reemplazo efectivo->transferencia -> ok ('||COALESCE(r->>'error','')||')');
END $$;
-- APPEND-ONLY: original conservado + sustituto vivo
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE business_id=:'biz')=2, 'U3 2 filas: original conservado + sustituto');
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NULL)=1, 'U4 exactamente 1 pago VIVO');
SELECT pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NULL)='transferencia', 'U5 el vivo es transferencia');
SELECT pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NOT NULL)='efectivo', 'U6 el reemplazado conserva efectivo (historia intacta)');
SELECT pg_temp.assert((SELECT replacement_payment_id FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NOT NULL)
  = (SELECT id FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NULL), 'U7 el original apunta a su sustituto');
SELECT pg_temp.assert((SELECT replaced_by FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NOT NULL)=:'OA', 'U8 replaced_by = auth.uid (actor canonico)');
-- fecha original intacta; sustituto fechado HOY
SELECT pg_temp.assert((SELECT date FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NOT NULL)=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5), 'U9 el original conserva su fecha (mes anterior)');
SELECT pg_temp.assert((SELECT date FROM comprobante_payments WHERE business_id=:'biz' AND replaced_at IS NULL)=public.ar_today(), 'U10 el sustituto se fecha HOY');
-- periodo original intacto ; neto actual 0 ; acumulado sin cambio
SELECT pg_temp.assert(pg_temp.cf(:'biz', date_trunc('month', public.ar_today() - interval '1 month')::date, (date_trunc('month', public.ar_today())::date - 1)) = (SELECT cf_prev FROM pg_temp_snap), 'U11 cashflow del periodo ORIGINAL identico antes/despues');
SELECT pg_temp.assert(pg_temp.cf(:'biz', date_trunc('month', public.ar_today())::date, (date_trunc('month', public.ar_today())+interval '1 month - 1 day')::date) = 0, 'U12 neto del reemplazo en el periodo ACTUAL = 0 (-1000 +1000)');
SELECT pg_temp.assert(pg_temp.cf(:'biz','1900-01-01','2999-12-31') = 1000, 'U13 cashflow acumulado sigue +1000 (la venta se cobro una vez)');
-- comprobante sincronizado con el conjunto VIVO
SELECT pg_temp.assert((SELECT total_cobrado FROM comprobantes WHERE business_id=:'biz')=1000, 'U14 total_cobrado = 1000 (sin duplicar por la fila reemplazada)');
SELECT pg_temp.assert((SELECT saldo_pendiente FROM comprobantes WHERE business_id=:'biz')=0 AND (SELECT estado_comercial FROM comprobantes WHERE business_id=:'biz')='pagado', 'U15 saldo/estado correctos');
-- vista vigente
SELECT pg_temp.assert((SELECT medios_de_pago FROM v_comprobantes_full WHERE business_id=:'biz')='transferencia', 'U16 v_comprobantes_full.medios_de_pago = transferencia (solo vivos)');
SELECT pg_temp.assert((SELECT total_pagado_calc FROM v_comprobantes_full WHERE business_id=:'biz')=1000, 'U17 total_pagado_calc = 1000 (sin doble conteo)');
-- P&L / COGS / stock sin cambios
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND category='mercaderia' AND reversed_at IS NULL)=1, 'U18 COGS sigue reconocido UNA vez');
SELECT pg_temp.assert((SELECT stock_quantity FROM inventory WHERE id=:'INV')=999, 'U19 stock sin cambios por el reemplazo');

-- ============ Guard de periodo: metadata vs economico =======================
-- Se usa un comprobante dedicado con un pago VIVO backdateado a un mes CERRADO.
DO $$
DECLARE r jsonb; v_cg uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000005d7101'::uuid,'SG','hg',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000005d7d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',700)),
      'pagos',jsonb_build_array(jsonb_build_object('amount',700,'amount_ars',700,'payment_method','efectivo'))));
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'status'='created', 'PG0 comprobante para guard -> created');
END $$;
-- backdatear SOLO ese pago (y su FM) al mes anterior y cerrar ese mes
SET LOCAL session_replication_role='replica';
UPDATE comprobante_payments SET date=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5)
  WHERE business_id=:'biz' AND amount_ars=700;
UPDATE financial_movements SET date=(date_trunc('month', public.ar_today() - interval '1 month')::date + 5)
  WHERE business_id=:'biz' AND source='comprobante' AND amount_ars=700;
SET LOCAL session_replication_role='origin';
DO $$
DECLARE v_pg uuid; e text; v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
  v_pe date := (date_trunc('month', public.ar_today())::date - 1);
BEGIN
  SELECT id INTO v_pg FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND amount_ars=700 AND replaced_at IS NULL;
  INSERT INTO finance_period_locks(business_id, period_start, period_end, status, closed_by, close_reason)
    VALUES ('00000000-0000-0000-0000-0000005d7101', v_p1, v_pe, 'closed','00000000-0000-0000-0000-0000005d7109','cierre 6F3');
  -- 1) cambiar MONTO de un pago VIVO de periodo cerrado -> PERIOD_CLOSED
  e:=''; BEGIN UPDATE comprobante_payments SET amount_ars=9999 WHERE id=v_pg; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'PG1 cambiar monto de pago cerrado -> PERIOD_CLOSED');
  -- 2) cambiar METODO -> PERIOD_CLOSED
  e:=''; BEGIN UPDATE comprobante_payments SET payment_method='qr' WHERE id=v_pg; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'PG2 cambiar metodo de pago cerrado -> PERIOD_CLOSED');
  -- 3) cambiar FECHA -> PERIOD_CLOSED
  e:=''; BEGIN UPDATE comprobante_payments SET date=public.ar_today() WHERE id=v_pg; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'PG3 cambiar fecha de pago cerrado -> PERIOD_CLOSED');
  -- 6F.3a §1) las NOTAS son historia documental: tampoco se reescriben tras el cierre
  e:=''; BEGIN UPDATE comprobante_payments SET notes='reescrito' WHERE id=v_pg; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'PG3b cambiar NOTES de pago cerrado -> PERIOD_CLOSED (whitelist estricta)');
  -- una columna NO economica arbitraria tampoco pasa por omision (whitelist estricta)
  e:=''; BEGIN UPDATE comprobante_payments SET payment_provider='X' WHERE id=v_pg; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE 'PERIOD_CLOSED%', 'PG3c cambiar provider de pago cerrado -> PERIOD_CLOSED');
END $$;
-- 4) la RPC SI puede reemplazar ese pago de periodo cerrado: marcar metadata NO es
--    escritura economica en el periodo original; la compensacion/pago nuevo van HOY.
DO $$
DECLARE r jsonb; v_cg uuid; v_pg uuid; v_notes_before text; v_new uuid;
  v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  -- captura el pago ORIGINAL antes del reemplazo (luego habra otro de 700 vivo)
  SELECT id, comprobante_id, notes INTO v_pg, v_cg, v_notes_before FROM comprobante_payments
    WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND amount_ars=700 AND replaced_at IS NULL;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_cg,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',700,700,'ARS',1,'nota del sustituto',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RKG');
  RESET ROLE;
  v_new := (r->>'new_payment_id')::uuid;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'PG4 reemplazar un pago de periodo CERRADO -> permitido (solo metadata) ('||COALESCE(r->>'error','')||')');
  PERFORM pg_temp.assert((SELECT replaced_at FROM comprobante_payments WHERE id=v_pg) IS NOT NULL, 'PG5 el pago cerrado quedo marcado como reemplazado');
  PERFORM pg_temp.assert((SELECT date FROM comprobante_payments WHERE id=v_pg)=(v_p1+5), 'PG6 su fecha original NO cambio');
  PERFORM pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE id=v_pg)='efectivo', 'PG7 su metodo original NO cambio');
  -- 6F.3a §1: la RPC fija SOLO replaced_at/replaced_by/replacement_payment_id
  PERFORM pg_temp.assert((SELECT notes FROM comprobante_payments WHERE id=v_pg) IS NOT DISTINCT FROM v_notes_before, 'PG8 las NOTAS originales quedan identicas tras el reemplazo');
  PERFORM pg_temp.assert((SELECT notes FROM comprobante_payments WHERE id=v_new)='nota del sustituto', 'PG9 las notas nuevas viven SOLO en el pago sustituto');
  DELETE FROM finance_period_locks WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND period_start=v_p1;
END $$;

-- ============ Inmutabilidad de la fila reemplazada ==========================
DO $$
DECLARE v_old uuid; v_live uuid; e text;
BEGIN
  SELECT id INTO v_old FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND replaced_at IS NOT NULL;
  SELECT id INTO v_live FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND replaced_at IS NULL;
  e:=''; BEGIN DELETE FROM comprobante_payments WHERE id=v_old; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%reemplazado no se puede eliminar%', 'IM1 DELETE de un pago reemplazado prohibido');
  -- (now() es estable dentro de la tx: se usa un valor claramente distinto)
  e:=''; BEGIN UPDATE comprobante_payments SET replaced_at=now()+interval '1 day' WHERE id=v_old; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%metadata de reemplazo es inmutable%', 'IM2 metadata de reemplazo se fija una sola vez');
  -- auto-referencia bloqueada (CHECK)
  e:=''; BEGIN UPDATE comprobante_payments SET replaced_at=now(), replaced_by='00000000-0000-0000-0000-0000005d7109', replacement_payment_id=v_live WHERE id=v_live; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'IM3 auto-referencia / consistencia bloqueada');
END $$;

-- ============ PAGO MIXTO: efectivo 500 + tarjeta 500 -> transferencia 1000 ==
DO $$
DECLARE r jsonb; v_c2 uuid;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000005d7101'::uuid,'S2','h2',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000005d7d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos',jsonb_build_array(
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','efectivo'),
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','tarjeta_credito'))));
  PERFORM pg_temp.assert(r->>'status'='created', 'MX0 venta mixta -> created ('||COALESCE(r->>'error','')||')');
  v_c2 := (r->>'comprobante_id')::uuid;
  r := replace_comprobante_payment(v_c2,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',1000,1000,'ARS',1,'unificar',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK2');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'MX1 reemplazo de cobro MIXTO -> ok ('||COALESCE(r->>'error','')||')');
  -- 2 originales conservados + 1 vivo
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_c2)=3, 'MX2 3 filas (2 originales + 1 sustituto)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_c2 AND replaced_at IS NULL)=1, 'MX3 1 solo pago vivo');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_c2 AND replaced_at IS NOT NULL)=2, 'MX4 los 2 originales conservados');
  -- ambos apuntan al MISMO sustituto (sin unique)
  PERFORM pg_temp.assert((SELECT count(DISTINCT replacement_payment_id) FROM comprobante_payments WHERE comprobante_id=v_c2 AND replaced_at IS NOT NULL)=1, 'MX5 ambos originales apuntan al MISMO sustituto');
  -- compensacion individual por cada FM original
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_c2 AND source='reversal' AND type='expense')=2, 'MX6 una compensacion por cada pago original (2)');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_c2 AND source='comprobante' AND reversed_at IS NULL)=1, 'MX7 un solo FM income vivo (el sustituto)');
  -- estado vigente
  PERFORM pg_temp.assert((SELECT medios_de_pago FROM v_comprobantes_full WHERE id=v_c2)='transferencia', 'MX8 medios_de_pago vigente = transferencia');
  PERFORM pg_temp.assert((SELECT total_pagado_calc FROM v_comprobantes_full WHERE id=v_c2)=1000, 'MX9 total_pagado_calc = 1000');
  PERFORM pg_temp.assert((SELECT total_cobrado FROM comprobantes WHERE id=v_c2)=1000, 'MX10 total_cobrado = 1000 (no 2000)');
  -- historia completa
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_c2 AND replaced_at IS NOT NULL AND payment_method IN ('efectivo','tarjeta_credito'))=2, 'MX11 historia: efectivo y tarjeta_credito preservados');
END $$;

-- ============ Reemplazos ENCADENADOS: transferencia -> tarjeta_debito =======
DO $$
DECLARE r jsonb; v_comp uuid; v_t uuid; v_d uuid;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  SELECT id INTO v_t FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL;  -- transferencia viva
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'tarjeta_debito',1000,1000,'ARS',1,'segunda edicion',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK3');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'CH1 segunda edicion (transferencia->tarjeta_debito) -> ok (sin bloqueo permanente)');
  v_d := (r->>'new_payment_id')::uuid;
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=3, 'CH2 3 eslabones conservados (efectivo, transferencia, tarjeta_debito)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL)=1, 'CH3 solo la ultima fila esta viva');
  PERFORM pg_temp.assert((SELECT payment_method FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL)='tarjeta_debito', 'CH4 la viva es tarjeta_debito');
  -- cada eslabon apunta a su sustituto INMEDIATO
  PERFORM pg_temp.assert((SELECT replacement_payment_id FROM comprobante_payments WHERE comprobante_id=v_comp AND payment_method='transferencia')=v_d, 'CH5 transferencia -> tarjeta_debito (sustituto inmediato)');
  PERFORM pg_temp.assert((SELECT replacement_payment_id FROM comprobante_payments WHERE comprobante_id=v_comp AND payment_method='efectivo')=v_t, 'CH6 efectivo -> transferencia (sustituto inmediato, no el ultimo)');
  -- total nunca se duplica
  PERFORM pg_temp.assert((SELECT total_cobrado FROM comprobantes WHERE id=v_comp)=1000, 'CH7 total_cobrado sigue 1000 tras 2 reemplazos');
  -- INVARIANTE: el cashflow acumulado equivale EXACTAMENTE al conjunto de pagos
  -- VIVOS (cada venta cobrada una sola vez, sin importar cuantos reemplazos hubo).
  PERFORM pg_temp.assert(
    pg_temp.cf('00000000-0000-0000-0000-0000005d7101','1900-01-01','2999-12-31')
    = (SELECT COALESCE(SUM(amount_ars),0) FROM comprobante_payments WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND replaced_at IS NULL),
    'CH8 cashflow acumulado == suma de pagos VIVOS (sin duplicar por los reemplazos)');
END $$;

-- ============ Idempotencia durable + source set ============================
DO $$
DECLARE r1 jsonb; r2 jsonb; v_comp uuid;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  -- misma key + misma intencion -> replay (no vuelve a reemplazar)
  r1 := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'tarjeta_debito',1000,1000,'ARS',1,'segunda edicion',
        '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK3');
  -- misma key + metodo distinto -> conflicto
  r2 := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'qr',1000,1000,'ARS',1,'segunda edicion',
        '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK3');
  RESET ROLE;
  PERFORM pg_temp.assert((r1->>'ok')::boolean AND (r1->>'replay')::boolean, 'ID1 misma key + misma intencion -> replay');
  PERFORM pg_temp.assert(r2->>'error_code'='IDEMPOTENCY_CONFLICT' AND r2->>'error'='IDEMPOTENCY_CONFLICT', 'ID2 metodo distinto -> IDEMPOTENCY_CONFLICT (contrato frontend)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=3, 'ID3 el replay NO creo eslabones nuevos');
END $$;
-- normalizacion de metodo: alias equivalente -> replay
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'  Tarjeta_Debito  ',1000,1000,'ARS',1,'segunda edicion',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RK3');
  PERFORM pg_temp.assert((r->>'replay')::boolean, 'NM1 "  Tarjeta_Debito  " normalizado -> mismo hash -> replay');
  -- metodo invalido -> VALIDATION_ERROR sin request
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'bitcoin',1000,1000,'ARS',1,'x',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RKBAD');
  PERFORM pg_temp.assert(r->>'error_code'='VALIDATION_ERROR' AND r->>'error'='Método de pago inválido', 'NM2 metodo invalido -> VALIDATION_ERROR');
  RESET ROLE;
END $$;
SELECT pg_temp.assert((SELECT count(*) FROM comprobante_payment_replace_requests WHERE business_id=:'biz' AND idempotency_key='RKBAD')=0, 'NM3 metodo invalido: 0 requests reservadas');

-- ============ Seguridad ====================================================
DO $$
DECLARE r jsonb; v_comp uuid;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  SET LOCAL "request.jwt.claim.sub" = '';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'efectivo',1000,1000,'ARS',1,NULL,NULL,0,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='UNAUTHORIZED', 'S1 sin auth -> UNAUTHORIZED');
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7209';  -- OB
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'efectivo',1000,1000,'ARS',1,NULL,NULL,0,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='FORBIDDEN', 'S2 cross-tenant -> FORBIDDEN');
  -- comprobante ajeno
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7201'::uuid,'efectivo',1000,1000,'ARS',1,NULL,NULL,0,NULL,NULL);
  PERFORM pg_temp.assert(r->>'error_code'='COMPROBANTE_NOT_FOUND', 'S3 comprobante de otro negocio -> COMPROBANTE_NOT_FOUND');
  RESET ROLE;
END $$;

-- ============ Audit E1: cero backstop + evento unico ========================
DO $$
DECLARE r jsonb; v_c3 uuid; v_before int; v_after int; a finance_audit_log%ROWTYPE;
BEGIN
  SELECT count(*) INTO v_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101';
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-0000005d7101'::uuid,'S3','h3',
    jsonb_build_object('tipo','factura_c','cc_total',0,
      'items',jsonb_build_array(jsonb_build_object('inventory_id','00000000-0000-0000-0000-0000005d7d01','descripcion','P','tipo_linea','producto','cantidad',1,'precio_unitario',1000)),
      'pagos',jsonb_build_array(
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','efectivo'),
        jsonb_build_object('amount',500,'amount_ars',500,'payment_method','qr'))));
  v_c3 := (r->>'comprobante_id')::uuid;
  SELECT count(*) INTO v_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101';
  r := replace_comprobante_payment(v_c3,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',1000,1000,'ARS',1,'unif',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RKA');
  RESET ROLE;
  SELECT count(*) INTO v_after FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101';
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'AU0 reemplazo de mixto (2 pagos) -> ok');
  PERFORM pg_temp.assert(v_after - v_before = 1, 'AU1 reemplazo de 2 pagos -> UN SOLO evento (cero backstop E1)');
  SELECT * INTO a FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND action='payment_replacement' AND entity_id=v_c3;
  PERFORM pg_temp.assert(a.entity_table='comprobantes' AND a.entity_id=v_c3, 'AU2 entidad = comprobantes/comprobante_id (no una fila original)');
  PERFORM pg_temp.assert(a.actor_user_id='00000000-0000-0000-0000-0000005d7109' AND a.economic_date=public.ar_today(), 'AU3 actor = auth.uid, economic_date = hoy');
  PERFORM pg_temp.assert(jsonb_array_length(a.new_data->'original_payment_ids')=2 AND jsonb_array_length(a.new_data->'compensating_fm_ids')=2, 'AU4 arrays de pagos originales y FM compensatorios (2)');
  PERFORM pg_temp.assert((a.new_data->>'new_payment_id') IS NOT NULL AND (a.new_data->>'source_payment_set_hash') IS NOT NULL, 'AU5 nuevo pago + source_payment_set_hash en la auditoria');
END $$;

-- ============ Rollback ante fallo de auditoria ==============================
ALTER TABLE finance_audit_log ADD CONSTRAINT tmp_fail_pr CHECK (action <> 'payment_replacement') NOT VALID;
DO $$
DECLARE r jsonb; v_comp uuid; n_rows int; v_tot numeric;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  SELECT count(*) INTO n_rows FROM comprobante_payments WHERE comprobante_id=v_comp;
  SELECT total_cobrado INTO v_tot FROM comprobantes WHERE id=v_comp;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'qr',1000,1000,'ARS',1,'rb',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'RKRB');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='AUDIT_FAILED', 'RB1 auditoria rota -> AUDIT_FAILED');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=n_rows, 'RB2 sin pago nuevo (rollback)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL)=1, 'RB3 el vivo sigue vivo (sin marcado parcial)');
  PERFORM pg_temp.assert((SELECT total_cobrado FROM comprobantes WHERE id=v_comp)=v_tot, 'RB4 total_cobrado intacto');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='RKRB')=0, 'RB5 sin request huerfana');
END $$;
ALTER TABLE finance_audit_log DROP CONSTRAINT tmp_fail_pr;

-- ============ Request table protegida ======================================
SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.comprobante_payment_replace_requests','SELECT'), 'RT1 authenticated NO SELECT replace_requests');
SELECT pg_temp.assert(NOT has_table_privilege('service_role','public.comprobante_payment_replace_requests','DELETE'), 'RT2 service_role NO DELETE');
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' LIMIT 1;
  e:=''; BEGIN DELETE FROM comprobante_payment_replace_requests WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'RT3 DELETE prohibido');
  e:=''; BEGIN UPDATE comprobante_payment_replace_requests SET request_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'RT4 request inmutable');
END $$;
-- 6F.3a: las columnas nuevas heredan la misma proteccion, sin grants por columna
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.comprobante_payment_replace_requests','status','UPDATE'), 'RT5 authenticated NO UPDATE status');
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.comprobante_payment_replace_requests','error_code','UPDATE'), 'RT6 authenticated NO UPDATE error_code');
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.comprobante_payment_replace_requests','source_payment_set_hash','UPDATE'), 'RT7 authenticated NO UPDATE source_payment_set_hash');
SELECT pg_temp.assert(NOT has_column_privilege('anon','public.comprobante_payment_replace_requests','status','SELECT'), 'RT8 anon NO SELECT status');
SELECT pg_temp.assert(NOT has_column_privilege('service_role','public.comprobante_payment_replace_requests','status','UPDATE'), 'RT9 service_role NO UPDATE status');

-- ============ 6F.3a: maquina de estados de la request =======================
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_constraint WHERE conname='cpr_requests_status_check'), 'ST0 CHECK de status presente');
-- una reserva exitosa queda completed + new_payment_id
SELECT pg_temp.assert((SELECT status FROM comprobante_payment_replace_requests WHERE business_id=:'biz' AND idempotency_key='RK1')='completed', 'ST1 reemplazo exitoso -> status=completed');
SELECT pg_temp.assert((SELECT new_payment_id FROM comprobante_payment_replace_requests WHERE business_id=:'biz' AND idempotency_key='RK1') IS NOT NULL, 'ST2 completed lleva new_payment_id');
SELECT pg_temp.assert((SELECT error_code FROM comprobante_payment_replace_requests WHERE business_id=:'biz' AND idempotency_key='RK1') IS NULL, 'ST3 completed sin error_code');
SELECT pg_temp.assert((SELECT source_payment_set_hash FROM comprobante_payment_replace_requests WHERE business_id=:'biz' AND idempotency_key='RK1') IS NOT NULL, 'ST4 source_payment_set_hash persistido');
-- transiciones prohibidas
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='RK1';
  e:=''; BEGIN UPDATE comprobante_payment_replace_requests SET status='processing' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%terminal%', 'ST5 completed -> processing PROHIBIDO (terminal)');
  e:=''; BEGIN UPDATE comprobante_payment_replace_requests SET status='stale_source' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'ST6 completed -> stale_source PROHIBIDO');
  e:=''; BEGIN UPDATE comprobante_payment_replace_requests SET source_payment_set_hash='x' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%inmutable%', 'ST7 source_payment_set_hash inmutable');
  -- status desconocido rechazado por el CHECK
  e:=''; BEGIN INSERT INTO comprobante_payment_replace_requests(business_id,user_id,op,idempotency_key,request_hash,comprobante_id,status)
    VALUES ('00000000-0000-0000-0000-0000005d7101','00000000-0000-0000-0000-0000005d7109','payment_replacement','ZZZ','h',(SELECT id FROM pg_temp_c WHERE kind='U'),'weird');
    EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'ST8 status desconocido rechazado por CHECK');
END $$;

-- ============ 6F.3a §4: retry de una request stale_source ===================
-- Se inyecta una request terminal stale_source (evidencia de un intento rechazado
-- por concurrencia) y se reintenta con la MISMA key e intencion.
DO $$
DECLARE r jsonb; v_comp uuid; v_hash text; v_rows_before int; v_live_before uuid;
BEGIN
  SELECT id INTO v_comp FROM pg_temp_c WHERE kind='U';
  -- hash de intencion identico al que calculara la RPC para estos argumentos
  v_hash := encode(extensions.digest(jsonb_build_object('op','payment_replacement','business_id','00000000-0000-0000-0000-0000005d7101'::uuid,
    'comprobante_id',v_comp,'method','qr','amount',round(1000,2),'amount_ars',round(1000,2),'currency','ARS',
    'exchange_rate',round(1,6),'notes','stale','commission_amount',round(0,2),'provider',NULL)::text,'sha256'),'hex');
  INSERT INTO comprobante_payment_replace_requests(business_id,user_id,op,idempotency_key,request_hash,comprobante_id,source_payment_set_hash,status,error_code)
    VALUES ('00000000-0000-0000-0000-0000005d7101','00000000-0000-0000-0000-0000005d7109','payment_replacement','STALEK',v_hash,v_comp,'hash_viejo','stale_source','PAYMENT_SET_CHANGED');
  SELECT count(*) INTO v_rows_before FROM comprobante_payments WHERE comprobante_id=v_comp;
  SELECT id INTO v_live_before FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'qr',1000,1000,'ARS',1,'stale',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'STALEK');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='PAYMENT_SET_CHANGED' AND r->>'error'='El cobro cambió mientras se procesaba. Volvé a intentarlo',
    'SR1 retry de una request stale_source -> PAYMENT_SET_CHANGED (contrato exacto)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=v_rows_before, 'SR2 el retry NO creo un segundo reemplazo');
  PERFORM pg_temp.assert((SELECT id FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL)=v_live_before, 'SR3 el pago vigente NO cambio');
  PERFORM pg_temp.assert((SELECT status FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='STALEK')='stale_source', 'SR4 la request sigue stale_source (no volvio a processing)');
  PERFORM pg_temp.assert((SELECT new_payment_id FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='STALEK') IS NULL, 'SR5 stale_source sin new_payment_id');
END $$;
-- una stale no puede mutarse manualmente a completed
DO $$
DECLARE v_id uuid; e text;
BEGIN
  SELECT id INTO v_id FROM comprobante_payment_replace_requests WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='STALEK';
  e:=''; BEGIN UPDATE comprobante_payment_replace_requests SET status='completed' WHERE id=v_id; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e<>'', 'SR6 stale_source -> completed PROHIBIDO (manual)');
END $$;

-- ============ 6F.4a: comprobante anulado no admite reemplazos ==============
DO $$
DECLARE r jsonb; v_comp uuid; v_pay_before int; v_fm_before int; v_live_before uuid; v_au_before int;
BEGIN
  -- comprobante nuevo, con su cobro, reemplazado UNA vez ANTES de anular
  SELECT id INTO v_comp FROM comprobantes WHERE business_id='00000000-0000-0000-0000-0000005d7101'
    AND id NOT IN (SELECT id FROM pg_temp_c) ORDER BY created_at DESC LIMIT 1;
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',1000,1000,'ARS',1,'antes',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'PREANN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='false', 'AN1 reemplazo previo a la anulacion OK');
  -- se anula (registro canonico + señales), como lo dejaria annul_comprobante_atomic
  PERFORM set_config('m7.annulment_scope','1',true);
  UPDATE comprobantes SET estado='anulado', status='cancelled', estado_comercial='anulado' WHERE id=v_comp;
  PERFORM set_config('m7.annulment_scope','',true);
  INSERT INTO comprobante_annulments(business_id,comprobante_id,user_id,idempotency_key,request_hash,mode,motivo,restore_stock,status,annulment_date)
    VALUES ('00000000-0000-0000-0000-0000005d7101',v_comp,'00000000-0000-0000-0000-0000005d7109','ANNK','h','refund_current_session','x',false,'completed','2026-07-16');

  SELECT count(*) INTO v_pay_before FROM comprobante_payments WHERE comprobante_id=v_comp;
  SELECT count(*) INTO v_fm_before  FROM financial_movements WHERE comprobante_id=v_comp;
  SELECT id INTO v_live_before FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL;
  SELECT count(*) INTO v_au_before FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND source_rpc='replace_comprobante_payment';

  -- (1) key NUEVA sobre comprobante anulado -> ALREADY_ANNULLED
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'qr',1000,1000,'ARS',1,'despues',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'POSTANN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='ALREADY_ANNULLED' AND r->>'error'='El comprobante está anulado',
    'AN2 key nueva sobre anulado -> ALREADY_ANNULLED (contrato exacto)');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=v_pay_before, 'AN3 no creo otro pago');
  PERFORM pg_temp.assert((SELECT id FROM comprobante_payments WHERE comprobante_id=v_comp AND replaced_at IS NULL)=v_live_before, 'AN4 no cambio el medio vigente');
  PERFORM pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=v_comp)=v_fm_before, 'AN5 no creo compensaciones');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payment_replace_requests
    WHERE business_id='00000000-0000-0000-0000-0000005d7101' AND idempotency_key='POSTANN')=0, 'AN6 no creo request');
  PERFORM pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id='00000000-0000-0000-0000-0000005d7101'
    AND source_rpc='replace_comprobante_payment')=v_au_before, 'AN7 no audito un reemplazo');

  -- (2) REPLAY de la key anterior a la anulacion -> sigue siendo replay
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000005d7109';
  r := replace_comprobante_payment(v_comp,'00000000-0000-0000-0000-0000005d7101'::uuid,'transferencia',1000,1000,'ARS',1,'antes',
       '00000000-0000-0000-0000-0000005d7109'::uuid,0,NULL,'PREANN');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'ok'='true' AND r->>'replay'='true',
    'AN8 replay de un reemplazo COMPLETADO antes de la anulacion sigue devolviendo replay');
  PERFORM pg_temp.assert((SELECT count(*) FROM comprobante_payments WHERE comprobante_id=v_comp)=v_pay_before, 'AN9 el replay no escribio nada');
END $$;

SELECT pg_temp.assert(true, '=== etapa7_rpc_integration_payment_replacement_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
