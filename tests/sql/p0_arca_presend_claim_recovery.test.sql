-- ============================================================================
-- P0-ARCA-B — recuperación de claims pre-envío (candidata 20260926120000).
-- Aplica la migración candidata DENTRO de la tx del test y termina en ROLLBACK.
-- Concurrencia real (dos sesiones): scripts/security/p0-arca-b-concurrency.mjs.
--
-- RUN (desde la raíz del repo, stack local techrepair-vite):
--   docker cp supabase/migrations/20260926120000_p0_arca_presend_claim_recovery.sql supabase_db_techrepair-vite:/tmp/p0b_raw.sql
--   docker exec supabase_db_techrepair-vite sh -c "sed -E '/^(BEGIN|COMMIT);[[:space:]]*$/d' /tmp/p0b_raw.sql > /tmp/p0b_mig.sql"
--   docker cp tests/sql/p0_arca_presend_claim_recovery.test.sql supabase_db_techrepair-vite:/tmp/p0b_test.sql
--   docker exec supabase_db_techrepair-vite psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -v migration=/tmp/p0b_mig.sql -f /tmp/p0b_test.sql
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
\i :migration

CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz  '00000000-0000-0000-0000-0000009b0101'
\set OWN  '00000000-0000-0000-0000-0000009b0109'
\set C1   '00000000-0000-0000-0000-0000009b0c01'
\set C2   '00000000-0000-0000-0000-0000009b0c02'
\set C3   '00000000-0000-0000-0000-0000009b0c03'

SET LOCAL session_replication_role = 'replica';
INSERT INTO auth.users(id) VALUES (:'OWN');
INSERT INTO businesses(id, name, owner_user_id) VALUES (:'biz', 'P0 ARCA B', :'OWN');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES (:'biz', :'OWN', 'owner', true);
INSERT INTO arca_config(business_id, cuit, cuit_emisor, punto_venta, ambiente)
  VALUES (:'biz', '20111111112', '20111111112', 910, 'homologacion');
INSERT INTO comprobantes(id, business_id, tipo, subtotal, impuestos, total, estado_fiscal) VALUES
  (:'C1', :'biz', 'factura_c', 100, 0, 100, 'pendiente_emision'),
  (:'C2', :'biz', 'factura_c', 100, 0, 100, 'pendiente_emision'),
  (:'C3', :'biz', 'factura_c', 100, 0, 100, 'pendiente_emision');
SET LOCAL session_replication_role = 'origin';

-- Deja un único intento para la serie del negocio de prueba y devuelve su id.
CREATE OR REPLACE FUNCTION pg_temp.seed(p_comp uuid, p_status text, p_numero int, p_sent boolean, p_age interval)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid;
BEGIN
  DELETE FROM public.arca_emission_attempts WHERE business_id = '00000000-0000-0000-0000-0000009b0101';
  INSERT INTO public.arca_emission_attempts (comprobante_id, business_id, correlation_id, ambiente, cuit_emisor,
      punto_venta, tipo_comprobante, status, numero_intentado, sent_at, started_at, updated_at)
    VALUES (p_comp, '00000000-0000-0000-0000-0000009b0101', 'seed', 'homologacion', '20111111112', 910, 11,
      p_status, p_numero, CASE WHEN p_sent THEN now() - p_age END, now() - p_age, now() - p_age)
    RETURNING id INTO v;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.claim_as(p_user uuid, p_comp uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.claim_comprobante_arca_emission(p_comp, 'p0b-test');
  RESET ROLE;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.svc(p_op text, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  IF p_op = 'release' THEN r := public.release_arca_presend_claim(p_id, 'test');
  ELSIF p_op = 'reserve' THEN r := public.reserve_arca_number(p_id, 5);
  ELSIF p_op = 'mark_sent' THEN r := public.mark_arca_attempt_sent(p_id);
  END IF;
  RESET ROLE;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS
  $$ SELECT status FROM public.arca_emission_attempts WHERE id = p_id $$;
CREATE OR REPLACE FUNCTION pg_temp.live() RETURNS bigint LANGUAGE sql AS
  $$ SELECT count(*) FROM public.arca_emission_attempts
     WHERE business_id = '00000000-0000-0000-0000-0000009b0101'
       AND status IN ('claimed','number_reserved','sent','pending_reconciliation') $$;
-- Una fila sigue exactamente como se sembró (status, número, sent_at, sin completar).
CREATE OR REPLACE FUNCTION pg_temp.untouched(p_id uuid, p_status text, p_numero int, p_sent boolean) RETURNS boolean LANGUAGE sql AS
  $$ SELECT status = p_status AND numero_intentado IS NOT DISTINCT FROM p_numero
            AND (sent_at IS NOT NULL) = p_sent AND completed_at IS NULL
     FROM public.arca_emission_attempts WHERE id = p_id $$;

SELECT pg_temp.assert(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.claim_comprobante_arca_emission(uuid,text)'::regprocedure)
    = ARRAY['search_path=pg_catalog, pg_temp'], 'M0 claim: search_path endurecido');

-- ═══════════════ SAME-COMPROBANTE SAFETY ═══════════════════════════════════
-- SC-A: claimed, sin número, sin sent_at, < 10 min → already_in_progress, intacto
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '3 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'claimed', NULL, false),
  'SC-A mismo comprobante, pre-envío, 3 min -> already_in_progress, intacto');
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '9 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'claimed', NULL, false),
  'SC-A2 9 min (antes se abandonaba a los 2) -> already_in_progress, intacto');

