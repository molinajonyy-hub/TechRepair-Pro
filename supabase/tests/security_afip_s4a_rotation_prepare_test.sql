-- ============================================================================
-- AFIP-S4A / S4A.1 — tests del contrato de preparación de rotación (LOCAL, txn).
-- Fixtures SINTÉTICOS embebidos (RSA 1024, node-forge). NUNCA material productivo.
-- Todo dentro de BEGIN…ROLLBACK. Foco S4A.1: idempotencia end-to-end (respuesta
-- perdida con clave regenerada), request_hash semántico, validación CSR↔pedido.
-- RUN: docker exec -i <db> psql -X -U postgres -d postgres -f este.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000054a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4a-owner@test.local', '', now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES ('00000000-0000-4000-8000-0000000054a1', 'S4A-test', '00000000-0000-4000-8000-0000000054a2', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;
INSERT INTO public.arca_config (business_id, cuit, ambiente, punto_venta, web_service, alias,
        cert_file, private_key, wsaa_token, wsaa_sign, estado_conexion)
VALUES ('00000000-0000-4000-8000-0000000054a1', '20111111112', 'homologacion', 1, 'wsfe', 'r',
        '-----BEGIN CERTIFICATE-----\nDUMMYCERT\n-----END CERTIFICATE-----',
        '-----BEGIN RSA PRIVATE KEY-----\nDUMMYLEGACYKEY\n-----END RSA PRIVATE KEY-----',
        'DUMMYTOKEN', 'DUMMYSIGN', 'conectado') ON CONFLICT (business_id) DO NOTHING;
SELECT private.arca_store_private_key_secret('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86', NULL, 'RSA', 1024, '00000000-0000-4000-8000-0000000054a2', false) AS s \gset

