-- ============================================================
-- Test suite Etapa 0 — M1 finance_hardening_base
-- (supabase/migrations/20260702100000_finance_hardening_base.sql)
--
-- HOW TO RUN (local stack, NUNCA prod):
--   supabase db reset
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < supabase/tests/etapa0_finance_hardening_test.sql
--
-- Cubre: ar_today (cortes 20:59/21:01 AR, cambio de mes y de año),
-- ownership + multi-moneda de create_owner_withdrawal, y caja abierta única.
-- Runs inside a single transaction and ROLLBACKs at the end.
-- ============================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label;
  ELSE RAISE NOTICE 'PASS: %', label; END IF;
END; $$;

-- ════════════════════════════════════════════════════════════
-- T1: ar_today — la conversión de zona es la correcta en los bordes.
-- Córdoba es UTC-3 (sin DST): el día argentino arranca a las 03:00 UTC.
-- ════════════════════════════════════════════════════════════
-- 20:59 AR del 2026-07-02 == 23:59 UTC del 2026-07-02 → sigue siendo 02/07 en AR
SELECT pg_temp.assert(
  ('2026-07-02 23:59:00+00'::timestamptz AT TIME ZONE 'America/Argentina/Cordoba')::date = DATE '2026-07-02',
  'T1a 20:59 AR (23:59 UTC) sigue siendo el mismo día argentino');
-- 21:01 AR del 2026-07-02 == 00:01 UTC del 2026-07-03 → CURRENT_DATE (UTC) ya
-- diría 03/07, pero el día argentino sigue siendo 02/07.
SELECT pg_temp.assert(
  ('2026-07-03 00:01:00+00'::timestamptz AT TIME ZONE 'America/Argentina/Cordoba')::date = DATE '2026-07-02',
  'T1b 21:01 AR (00:01 UTC del día siguiente) sigue siendo 02/07 en Argentina');
-- Cambio de mes: 30/06 22:30 AR == 01:30 UTC del 01/07 → AR sigue en junio.
SELECT pg_temp.assert(
  ('2026-07-01 01:30:00+00'::timestamptz AT TIME ZONE 'America/Argentina/Cordoba')::date = DATE '2026-06-30',
  'T1c cambio de mes: 22:30 AR del 30/06 NO se va al 01/07');
-- Cambio de año: 31/12 23:00 AR == 02:00 UTC del 01/01 → AR sigue en el año viejo.
SELECT pg_temp.assert(
  ('2027-01-01 02:00:00+00'::timestamptz AT TIME ZONE 'America/Argentina/Cordoba')::date = DATE '2026-12-31',
  'T1d cambio de año: 23:00 AR del 31/12 sigue siendo 2026 en Argentina');
-- ar_today() implementa EXACTAMENTE esa conversión sobre now()
SELECT pg_temp.assert(
  public.ar_today() = (now() AT TIME ZONE 'America/Argentina/Cordoba')::date,
  'T1e ar_today() = conversión canónica de now() a día argentino');

-- ── Seed común ──────────────────────────────────────────────
\set bizA   '00000000-0000-0000-0000-0000000f0a01'
\set bizB   '00000000-0000-0000-0000-0000000f0b01'
\set ownerA '00000000-0000-0000-0000-0000000f0a09'
\set ownerB '00000000-0000-0000-0000-0000000f0b09'
\set accArs '00000000-0000-0000-0000-0000000f0aa1'
\set accUsd '00000000-0000-0000-0000-0000000f0aa2'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'ownerA'), (:'ownerB');
INSERT INTO businesses(id, name, owner_user_id) VALUES
  (:'bizA', 'Etapa0 Hardening A', :'ownerA'),
  (:'bizB', 'Etapa0 Hardening B', :'ownerB');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  (:'bizA', :'ownerA', 'owner', true),
  (:'bizB', :'ownerB', 'owner', true);
-- Cuenta personal de ownerA: primaria ARS + fila multi-moneda ARS
INSERT INTO personal_accounts(id, user_id, name, type, currency, initial_balance, current_balance, is_active)
  VALUES (:'accArs', :'ownerA', 'Billetera Test', 'cash', 'ARS', 1000, 1000, true);
INSERT INTO personal_account_balances(user_id, account_id, currency, initial_balance, current_balance)
  VALUES (:'ownerA', :'accArs', 'ARS', 1000, 1000);
-- Cuenta personal SOLO USD (sin fila ARS)
INSERT INTO personal_accounts(id, user_id, name, type, currency, initial_balance, current_balance, is_active)
  VALUES (:'accUsd', :'ownerA', 'Caja USD Test', 'dollars', 'USD', 100, 100, true);
INSERT INTO personal_account_balances(user_id, account_id, currency, initial_balance, current_balance)
  VALUES (:'ownerA', :'accUsd', 'USD', 100, 100);
SET LOCAL session_replication_role = 'origin';

-- ════════════════════════════════════════════════════════════
-- T2: create_owner_withdrawal — negocio propio OK + multi-moneda sincronizada
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := create_owner_withdrawal(
    '00000000-0000-0000-0000-0000000f0a01'::uuid, 500, NULL,
    '00000000-0000-0000-0000-0000000f0aa1'::uuid, 'Test retiro OK');
  PERFORM pg_temp.assert((r->>'ok')::boolean, 'T2a retiro sobre negocio propio -> ok (' || COALESCE(r->>'error','') || ')');
  RESET ROLE;
