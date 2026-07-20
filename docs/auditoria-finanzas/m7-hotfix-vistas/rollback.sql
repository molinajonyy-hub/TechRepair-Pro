-- ============================================================================
-- ROLLBACK del hotfix 20260720120000 (vistas canonicas / security_invoker).
--
-- NO SE APLICA EN EL DESPLIEGUE. Existe para que exista: una migracion de
-- seguridad sin vuelta atras escrita y revisada es una apuesta, no un plan.
--
-- ⚠ REABRE UN LEAK CROSS-TENANT PROBADO.
-- Ejecutar esto devuelve las tres vistas al modo "privilegios del owner", con
-- lo cual cualquier usuario autenticado vuelve a poder leer ventas, COGS y
-- margenes de TODOS los negocios pasando otro business_id. Solo tiene sentido
-- si el fix rompiera algo peor, y como paso intermedio hacia otra solucion.
--
-- ── Cuando NO hace falta este archivo ───────────────────────────────────────
-- El fix no cambia datos, ni definiciones, ni columnas, ni grants: solo el modo
-- de evaluacion. Si el problema fuera que a un rol legitimo le falta acceso a
-- una tabla base, la respuesta correcta NO es revertir — es arreglar la
-- politica RLS o el grant de esa tabla. Revertir tapa el sintoma reabriendo el
-- agujero.
--
-- ── Alternativa preferible al rollback ──────────────────────────────────────
-- Si hiciera falta que un consumidor vea datos que su RLS no le deja ver, la
-- via segura es una RPC SECURITY DEFINER minima: search_path fijo, auth
-- obligatoria y filtro business_id interno verificado server-side — como ya
-- hace finance_dashboard_summary. Nunca ampliar el SELECT sobre tablas base.
-- ============================================================================

BEGIN;

ALTER VIEW public.v_finance_sales_ledger   SET (security_invoker = false);
ALTER VIEW public.v_finance_pnl            SET (security_invoker = false);
ALTER VIEW public.v_finance_product_margin SET (security_invoker = false);

-- Deja constancia de que se reabrio a proposito.
DO $$
BEGIN
  RAISE WARNING
    'ROLLBACK aplicado: las 3 vistas canonicas volvieron a correr con privilegios '
    'del owner. El aislamiento cross-tenant esta REABIERTO. El check '
    'canonical_views_without_security_invoker del health check debe estar en fail.';
END $$;

COMMIT;

-- Verificacion post-rollback (debe devolver 3):
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='public'
--      AND c.relname IN ('v_finance_pnl','v_finance_sales_ledger','v_finance_product_margin')
--      AND NOT COALESCE(c.reloptions::text[] @> ARRAY['security_invoker=true'], false);