CREATE TEMP TABLE s4a_pre AS
SELECT (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS active_cnt,
       (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS active_fp,
       (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')||private_key) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054a1') AS cfg;

CREATE TEMP TABLE s4a_results (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(l text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO s4a_results(label, ok) VALUES (l, coalesce(ok,false)); END $f$;

DO $t$
DECLARE r jsonb; v_pend uuid; v_sec uuid;
BEGIN
  -- 1) Preparación OK (clave A, subject S_A)
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('1 prepared', r->>'state' = 'ROTATION_PREPARED');
  PERFORM pg_temp.chk('1 returns csr A', (r->>'csr_pem') = $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$);
  PERFORM pg_temp.chk('1 sin clave en retorno', (r::text) !~ 'PRIVATE KEY');
  SELECT id, private_key_secret_id INTO v_pend, v_sec FROM private.arca_credential_rotations
    WHERE business_id='00000000-0000-4000-8000-0000000054a1' AND state='pending_rotation';
  PERFORM pg_temp.chk('1 pending + secret', v_pend IS NOT NULL AND EXISTS(SELECT 1 FROM vault.secrets WHERE id=v_sec));

  -- 2) Replay EXACTO (misma clave, mismo pedido, misma idem) → ALREADY_PREPARED
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('2 replay exacto', r->>'state' = 'ROTATION_ALREADY_PREPARED');

  -- 3) RESPUESTA PERDIDA: retry con OTRA clave (A2) pero MISMO subject + MISMA idem.
  --    Debe devolver ROTATION_ALREADY_PREPARED con CSR A (no A2), fingerprint A,
  --    sin crear otro secreto ni otra rotación. (Sección 4 — test obligatorio)
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDeEgChh1wXXZNq5WfSv5tXX6HBYvawizlAR2rVcCaiMnXrmmdZ
ArYFmOlbpRC2i1a5Ty3EtPq5qdkpZDawCnNj66Efz8/fhxwR05t0qEErjNEBJtwZ
I75ORt62UZyTImQY5rNnhU5+18uVZ0Ocy41dTsgKxdPqfoOZFn0MIUZYjwIDAQAB
AoGBAL/77FO5RCJnIdVecr2+LLwCz0LzHbZPBrXNiEzx4lSDL3L6T7KiJ177bXNv
Zt2J5PXbwAO5OrFcZ4PjQWw7/LiebqXSfU6kTBsrkCoFM6LYtLVSWvYnAvZHCg/Y
LOCCBp+os7Kh8fX8zkAuHd81BPyPLty6dvSLdQZVrUnBQQbhAkEA/6Sr88tQ4BYH
Sap+N7pCuW4U5byAcKJll7xJ6jlQyZogWGR1+X3LQoKPvDANJBGH9EtitSG/r88C
P3MaaLtGNwJBAN5hVj257WBs+vhauIOa3wvnX5ENMg1ab9h+aa7IgxTdOsCp5EOL
16LSNBaIAsS3bFQVIftoMDyTRZ18Z8O31GkCQG/5jx/wNHKS84o+1Z5PRZ63Kwwd
7xxm5Zz66l1f0ZUcn4JYLpyjjv6I9bB2U6syypwk0Q2JxM6bG97y6eRp8y0CQQCC
7hhSu3dxgHi7ZN6iTbrpTU7NHlHL3uVfN/6NM+1JiX+gE+cbhehuKwkUAvxuSfh0
AQVC+nL8F1GziZ2mdEORAkBpJky29l7UqFm/6+mnh18lBpQGQYeN0FTeHcMLGRiL
kWbrmyhQ85Q6iUf0YilVQomyktB+OSWYPINz6Zfs7vNC
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA3hIAoYdcF12TauVn
0r+bV1+hwWL2sIs5QEdq1XAmojJ165pnWQK2BZjpW6UQtotWuU8txLT6uanZKWQ2
sApzY+uhH8/P34ccEdObdKhBK4zRASbcGSO+TkbetlGckyJkGOazZ4VOftfLlWdD
nMuNXU7ICsXT6n6DmRZ9DCFGWI8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAMz2
ds8/zhpvEkLM/jXE48dnDTGDydfae9O/vSzVMX2g+6QzGjBZyrjjDhqFmA14STWb
p3rABqFGNIW8c3FATZOej3G9Ezlg6CDWowXPwG0f142bQc6pQUORIUoKjznIaer3
TFc98g7FnqDgvKlFRLB2K/BvX9NhfCq0jKgkPaAW
-----END CERTIFICATE REQUEST-----$p$, 'f1999074cb11df0ea036dce7e9e1682660e1ba425ab433858829e15db4ec0346',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('3 respuesta perdida → ALREADY_PREPARED', r->>'state' = 'ROTATION_ALREADY_PREPARED');
  PERFORM pg_temp.chk('3 devuelve CSR A (no A2)', (r->>'csr_pem') = $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$);
  PERFORM pg_temp.chk('3 devuelve fingerprint A', (r->>'fingerprint_trunc') = left('3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',16));
  PERFORM pg_temp.chk('3 pending sigue con fingerprint A (clave A2 NO se guardó)',
    (SELECT private_key_fingerprint FROM private.arca_credential_rotations WHERE id=v_pend) = '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86');
  PERFORM pg_temp.chk('3 un solo secreto de rotación',
    (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%') = 1);
  PERFORM pg_temp.chk('3 una sola pending',
    (SELECT count(*) FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054a1' AND state='pending_rotation') = 1);
  PERFORM pg_temp.chk('3 cero huérfanos',
    (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
     = (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation'));

  -- 4) Conflicto SEMÁNTICO: misma idem, subject DISTINTO (B) → IDEMPOTENCY_CONFLICT
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQDZVXh0yMdFo91H+d4Eo2lFxLZX0ZQ8YaxdJVTZm7XbW3o5v3eF
EQL8DlG4UN4Gc/emuhk1ldPewq1eUO6pZE0UYGiV7S8pJyOWFnz8KI+j2GnSJq19
COLAh/VVFNsVeHygiwk1n4LA6tfUCky7gz3B6pSbkfJHQqhAVDxBG1ePkwIDAQAB
AoGAUulifNsj+pNbFdxjMM3OmYlELxiLPsXcZeSaDDJ1HGw3otRCmoc05kfoMTLY
oQmYzwhsGZ9BJtiKH1Ms2X6kUI9+m6fgHz0//sr5BhU/U2gvNqyDBk2XyH65HIw4
a0Zbt7ZoI4LFeeipjFioVnPy5Hw4L67yh3ByPV8oDvbvAOECQQDfHaieYc9H4Yn8
3ZMfa6vhGtVMwUR5XFv7ogjhICCKBLzUvj+n4mHDIrQgTIrRxKVc3a5DtwGg5jIT
25T0QeHrAkEA+V2nJN1fy/mn47m8EpuI+nSzNsEVzXNeEmF55WlA1jt1BneVgUBc
t33dHI4ITpb8Kngz50OfitiVb3FXMsH2+QJAE5CzP6hOF/yUMCNyClhTyzqiJ8fu
7EGII2nTI4LAt7mwoWtJg7xbXFRHvWlY5wo6gglChdefge+NxqYDyuOYHwJABBsF
oHbAmAQhPn+VWB0VcUIwnSsqp7pJhzXxotRLy/sonxWi8YDUxfSdilXQTzLvLefS
uvEDFG8ibrZIAD7vSQJARjdrtYENWlEsele7g4fW5WFqECr+BN0ePYdFH2LwAOYs
xcB5+EtV4qV45/ey49kzG0ECzwD0v6sp6jGlI0LIWg==
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
RG9zMRkwFwYDVQQFExBDVUlUIDIwMjIyMjIyMjIzMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIERvczCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA2VV4dMjHRaPdR/ne
BKNpRcS2V9GUPGGsXSVU2Zu121t6Ob93hREC/A5RuFDeBnP3proZNZXT3sKtXlDu
qWRNFGBole0vKScjlhZ8/CiPo9hp0iatfQjiwIf1VRTbFXh8oIsJNZ+CwOrX1ApM
u4M9weqUm5HyR0KoQFQ8QRtXj5MCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBANhJ
FfnK28oSjOzuq0+ehkSBGp5YMG+roUbO+1Nm+zkp77v6tAHYkTL6r62grWrkvM4M
B9Y3du4fg+sxNl9Ujuw5KCZhQL+5UUgaqovlNMnOd9TsYroN3AHgO/O10Ozi6UXS
4zzq07NAzcEH6F5uVQj7ufUriyiujYYMNgA7gNVE
-----END CERTIFICATE REQUEST-----$p$, 'a4d930b020b52873a25fd5e9cd315fcd82c4f7948f098bfdd5025484fabd1106',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Dos","serialnumber":"CUIT 20222222223","cn":"Taller S4A Dos"}$j$::jsonb, 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('4 conflicto semántico (subject) → IDEMPOTENCY_CONFLICT', r->>'state' = 'IDEMPOTENCY_CONFLICT');

  -- 5) Cross-check declarado↔CSR: key_size declarado MIENTE (4096) → CSR_KEY_MISMATCH
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 4096, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-mix1', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('5 key_size declarado ≠ CSR → CSR_KEY_MISMATCH', r->>'state' = 'CSR_KEY_MISMATCH');

  -- 6) Cross-check: subject declarado ≠ subject del CSR → CSR_KEY_MISMATCH
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Dos","serialnumber":"CUIT 20222222223","cn":"Taller S4A Dos"}$j$::jsonb, 'idem-mix2', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('6 subject declarado ≠ CSR → CSR_KEY_MISMATCH', r->>'state' = 'CSR_KEY_MISMATCH');

  -- 7) CSR mismatch real: clave A + CSR B (fp distinto) → CSR_KEY_MISMATCH
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
RG9zMRkwFwYDVQQFExBDVUlUIDIwMjIyMjIyMjIzMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIERvczCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA2VV4dMjHRaPdR/ne
BKNpRcS2V9GUPGGsXSVU2Zu121t6Ob93hREC/A5RuFDeBnP3proZNZXT3sKtXlDu
qWRNFGBole0vKScjlhZ8/CiPo9hp0iatfQjiwIf1VRTbFXh8oIsJNZ+CwOrX1ApM
u4M9weqUm5HyR0KoQFQ8QRtXj5MCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBANhJ
FfnK28oSjOzuq0+ehkSBGp5YMG+roUbO+1Nm+zkp77v6tAHYkTL6r62grWrkvM4M
B9Y3du4fg+sxNl9Ujuw5KCZhQL+5UUgaqovlNMnOd9TsYroN3AHgO/O10Ozi6UXS
4zzq07NAzcEH6F5uVQj7ufUriyiujYYMNgA7gNVE
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-mix3', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('7 clave A + CSR B → CSR_KEY_MISMATCH', r->>'state' = 'CSR_KEY_MISMATCH');

  -- 8) Pending conflict: otra idem, mismo subject, ya hay pending → PENDING_CONFLICT
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDeEgChh1wXXZNq5WfSv5tXX6HBYvawizlAR2rVcCaiMnXrmmdZ
ArYFmOlbpRC2i1a5Ty3EtPq5qdkpZDawCnNj66Efz8/fhxwR05t0qEErjNEBJtwZ
I75ORt62UZyTImQY5rNnhU5+18uVZ0Ocy41dTsgKxdPqfoOZFn0MIUZYjwIDAQAB
AoGBAL/77FO5RCJnIdVecr2+LLwCz0LzHbZPBrXNiEzx4lSDL3L6T7KiJ177bXNv
Zt2J5PXbwAO5OrFcZ4PjQWw7/LiebqXSfU6kTBsrkCoFM6LYtLVSWvYnAvZHCg/Y
LOCCBp+os7Kh8fX8zkAuHd81BPyPLty6dvSLdQZVrUnBQQbhAkEA/6Sr88tQ4BYH
Sap+N7pCuW4U5byAcKJll7xJ6jlQyZogWGR1+X3LQoKPvDANJBGH9EtitSG/r88C
P3MaaLtGNwJBAN5hVj257WBs+vhauIOa3wvnX5ENMg1ab9h+aa7IgxTdOsCp5EOL
16LSNBaIAsS3bFQVIftoMDyTRZ18Z8O31GkCQG/5jx/wNHKS84o+1Z5PRZ63Kwwd
7xxm5Zz66l1f0ZUcn4JYLpyjjv6I9bB2U6syypwk0Q2JxM6bG97y6eRp8y0CQQCC
7hhSu3dxgHi7ZN6iTbrpTU7NHlHL3uVfN/6NM+1JiX+gE+cbhehuKwkUAvxuSfh0
AQVC+nL8F1GziZ2mdEORAkBpJky29l7UqFm/6+mnh18lBpQGQYeN0FTeHcMLGRiL
kWbrmyhQ85Q6iUf0YilVQomyktB+OSWYPINz6Zfs7vNC
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA3hIAoYdcF12TauVn
0r+bV1+hwWL2sIs5QEdq1XAmojJ165pnWQK2BZjpW6UQtotWuU8txLT6uanZKWQ2
sApzY+uhH8/P34ccEdObdKhBK4zRASbcGSO+TkbetlGckyJkGOazZ4VOftfLlWdD
nMuNXU7ICsXT6n6DmRZ9DCFGWI8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAMz2
ds8/zhpvEkLM/jXE48dnDTGDydfae9O/vSzVMX2g+6QzGjBZyrjjDhqFmA14STWb
p3rABqFGNIW8c3FATZOej3G9Ezlg6CDWowXPwG0f142bQc6pQUORIUoKjznIaer3
TFc98g7FnqDgvKlFRLB2K/BvX9NhfCq0jKgkPaAW
-----END CERTIFICATE REQUEST-----$p$, 'f1999074cb11df0ea036dce7e9e1682660e1ba425ab433858829e15db4ec0346',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-otro', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('8 pending_conflict', r->>'state' = 'ROTATION_PENDING_CONFLICT');

  -- 9) Clave inválida → KEY_GENERATION_FAILED
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'no-es-clave', $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-bad', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('9 key_generation_failed', r->>'state' = 'KEY_GENERATION_FAILED');

  -- 10) Actor no-owner → UNAUTHORIZED
  r := public.arca_prepare_certificate_rotation('00000000-0000-4000-8000-0000000054a1', $p$-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDAXKBUm6lrfvd4fUIa+/qQ8xcE7ly0Wcaz9l1OnJqjTujt2JFq
4DbbFie892u/OkQHsbWV31gPATPAfkvOBxyiYPgGdrVKRtdIdXr0yudrFwhm8c2W
2hWmYrM3UFZ8P3OwsrfJ9a/fjSsQL98yaOe8in+qxRxpMtIeF1MjwuodVQIDAQAB
AoGAFCig1L0LYCyKGqJlzxYhCBexjd688FmILUvgM2DOA9c9Kc/MTXr5xLPpri/v
pragcn35HZ+uRsRFfCLAJvMv2NXSBPT77l2PO176EqAcu+TCAPxTHPsIJ2YBDXBM
hMmY4bXoxrV+kmuGw7l5dHOqUPTD+9I+8L7Ck0nmO0PV1wECQQDNYKOJMjUJTpZV
od8GL0dj+yh7ZVm/VJ6Mv8JeYV9L6W5Y1bteuYa9V6atRbDAEZw83a8WaeTfBmAi
FYmrfQFlAkEA78ayIrTn2/b+OxQ3iDWt22Lo8WijJ/s8r1FoqzZgkAetAC7RrGJy
FIP4onZllmTwLdcKNfmGWe8mm0c/9bBlMQJBAK1kI21XKBO9d4rAaOxtyhYNG3Zi
cMzqAhnOY6kPCEeswm7Zs6EbfTgp4hxzs+/UblWsy39e082/MjZUfLB9j0kCQQCM
CMxSjrr28VprIJSKHWeLQEnxa34WRJmdfnsVuy1MEN+Nwso71kbwCl80atdLrWnE
K9nPygoYDh7LAyKsl7eRAkAGhF1yId9yjkfBiRJyN9I6x5JKgk7pAuPqpKzX1kRp
9FxGyrS4pOtxxxNrjlj1kZPYxoRAklnC0Fl7EKL6oCMY
-----END RSA PRIVATE KEY-----$p$, $p$-----BEGIN CERTIFICATE REQUEST-----
MIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg
VW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg
UzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwFygVJupa373eH1C
Gvv6kPMXBO5ctFnGs/ZdTpyao07o7diRauA22xYnvPdrvzpEB7G1ld9YDwEzwH5L
zgccomD4Bna1SkbXSHV69MrnaxcIZvHNltoVpmKzN1BWfD9zsLK3yfWv340rEC/f
MmjnvIp/qsUcaTLSHhdTI8LqHVUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHlX
VzGaYqL8DmXlA4eOLpn5rERRaVRFfQ9Tb/Qx3NkX+ThV7+mEFgfULgTSLM2iKSTz
SMsTZzqI417we/ppza9OeLokxkE3sCxCUMSqYst5gD1cbHUQPonX69DNoDA3HjKj
hNoQPywfmT5DLwgsqzqVIgsRA8hZk2PecdniJcBq
-----END CERTIFICATE REQUEST-----$p$, '3f115c3c74f4560e209817f48169b17d63afd0be7fc39363210bc48881b0fa86',
        'RSA', 1024, 65537, $j${"c":"AR","o":"Taller S4A Uno","serialnumber":"CUIT 20111111112","cn":"Taller S4A Uno"}$j$::jsonb, 'idem-unauth', '00000000-0000-4000-8000-00000000dead');
  PERFORM pg_temp.chk('10 unauthorized', r->>'state' = 'UNAUTHORIZED');

  -- 11) Cancelación pending + replay idempotente
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('11 cancel', r->>'state' = 'ROTATION_CANCELLED');
  PERFORM pg_temp.chk('11 secreto removido', NOT EXISTS(SELECT 1 FROM vault.secrets WHERE id=v_sec));
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-A', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('11 cancel replay idempotente', r->>'state' = 'ROTATION_CANCELLED');
  r := public.arca_cancel_certificate_rotation('00000000-0000-4000-8000-0000000054a1', 'idem-nope', '00000000-0000-4000-8000-0000000054a2');
  PERFORM pg_temp.chk('11 no_pending_rotation', r->>'state' = 'NO_PENDING_ROTATION');