END $$;

SELECT pg_temp.assert(
  (SELECT current_balance FROM personal_account_balances
    WHERE account_id = '00000000-0000-0000-0000-0000000f0aa1' AND currency = 'ARS') = 1500,
  'T2b personal_account_balances (fuente multi-moneda) refleja el retiro: 1000+500');
SELECT pg_temp.assert(
  (SELECT current_balance FROM personal_accounts WHERE id = '00000000-0000-0000-0000-0000000f0aa1') = 1500,
  'T2c personal_accounts.current_balance (legacy) quedó SINCRONIZADO: 1500');
SELECT pg_temp.assert(
  (SELECT count(*) FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000f0a01'
      AND source = 'owner_withdrawal' AND type = 'expense' AND movement_type IS NULL) = 1,
  'T2d FM de egreso del negocio: type=expense y sin el metadato contradictorio movement_type=income');
SELECT pg_temp.assert(
  (SELECT date FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000f0a01' AND source = 'owner_withdrawal') = public.ar_today(),
  'T2e fecha del retiro = día argentino (ar_today), no UTC');
SELECT pg_temp.assert(
  (SELECT count(*) FROM business_finance_entries WHERE business_id = '00000000-0000-0000-0000-0000000f0a01') = 0,
  'T2f el retiro NO genera BFE (no es gasto operativo del P&L)');

-- ════════════════════════════════════════════════════════════
-- T3: create_owner_withdrawal — negocio AJENO rechazado (P0-8)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  -- ownerB intenta drenar caja del negocio de ownerA hacia... su cuenta no
  -- existe en bizA, pero el punto es el business_id ajeno.
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0b09';
  r := create_owner_withdrawal(
    '00000000-0000-0000-0000-0000000f0a01'::uuid, 999, NULL,
    '00000000-0000-0000-0000-0000000f0aa1'::uuid, 'Ataque cross-tenant');
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE, 'T3a retiro sobre negocio ajeno -> rechazado');
  PERFORM pg_temp.assert(r->>'error' ILIKE '%permiso%', 'T3b el error explica la falta de permiso');
  RESET ROLE;
END $$;
SELECT pg_temp.assert(
  (SELECT count(*) FROM financial_movements
    WHERE business_id = '00000000-0000-0000-0000-0000000f0a01' AND source = 'owner_withdrawal') = 1,
  'T3c ningún FM adicional fue creado por el intento cross-tenant');

-- ════════════════════════════════════════════════════════════
-- T4: monto inválido y cuenta sin ARS
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-0000000f0a09';
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000000f0a01'::uuid, 0, NULL,
    '00000000-0000-0000-0000-0000000f0aa1'::uuid, NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE, 'T4a monto 0 -> rechazado');
  r := create_owner_withdrawal('00000000-0000-0000-0000-0000000f0a01'::uuid, 100, NULL,
    '00000000-0000-0000-0000-0000000f0aa2'::uuid, NULL);
  PERFORM pg_temp.assert((r->>'ok')::boolean IS NOT TRUE AND r->>'error' ILIKE '%ARS%',
    'T4b cuenta solo-USD -> rechazado (no se inventa conversión)');
  RESET ROLE;
END $$;

-- ════════════════════════════════════════════════════════════
-- T5: caja abierta única por negocio (índice único parcial)
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_caja1 uuid; v_dup_blocked boolean := false;
BEGIN
  INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
    VALUES ('00000000-0000-0000-0000-0000000f0a01', 'abierta', 100, 0, 0, 0, 1)
    RETURNING id INTO v_caja1;
  RAISE NOTICE 'PASS: T5a primera caja abierta para bizA';

  BEGIN
    INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
      VALUES ('00000000-0000-0000-0000-0000000f0a01', 'abierta', 0, 0, 0, 0, 1);
  EXCEPTION WHEN unique_violation THEN
    v_dup_blocked := true;
  END;
  PERFORM pg_temp.assert(v_dup_blocked, 'T5b segunda caja abierta para el MISMO negocio -> unique_violation');

  INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
    VALUES ('00000000-0000-0000-0000-0000000f0b01', 'abierta', 0, 0, 0, 0, 1);
  RAISE NOTICE 'PASS: T5c OTRO negocio puede abrir su propia caja';

  UPDATE cajas SET status = 'cerrada', closed_at = now() WHERE id = v_caja1;
  INSERT INTO cajas (business_id, status, efectivo_inicial, transferencia_inicial, tarjeta_inicial, usd_inicial, usd_cotizacion_apertura)
    VALUES ('00000000-0000-0000-0000-0000000f0a01', 'abierta', 0, 0, 0, 0, 1);
  RAISE NOTICE 'PASS: T5d tras cerrar la anterior, se puede abrir una nueva';
END $$;

SELECT pg_temp.assert(true, '=== etapa0_finance_hardening_test: TODOS LOS CASOS PASARON ===');
ROLLBACK;
