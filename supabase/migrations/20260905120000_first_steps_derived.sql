-- ============================================================================
-- P0 FIRST-STEPS-1 — "Primeros pasos" derivado del estado real del tenant.
--
-- CONTEXTO
-- --------
-- El checklist de onboarding usaba `localStorage` como fuente de completitud y
-- permitia marcar tareas a mano. Eso es una afirmacion del navegador, no del
-- negocio: se perdia al cambiar de dispositivo, mentia si el usuario tildaba
-- sin hacer nada, y no sobrevivia a un logout.
--
-- Esta migracion crea la UNICA lectura canonica del progreso, derivada
-- server-side de los registros que ya existen. No se crea ninguna tabla de
-- "completed steps": los hechos historicos alcanzan.
--
-- CONTRATO
-- --------
--   public.get_my_first_steps() -> (has_customer, has_order, has_inventory,
--                                   has_cobro, has_logo) : boolean
--
-- Sin parametros. El tenant se deriva server-side de `auth.uid()`. Es
-- imposible pedir el progreso de otro negocio: no hay firma que lo permita.
--
-- No devuelve business_id, conteos, montos, PII ni detalle financiero.
--
-- POR QUE SECURITY DEFINER (necesidad demostrada, no comodidad)
-- ------------------------------------------------------------
-- La preferencia del lote era SECURITY INVOKER. Se descarto tras medir las
-- policies reales de las tablas fuente:
--
--   account_movements : current_business_id() = business_id
--                       AND current_user_can('finance')
--                       AND business_has_feature('currentAccounts')   <-- plan
--   comprobante_payments : ... AND current_user_can('comprobantes')
--   orders / order_payments / inventory : ... AND is_staff()
--
-- Bajo INVOKER el progreso de onboarding dejaria de ser una propiedad del
-- TENANT y pasaria a depender de (a) el rol del que mira y (b) el PLAN
-- contratado. Un cajero sin capacidad `comprobantes` veria "Hacer tu primer
-- cobro" pendiente para siempre, y un tenant cuyo plan no incluye
-- `currentAccounts` no podria nunca ver su propia cobranza de cuenta
-- corriente. Peor: la tarea volveria a pendiente al cambiar de plan.
--
-- El progreso de aprendizaje no es informacion privilegiada ni financiera —
-- son cinco booleanos sobre hechos del propio negocio del que pregunta — asi
-- que DEFINER acotado a esos cinco EXISTS es el minimo privilegio correcto.
-- El aislamiento por tenant se mantiene intacto: lo impone la funcion, no la
-- RLS que se saltea.
--
-- MIGRACION RETENIDA: no aplicar antes de 20260903120000 (MOBILE-2A) y
-- 20260904120000 (ONBOARDING-1).
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- get_my_first_steps()
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_first_steps()
RETURNS TABLE (
  has_customer  boolean,
  has_order     boolean,
  has_inventory boolean,
  has_cobro     boolean,
  has_logo      boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH biz AS (
    SELECT public.current_user_business_id() AS id
  )
  SELECT
    -- ── 1. Primer cliente ────────────────────────────────────────────────
    -- `customers.active` es NOT NULL. Un cliente dado de baja no demuestra
    -- que el usuario sepa dar de alta un cliente HOY, y la fila sigue siendo
    -- editable: se exige el estado canonico visible.
    EXISTS (
      SELECT 1 FROM public.customers c, biz
      WHERE c.business_id = biz.id
        AND c.active
    ) AS has_customer,

    -- ── 2. Primera orden ─────────────────────────────────────────────────
    -- Sin filtro de `status`: una orden entregada o cancelada demuestra
    -- igual que el usuario aprendio a crear una orden. La tarea mide
    -- aprendizaje, no trabajo en curso.
    EXISTS (
      SELECT 1 FROM public.orders o, biz
      WHERE o.business_id = biz.id
    ) AS has_order,

    -- ── 3. Primer producto ───────────────────────────────────────────────
    -- Unidad VENDIBLE, no fila cualquiera:
    --   * `is_active` distinto de false  -> excluye bajas logicas.
    --   * `has_variants` distinto de true -> excluye el padre estructural,
    --     que no se vende: lo vendible son sus hijos (`parent_id` seteado,
    --     `has_variants` = false), que si cuentan.
    -- `productService.createProductWithVariants` marca el padre SOLO despues
    -- de crear los hijos, asi que un padre marcado siempre implica hijos.
    -- Medido contra produccion: los 7 tenants con inventario tienen >= 1
    -- fila vendible bajo esta regla; ninguno pierde el paso.
    EXISTS (
      SELECT 1 FROM public.inventory i, biz
      WHERE i.business_id = biz.id
        AND COALESCE(i.is_active, true)   IS TRUE
        AND COALESCE(i.has_variants, false) IS FALSE
    ) AS has_inventory,

    -- ── 4. Primer cobro ──────────────────────────────────────────────────
    -- Definicion: EXISTENCIA HISTORICA de un cobro canonico que realmente
    -- ocurrio. Deliberadamente NO se filtra por `replaced_at` ni por
    -- `reversed_at`: si el usuario cobro ayer y hoy anulo, aprendio a cobrar
    -- igual. La tarea no puede volver a pendiente por una reversa.
    --
    -- Esto es seguro porque las tres fuentes son append-only para el tenant:
    -- ninguna tiene policy de UPDATE ni de DELETE para `authenticated`, y
    -- ninguna funcion del esquema ejecuta DELETE FROM sobre ellas. Las
    -- reversas se asientan como filas NUEVAS
    -- (`order_payment_reversals`, `account_payment_reversals`,
    -- `comprobante_payment_replace_requests`).
    --
    -- NO cuentan, por decision explicita:
    --   * payments / subscription_payments  -> es el SaaS cobrandole al
    --     comerciante, no el comerciante cobrandole a su cliente.
    --   * la existencia de una orden        -> no es un cobro.
    --   * orders.amount_paid                -> campo manual, no un asiento.
    --   * financial_movements               -> incluye egresos y aperturas
    --     de caja; un gasto no es un cobro.
    --   * account_movements.debit           -> es un cargo al cliente
    --     (venta/ajuste), lo contrario de una cobranza.
    (
      EXISTS (
        SELECT 1 FROM public.comprobante_payments cp, biz
        WHERE cp.business_id = biz.id
      )
      OR EXISTS (
        SELECT 1 FROM public.order_payments op, biz
        WHERE op.business_id = biz.id
      )
      OR EXISTS (
        -- `credit > 0` es la cobranza de cuenta corriente (type='pago').
        -- `debit > 0` es venta/ajuste: cargo, no cobro.
        SELECT 1 FROM public.account_movements am, biz
        WHERE am.business_id = biz.id
          AND am.credit > 0
      )
    ) AS has_cobro,

    -- ── 5. Logo ──────────────────────────────────────────────────────────
    -- Doble fuente a proposito, para no acoplarse a ONBOARDING-1: durante la
    -- transicion el logo puede vivir en `businesses.logo_url` (writer viejo)
    -- o en `business_settings.logo_url` (writer canonico nuevo). No se exige
    -- que coincidan — normalizarlas es trabajo de ONBOARDING-1. Aca solo se
    -- lee; este lote NO duplica el writer canonico.
    -- `NULLIF(btrim(...), '')` evita que un string vacio cuente como logo.
    (
      EXISTS (
        SELECT 1 FROM public.businesses b, biz
        WHERE b.id = biz.id
          AND NULLIF(btrim(b.logo_url), '') IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.business_settings s, biz
        WHERE s.business_id = biz.id
          AND NULLIF(btrim(s.logo_url), '') IS NOT NULL
      )
    ) AS has_logo;
$function$;

COMMENT ON FUNCTION public.get_my_first_steps() IS
  'P0 FIRST-STEPS-1: progreso de "Primeros pasos" derivado del estado real del '
  'tenant. Cinco booleanos, un round-trip, sin parametros: el negocio se deriva '
  'de auth.uid() server-side. El cobro es un hecho historico y NO vuelve a '
  'pendiente ante una reversa.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants — authenticated y nadie mas.
--
-- El EXECUTE a PUBLIC es el DEFAULT de PostgreSQL: si no se revoca
-- explicitamente, `anon` puede invocar la RPC (y con SECURITY DEFINER eso es
-- justamente lo que no queremos). Se revoca antes de otorgar.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_my_first_steps() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_first_steps() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_first_steps() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondiciones. Corren dentro del BEGIN/COMMIT explicito de arriba: las
-- migraciones de Supabase se aplican en AUTOCOMMIT, asi que sin transaccion
-- propia un RAISE aca no revertiria el DDL ya aplicado.
-- ─────────────────────────────────────────────────────────────────────────────
DO $postcond$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_my_first_steps';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FIRST-STEPS-1: get_my_first_steps() no existe';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FIRST-STEPS-1: anon conserva EXECUTE sobre get_my_first_steps()';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FIRST-STEPS-1: authenticated NO tiene EXECUTE';
  END IF;

  -- `aclexplode(NULL)` da falso negativo cuando el acl quedo por defecto:
  -- se consulta el privilegio, no el acl.
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FIRST-STEPS-1: PUBLIC conserva EXECUTE sobre get_my_first_steps()';
  END IF;
END
$postcond$;

COMMIT;
