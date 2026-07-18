-- ============================================================================
-- M7 7E.1b — Contratos de idempotencia de los mutadores restantes.
--
-- Lo que ESTE archivo cubre: replay secuencial, contratos de error tipados,
-- efecto económico contado una sola vez, cross-tenant, sin autenticar, y las
-- constraints que sostienen todo.
--
-- Lo que NO cubre y va aparte: la concurrencia real. Dos sesiones simultáneas
-- no se pueden montar dentro de una única transacción psql; vive en
-- scripts/finance/concurrency-harness.mjs (17 verificaciones). Simular
-- concurrencia con dos llamadas secuenciales sería mentir: en READ COMMITTED
-- el caso peligroso es justamente el que NO se puede reproducir en serie.
--
-- RUN: docker exec -i ... psql -X -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set bizA '00000000-0000-0000-0000-0000007e1a01'
\set bizB '00000000-0000-0000-0000-0000007e1a02'
\set OA   '00000000-0000-0000-0000-0000007e1a09'
\set OB   '00000000-0000-0000-0000-0000007e1a08'
\set ORIG '00000000-0000-0000-0000-0000007e1ac1'
\set NC   '00000000-0000-0000-0000-0000007e1ac2'
\set SUP  '00000000-0000-0000-0000-0000007e1ad1'
\set PUR  '00000000-0000-0000-0000-0000007e1ad2'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OA'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'bizA','7E1b A',:'OA'),(:'bizB','7E1b B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'bizA',:'OA','owner',true),(:'bizB',:'OB','owner',true);
INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date)
  VALUES (:'ORIG','factura_c','0001-7E1A01','emitido','emitido',1000,1000,0,1000,:'bizA',:'OA','0001',now(),now());
INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date,comprobante_original_id)
  VALUES (:'NC','nota_credito','0001-7E1A02','emitido','emitido',1000,1000,0,0,:'bizA',:'OA','0001',now(),now(),:'ORIG');
INSERT INTO suppliers(id,business_id,name) VALUES (:'SUP',:'bizA','Prov 7E1b');
INSERT INTO supplier_purchases(id,business_id,supplier_id,purchase_date,total_amount,paid_amount)
  VALUES (:'PUR',:'bizA',:'SUP',current_date,500,0);
SET LOCAL session_replication_role='origin';

-- ══ create_credit_note_finance_reversal ═════════════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e1a09',true);

  r1 := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e1ac2');
  PERFORM pg_temp.assert((r1->>'ok')::boolean, 'NC1 primera ejecucion ok ('||COALESCE(r1->>'error','')||')');
  PERFORM pg_temp.assert((r1->>'replay')::boolean IS FALSE, 'NC2 la primera NO es replay');

  -- Replay: misma NC, sin key. La identidad natural alcanza.
  r2 := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e1ac2');
  PERFORM pg_temp.assert((r2->>'ok')::boolean, 'NC3 replay devuelve ok');
  PERFORM pg_temp.assert((r2->>'replay')::boolean, 'NC4 el replay se declara como tal');
  PERFORM pg_temp.assert((r2->>'fm_created')::boolean IS FALSE
                     AND (r2->>'bfe_created')::boolean IS FALSE, 'NC5 el replay no crea nada');
  RESET ROLE;
END $$;

-- Efecto económico contado UNA sola vez, mirando las tablas y no el retorno.
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements
   WHERE comprobante_id=:'NC' AND sign=-1)=1, 'NC6 exactamente 1 financial_movement');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries
   WHERE reference_comprobante_id=:'NC' AND amount<0)=1, 'NC7 exactamente 1 BFE negativo');

-- Cross-tenant: el dueño de otro negocio no puede revertir esta NC.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e1a08',true);  -- OB
  r := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e1ac2');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='FORBIDDEN',
    'NC8 cross-tenant -> FORBIDDEN (obtuvo '||COALESCE(r->>'error_code','?')||')');
END $$;

-- Sin autenticar: auth.uid() nulo no debe pasar el control de pertenencia.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','',true);
  r := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e1ac2');
  RESET ROLE;
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE, 'NC9 sin actor -> rechazado');
END $$;

-- El contrato de error no filtra SQL crudo (era el defecto real de este RPC).
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e1a09',true);
  r := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-000000000999');  -- inexistente
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='NOT_FOUND', 'NC10 NC inexistente -> NOT_FOUND');
  PERFORM pg_temp.assert(r::text NOT LIKE '%duplicate key%' AND r::text NOT LIKE '%constraint%',
    'NC11 el error no filtra texto de Postgres');
END $$;

-- La constraint que sostiene la idempotencia debe existir de verdad.
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uniq_bfe_comprobante_reversal'),
  'NC12 indice unico del BFE de reversa presente');

-- Y NO debe existir uno equivalente del lado FM: un cobro mixto genera varios
-- movimientos compensatorios legitimos para el mismo comprobante, y un unico
-- ahi rompe la anulacion (lo detecto PA6 de la suite de anulacion).
SELECT pg_temp.assert(NOT EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uniq_fm_comprobante_reversal'),
  'NC13 NO hay indice unico en financial_movements (romperia la anulacion mixta)');

-- ══ delete_supplier_purchase_safe + tombstone ═══════════════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e1a09',true);
  r1 := public.delete_supplier_purchase_safe('00000000-0000-0000-0000-0000007e1a01',
        '00000000-0000-0000-0000-0000007e1ad2','00000000-0000-0000-0000-0000007e1a09');
  PERFORM pg_temp.assert((r1->>'ok')::boolean, 'DEL1 borrado ok ('||COALESCE(r1->>'error','')||')');

  -- Retry tras perder la respuesta: antes devolvia "Compra no encontrada".
  r2 := public.delete_supplier_purchase_safe('00000000-0000-0000-0000-0000007e1a01',
        '00000000-0000-0000-0000-0000007e1ad2','00000000-0000-0000-0000-0000007e1a09');
  RESET ROLE;
  PERFORM pg_temp.assert((r2->>'ok')::boolean AND (r2->>'replay')::boolean
                     AND r2->>'error_code'='ALREADY_DELETED',
    'DEL2 el retry recibe ALREADY_DELETED como replay, no un error');
