-- ============================================================================
-- M7 7E.3 — El check bfe_income_duplicated distingue cobro mixto de duplicación.
--
-- Contexto: el predicado original contaba filas (count > 1 por comprobante) y
-- marcaba como CRITICAL todo cobro mixto, que genera legítimamente un espejo
-- `revenue_collection_mirror` por medio de pago. Se detectó en producción, sobre
-- datos correctos, después de desplegar M7.
--
-- Este suite prueba el invariante económico nuevo —el espejo de ingreso no puede
-- superar lo efectivamente cobrado— y, sobre todo, FALSIFICA el predicado viejo:
-- los casos válidos de abajo lo harían fallar. Sin eso, el test no demuestra que
-- el cambio sirvió para algo.
--
-- RUN: docker exec -i ... psql -X -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set BIZ  '00000000-0000-0000-0000-0000007e3a01'
\set BIZ2 '00000000-0000-0000-0000-0000007e3a02'
\set U1   '00000000-0000-0000-0000-0000007e3a09'
\set U2   '00000000-0000-0000-0000-0000007e3a08'

-- Comprobantes: C1 pago único · C2 mixto (2) · C3 mixto (3) · C4 duplicación
-- real · C5 espejo > cobrado · C6 con espejo revertido · C7 en el otro negocio
\set C1 '00000000-0000-0000-0000-0000007e3c01'
\set C2 '00000000-0000-0000-0000-0000007e3c02'
\set C3 '00000000-0000-0000-0000-0000007e3c03'
\set C4 '00000000-0000-0000-0000-0000007e3c04'
\set C5 '00000000-0000-0000-0000-0000007e3c05'
\set C6 '00000000-0000-0000-0000-0000007e3c06'
\set C7 '00000000-0000-0000-0000-0000007e3c07'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'U1'),(:'U2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'BIZ','7E3 A',:'U1'),(:'BIZ2','7E3 B',:'U2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'BIZ',:'U1','owner',true),(:'BIZ2',:'U2','owner',true);

INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date) VALUES
  (:'C1','factura_c','0001-7E3001','emitido','no_fiscal',1000,1000,1000,0,:'BIZ',:'U1','0001','2026-06-01','2026-06-01'),
  (:'C2','factura_c','0001-7E3002','emitido','no_fiscal',1000,1000,1000,0,:'BIZ',:'U1','0001','2026-06-02','2026-06-02'),
  (:'C3','factura_c','0001-7E3003','emitido','no_fiscal',900 ,900 ,900 ,0,:'BIZ',:'U1','0001','2026-06-03','2026-06-03'),
  (:'C4','factura_c','0001-7E3004','emitido','no_fiscal',1000,1000,1000,0,:'BIZ',:'U1','0001','2026-06-04','2026-06-04'),
  (:'C5','factura_c','0001-7E3005','emitido','no_fiscal',1000,1000,1100,0,:'BIZ',:'U1','0001','2026-06-05','2026-06-05'),
  (:'C6','factura_c','0001-7E3006','emitido','no_fiscal',1000,1000,1000,0,:'BIZ',:'U1','0001','2026-06-06','2026-06-06'),
  (:'C7','factura_c','0001-7E3007','emitido','no_fiscal',1000,1000,1000,0,:'BIZ2',:'U2','0001','2026-06-07','2026-06-07');

-- Pagos (activos)
INSERT INTO comprobante_payments(comprobante_id,business_id,amount,currency,amount_ars,exchange_rate,payment_method,commission_amount,date,created_by) VALUES
  (:'C1',:'BIZ',1000,'ARS',1000,1,'efectivo',0,'2026-06-01',:'U1'),
  (:'C2',:'BIZ', 500,'ARS', 500,1,'efectivo',0,'2026-06-02',:'U1'),
  (:'C2',:'BIZ', 500,'ARS', 500,1,'transferencia',0,'2026-06-02',:'U1'),
  (:'C3',:'BIZ', 300,'ARS', 300,1,'efectivo',0,'2026-06-03',:'U1'),
  (:'C3',:'BIZ', 300,'ARS', 300,1,'transferencia',0,'2026-06-03',:'U1'),
  (:'C3',:'BIZ', 300,'ARS', 300,1,'tarjeta_credito',0,'2026-06-03',:'U1'),
  (:'C4',:'BIZ',1000,'ARS',1000,1,'efectivo',0,'2026-06-04',:'U1'),
  (:'C5',:'BIZ',1100,'ARS',1100,1,'tarjeta_credito',0,'2026-06-05',:'U1'),
  (:'C6',:'BIZ',1000,'ARS',1000,1,'efectivo',0,'2026-06-06',:'U1'),
  (:'C7',:'BIZ2',1000,'ARS',1000,1,'efectivo',0,'2026-06-07',:'U2');

