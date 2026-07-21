-- ============================================================================
-- HOTFIX seguridad — Retirar encrypt_data / decrypt_data de la API pública.
--
-- NO TOCA NI UN DATO. No cambia owner, ni SECURITY DEFINER, ni RLS, ni tablas.
-- Neutraliza los cuerpos (stubs fail-closed) y revoca EXECUTE de los 4 roles.
--
-- ── El defecto ──────────────────────────────────────────────────────────────
-- public.encrypt_data(data_to_encrypt text) y public.decrypt_data(encrypted_data
-- text) son SECURITY DEFINER, propiedad de `postgres`, sin validación de identidad
-- ni de tenant, ejecutables por PUBLIC/anon/authenticated/service_role, y cifran/
-- descifran con una clave simétrica HARDCODEADA y comprometida (versionada en Git
-- desde el baseline 20260628190324). Constituyen un oráculo de cifrado/descifrado.
-- Severidad: decrypt_data P1, encrypt_data P2.
--
-- ── Por qué neutralizar + revocar y no un auth check ────────────────────────
-- Cero consumidores correctos y vivos:
--   · EncryptionService (src/services/encryptionService.ts) es código muerto
--     (no se importa en ningún módulo);
--   · arcaService.uploadCertificate llama con `plain_text` (la firma es
--     `data_to_encrypt`) → PostgREST no resuelve → cae a texto plano;
--   · afip-wsaa (Edge, service_role) llama con `encrypted_text` (la firma es
--     `encrypted_data`) → no resuelve → devuelve el valor tal cual.
-- Ambos consumidores ARCA ya operan por fallback y NO dependen de un éxito.
-- Además no hay ciphertext real producido por estas funciones en la base.
-- Endurecer el cuerpo con auth.uid() sería mantener publicado un oráculo legacy
-- con clave quemada; la decisión es retirarlas por completo.
--
-- ── La clave hardcodeada ────────────────────────────────────────────────────
-- Los stubs de abajo NO contienen la clave legacy ni pgp_sym_*. La clave sólo
-- permanece en la migración baseline ya aplicada (historia inmutable): NO se
-- reescribe historial. Tras este deploy, el cuerpo productivo y cualquier dump
-- nuevo del esquema final quedan sin la clave.
--
-- ── Orden ───────────────────────────────────────────────────────────────────
-- 1) CREATE OR REPLACE con cuerpos neutralizados;
-- 2) REVOKE explícito a los 4 roles (estado final explícito, aunque CREATE OR
--    REPLACE de la misma firma conserva la ACL);
-- 3) COMMENT;
-- 4) post-condiciones duras verificadas contra el catálogo real.
-- ============================================================================

-- ── 1) Stubs fail-closed ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.encrypt_data(data_to_encrypt text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Retirada de la API. No cifra, no descifra, no retorna el argumento.
  RAISE EXCEPTION 'LEGACY_CRYPTO_RPC_RETIRED' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_data(encrypted_data text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Retirada de la API. No cifra, no descifra, no retorna el argumento.
  RAISE EXCEPTION 'LEGACY_CRYPTO_RPC_RETIRED' USING ERRCODE = '42501';
END;
$$;

-- ── 2) REVOKE explícito (estado final) ──────────────────────────────────────
REVOKE ALL PRIVILEGES ON FUNCTION public.encrypt_data(text) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.encrypt_data(text) FROM anon;
REVOKE ALL PRIVILEGES ON FUNCTION public.encrypt_data(text) FROM authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.encrypt_data(text) FROM service_role;

REVOKE ALL PRIVILEGES ON FUNCTION public.decrypt_data(text) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.decrypt_data(text) FROM anon;
REVOKE ALL PRIVILEGES ON FUNCTION public.decrypt_data(text) FROM authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.decrypt_data(text) FROM service_role;

-- ── 3) COMMENT ──────────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.encrypt_data(text) IS
  'RETIRADA DE LA API PÚBLICA (hotfix cripto 20260721120000). Oráculo SECURITY '
  'DEFINER sin authz bajo clave simétrica hardcodeada comprometida. Cuerpo '
  'neutralizado (stub fail-closed: LEGACY_CRYPTO_RPC_RETIRED). No re-otorgar '
  'EXECUTE a PUBLIC/anon/authenticated/service_role y no reintroducir la clave '
  'ni pgp_sym_*. Si se necesita cripto, implementarla fuera de PostgREST '
  '(Edge/Vault) con clave rotable y contrato explícito.';

COMMENT ON FUNCTION public.decrypt_data(text) IS
  'RETIRADA DE LA API PÚBLICA (hotfix cripto 20260721120000). Oráculo SECURITY '
  'DEFINER sin authz bajo clave simétrica hardcodeada comprometida. Cuerpo '
  'neutralizado (stub fail-closed: LEGACY_CRYPTO_RPC_RETIRED). No re-otorgar '
  'EXECUTE a PUBLIC/anon/authenticated/service_role y no reintroducir la clave '
  'ni pgp_sym_*. Si se necesita cripto, implementarla fuera de PostgREST '
  '(Edge/Vault) con clave rotable y contrato explícito.';

-- ── 4) Post-condiciones duras (catálogo real) ───────────────────────────────
-- El fingerprint 1062de99c033e5b7 es un hash truncado irreversible de la clave
-- legacy (no es la clave). Se usa para detectar su reaparición sin transcribirla.
DO $$
DECLARE
  r     record;
  v_oid oid;
  v_bad text[] := '{}';
BEGIN
  FOR r IN SELECT unnest(ARRAY['public.encrypt_data(text)','public.decrypt_data(text)']) AS sig
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'HOTFIX abortado: % no existe con la firma esperada.', r.sig;
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')          THEN v_bad := v_bad || (r.sig||':anon'); END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN v_bad := v_bad || (r.sig||':authenticated'); END IF;
    IF has_function_privilege('service_role', v_oid, 'EXECUTE')  THEN v_bad := v_bad || (r.sig||':service_role'); END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid=v_oid AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_bad := v_bad || (r.sig||':PUBLIC');
    END IF;

    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=v_oid) <> 'postgres' THEN
      v_bad := v_bad || (r.sig||':owner_cambio');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid=v_oid AND p.proconfig IS NOT NULL
                      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) THEN
      v_bad := v_bad || (r.sig||':search_path_mutable');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prosrc ILIKE '%LEGACY_CRYPTO_RPC_RETIRED%') THEN
      v_bad := v_bad || (r.sig||':sin_stub');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prosrc ~* 'pgp_sym_(en|de)crypt') THEN
      v_bad := v_bad || (r.sig||':pgp_sym_presente');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prosrc ~* 'return\s+(encrypted_data|data_to_encrypt)\b') THEN
      v_bad := v_bad || (r.sig||':retorna_argumento');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, regexp_matches(p.prosrc, '''([^'']+)''', 'g') m
                WHERE p.oid=v_oid AND left(encode(sha256(convert_to(m[1],'UTF8')),'hex'),16)='1062de99c033e5b7') THEN
      v_bad := v_bad || (r.sig||':fingerprint_clave_legacy');
    END IF;
  END LOOP;

  IF array_length(v_bad,1) IS NOT NULL THEN
    RAISE EXCEPTION 'HOTFIX incompleto → %', array_to_string(v_bad, ', ');
  END IF;

  RAISE NOTICE 'HOTFIX: encrypt_data/decrypt_data neutralizadas (stubs fail-closed) y fuera de la API pública (PUBLIC/anon/authenticated/service_role sin EXECUTE).';
END $$;