END $$;

SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchases WHERE id=:'PUR')=0,
  'DEL3 la compra quedo eliminada');
SELECT pg_temp.assert((SELECT count(*) FROM supplier_purchase_deletions
   WHERE purchase_id=:'PUR')=1, 'DEL4 exactamente un tombstone');

-- Una compra que nunca existio NO debe confundirse con una ya borrada.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e1a09',true);
  r := public.delete_supplier_purchase_safe('00000000-0000-0000-0000-0000007e1a01',
       '00000000-0000-0000-0000-000000000998','00000000-0000-0000-0000-0000007e1a09');
  RESET ROLE;
  PERFORM pg_temp.assert(r->>'error_code'='NOT_FOUND',
    'DEL5 compra inexistente -> NOT_FOUND (distinta de ALREADY_DELETED)');
END $$;

-- El tombstone es append-only, como el resto del ledger M7.
DO $$
DECLARE e text; v uuid;
BEGIN
  SELECT id INTO v FROM supplier_purchase_deletions LIMIT 1;
  e:=''; BEGIN DELETE FROM supplier_purchase_deletions WHERE id=v; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%append-only%', 'DEL6 DELETE prohibido sobre el tombstone');
  e:=''; BEGIN UPDATE supplier_purchase_deletions SET purchase_id=gen_random_uuid() WHERE id=v; EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%append-only%', 'DEL7 UPDATE prohibido sobre el tombstone');
END $$;

SELECT pg_temp.assert(NOT has_table_privilege('authenticated','public.supplier_purchase_deletions','INSERT'),
  'DEL8 authenticated NO inserta tombstones directo');
SELECT pg_temp.assert(has_table_privilege('authenticated','public.supplier_purchase_deletions','SELECT'),
  'DEL9 authenticated puede leerlos (para la UI)');
SELECT pg_temp.assert((SELECT relrowsecurity FROM pg_class WHERE oid='public.supplier_purchase_deletions'::regclass),
  'DEL10 RLS activo en el tombstone');

-- ══ seed_expense_categories — la constraint que faltaba ═════════════════════
SELECT pg_temp.assert(EXISTS(SELECT 1 FROM pg_indexes WHERE indexname='uniq_expense_categories_business_name'),
  'SEED1 indice unico (business_id, name) presente');

DO $$
DECLARE n1 int; n2 int;
BEGIN
  PERFORM public.seed_expense_categories('00000000-0000-0000-0000-0000007e1a01');
  SELECT count(*) INTO n1 FROM expense_categories WHERE business_id='00000000-0000-0000-0000-0000007e1a01';
  PERFORM public.seed_expense_categories('00000000-0000-0000-0000-0000007e1a01');
  SELECT count(*) INTO n2 FROM expense_categories WHERE business_id='00000000-0000-0000-0000-0000007e1a01';
  PERFORM pg_temp.assert(n1=7, 'SEED2 la primera siembra deja 7 categorias (dejo '||n1||')');
  PERFORM pg_temp.assert(n2=7, 'SEED3 la segunda no agrega nada (quedaron '||n2||')');
END $$;

-- Ni siquiera un INSERT directo puede duplicar el nombre.
DO $$
DECLARE e text;
BEGIN
  e:=''; BEGIN
    INSERT INTO expense_categories(business_id,name,color,sort_order)
      VALUES ('00000000-0000-0000-0000-0000007e1a01','Operativos','#000',9);
  EXCEPTION WHEN OTHERS THEN e:=SQLERRM; END;
  PERFORM pg_temp.assert(e LIKE '%duplicate key%' OR e LIKE '%unique%',
    'SEED4 la constraint rechaza un nombre repetido');
END $$;

-- ══ pay_recurring_expense — contrato tipado ═════════════════════════════════
SELECT pg_temp.assert(EXISTS(
  SELECT 1 FROM pg_indexes WHERE tablename='personal_recurring_expense_payments'
    AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%recurring_expense_id%'
    AND indexdef LIKE '%period_year%' AND indexdef LIKE '%period_month%'),
  'REC1 UNIQUE(recurring_expense_id, period_year, period_month) presente');

-- ══ pay_card_statement_atomic — ya era correcta; se blinda el contrato ══════
SELECT pg_temp.assert(EXISTS(
  SELECT 1 FROM pg_indexes WHERE indexname='personal_card_payments_no_dup_period'),
  'CARD1 UNIQUE(user_id, credit_card_id, period) presente');
SELECT pg_temp.assert((SELECT prosrc FROM pg_proc WHERE proname='pay_card_statement_atomic')
  LIKE '%unique_violation%',
  'CARD2 mapea unique_violation -> already_paid (no filtra SQL)');

-- ══ 7E.1 no retrocede por culpa de este lote ═══════════════════════════════
SELECT pg_temp.assert(NOT has_schema_privilege('authenticated','public','CREATE'),
  'SEC1 authenticated sigue sin CREATE sobre public');
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('create_credit_note_finance_reversal','pay_recurring_expense',
                       'delete_supplier_purchase_safe','supplier_purchase_deletions_immutable')
     AND NOT ('search_path=pg_catalog, pg_temp' = ANY(COALESCE(p.proconfig,'{}'::text[]))))=0,
  'SEC2 las funciones reescritas usan search_path=pg_catalog, pg_temp');

ROLLBACK;
