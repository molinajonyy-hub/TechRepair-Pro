-- SEC-08D - VISIBILIDAD DE LOS INSIGHTS FINANCIEROS.
--
-- Cierra la ultima policy de lectura sensible que no exigia autoridad.
--
-- -- El hallazgo -------------------------------------------------------------
-- `finance_insights_select` era, en toda la base, la UNICA policy de lectura
-- financiera sin termino de capability:
--
--     USING (business_id = current_business_id())
--
-- Sus pares ya exigen autoridad desde hace tres lotes:
--   * financial_movements / business_finance_entries / expenses -> `finance`
--   * account_movements  -> `finance` + business_has_feature('currentAccounts')
--   * supplier_*         -> can_view_supplier_finance()   (SEC-08C)
--   * purchases / purchase_items -> can_view_inventory_cost() (SEC-08B)
--
-- -- Por que importa ---------------------------------------------------------
-- La ESCRITURA ya exigia las dos cosas:
--     generate_finance_insights ->
--       private.require_action_authority(biz, 'finance', NULL, 'advancedFinance')
-- La LECTURA no exigia ninguna. Escritura y lectura quedaban asimetricas.
--
-- El contenido no es un titulo decorativo: `impact_ars` y `evidence.dead_value`
-- son una valuacion de inventario A COSTO (evidence.source = "inventory +
-- comprobante_items + inventory_movements"), mas reglas de margen. Es decir,
-- reintroducia POR AGREGADO el costo que SEC-08B habia revocado a nivel columna
-- para todo actor sin `inventory_view_costs`.
--
-- En el frontend `/finance` tiene DOS gates (ProtectedRouteByPermission
-- 'finance' + ProtectedRouteByFeature 'advancedFinance', src/App.tsx). La tabla
-- tenia CERO: un GET /rest/v1/finance_insights los saltea a los dos. El propio
-- App.tsx ya dejo escrita la doctrina: "Ocultar el item del sidebar NO es
-- proteccion: escribir la URL a mano tenia que fallar igual".
--
-- -- Por que ademas cambia el helper del tenant -------------------------------
-- `current_business_id()` es el UNICO helper de negocio SIN filtro `is_active`.
-- Todas las demas policies que lo usan lo acompanan de `is_staff()` o
-- `current_user_can()`, que si filtran por perfil activo. Esta no acompanaba
-- nada, asi que un empleado DESACTIVADO con JWT vivo seguia leyendo.
-- `current_user_business_id()` filtra `is_active` y ademas ordena de forma
-- determinista. Es el helper que ya usan fm_select_finance_capability y
-- bfe_select_finance_capability.
--
-- -- Por que estos tres terminos y no un helper nuevo -------------------------
-- No se inventa ninguna capability ni ninguna funcion: la expresion compone
-- autoridades EXISTENTES, y es la misma forma que ya usa account_movements
-- (tenant + capability + feature de plan).
--
-- `business_has_feature(text)` evalua contra `b.id = current_user_business_id()`.
-- Como el primer termino ya fija `business_id = current_user_business_id()`, el
-- tercero evalua NECESARIAMENTE el plan del mismo negocio que la fila. No hace
-- falta una variante que reciba el business_id.
--
-- `current_user_can_in_business(business_id, 'finance')` -y no `current_user_can`-
-- porque resuelve la capability contra el perfil DE ESE negocio y honra tanto al
-- owner como a los overrides de `profiles.permissions`. Es el helper scopeado que
-- vienen usando SEC-08A/B/C.
--
-- -- Alcance -----------------------------------------------------------------
-- Una sola policy. No se toca el frontend, no se crea ninguna RPC y no se
-- reescribe `finance_insights_read`: esa funcion es INVOKER (no SECURITY
-- DEFINER), asi que lee la tabla bajo RLS y HEREDA este endurecimiento. La
-- postcondicion lo verifica en vez de asumirlo.

BEGIN;

DROP POLICY IF EXISTS finance_insights_select ON public.finance_insights;

CREATE POLICY finance_insights_select
ON public.finance_insights
FOR SELECT
TO authenticated
USING (
  business_id = current_user_business_id()
  AND current_user_can_in_business(business_id, 'finance')
  AND business_has_feature('advancedFinance')
);

COMMENT ON TABLE public.finance_insights IS
  'SEC-08D. Lectura gobernada por la MISMA autoridad que la escritura: tenant '
  '(current_user_business_id, que filtra is_active) + capability `finance` '
  'resuelta en el negocio de la fila + feature de plan `advancedFinance`. '
  'Contiene valuacion de inventario a costo en impact_ars/evidence.dead_value, '
  'asi que un actor sin `finance` no puede leerla ni por PostgREST ni via '
  'finance_insights_read (INVOKER, sujeta a esta RLS).';

-- -- Postcondiciones ---------------------------------------------------------
DO $$
DECLARE
  v_qual text;
  v_n    int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'finance_insights' AND cmd = 'SELECT';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SEC-08D: se esperaba exactamente 1 policy SELECT en finance_insights, hay %', v_n;
  END IF;

  SELECT qual INTO v_qual
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'finance_insights' AND cmd = 'SELECT';

  IF v_qual NOT LIKE '%current_user_business_id()%' THEN
    RAISE EXCEPTION 'SEC-08D: la policy perdio el scope de tenant';
  END IF;
  -- `current_business_id` NO es substring de `current_user_business_id`
  -- (entre medio va `user_`), asi que este chequeo no da falso positivo.
  IF v_qual LIKE '%current_business_id()%' THEN
    RAISE EXCEPTION 'SEC-08D: la policy volvio al helper sin filtro is_active';
  END IF;
  IF v_qual NOT LIKE '%current_user_can_in_business%' OR v_qual NOT LIKE '%''finance''%' THEN
    RAISE EXCEPTION 'SEC-08D: la policy no exige la capability `finance` en el negocio de la fila';
  END IF;
  IF v_qual NOT LIKE '%business_has_feature%' OR v_qual NOT LIKE '%''advancedFinance''%' THEN
    RAISE EXCEPTION 'SEC-08D: la policy no exige el feature de plan `advancedFinance`';
  END IF;

  -- La lectura sigue siendo INVOKER: si alguien la convirtiera en SECDEF,
  -- dejaria de heredar esta policy y el lote quedaria sin efecto.
  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.finance_insights_read(uuid,date,date,text,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'SEC-08D: finance_insights_read paso a SECURITY DEFINER y ya no hereda la RLS';
  END IF;

  -- RLS activa y FORZADA (tambien para el owner de la tabla).
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class WHERE oid = 'public.finance_insights'::regclass) THEN
    RAISE EXCEPTION 'SEC-08D: finance_insights perdio RLS activa/forzada';
  END IF;

  -- La frontera anon no se toca ni se afloja.
  IF has_table_privilege('anon', 'public.finance_insights', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08D: anon recupero SELECT sobre finance_insights';
  END IF;

  -- El actor legitimo conserva el GRANT: sin esto el lote seria un apagon.
  IF NOT has_table_privilege('authenticated', 'public.finance_insights', 'SELECT') THEN
    RAISE EXCEPTION 'SEC-08D: authenticated perdio el GRANT de lectura';
  END IF;

  -- No se invento una capability nueva.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public','private') AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) LIKE '%''finance_insights''%'
  ) THEN
    RAISE EXCEPTION 'SEC-08D: aparecio una capability `finance_insights`; el lote compone las existentes';
  END IF;
END $$;

COMMIT;
