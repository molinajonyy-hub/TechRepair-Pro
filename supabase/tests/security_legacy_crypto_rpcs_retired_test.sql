-- ============================================================================
-- HOTFIX cripto — encrypt_data/decrypt_data retiradas y neutralizadas.
--
-- Invariantes de catálogo/privilegios (autoritativos para EXECUTE), el stub
-- fail-closed, y falsificaciones que reabren superficie y exigen detección.
--
-- El rechazo DINÁMICO por HTTP (anon → denegado) se prueba fuera de acá con
-- `npm run verify:legacy-crypto-private`. NO se usa el patrón
-- `DO + SET LOCAL ROLE + llamada sin permiso + EXCEPTION` (SIGSEGV en
-- postgres:17.6.1.104). La invocación del stub se hace como OWNER (privilegiado),
-- que no dispara el crash y sí prueba el fail-closed.
--
-- RUN: psql -X -f  (una tx + ROLLBACK; no deja nada).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- ══ 1. Ambas existen con su firma, owner y SECDEF intactos ══════════════════
SELECT pg_temp.assert(to_regprocedure('public.encrypt_data(text)') IS NOT NULL, 'LC1 encrypt_data existe');
SELECT pg_temp.assert(to_regprocedure('public.decrypt_data(text)') IS NOT NULL, 'LC2 decrypt_data existe');
SELECT pg_temp.assert((SELECT bool_and(prosecdef) FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC3 ambas siguen SECURITY DEFINER');
SELECT pg_temp.assert((SELECT bool_and(pg_get_userbyid(proowner)='postgres') FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC4 owner sigue postgres');
SELECT pg_temp.assert((SELECT bool_and(EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')) FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC5 search_path fijo (no mutable)');

-- ══ 2. Ningún rol de cliente puede ejecutarlas (herencia resuelta) ══════════
SELECT pg_temp.assert(NOT has_function_privilege('anon','public.encrypt_data(text)'::regprocedure,'EXECUTE') AND NOT has_function_privilege('anon','public.decrypt_data(text)'::regprocedure,'EXECUTE'), 'LC6 anon no ejecuta ninguna');
SELECT pg_temp.assert(NOT has_function_privilege('authenticated','public.encrypt_data(text)'::regprocedure,'EXECUTE') AND NOT has_function_privilege('authenticated','public.decrypt_data(text)'::regprocedure,'EXECUTE'), 'LC7 authenticated no ejecuta ninguna');
SELECT pg_temp.assert(NOT has_function_privilege('service_role','public.encrypt_data(text)'::regprocedure,'EXECUTE') AND NOT has_function_privilege('service_role','public.decrypt_data(text)'::regprocedure,'EXECUTE'), 'LC8 service_role no ejecuta ninguna');
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure) AND a.grantee=0 AND a.privilege_type='EXECUTE')=0, 'LC9 PUBLIC no tiene EXECUTE en ninguna');

-- ══ 3. Cuerpos neutralizados: stub, sin pgp_sym, sin clave, no retornan arg ═══
SELECT pg_temp.assert((SELECT bool_and(prosrc ILIKE '%LEGACY_CRYPTO_RPC_RETIRED%') FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC10 ambas son stub fail-closed');
SELECT pg_temp.assert((SELECT bool_and(prosrc !~* 'pgp_sym') FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC11 sin pgp_sym en el cuerpo');
SELECT pg_temp.assert((SELECT bool_and(prosrc !~* 'return\s+(encrypted_data|data_to_encrypt)\b') FROM pg_proc WHERE oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure)), 'LC12 no retornan el argumento');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_proc p, regexp_matches(p.prosrc,'''([^'']+)''','g') m WHERE p.oid IN ('public.encrypt_data(text)'::regprocedure,'public.decrypt_data(text)'::regprocedure) AND left(encode(sha256(convert_to(m[1],'UTF8')),'hex'),16)='1062de99c033e5b7'), 'LC13 la clave legacy (por fingerprint) no está en ningún cuerpo');

-- ══ 4. El stub falla cerrado al invocarlo como OWNER (no SIGSEGV) ════════════
DO $$
DECLARE v_out text;
BEGIN
  BEGIN
    SELECT public.encrypt_data('sintetico') INTO v_out;
    PERFORM pg_temp.assert(false, 'LC14 encrypt_data debía fallar cerrado y no retornó');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert(SQLERRM ILIKE '%LEGACY_CRYPTO_RPC_RETIRED%', 'LC14 encrypt_data(owner) → LEGACY_CRYPTO_RPC_RETIRED');
  END;
  BEGIN
    SELECT public.decrypt_data('sintetico') INTO v_out;
    PERFORM pg_temp.assert(false, 'LC15 decrypt_data debía fallar cerrado y no retornó');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert(SQLERRM ILIKE '%LEGACY_CRYPTO_RPC_RETIRED%', 'LC15 decrypt_data(owner) → LEGACY_CRYPTO_RPC_RETIRED');
  END;
END $$;

-- ══ 5. FALSIFICACIÓN: un GRANT reabre y debe ser detectable; el REVOKE cierra ═
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.decrypt_data(text) TO anon;
  PERFORM pg_temp.assert(has_function_privilege('anon','public.decrypt_data(text)'::regprocedure,'EXECUTE'), 'LC16 FALSIFICACION: tras GRANT, anon vuelve a poder');
  REVOKE ALL PRIVILEGES ON FUNCTION public.decrypt_data(text) FROM anon;
  PERFORM pg_temp.assert(NOT has_function_privilege('anon','public.decrypt_data(text)'::regprocedure,'EXECUTE'), 'LC17 el REVOKE vuelve a cerrar');
END $$;

ROLLBACK;