END $t$;

SELECT pg_temp.chk('12 active credential intacta',
  (SELECT active_cnt FROM s4a_pre) = (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1')
  AND (SELECT active_fp FROM s4a_pre) = (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
SELECT pg_temp.chk('13 arca_config intacto (cert/token/sign/private_key)',
  (SELECT cfg FROM s4a_pre) = (SELECT md5(cert_file||coalesce(wsaa_token,'')||coalesce(wsaa_sign,'')||private_key) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054a1'));
SELECT pg_temp.chk('14 cero secretos de rotación huérfanos',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%')
   = (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation'));
SELECT pg_temp.chk('14 secreto active intacto (patrón separado)',
  (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key:%') = 1);
SELECT pg_temp.chk('15 auditoría fingerprint truncado (<=16, hex o vacío)',
  (SELECT bool_and(fingerprint_trunc IS NULL OR (length(fingerprint_trunc) <= 16 AND fingerprint_trunc ~ '^[0-9a-f]*$'))
     FROM private.arca_credential_audit WHERE event LIKE 'arca_certificate_rotation%'));
SELECT pg_temp.chk('15 evento replayed registrado (respuesta perdida)',
  (SELECT count(*) FROM private.arca_credential_audit WHERE event='arca_certificate_rotation_replayed') >= 1);
SELECT pg_temp.chk('16 prepare service_role-only',
  has_function_privilege('service_role','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.arca_prepare_certificate_rotation(uuid,text,text,text,text,integer,bigint,jsonb,text,uuid)','EXECUTE'));

\echo '── AFIP-S4A/S4A.1 resultados ──'
SELECT n, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) AS r, label FROM s4a_results ORDER BY n;
DO $v$
DECLARE f int;
BEGIN
  SELECT count(*) INTO f FROM s4a_results WHERE NOT ok;
  IF f > 0 THEN RAISE EXCEPTION 'AFIP-S4A: % assert(s) fallaron', f;
  ELSE RAISE NOTICE 'AFIP-S4A: % asserts OK', (SELECT count(*) FROM s4a_results); END IF;
END $v$;
ROLLBACK;