-- Espejos de ingreso
INSERT INTO business_finance_entries(business_id,date,type,category,description,amount,currency,amount_ars,exchange_rate,reference_comprobante_id,source,economic_class,reversed_at) VALUES
  -- C1: uno solo, exacto -> VALIDO
  (:'BIZ','2026-06-01','income','ventas_productos','C1',1000,'ARS',1000,1,:'C1','comprobante','revenue_collection_mirror',NULL),
  -- C2: MIXTO 500+500 = 1000 -> VALIDO (el predicado viejo lo marcaba)
  (:'BIZ','2026-06-02','income','ventas_productos','C2 efectivo',500,'ARS',500,1,:'C2','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ','2026-06-02','income','ventas_productos','C2 transf',  500,'ARS',500,1,:'C2','comprobante','revenue_collection_mirror',NULL),
  -- C3: TRES medios 300x3 = 900 -> VALIDO
  (:'BIZ','2026-06-03','income','ventas_productos','C3 a',300,'ARS',300,1,:'C3','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ','2026-06-03','income','ventas_productos','C3 b',300,'ARS',300,1,:'C3','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ','2026-06-03','income','ventas_productos','C3 c',300,'ARS',300,1,:'C3','comprobante','revenue_collection_mirror',NULL),
  -- C4: DUPLICACION REAL: un pago de 1000 espejado dos veces = 2000 -> FAIL
  (:'BIZ','2026-06-04','income','ventas_productos','C4',1000,'ARS',1000,1,:'C4','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ','2026-06-04','income','ventas_productos','C4 dup',1000,'ARS',1000,1,:'C4','comprobante','revenue_collection_mirror',NULL),
  -- C5: cobrado 1100 (con recargo) y espejo 1100 -> VALIDO pese a superar el bruto
  (:'BIZ','2026-06-05','income','ventas_productos','C5',1100,'ARS',1100,1,:'C5','comprobante','revenue_collection_mirror',NULL),
  -- C6: espejo correcto + uno REVERTIDO que no debe contarse -> VALIDO
  (:'BIZ','2026-06-06','income','ventas_productos','C6',1000,'ARS',1000,1,:'C6','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ','2026-06-06','income','ventas_productos','C6 revertido',1000,'ARS',1000,1,:'C6','comprobante','revenue_collection_mirror','2026-06-06'),
  -- C7: duplicacion real en el OTRO negocio (aislamiento)
  (:'BIZ2','2026-06-07','income','ventas_productos','C7',1000,'ARS',1000,1,:'C7','comprobante','revenue_collection_mirror',NULL),
  (:'BIZ2','2026-06-07','income','ventas_productos','C7 dup',1000,'ARS',1000,1,:'C7','comprobante','revenue_collection_mirror',NULL);
SET LOCAL session_replication_role='origin';

-- ══ Predicado NUEVO (el que instala la migracion) ═══════════════════════════
CREATE OR REPLACE FUNCTION pg_temp.nuevo(p_biz uuid)
RETURNS TABLE(n int, importe numeric) LANGUAGE sql STABLE AS $$
  SELECT count(*)::int, COALESCE(SUM(exceso),0) FROM (
    SELECT b.reference_comprobante_id, SUM(b.amount_ars) - COALESCE(p.pagos,0) AS exceso
      FROM business_finance_entries b
      JOIN (SELECT comprobante_id, SUM(amount_ars) AS pagos, count(*) AS n_pagos
              FROM comprobante_payments WHERE replaced_at IS NULL GROUP BY 1) p
        ON p.comprobante_id = b.reference_comprobante_id
     WHERE b.business_id=p_biz AND b.type='income' AND b.amount_ars > 0
       AND b.reference_comprobante_id IS NOT NULL AND b.reversed_at IS NULL
       AND p.n_pagos > 0
     GROUP BY b.reference_comprobante_id, p.pagos
    HAVING SUM(b.amount_ars) > COALESCE(p.pagos,0) + 1.00) x;
$$;

