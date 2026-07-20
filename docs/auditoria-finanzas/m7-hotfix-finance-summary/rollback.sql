-- ============================================================================
-- ROLLBACK del hotfix 20260719130000 (get_finance_summary fuera de la API).
--
-- NO SE APLICA EN EL DESPLIEGUE. Existe para que exista.
--
-- ⚠ REABRE UNA FUGA FINANCIERA SIN AUTENTICACION.
-- Restaurar estos grants vuelve a permitir que cualquiera con la publishable
-- key —que viaja en el bundle del frontend— lea el resumen financiero de
-- CUALQUIER negocio pasando su UUID, sin autenticarse. Reproducido por HTTP.
--
-- ── Por que casi con seguridad NO lo vas a necesitar ────────────────────────
-- El hotfix no cambia datos, ni el cuerpo de la funcion, ni tablas, ni RLS:
-- solo quita EXECUTE. No se encontro ningun consumidor —ni en la base, ni en
-- src/, ni en supabase/functions/, ni en scripts/— asi que no hay nada que
-- pueda romperse por revocarlo.
--
-- ── Si apareciera un consumidor legitimo ────────────────────────────────────
-- La respuesta correcta NO es restaurar el grant. Es reescribir la funcion con
-- validacion de identidad server-side, como ya hace finance_dashboard_summary:
--
--     IF NOT EXISTS (SELECT 1 FROM businesses WHERE id=p_business_id AND owner_user_id=auth.uid())
--        AND NOT EXISTS (SELECT 1 FROM profiles WHERE business_id=p_business_id AND user_id=auth.uid())
--     THEN RETURN ... 'Sin acceso al negocio'; END IF;
--
-- Restaurar el grant tal cual reabre el agujero para todos los negocios, no
-- solo para el consumidor que lo necesitaba.
-- ============================================================================

BEGIN;

-- Estado previo exacto, tomado de la ACL antes del hotfix:
--   {=X/postgres, postgres=X/postgres, authenticated=X/postgres}
-- O sea: EXECUTE para PUBLIC (de donde anon y service_role lo heredaban) y un
-- grant propio para authenticated.
GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid, date, date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_finance_summary(uuid, date, date) TO authenticated;

COMMENT ON FUNCTION public.get_finance_summary(uuid, date, date) IS NULL;

DO $$
BEGIN
  RAISE WARNING
    'ROLLBACK aplicado: get_finance_summary vuelve a ser ejecutable por PUBLIC. '
    'La fuga financiera SIN AUTENTICACION esta REABIERTA. Verificar con: '
    'npm run verify:finance-summary-private (debe dar FUGA ABIERTA).';
END $$;

COMMIT;

-- Verificacion post-rollback (debe devolver true):
--   SELECT has_function_privilege('anon','public.get_finance_summary(uuid,date,date)','EXECUTE');
