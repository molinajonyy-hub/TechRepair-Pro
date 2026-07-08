-- ============================================================================
-- M6 (Fase 7) — Pagos proveedor: BLOQUEO explícito de DELETE/UPDATE directo
--
-- DECISIÓN: bloqueo (no reverso). Auditoría: NO existe UI activa para
-- eliminar/editar/revertir un pago proveedor individual. Los pagos se crean por
-- RPC atómica (create_supplier_purchase_atomic / pay_supplier_purchase_atomic) y
-- por el flujo "pago libre" (insert client-side legítimo). El borrado de compra
-- pasa por delete_supplier_purchase_safe (bloquea compras con pagos: blocked_paid).
--
-- Riesgo a cerrar: las policies eran `[ALL] to authenticated`, habilitando
-- DELETE/UPDATE DIRECTO de supplier_payments y supplier_account_movements (dejaría
-- ledger/FM asimétricos). Se reemplazan por SELECT + INSERT (se conserva el
-- create client-side legítimo); DELETE/UPDATE quedan denegados por defecto.
--
-- El reverso de pago proveedor queda como OPERACIÓN FUTURA CONTROLADA
-- (reverse_supplier_payment_atomic), append-only, cuando exista una UI que lo
-- requiera. No se inventa UI nueva acá. Fortalece RLS (no la debilita).
-- ============================================================================

-- ── supplier_payments: [ALL] → SELECT + INSERT (bloquea DELETE/UPDATE) ──
DROP POLICY IF EXISTS "rls_supplier_payments" ON "public"."supplier_payments";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_payments' AND policyname='supplier_payments_select') THEN
    CREATE POLICY "supplier_payments_select" ON "public"."supplier_payments"
      FOR SELECT TO "authenticated" USING ((business_id = current_business_id()) AND is_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_payments' AND policyname='supplier_payments_insert') THEN
    CREATE POLICY "supplier_payments_insert" ON "public"."supplier_payments"
      FOR INSERT TO "authenticated" WITH CHECK ((business_id = current_business_id()) AND is_staff());
  END IF;
END $$;

-- ── supplier_account_movements: [ALL] → SELECT + INSERT (bloquea DELETE/UPDATE) ──
DROP POLICY IF EXISTS "rls_supplier_account_movements" ON "public"."supplier_account_movements";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_account_movements' AND policyname='supplier_account_movements_select') THEN
    CREATE POLICY "supplier_account_movements_select" ON "public"."supplier_account_movements"
      FOR SELECT TO "authenticated" USING ((business_id = current_business_id()) AND is_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_account_movements' AND policyname='supplier_account_movements_insert') THEN
    CREATE POLICY "supplier_account_movements_insert" ON "public"."supplier_account_movements"
      FOR INSERT TO "authenticated" WITH CHECK ((business_id = current_business_id()) AND is_staff());
  END IF;
END $$;

-- ROLLBACK: DROP las 4 policies nuevas y recrear
--   rls_supplier_payments / rls_supplier_account_movements FOR ALL to authenticated
--   USING/CHECK ((business_id = current_business_id()) AND is_staff()).
