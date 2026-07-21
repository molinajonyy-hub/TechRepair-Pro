-- ============================================================================
-- HOTFIX P0 — Retirar `register_order_payment` de la API pública.
--
-- NO TOCA NI UN DATO. No cambia el cuerpo, ni el owner, ni SECURITY DEFINER, ni
-- financial_movements, ni RLS. Solo revoca EXECUTE.
--
-- ── El defecto ──────────────────────────────────────────────────────────────
-- public.register_order_payment(uuid, uuid, numeric) es SECURITY DEFINER,
-- propiedad de `postgres`, y NO valida identidad: no llama a auth.uid() ni a
-- ningún helper de membresía. Recibe p_business_id y p_amount_paid del llamador
-- e INSERTA en financial_movements. Al correr con privilegios del owner, saltea
-- el RLS de financial_movements.
--
-- ACL previa: {=X/postgres, postgres=X/postgres} → el pseudo-rol PUBLIC tiene
-- EXECUTE, así que anon/authenticated/service_role lo heredan. Un atacante NO
-- autenticado puede inyectar movimientos financieros (income/expense) con monto
-- y negocio arbitrarios en el ledger de CUALQUIER negocio.
--
-- ── Por qué REVOKE y no un auth check ──────────────────────────────────────
-- Cero consumidores: sin llamadas desde la base (barrido de prosrc y triggers),
-- sin frontend, sin Edge Functions, sin cron, sin scripts. El propio mapa de
-- superficie de escritura de M6 (docs/auditoria-finanzas/m6/write-surface-map.md)
-- la documenta como "existe, no usado por UI"; la app usa
-- create_order_payment_atomic, que sí valida. Es código muerto.
-- Meterle un auth.uid() sería endurecer código muerto y dejarlo publicado.
--
-- ── Por qué NO se hace DROP ─────────────────────────────────────────────────
-- Un DROP es irreversible y no aporta seguridad por encima del REVOKE: sin
-- EXECUTE la función es inalcanzable vía PostgREST. Se deja el objeto para que
-- el cambio sea trivialmente reversible y auditable.
--
-- ── service_role ────────────────────────────────────────────────────────────
-- También se revoca: tenía EXECUTE sólo por herencia de PUBLIC y no hay
-- consumidor server-side. La función se retira por completo de la API.
-- ============================================================================

REVOKE ALL ON FUNCTION public.register_order_payment(uuid, uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_order_payment(uuid, uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.register_order_payment(uuid, uuid, numeric) FROM authenticated;
REVOKE ALL ON FUNCTION public.register_order_payment(uuid, uuid, numeric) FROM service_role;

COMMENT ON FUNCTION public.register_order_payment(uuid, uuid, numeric) IS
  'RETIRADA DE LA API PÚBLICA (hotfix P0 20260720140000). RPC financiera legacy '
  'SECURITY DEFINER sin autorización: insertaba en financial_movements con '
  'business_id y monto del llamador, salteando RLS, y era ejecutable por PUBLIC/'
  'anon. Sin consumidores (código muerto). No volver a otorgar EXECUTE a PUBLIC/'
  'anon/authenticated: si alguna vez se necesita, reescribirla con auth.uid(), '
  'validación de membresía, idempotencia y contrato financiero correcto.';

-- ── Post-condición dura ─────────────────────────────────────────────────────
-- Falla (y la migración NO se marca aplicada) si la función no existe con la
-- firma exacta, o si algún rol de cliente conserva EXECUTE. Se usa
-- has_function_privilege, que resuelve la herencia desde PUBLIC.
DO $$
DECLARE
  v_oid   oid;
  v_malos text[] := '{}';
  v_rol   text;
BEGIN
  v_oid := to_regprocedure('public.register_order_payment(uuid,uuid,numeric)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'HOTFIX abortado: public.register_order_payment(uuid,uuid,numeric) no existe con la firma esperada.';
  END IF;

  FOREACH v_rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(v_rol, v_oid, 'EXECUTE') THEN
      v_malos := v_malos || v_rol;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    v_malos := v_malos || 'PUBLIC';
  END IF;

  IF array_length(v_malos, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'HOTFIX incompleto: todavía pueden ejecutar register_order_payment → %',
      array_to_string(v_malos, ', ');
  END IF;

  RAISE NOTICE 'HOTFIX: register_order_payment fuera de la API pública (PUBLIC/anon/authenticated/service_role sin EXECUTE).';
END $$;
