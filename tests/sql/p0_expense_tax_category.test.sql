-- ============================================================================
-- P0 2026-09-10 — gasto general "Impuestos" devolvía INTERNAL_ERROR.
--
-- Causa: Expenses.tsx mandaba p_finance_type='taxes'. business_finance_entries_type_check
-- no lo admite: el INSERT del BFE fallaba dentro de create_expense_with_finance y
-- su EXCEPTION WHEN OTHERS lo devolvía como INTERNAL_ERROR, sin escritura parcial.
-- Fix (sólo front): 'impuestos' viaja como fixed_cost_local, que bfe_economic_class
-- ya clasifica como operating_expense (R10).
--
-- Ejerce la RPC canónica (wrapper público + autoridad 'finance' de Lote 3) con el
-- payload corregido: transferencia, efectivo con caja, fijo/local, replay,
-- conflicto de idempotencia, período cerrado, permisos, auditoría, coherencia
-- BFE/expense/FM y atomicidad del payload viejo.
-- RUN: docker cp … && psql -X -v ON_ERROR_STOP=1 -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000009e0101'
\set OWN  '00000000-0000-0000-0000-0000009e0109'
\set CSH  '00000000-0000-0000-0000-0000009e0107'
\set bizB '00000000-0000-0000-0000-0000009e0201'
\set OB   '00000000-0000-0000-0000-0000009e0209'
\set CAJA '00000000-0000-0000-0000-0000009e0301'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'OWN'),(:'CSH'),(:'OB');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','P0 gasto A',:'OWN'),(:'bizB','P0 gasto B',:'OB');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'biz',:'OWN','owner',true),(:'biz',:'CSH','cashier',true),(:'bizB',:'OB','owner',true);
INSERT INTO cajas(id,business_id,opened_by,status) VALUES (:'CAJA',:'biz',:'OWN','abierta');
SET LOCAL session_replication_role='origin';

DO $$ DECLARE v_p1 date := date_trunc('month', public.ar_today() - interval '1 month')::date;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000009e0109';
  PERFORM close_period('00000000-0000-0000-0000-0000009e0101'::uuid, v_p1, 'setup P0 gasto'); RESET ROLE;
END $$;