-- ══ Predicado VIEJO, para falsificar ════════════════════════════════════════
CREATE OR REPLACE FUNCTION pg_temp.viejo(p_biz uuid)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM (
    SELECT reference_comprobante_id FROM business_finance_entries
     WHERE business_id=p_biz AND type='income' AND amount_ars > 0
       AND reference_comprobante_id IS NOT NULL
     GROUP BY 1 HAVING count(*)>1) x;
$$;

-- ── Casos válidos: el NUEVO no los marca ────────────────────────────────────
SELECT pg_temp.assert((SELECT n FROM pg_temp.nuevo(:'BIZ')) = 1,
  'D1 en el negocio A el predicado nuevo marca EXACTAMENTE 1 (solo C4, la duplicacion real)');
SELECT pg_temp.assert((SELECT importe FROM pg_temp.nuevo(:'BIZ')) = 1000,
  'D2 el importe en riesgo es 1000 (el exceso de C4), no un total inventado');

-- ── FALSIFICACION: el predicado viejo marcaba los casos validos ─────────────
SELECT pg_temp.assert(pg_temp.viejo(:'BIZ') = 4,
  'D3 el predicado VIEJO marcaba 4 (C2 mixto, C3 tres medios, C4 real, C6 con revertido): 3 de ellos falsos positivos');
SELECT pg_temp.assert(pg_temp.viejo(:'BIZ') > (SELECT n FROM pg_temp.nuevo(:'BIZ')),
  'D4 el nuevo marca ESTRICTAMENTE MENOS que el viejo: la correccion sirvio para algo');

-- ── Aislamiento por negocio ─────────────────────────────────────────────────
SELECT pg_temp.assert((SELECT n FROM pg_temp.nuevo(:'BIZ2')) = 1,
  'D5 la duplicacion del otro negocio se detecta en SU negocio');
SELECT pg_temp.assert((SELECT n FROM pg_temp.nuevo(:'BIZ')) = 1,
  'D6 y no se filtra al negocio A (sigue siendo 1, no 2)');

-- ── El check REAL, a traves de finance_health_check_v2 ──────────────────────
DO $$
DECLARE r jsonb; c jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e3a09',true);
  r := public.finance_health_check_v2('00000000-0000-0000-0000-0000007e3a01'::uuid, true);
  RESET ROLE;
  SELECT e INTO c FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='bfe_income_duplicated';
  PERFORM pg_temp.assert(c IS NOT NULL, 'D7 el check sigue existiendo');
  PERFORM pg_temp.assert(c->>'result'='fail', 'D8 con una duplicacion real, falla');
  PERFORM pg_temp.assert((c->>'count')::int = 1,
    'D9 cuenta 1, no 4: los cobros mixtos ya no son falsos positivos (obtuvo '||COALESCE(c->>'count','?')||')');
  PERFORM pg_temp.assert((c->>'amount_ars')::numeric = 1000,
    'D10 informa el importe en riesgo (1000), antes iba en 0');
  PERFORM pg_temp.assert(c->>'severity_level'='critical', 'D11 sigue siendo critical');
END $$;

-- ── Sin duplicaciones, pasa ────────────────────────────────────────────────
DO $$
DECLARE r jsonb; c jsonb;
BEGIN
  SET LOCAL session_replication_role='replica';
  DELETE FROM business_finance_entries
   WHERE reference_comprobante_id='00000000-0000-0000-0000-0000007e3c04'::uuid AND description='C4 dup';
  SET LOCAL session_replication_role='origin';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e3a09',true);
  r := public.finance_health_check_v2('00000000-0000-0000-0000-0000007e3a01'::uuid, true);
  RESET ROLE;
  SELECT e INTO c FROM jsonb_array_elements(r->'checks') e WHERE e->>'check_id'='bfe_income_duplicated';
  PERFORM pg_temp.assert(c->>'result'='pass',
    'D12 quitada la duplicacion real, el check PASA aunque queden 2 cobros mixtos y 3 medios');
  PERFORM pg_temp.assert((c->>'count')::int = 0, 'D13 cuenta 0');
END $$;

-- El predicado viejo SEGUIRIA fallando en ese mismo estado: la prueba de que
-- el problema era el predicado y no los datos.
SELECT pg_temp.assert(pg_temp.viejo(:'BIZ') = 3,
  'D14 el VIEJO todavia marcaria 3 sobre datos ya correctos: era el predicado, no los datos');

ROLLBACK;
