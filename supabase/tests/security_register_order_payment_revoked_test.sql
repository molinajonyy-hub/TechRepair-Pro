-- ============================================================================
-- HOTFIX P0 — register_order_payment retirada de la API pública.
--
-- Invariantes de catálogo y privilegios (autoritativos para EXECUTE) + una
-- falsificación que reabre el permiso y exige que el predicado lo detecte.
--
-- El rechazo DINÁMICO por HTTP (anon → denegado) se prueba fuera de acá con
-- `npm run verify:register-order-payment-private`, que es además el vector real.
-- No se usa el patrón `DO + SET LOCAL ROLE + llamada sin permiso + EXCEPTION`:
-- crashea el backend con SIGSEGV en postgres:17.6.1.104 (ver hotfix
-- get_finance_summary).
--
-- RUN: psql -X -f  (una tx + ROLLBACK; no deja nada).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- ══ 1. Existe con su firma exacta, sin DROP, cuerpo/modo intactos ═══════════
SELECT pg_temp.assert(
  to_regprocedure('public.register_order_payment(uuid,uuid,numeric)') IS NOT NULL,
  'ROP1 existe con firma (uuid,uuid,numeric) — no se dropeo');
SELECT pg_temp.assert(
  (SELECT prosecdef FROM pg_proc WHERE oid='public.register_order_payment(uuid,uuid,numeric)'::regprocedure),
  'ROP2 sigue SECURITY DEFINER (cuerpo/modo sin cambios)');
SELECT pg_temp.assert(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.register_order_payment(uuid,uuid,numeric)'::regprocedure)='postgres',
  'ROP3 owner sigue siendo postgres');

-- ══ 2. Nadie del lado cliente puede ejecutarla (herencia resuelta) ══════════
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
  'ROP4 anon NO puede ejecutarla');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
  'ROP5 authenticated NO puede ejecutarla');
SELECT pg_temp.assert(NOT has_function_privilege('service_role','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
  'ROP6 service_role NO puede ejecutarla');
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid='public.register_order_payment(uuid,uuid,numeric)'::regprocedure
      AND a.grantee=0 AND a.privilege_type='EXECUTE')=0,
  'ROP7 el pseudo-rol PUBLIC no tiene EXECUTE');

-- ══ 3. FALSIFICACION (sin invocar entre roles) ══════════════════════════════
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.register_order_payment(uuid,uuid,numeric) TO anon;
  PERFORM pg_temp.assert(
    has_function_privilege('anon','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
    'ROP8 FALSIFICACION: tras un GRANT, anon vuelve a poder ejecutarla');
  REVOKE ALL ON FUNCTION public.register_order_payment(uuid,uuid,numeric) FROM anon;
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
    'ROP9 reaplicar el REVOKE vuelve a cerrar (idempotente)');
  REVOKE ALL ON FUNCTION public.register_order_payment(uuid,uuid,numeric) FROM anon;
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.register_order_payment(uuid,uuid,numeric)'::regprocedure,'EXECUTE'),
    'ROP10 el REVOKE es idempotente');
END $$;

-- ══ 4. No se amplió otra superficie: la RPC legítima sigue disponible ═══════
SELECT pg_temp.assert(
  (SELECT bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='create_order_payment_atomic'),
  'ROP11 create_order_payment_atomic (la RPC legitima de cobro) sigue ejecutable por authenticated');

ROLLBACK;