-- SC-B: claimed, sin número, sin sent_at, > 10 min → abandonado y recuperado
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '11 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'acquired' AND ((:'r'::jsonb)->>'recovered_abandoned_attempt')::boolean
  AND pg_temp.st(:'s') = 'abandoned' AND pg_temp.live() = 1, 'SC-B mismo comprobante, pre-envío, 11 min -> recuperado, un vivo');
SELECT pg_temp.assert((SELECT error_mensaje = 'stale pre-send claim recovered by the same comprobante' AND completed_at IS NOT NULL
  FROM arca_emission_attempts WHERE id = :'s'), 'SC-B2 la recuperación queda trazada');

-- SC-C: claimed CON número, sin sent_at, > 10 min → NUNCA
SELECT pg_temp.seed(:'C1', 'claimed', 5, false, '11 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'claimed', 5, false),
  'SC-C mismo comprobante, claimed con número -> nunca abandonado');

-- SC-D: claimed sin número, CON sent_at, > 10 min → NUNCA
SELECT pg_temp.seed(:'C1', 'claimed', NULL, true, '11 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'claimed', NULL, true),
  'SC-D mismo comprobante, claimed con sent_at -> nunca abandonado');

-- SC-E: claimed con número Y sent_at (p. ej. pending retomado), > 10 min → NUNCA
SELECT pg_temp.seed(:'C1', 'claimed', 5, true, '11 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'claimed', 5, true),
  'SC-E mismo comprobante, claimed con número y sent_at -> nunca abandonado');

-- SC-F: number_reserved / sent propios, viejos → already_in_progress, intactos
SELECT pg_temp.seed(:'C1', 'number_reserved', 5, false, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'number_reserved', 5, false),
  'SC-F1 mismo comprobante, number_reserved -> intacto');
SELECT pg_temp.seed(:'C1', 'sent', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.untouched(:'s', 'sent', 5, true),
  'SC-F2 mismo comprobante, sent -> intacto');

-- SC-G: pending_reconciliation propio → se retoma para conciliar (comportamiento previo)
SELECT pg_temp.seed(:'C1', 'pending_reconciliation', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'acquired' AND ((:'r'::jsonb)->>'reconciliation_pending')::boolean
  AND (:'r'::jsonb)->>'attempt_id' = :'s' AND pg_temp.st(:'s') = 'claimed'
  AND (SELECT numero_intentado = 5 AND sent_at IS NOT NULL FROM arca_emission_attempts WHERE id = :'s'),
  'SC-G pending_reconciliation propio -> retomado con su número (sin cambio)');

-- ═══════════════ CROSS-COMPROBANTE SAFETY ══════════════════════════════════
-- X1: claim ajeno pre-envío, > 10 min → recuperado
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '11 minutes') AS s1 \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'acquired' AND ((:'r'::jsonb)->>'recovered_stale_serie_claim')::boolean
  AND (:'r'::jsonb)->>'recovered_attempt_id' = :'s1', 'X1 claim ajeno pre-envío >10 min -> recuperado, C2 adquiere');