-- ═══════════════ Owner con autoridad finance ═══════════════════════════════
DO $$
DECLARE r jsonb; v_exp uuid;
  v_cur  date := public.ar_today();
  v_p1   date := date_trunc('month', public.ar_today() - interval '1 month')::date;
  c_biz  uuid := '00000000-0000-0000-0000-0000009e0101';
  c_own  uuid := '00000000-0000-0000-0000-0000009e0109';
  c_caja uuid := '00000000-0000-0000-0000-0000009e0301';
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000009e0109';

  -- T1: payload del incidente con el tipo corregido.
  r := public.create_expense_with_finance(c_biz, c_own, 'Alquiler + Servicios', 'Impuestos', 'impuestos',
    'fixed_cost_local', 592300, 'transferencia', v_cur, false, NULL, NULL, c_caja, 'P0-T1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND NOT (r->>'replay')::boolean,
    'T1 Impuestos/transferencia (fixed_cost_local) -> ok ('||COALESCE(r->>'error_code','')||')');
  v_exp := (r->>'expense_id')::uuid;

  -- T2: payload viejo. Reproduce el incidente y fija que no deja nada a medias.
  r := public.create_expense_with_finance(c_biz, c_own, 'impuesto viejo', 'Impuestos', 'impuestos',
    'taxes', 111, 'transferencia', v_cur, false, NULL, NULL, c_caja, 'P0-T2');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS FALSE AND r->>'error_code'='INTERNAL_ERROR',
    'T2 payload viejo p_finance_type=taxes -> INTERNAL_ERROR (causa del incidente)');

  -- T3: efectivo con caja abierta.
  r := public.create_expense_with_finance(c_biz, c_own, 'monitor', 'Equipamiento', 'equipamiento',
    'fixed_cost_local', 2500, 'efectivo', v_cur, false, NULL, NULL, c_caja, 'P0-T3');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T3 efectivo con caja abierta -> ok');

  -- T4: fijo/local sin caja explícita (el trigger asigna la caja abierta).
  r := public.create_expense_with_finance(c_biz, c_own, 'campaña', 'Marketing', 'marketing',
    'fixed_cost_local', 3000, 'transferencia', v_cur, false, NULL, NULL, NULL, 'P0-T4');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T4 fijo/local (Marketing) -> ok');

  -- T5: replay idempotente del T1.
  r := public.create_expense_with_finance(c_biz, c_own, 'Alquiler + Servicios', 'Impuestos', 'impuestos',
    'fixed_cost_local', 592300, 'transferencia', v_cur, false, NULL, NULL, c_caja, 'P0-T1');
  PERFORM pg_temp.assert((r->>'ok')::boolean AND (r->>'replay')::boolean AND (r->>'expense_id')::uuid = v_exp,
    'T5 replay misma key + payload -> mismo gasto, sin escribir');

  -- T6: misma key, monto distinto.
  r := public.create_expense_with_finance(c_biz, c_own, 'Alquiler + Servicios', 'Impuestos', 'impuestos',
    'fixed_cost_local', 592301, 'transferencia', v_cur, false, NULL, NULL, c_caja, 'P0-T1');
  PERFORM pg_temp.assert(r->>'error_code'='IDEMPOTENCY_CONFLICT', 'T6 misma key, payload distinto -> IDEMPOTENCY_CONFLICT');

  -- T7: período cerrado.
  r := public.create_expense_with_finance(c_biz, c_own, 'impuesto mes cerrado', 'Impuestos', 'impuestos',
    'fixed_cost_local', 777, 'transferencia', v_p1 + 5, false, NULL, NULL, c_caja, 'P0-T7');
  PERFORM pg_temp.assert(r->>'error_code'='PERIOD_CLOSED', 'T7 período cerrado -> PERIOD_CLOSED');

  RESET ROLE;
END $$;

-- ═══════════════ Permisos (wrapper público, autoridad finance) ═════════════
DO $$
DECLARE r jsonb; v_denied boolean := false;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000009e0209';  -- OB, no miembro
  BEGIN
    r := public.create_expense_with_finance('00000000-0000-0000-0000-0000009e0101'::uuid, NULL, 'cross', 'Impuestos',
      'impuestos', 'fixed_cost_local', 999, 'transferencia', public.ar_today(), false, NULL, NULL, NULL, 'P0-T8');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  PERFORM pg_temp.assert(v_denied, 'T8 no miembro -> 42501 (require_action_authority finance)');
  RESET ROLE;
END $$;

DO $$
DECLARE r jsonb; v_denied boolean := false;
  v_expected boolean := private.capability_resolve('cashier', NULL::jsonb, 'finance') IS TRUE;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000009e0107';  -- cashier
  BEGIN
    r := public.create_expense_with_finance('00000000-0000-0000-0000-0000009e0101'::uuid, NULL, 'cajero', 'Impuestos',
      'impuestos', 'fixed_cost_local', 444, 'transferencia', public.ar_today(), false, NULL, NULL, NULL, 'P0-T9');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  PERFORM pg_temp.assert(v_denied = NOT v_expected,
    'T9 cashier: acceso = capability finance del rol (' || CASE WHEN v_expected THEN 'permitido' ELSE 'denegado' END || ')');
  RESET ROLE;
END $$;

-- GAP-1 (preexistente, fuera de este hotfix): create_expense_with_finance no exige
-- caja abierta para efectivo. La única barrera es Expenses.tsx (cajaIsOpen). Se
-- fija el comportamiento actual para que el hallazgo sea visible y reproducible.
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000009e0209';  -- OB, bizB sin caja
  r := public.create_expense_with_finance('00000000-0000-0000-0000-0000009e0201'::uuid, NULL, 'efectivo sin caja', 'Impuestos',
    'impuestos', 'fixed_cost_local', 555, 'efectivo', public.ar_today(), false, NULL, NULL, NULL, 'P0-GAP1');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'GAP-1 efectivo sin caja abierta: el server lo acepta (sin guard server-side)');
  RESET ROLE;
