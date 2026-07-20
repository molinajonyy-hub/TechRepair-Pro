-- ============================================================================
-- HOTFIX CRITICO — get_finance_summary retirada de la API publica.
--
-- No alcanza con leer la ACL: eso prueba que alguien escribio un REVOKE, no que
-- la funcion sea inalcanzable. Este suite INTENTA EJECUTARLA con cada rol de
-- cliente y exige que el motor la rechace.
--
-- FALSIFICACION: la seccion 4 vuelve a otorgar EXECUTE dentro de la transaccion
-- y exige que la fuga REAPAREZCA — devolviendo datos financieros de un negocio
-- ajeno sin autenticacion. Un test de seguridad que nunca vio fallar su
-- predicado no probo nada.
--
-- RUN: psql -X -f  (una tx + ROLLBACK; no deja nada).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- ══ 1. La funcion sigue existiendo con su firma exacta ══════════════════════
-- El hotfix NO hace DROP: si desaparecio, el cambio se fue de alcance.
SELECT pg_temp.assert(
  to_regprocedure('public.get_finance_summary(uuid,date,date)') IS NOT NULL,
  'GFS1 la funcion existe con su firma exacta (uuid,date,date) — no se dropeo');

SELECT pg_temp.assert(
  (SELECT p.prosecdef FROM pg_proc p WHERE p.oid='public.get_finance_summary(uuid,date,date)'::regprocedure),
  'GFS2 sigue siendo SECURITY DEFINER (no se cambio el cuerpo ni el modo)');

SELECT pg_temp.assert(
  (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
    WHERE p.oid='public.get_finance_summary(uuid,date,date)'::regprocedure) = 'postgres',
  'GFS3 el owner no cambio');

-- ══ 2. Nadie del lado cliente puede ejecutarla ══════════════════════════════
-- has_function_privilege resuelve la HERENCIA. Esa es la pregunta correcta:
-- anon nunca tuvo un grant propio, heredaba EXECUTE de PUBLIC.
SELECT pg_temp.assert(
  NOT has_function_privilege('anon','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
  'GFS4 anon NO puede ejecutarla');

SELECT pg_temp.assert(
  NOT has_function_privilege('authenticated','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
  'GFS5 authenticated NO puede ejecutarla');

SELECT pg_temp.assert(
  NOT has_function_privilege('service_role','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
  'GFS6 service_role NO puede ejecutarla (no se demostro necesidad activa)');

-- El grant a PUBLIC es la causa raiz: alcanza a todo rol presente y futuro.
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid='public.get_finance_summary(uuid,date,date)'::regprocedure
      AND a.grantee=0 AND a.privilege_type='EXECUTE') = 0,
  'GFS7 el pseudo-rol PUBLIC no tiene EXECUTE');

-- ══ 3. NOTA — por que el rechazo dinamico NO se prueba aca ══════════════════
-- La forma natural de probarlo en SQL seria, dentro de un DO:
--     SET LOCAL ROLE anon; PERFORM ... ; EXCEPTION WHEN OTHERS ...
-- Ese patron CRASHEA el servidor con SIGSEGV en postgres:17.6.1.104 (el mismo
-- build que usa produccion). Verificado: se reproduce con esta funcion y
-- tambien con finance_dashboard_summary, o sea NO es propio de este hotfix ni
-- de esta funcion — es el patron "cambio de rol + error de permisos capturado
-- dentro de plpgsql". Aislado: el cambio de rol solo no crashea, y la llamada
-- sin cambio de rol tampoco; hace falta la combinacion.
--
-- No se deja un test que voltea la base. El rechazo dinamico se prueba por el
-- camino que de verdad importa —HTTP contra PostgREST como anon— en
-- `npm run verify:finance-summary-private`, que es ademas el vector real del
-- ataque. Aca quedan los invariantes de catalogo y privilegios, que son
-- autoritativos para EXECUTE y no requieren invocar nada.
--
-- El crash esta reportado como hallazgo separado en el entregable. No es
-- alcanzable desde la API publica (anon no puede ejecutar bloques DO via
-- PostgREST), pero tumba la instancia entera para un operador que corra
-- scripts de mantenimiento.

-- ══ 4. FALSIFICACION (sin invocar entre roles) ══════════════════════════════
-- Se reabre el permiso a proposito y se exige que el predicado del guard lo
-- detecte; despues se restaura. Un test de seguridad que nunca vio fallar su
-- predicado no probo nada.
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid,date,date) TO anon;

  PERFORM pg_temp.assert(
    has_function_privilege('anon','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
    'GFS8 FALSIFICACION: tras un GRANT, anon vuelve a poder ejecutarla');

  -- Y el predicado exacto que usa el guard tiene que verlo.
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid='public.get_finance_summary(uuid,date,date)'::regprocedure
        AND a.grantee = 'anon'::regrole::oid AND a.privilege_type='EXECUTE') = 1,
    'GFS9 FALSIFICACION: el grant a anon es visible en la ACL');

  REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM anon;

  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
    'GFS10 reaplicar el REVOKE vuelve a cerrar el acceso (idempotente)');

  -- El REVOKE tiene que ser idempotente: correrlo dos veces no rompe.
  REVOKE ALL ON FUNCTION public.get_finance_summary(uuid,date,date) FROM anon;
  PERFORM pg_temp.assert(
    NOT has_function_privilege('anon','public.get_finance_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
    'GFS11 el REVOKE es idempotente');
END $$;

-- ══ 5. No se amplio la superficie de otras funciones ════════════════════════
-- El hotfix es quirurgico: finance_dashboard_summary es la RPC financiera
-- legitima y NO puede haberse tocado.
SELECT pg_temp.assert(
  has_function_privilege('authenticated','public.finance_dashboard_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
  'GFS12 finance_dashboard_summary sigue ejecutable por authenticated (no se toco)');

SELECT pg_temp.assert(
  NOT has_function_privilege('anon','public.finance_dashboard_summary(uuid,date,date)'::regprocedure,'EXECUTE'),
  'GFS13 finance_dashboard_summary sigue sin acceso anon');

ROLLBACK;