SELECT pg_temp.assert(pg_temp.st(:'s1') = 'abandoned'
  AND (SELECT error_mensaje LIKE 'stale pre-send claim recovered by comprobante %' AND completed_at IS NOT NULL
       FROM arca_emission_attempts WHERE id = :'s1'), 'X1b abandonado con traza');
SELECT pg_temp.assert(pg_temp.live() = 1, 'X1c un solo intento vivo en la serie');
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress', 'X1d C2 otra vez -> already_in_progress (idempotente)');
SELECT pg_temp.claim_as(:'OWN', :'C3') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.live() = 1, 'X1e C3 mientras C2 vive -> serie_ocupada, un vivo');

-- X2..X8: estados ajenos que NUNCA se recuperan
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '3 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'claimed', NULL, false), 'X2 ajeno fresco (3 min) -> intacto');
SELECT pg_temp.seed(:'C1', 'number_reserved', 5, false, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'number_reserved', 5, false), 'X3 ajeno number_reserved -> intacto');
SELECT pg_temp.seed(:'C1', 'sent', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'sent', 5, true), 'X4 ajeno sent -> intacto');
SELECT pg_temp.seed(:'C1', 'pending_reconciliation', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'pending_reconciliation', 5, true), 'X5 ajeno pending_reconciliation -> retenido');
SELECT pg_temp.seed(:'C1', 'claimed', 5, false, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'claimed', 5, false), 'X6 ajeno claimed con número -> intacto');
SELECT pg_temp.seed(:'C1', 'claimed', NULL, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'claimed', NULL, true), 'X7 ajeno claimed con sent_at -> intacto');
SELECT pg_temp.seed(:'C1', 'claimed', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.untouched(:'s', 'claimed', 5, true), 'X8 ajeno claimed con número y sent_at -> intacto');

-- ═══════════════ RELEASE RPC (afip-cae) ════════════════════════════════════
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(((:'r'::jsonb)->>'released')::boolean AND pg_temp.st(:'s') = 'abandoned'
  AND (SELECT error_mensaje = 'pre-send claim released: test' FROM arca_emission_attempts WHERE id = :'s'), 'R1 claimed pre-envío -> liberado y trazado');
SELECT pg_temp.seed(:'C1', 'claimed', 5, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.untouched(:'s', 'claimed', 5, false), 'R2 claimed con número -> no se libera');
SELECT pg_temp.seed(:'C1', 'claimed', NULL, true, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.untouched(:'s', 'claimed', NULL, true), 'R3 claimed con sent_at -> no se libera');
SELECT pg_temp.seed(:'C1', 'number_reserved', 5, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.untouched(:'s', 'number_reserved', 5, false), 'R4 number_reserved -> no se libera');
SELECT pg_temp.seed(:'C1', 'sent', 5, true, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.untouched(:'s', 'sent', 5, true), 'R5 sent -> no se libera');
SELECT pg_temp.seed(:'C1', 'pending_reconciliation', 5, true, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.untouched(:'s', 'pending_reconciliation', 5, true), 'R6 pending_reconciliation -> no se libera');

-- Z: una invocación rezagada no puede avanzar un claim liberado
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.svc('reserve', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'success')::boolean, 'Z1 reserva sobre un claim liberado -> rechazada');
SELECT pg_temp.svc('mark_sent', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'success')::boolean AND pg_temp.st(:'s') = 'abandoned'
  AND (SELECT numero_intentado IS NULL FROM arca_emission_attempts WHERE id = :'s'), 'Z2 marca de envío rechazada, sin número');

-- P: permisos
SELECT pg_temp.assert(NOT has_function_privilege('authenticated', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE'), 'P1 release: sólo service_role');
SELECT pg_temp.assert(has_function_privilege('authenticated', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE'), 'P2 claim: grants sin cambio');
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '11 minutes') AS s \gset
SELECT pg_temp.claim_as('00000000-0000-0000-0000-0000009b0999', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'not_found' AND pg_temp.untouched(:'s', 'claimed', NULL, false), 'P3 no miembro -> not_found, nada recuperado');

ROLLBACK;
