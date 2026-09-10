-- ============================================================================
-- P0-ARCA-B — recuperación de claims pre-envío (candidata 20260926120000).
-- Aplica la migración candidata DENTRO de la tx del test y termina en ROLLBACK.
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

-- ── S1: claim ajeno pre-envío, viejo (>10 min) → se recupera ────────────────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '11 minutes') AS s1 \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'acquired' AND ((:'r'::jsonb)->>'recovered_stale_serie_claim')::boolean
  AND (:'r'::jsonb)->>'recovered_attempt_id' = :'s1', 'S1 claim ajeno sin número ni envío, >10 min -> recuperado, C2 adquiere');
SELECT pg_temp.assert(pg_temp.st(:'s1') = 'abandoned', 'S1b el intento viejo queda abandoned');
SELECT pg_temp.assert((SELECT error_mensaje LIKE 'stale pre-send claim recovered by comprobante %' AND completed_at IS NOT NULL
  FROM arca_emission_attempts WHERE id = :'s1'), 'S1c la recuperación queda trazada');
SELECT pg_temp.assert(pg_temp.live() = 1, 'S1d un solo intento vivo en la serie');
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress', 'S1e C2 otra vez -> already_in_progress (idempotente)');
SELECT pg_temp.claim_as(:'OWN', :'C3') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada', 'S1f C3 mientras C2 está vivo y fresco -> serie_ocupada');

-- ── S2..S6: estados que NUNCA se recuperan desde otro comprobante ───────────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '3 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.st(:'s') = 'claimed', 'S2 claim ajeno fresco (3 min) -> serie_ocupada, intacto');

SELECT pg_temp.seed(:'C1', 'number_reserved', 5, false, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.st(:'s') = 'number_reserved', 'S3 number_reserved viejo -> nunca se libera');

SELECT pg_temp.seed(:'C1', 'sent', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.st(:'s') = 'sent', 'S4 sent viejo -> nunca se libera');

SELECT pg_temp.seed(:'C1', 'pending_reconciliation', 5, true, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.st(:'s') = 'pending_reconciliation', 'S5 pending_reconciliation -> se retiene para conciliar');

SELECT pg_temp.seed(:'C1', 'claimed', 5, false, '1 day') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'serie_ocupada' AND pg_temp.st(:'s') = 'claimed', 'S6 claimed CON número (defensivo) -> nunca se libera');

-- ── S7/S8: mismo comprobante, comportamiento previo preservado ──────────────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '3 minutes') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'acquired' AND ((:'r'::jsonb)->>'recovered_abandoned_attempt')::boolean
  AND pg_temp.st(:'s') = 'abandoned' AND pg_temp.live() = 1, 'S7 mismo comprobante, claim propio >2 min -> recuperación existente intacta');

SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '30 seconds') AS s \gset
SELECT pg_temp.claim_as(:'OWN', :'C1') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'already_in_progress' AND pg_temp.st(:'s') = 'claimed', 'S8 mismo comprobante, claim propio fresco -> already_in_progress');

-- ── S9: release_arca_presend_claim sólo actúa sobre el estado pre-envío ──────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(((:'r'::jsonb)->>'released')::boolean AND pg_temp.st(:'s') = 'abandoned'
  AND (SELECT error_mensaje = 'pre-send claim released: test' FROM arca_emission_attempts WHERE id = :'s'), 'S9 claimed sin número ni envío -> liberado y trazado');
SELECT pg_temp.seed(:'C1', 'number_reserved', 5, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.st(:'s') = 'number_reserved', 'S9b number_reserved -> no se libera');
SELECT pg_temp.seed(:'C1', 'sent', 5, true, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.st(:'s') = 'sent', 'S9c sent -> no se libera');
SELECT pg_temp.seed(:'C1', 'pending_reconciliation', 5, true, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'released')::boolean AND pg_temp.st(:'s') = 'pending_reconciliation', 'S9d pending_reconciliation -> no se libera');

-- ── S10: una invocación rezagada no puede avanzar un claim liberado ─────────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '0 seconds') AS s \gset
SELECT pg_temp.svc('release', :'s') AS r \gset
SELECT pg_temp.svc('reserve', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'success')::boolean, 'S10 reserva sobre un claim liberado -> rechazada');
SELECT pg_temp.svc('mark_sent', :'s') AS r \gset
SELECT pg_temp.assert(NOT ((:'r'::jsonb)->>'success')::boolean AND pg_temp.st(:'s') = 'abandoned'
  AND (SELECT numero_intentado IS NULL FROM arca_emission_attempts WHERE id = :'s'), 'S10b marca de envío rechazada, sin número');

-- ── S11: permisos ───────────────────────────────────────────────────────────
SELECT pg_temp.assert(NOT has_function_privilege('authenticated', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.release_arca_presend_claim(uuid,text)', 'EXECUTE'), 'S11 release: sólo service_role');
SELECT pg_temp.assert(has_function_privilege('authenticated', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.claim_comprobante_arca_emission(uuid,text)', 'EXECUTE'), 'S11b claim: grants sin cambio');

-- ── S12: un no miembro no ve ni recupera nada ───────────────────────────────
SELECT pg_temp.seed(:'C1', 'claimed', NULL, false, '11 minutes') AS s \gset
SELECT pg_temp.claim_as('00000000-0000-0000-0000-0000009b0999', :'C2') AS r \gset
SELECT pg_temp.assert((:'r'::jsonb)->>'result' = 'not_found' AND pg_temp.st(:'s') = 'claimed', 'S12 no miembro -> not_found, el claim viejo queda intacto');

ROLLBACK;
