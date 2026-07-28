-- ============================================================================
-- Pre-launch Stability P0 — v_finance_position devolvia 403 / SQLSTATE 42501.
--
-- SINTOMA (produccion, sesion owner real):
--   GET /rest/v1/v_finance_position?select=receivables,payables&business_id=eq.<uuid>
--   -> HTTP 403
--      {"code":"42501","message":"permission denied for table owner_withdrawals"}
--
-- CAUSA EXACTA:
--   `v_finance_position` es WITH (security_invoker = true). Eso es correcto y se
--   preserva: la vista se ejecuta con los privilegios y las policies del que
--   consulta, no con los del owner. Pero justamente por eso el rol `authenticated`
--   necesita GRANT SELECT sobre CADA tabla base que la vista toca.
--
--   `public.owner_withdrawals` (CTE `owner`, que alimenta owner_withdrawals_total /
--   owner_contributions_total / owner_net_capital) es la UNICA dependencia de la
--   vista que nunca recibio ese grant: quedo con ACL solo para `postgres` desde el
--   baseline remoto 20260628190324. Todas las demas dependencias
--   (comprobantes, comprobante_items, comprobante_payments, supplier_account_movements,
--   businesses, inventory, business_finance_entries, financial_movements,
--   account_movements) ya tenian SELECT para `authenticated`.
--
--   El diagnostico se cerro por descarte, no por suposicion: con la misma sesion
--   authenticated, leer todas las demas dependencias funciona; solo
--   owner_withdrawals levanta 42501.
--
-- POR QUE **NO** ES FALTA DE POLICY:
--   RLS ya esta ENABLE y ya existe una policy permisiva que cubre SELECT:
--     owner_withdrawals_own  cmd=ALL  USING (user_id = auth.uid())
--   El GRANT y la RLS son dos capas distintas: sin GRANT, Postgres corta ANTES de
--   evaluar la policy. Por eso el error es 42501 "permission denied" y no un
--   resultado vacio. Agregar una policy no habria cambiado nada.
--
-- POR QUE ESTA CORRECCION NO AMPLIA LA SUPERFICIE:
--   1. RLS sigue ENABLE y la policy sigue intacta: `authenticated` solo puede ver
--      las filas donde user_id = auth.uid() — sus propios movimientos de capital.
--      No hay lectura cruzada entre negocios ni entre usuarios.
--   2. Se concede SELECT y nada mas. INSERT/UPDATE/DELETE siguen sin grant: las
--      escrituras entran unicamente por las RPC SECURITY DEFINER
--      `create_owner_withdrawal` / `create_owner_contribution` (owner=postgres),
--      que no dependen de los privilegios del invocador.
--   3. PUBLIC y `anon` quedan explicitamente revocados abajo.
--   4. Es exactamente el contrato que el proyecto ya habia asumido: la vista
--      hermana `v_owner_flows` (tambien security_invoker) ya expone estas mismas
--      columnas a `authenticated` desde 20260704120000 — y por este mismo faltante
--      estaba igual de rota. Este grant la arregla tambien.
--
-- ALTERNATIVAS DESCARTADAS:
--   - Pasar la vista a SECURITY DEFINER: esconderia el problema de permisos y
--     romperia el aislamiento por business_id que hoy da el invoker. Prohibido.
--   - RPC/vista intermedia nueva: no aporta nada aca. El acceso ya queda acotado a
--     las filas propias por la policy vigente; una capa extra seria un helper
--     paralelo redundante frente al modelo canonico ya existente.
--
-- NO MODIFICA DATOS. NO TOCA RLS. NO TOCA POLICIES. NO TOCA LA VISTA.
--
-- Rollback:
--   REVOKE SELECT ON public.owner_withdrawals FROM authenticated;
--   (deja la vista en 403 otra vez — es el estado previo, no un estado sano)
--
-- Tests: supabase/tests/stability_p0_finance_position_grants_test.sql
-- ============================================================================

-- ── La correccion minima ────────────────────────────────────────────────────
GRANT SELECT ON "public"."owner_withdrawals" TO "authenticated";

-- ── Cierre explicito del resto de la superficie ─────────────────────────────
-- Defensivo e idempotente: hoy ninguno de estos tiene privilegios sobre la tabla.
-- Se dejan escritos para que el contrato quede afirmado en la migracion y para
-- que un REVOKE accidental futuro sea visible en el diff.
REVOKE ALL ON "public"."owner_withdrawals" FROM PUBLIC;
REVOKE ALL ON "public"."owner_withdrawals" FROM "anon";

-- Las escrituras NO pasan por el rol del usuario: solo por las RPC SECURITY
-- DEFINER. Reafirmado explicitamente.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."owner_withdrawals" FROM "authenticated";

COMMENT ON TABLE "public"."owner_withdrawals" IS
  'Retiros y aportes de capital del dueno (flow_type: withdrawal|contribution). '
  'SELECT para authenticated acotado por RLS a user_id = auth.uid(); lo necesita '
  'v_finance_position / v_owner_flows (security_invoker). Las escrituras entran '
  'SOLO por create_owner_withdrawal / create_owner_contribution (SECURITY DEFINER).';

-- ── Verificacion in-migration (falla el deploy si el contrato no quedo) ──────
DO $$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.owner_withdrawals', 'SELECT') THEN
    RAISE EXCEPTION 'POST-CHECK: authenticated deberia tener SELECT sobre owner_withdrawals';
  END IF;

  IF has_table_privilege('anon', 'public.owner_withdrawals', 'SELECT') THEN
    RAISE EXCEPTION 'POST-CHECK: anon NO deberia tener SELECT sobre owner_withdrawals';
  END IF;

  IF has_table_privilege('authenticated', 'public.owner_withdrawals', 'INSERT')
     OR has_table_privilege('authenticated', 'public.owner_withdrawals', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.owner_withdrawals', 'DELETE') THEN
    RAISE EXCEPTION 'POST-CHECK: authenticated NO deberia poder escribir owner_withdrawals';
  END IF;

  -- La RLS es la que acota las filas: sin ella, el grant SI ampliaria la superficie.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.owner_withdrawals'::regclass) THEN
    RAISE EXCEPTION 'POST-CHECK: RLS debe seguir ENABLE en owner_withdrawals';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='owner_withdrawals'
      AND cmd IN ('ALL','SELECT')
  ) THEN
    RAISE EXCEPTION 'POST-CHECK: falta la policy que acota SELECT en owner_withdrawals';
  END IF;

  -- La vista NO puede haber perdido security_invoker.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid='public.v_finance_position'::regclass
      AND 'security_invoker=true' = ANY(reloptions)
  ) THEN
    RAISE EXCEPTION 'POST-CHECK: v_finance_position debe seguir con security_invoker=true';
  END IF;
END $$;
