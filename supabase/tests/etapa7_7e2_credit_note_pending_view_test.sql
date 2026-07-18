-- ============================================================================
-- M7 7E.2 §7 — La NC sin reversa financiera deja evidencia DURABLE y accionable.
--
-- El caso: la NC ya se emitió en ARCA (no se puede deshacer) y la reversa
-- financiera posterior falla. El ingreso original sigue contado. Eso no puede
-- quedar en un console.error del navegador: tiene que sobrevivir a un refresh,
-- a cerrar sesión y a cambiar de máquina.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set BIZ  '00000000-0000-0000-0000-0000007e2a01'
\set BIZ2 '00000000-0000-0000-0000-0000007e2a02'
\set U1   '00000000-0000-0000-0000-0000007e2a09'
\set U2   '00000000-0000-0000-0000-0000007e2a08'
\set ORIG '00000000-0000-0000-0000-0000007e2ac1'
\set NC   '00000000-0000-0000-0000-0000007e2ac2'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'U1'),(:'U2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'BIZ','7E2 A',:'U1'),(:'BIZ2','7E2 B',:'U2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES (:'BIZ',:'U1','owner',true),(:'BIZ2',:'U2','owner',true);
INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date)
  VALUES (:'ORIG','factura_c','0001-00007201','emitido','emitido',10000,10000,10000,0,:'BIZ',:'U1','0001','2026-05-02','2026-05-02');
-- NC emitida SIN su movimiento compensatorio = exactamente el estado que deja
-- una reversa fallida.
INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,business_id,created_by,punto_venta,fecha,date,comprobante_original_id)
  VALUES (:'NC','nota_credito','0001-00007202','emitido','emitido',10000,10000,0,0,:'BIZ',:'U1','0001','2026-05-20','2026-05-20',:'ORIG');
SET LOCAL session_replication_role='origin';

-- ══ 1. La vista identifica QUE comprobante ═════════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')=1,
  'CN1 la NC sin reversa aparece en la vista');
SELECT pg_temp.assert((SELECT importe_pendiente FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')=10000,
  'CN2 informa el importe pendiente');
SELECT pg_temp.assert((SELECT numero FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')='0001-00007202',
  'CN3 informa el numero de la NC');
SELECT pg_temp.assert((SELECT numero_original FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')='0001-00007201',
  'CN4 informa el comprobante original que quedo sin anular contablemente');
SELECT pg_temp.assert((SELECT business_id FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')=:'BIZ',
  'CN5 informa el negocio');

-- ══ 2. El Health Check la cuenta (señal durable, server-side) ══════════════
DO $$
DECLARE r jsonb; c jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e2a09',true);
  r := public.finance_health_check_v2('00000000-0000-0000-0000-0000007e2a01'::uuid, true);
  RESET ROLE;
  SELECT e INTO c FROM jsonb_array_elements(r->'checks') e
   WHERE e->>'check_id'='credit_note_cash_not_compensated';
  PERFORM pg_temp.assert(c->>'result'='fail', 'CN6 el Health Check la marca en fail');
  PERFORM pg_temp.assert((c->>'count')::int=1, 'CN7 cuenta exactamente una');
  PERFORM pg_temp.assert((c->>'amount_ars')::numeric=10000, 'CN8 informa el importe');
  PERFORM pg_temp.assert(c->>'severity_level' IN ('high','critical'), 'CN9 severidad alta');
END $$;

-- ══ 3. La recuperación es idempotente y apaga la señal ═════════════════════
DO $$
DECLARE r1 jsonb; r2 jsonb; c jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e2a09',true);
  r1 := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e2ac2');
  PERFORM pg_temp.assert((r1->>'ok')::boolean, 'CN10 el reintento registra la reversa');
  -- Reintentar de nuevo no puede duplicar nada.
  r2 := public.create_credit_note_finance_reversal('00000000-0000-0000-0000-0000007e2ac2');
  PERFORM pg_temp.assert((r2->>'replay')::boolean, 'CN11 un segundo reintento es replay');
  RESET ROLE;
END $$;

SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE comprobante_id=:'NC' AND sign=-1)=1,
  'CN12 exactamente un movimiento compensatorio pese a los dos reintentos');
SELECT pg_temp.assert((SELECT count(*) FROM v_credit_notes_pending_reversal WHERE comprobante_id=:'NC')=0,
  'CN13 la vista deja de listarla una vez resuelta');

DO $$
DECLARE r jsonb; c jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e2a09',true);
  r := public.finance_health_check_v2('00000000-0000-0000-0000-0000007e2a01'::uuid, true);
  RESET ROLE;
  SELECT e INTO c FROM jsonb_array_elements(r->'checks') e
   WHERE e->>'check_id'='credit_note_cash_not_compensated';
  PERFORM pg_temp.assert(c->>'result'='pass', 'CN14 el Health Check vuelve a pass');
END $$;

-- ══ 4. Aislamiento entre negocios ══════════════════════════════════════════
-- La vista es security_invoker: hereda las RLS de comprobantes, así que el
-- dueño de otro negocio no puede ver esta NC ni por accidente.
DO $$
DECLARE n int;
BEGIN
  SET LOCAL session_replication_role='replica';
  INSERT INTO comprobantes(id,tipo,numero,estado,estado_fiscal,total,total_bruto,total_cobrado,saldo_pendiente,
                           business_id,created_by,punto_venta,fecha,date,comprobante_original_id)
  VALUES ('00000000-0000-0000-0000-0000007e2ac3','nota_credito','0001-00007203','emitido','emitido',5000,5000,0,0,
          '00000000-0000-0000-0000-0000007e2a01','00000000-0000-0000-0000-0000007e2a09','0001','2026-05-21','2026-05-21',
          '00000000-0000-0000-0000-0000007e2ac1');
  SET LOCAL session_replication_role='origin';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000007e2a08',true);  -- dueño de OTRO negocio
  SELECT count(*) INTO n FROM public.v_credit_notes_pending_reversal;
  RESET ROLE;
  PERFORM pg_temp.assert(n=0, 'CN15 el dueño de otro negocio no ve NC ajenas (obtuvo '||n||')');
END $$;

ROLLBACK;
