-- ============================================================================
-- P0-CC · CC-E — El cliente deja de escribir el ledger de cuenta corriente.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- QUÉ CIERRA
-- ─────────────────────────────────────────────────────────────────────────────
-- `20260702140000_ledger_protection.sql` revocó UPDATE y DELETE sobre
-- `account_movements`, pero dejó el INSERT abierto para `authenticated`. Ese
-- hueco es el que permitió el defecto que originó este lote: la pantalla de
-- `/cuentas` bajaba la deuda de un cliente con un INSERT directo, sin crear el
-- movimiento de caja ni el asiento financiero.
--
-- CC-B sacó ese INSERT del frontend y CC-D le dio RPC propia a lo último que
-- quedaba escribiendo a mano (deuda manual y ajustes). Con eso, revocar el
-- INSERT ya no rompe ningún camino de producto: lo convierte en imposible.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ VA ÚLTIMA
-- ─────────────────────────────────────────────────────────────────────────────
-- Es FAIL-CLOSED: si quedara un escritor sin migrar, dejaría de funcionar. Por
-- eso se aplica sólo después de A/B/C/D, y sólo tras verificar en TODO el repo
-- que no queda ninguno. Verificación hecha sobre `src/`:
--
--   useEntityTimeline.ts:79      -> SELECT
--   cuentasService.ts:135        -> SELECT (getMovements)
--   cuentasService.ts:247        -> SELECT (getCobrosReversibles)
--
-- Cero INSERT desde el cliente. `addMovement`, `registerSale` y
-- `registerPurchase` fueron eliminadas en CC-D.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- QUÉ SIGUE ESCRIBIENDO
-- ─────────────────────────────────────────────────────────────────────────────
-- Todas las RPC del ledger son SECURITY DEFINER owned by `postgres`, así que no
-- pasan por los grants del rol y NO se ven afectadas:
--
--   create_comprobante_checkout_atomic        venta a cuenta corriente
--   record_customer_account_payment_atomic    cobro
--   record_customer_account_adjustment_atomic deuda manual / ajuste
--   reverse_customer_account_payment_atomic   reversa del cobro
--   annul_comprobante_atomic                  anulación
--   replace_comprobante_payment               reemplazo de pagos
--   (+ el ledger de devengado de M7 6F.4)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LA LECTURA NO SE TOCA
-- ─────────────────────────────────────────────────────────────────────────────
-- Se revoca INSERT, no SELECT. El extracto de la cuenta y el timeline siguen
-- funcionando; su acceso ya lo gobierna la capacidad `finance` desde CC-C.
--
-- No se toca `supplier_account_movements`: es otro libro, con sus propias RPC,
-- y no entra en el alcance de este lote.
-- ============================================================================

BEGIN;

-- ── 1. Fin del INSERT directo ───────────────────────────────────────────────
REVOKE INSERT ON "public"."account_movements" FROM "authenticated";
REVOKE INSERT ON "public"."account_movements" FROM "anon";
-- El GRANT de tabla puede haber llegado por PUBLIC en algún baseline viejo.
REVOKE INSERT ON "public"."account_movements" FROM PUBLIC;

-- La policy de INSERT se retira: sin GRANT no se alcanza, y dejarla sugeriría
-- que existe un camino de escritura para el cliente. Que no exista es el punto.
DROP POLICY IF EXISTS "account_movements_insert" ON "public"."account_movements";

-- `authenticated` conserva EXACTAMENTE lo que necesita: leer.
-- (SELECT sigue gobernado por `account_movements_select`, que exige
--  tenant + capacidad `finance` + feature `currentAccounts` desde CC-C.)

-- ── 2. Postcondiciones ──────────────────────────────────────────────────────
DO $post$
DECLARE v_n int;
BEGIN
  -- 2.1 Ni INSERT, ni UPDATE, ni DELETE para el cliente.
  IF has_table_privilege('authenticated', 'public.account_movements', 'INSERT') THEN
    RAISE EXCEPTION 'CC-E: authenticated conserva INSERT sobre el ledger'; END IF;
  IF has_table_privilege('authenticated', 'public.account_movements', 'UPDATE') THEN
    RAISE EXCEPTION 'CC-E: authenticated conserva UPDATE sobre el ledger'; END IF;
  IF has_table_privilege('authenticated', 'public.account_movements', 'DELETE') THEN
    RAISE EXCEPTION 'CC-E: authenticated conserva DELETE sobre el ledger'; END IF;
  IF has_table_privilege('anon', 'public.account_movements', 'INSERT') THEN
    RAISE EXCEPTION 'CC-E: anon conserva INSERT sobre el ledger'; END IF;

  -- 2.2 …pero la LECTURA sigue viva: revocar de más rompería el extracto.
  IF NOT has_table_privilege('authenticated', 'public.account_movements', 'SELECT') THEN
    RAISE EXCEPTION 'CC-E: se revocó de más — el cliente ya no puede leer el extracto'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='account_movements'
                    AND cmd='SELECT' AND COALESCE(qual,'') LIKE '%current_user_can%') THEN
    RAISE EXCEPTION 'CC-E: falta la policy de lectura con capacidad'; END IF;

  -- 2.3 No debe quedar NINGUNA policy de escritura sobre el ledger.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='account_movements'
     AND cmd IN ('INSERT','UPDATE','DELETE','ALL');
  IF v_n > 0 THEN RAISE EXCEPTION 'CC-E: quedaron % policies de escritura en el ledger', v_n; END IF;

  -- 2.4 Las RPC que SÍ escriben siguen siendo SECDEF de postgres. Si alguna
  --     dejara de serlo, este revoke la rompería en silencio.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('create_comprobante_checkout_atomic',
                       'record_customer_account_payment_atomic',
                       'record_customer_account_adjustment_atomic',
                       'reverse_customer_account_payment_atomic',
                       'annul_comprobante_atomic')
     AND p.prosecdef
     AND p.proowner = 'postgres'::regrole;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'CC-E: sólo % de 5 RPC del ledger son SECDEF/postgres — el revoke las rompería', v_n; END IF;

  RAISE NOTICE 'CC-E OK: el ledger de cuenta corriente ya no se escribe desde el cliente.';
END $post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado):
--   GRANT INSERT ON public.account_movements TO authenticated;
--   CREATE POLICY "account_movements_insert" ON public.account_movements
--     FOR INSERT WITH CHECK (current_business_id() = business_id
--       AND current_user_can('finance') AND business_has_feature('currentAccounts'));
--
--   Reabrir esto devuelve la posibilidad de bajar una deuda sin tocar la caja.
--   Si hace falta un camino de escritura nuevo, la respuesta es una RPC, no
--   este GRANT.
-- ============================================================================