END $$;

-- ═══════════════ Verificaciones sobre tablas (postgres) ═════════════════════
-- T1: coherencia BFE / expense / FM / request / auditoría
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND amount=592300)=1, 'T1b un solo expense');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND amount=592300)=1, 'T1c un solo BFE (el trigger no duplica)');
SELECT pg_temp.assert((
  SELECT b.type='fixed_cost_local' AND b.category='impuestos' AND b.economic_class='operating_expense'
     AND b.source='expense' AND b.payment_method='transferencia' AND b.date=public.ar_today()
  FROM expenses e JOIN business_finance_entries b ON b.id=e.finance_entry_id
  WHERE e.business_id=:'biz' AND e.amount=592300), 'T1d BFE fixed_cost_local/impuestos -> operating_expense');
SELECT pg_temp.assert((
  SELECT count(*) FROM expenses e JOIN financial_movements f ON f.reference_id=e.finance_entry_id
  WHERE e.business_id=:'biz' AND e.amount=592300 AND f.type='expense' AND f.source='expense'
    AND f.amount=592300 AND f.metodo_pago='transferencia' AND f.caja_id=:'CAJA')=1, 'T1e FM egreso transferencia en la caja, enlazado al BFE');
SELECT pg_temp.assert((SELECT expense_id IS NOT NULL FROM expense_requests WHERE business_id=:'biz' AND idempotency_key='P0-T1'), 'T1f request idempotente completado');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND request_id='P0-T1' AND action='operating_expense_create')=1, 'T1g exactamente un evento de auditoría (replay incluido)');

-- T2: el payload viejo no dejó nada
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND amount=111)=0, 'T2b sin expense');
SELECT pg_temp.assert((SELECT count(*) FROM business_finance_entries WHERE business_id=:'biz' AND amount=111)=0, 'T2c sin BFE');
SELECT pg_temp.assert((SELECT count(*) FROM financial_movements WHERE business_id=:'biz' AND amount=111)=0, 'T2d sin FM');
SELECT pg_temp.assert((SELECT count(*) FROM expense_requests WHERE business_id=:'biz' AND idempotency_key='P0-T2')=0, 'T2e sin reserva idempotente');
SELECT pg_temp.assert((SELECT count(*) FROM finance_audit_log WHERE business_id=:'biz' AND request_id='P0-T2')=0, 'T2f sin auditoría');

-- T3/T4
SELECT pg_temp.assert((
  SELECT count(*) FROM expenses e JOIN financial_movements f ON f.reference_id=e.finance_entry_id
  WHERE e.business_id=:'biz' AND e.amount=2500 AND f.metodo_pago='efectivo' AND f.caja_id=:'CAJA')=1, 'T3b FM efectivo en la caja abierta');
SELECT pg_temp.assert((
  SELECT b.economic_class='operating_expense' FROM expenses e JOIN business_finance_entries b ON b.id=e.finance_entry_id
  WHERE e.business_id=:'biz' AND e.amount=3000), 'T4b Marketing -> operating_expense');
SELECT pg_temp.assert((
  SELECT f.caja_id=:'CAJA' FROM expenses e JOIN financial_movements f ON f.reference_id=e.finance_entry_id
  WHERE e.business_id=:'biz' AND e.amount=3000), 'T4c FM sin caja explícita -> caja abierta asignada por trigger');

-- T6/T7/T8: rechazos sin escritura
SELECT pg_temp.assert((SELECT count(*) FROM expenses WHERE business_id=:'biz' AND amount IN (592301, 777, 999))=0, 'T6-T8 rechazos sin escritura');

SELECT pg_temp.assert((
  SELECT f.caja_id IS NULL FROM expenses e JOIN financial_movements f ON f.reference_id=e.finance_entry_id
  WHERE e.business_id=:'bizB' AND e.amount=555), 'GAP-1b FM de efectivo quedó sin caja');

ROLLBACK;
