-- PRODUCT-VARIANTS-1: existing product_variants has RLS but no authenticated
-- privileges (verified in the baseline and the local catalog). Enable metadata
-- access without granting legacy stock/cost reads or changing any stock writer.
-- No DML, no repair of existing/legacy families, no production application.
BEGIN;

DO $pre$
BEGIN
  IF to_regprocedure('public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.inventory'::regclass AND tgname='zz_inventory_stock_authority_guard') THEN
    RAISE EXCEPTION 'Variants V2 requires G2-C.3A1 and G2-C.3A3';
  END IF;
  IF EXISTS (SELECT inventory_item_id FROM public.product_variants WHERE inventory_item_id IS NOT NULL GROUP BY inventory_item_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate variant inventory links: audit before applying; no automatic repair';
  END IF;
END $pre$;

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_inventory_item_unique
  ON public.product_variants(inventory_item_id) WHERE inventory_item_id IS NOT NULL;

REVOKE ALL ON public.product_variants FROM anon, authenticated;
GRANT SELECT (id,business_id,product_id,inventory_item_id,name,sku,barcode,attributes,
  sale_price_ars,sale_price_usd,wholesale_price_ars,wholesale_price_usd,cost_currency,
  exchange_rate_used,min_stock,location,active,is_default,sort_order,image_url,created_at,updated_at)
  ON public.product_variants TO authenticated;
GRANT INSERT (business_id,product_id,inventory_item_id,name,sku,barcode,attributes,
  cost_price_ars,cost_price_usd,cost_currency,sale_price_ars,sale_price_usd,
  wholesale_price_ars,wholesale_price_usd,margin_percent,exchange_rate_used,
  min_stock,location,active,is_default,sort_order,image_url)
  ON public.product_variants TO authenticated;
-- Links and tenant are immutable from the API. Cost metadata is compatibility
-- only; authorized reads still come exclusively from inventory_costs.
GRANT UPDATE (name,sku,barcode,attributes,cost_price_ars,cost_price_usd,cost_currency,
  sale_price_ars,sale_price_usd,wholesale_price_ars,wholesale_price_usd,margin_percent,
  exchange_rate_used,min_stock,location,active,is_default,sort_order,image_url,updated_at)
  ON public.product_variants TO authenticated;
GRANT DELETE ON public.product_variants TO authenticated;

DROP POLICY IF EXISTS tenant_isolation_variants ON public.product_variants;
CREATE POLICY variants_v2_read ON public.product_variants FOR SELECT TO authenticated
  USING (business_id=public.current_business_id() AND public.current_user_can('inventory'));
CREATE POLICY variants_v2_insert ON public.product_variants FOR INSERT TO authenticated
  WITH CHECK (business_id=public.current_business_id() AND public.current_user_can('inventory'));
CREATE POLICY variants_v2_update ON public.product_variants FOR UPDATE TO authenticated
  USING (business_id=public.current_business_id() AND public.current_user_can('inventory'))
  WITH CHECK (business_id=public.current_business_id() AND public.current_user_can('inventory'));
CREATE POLICY variants_v2_rollback ON public.product_variants FOR DELETE TO authenticated
  USING (business_id=public.current_business_id() AND public.can_manage());

CREATE OR REPLACE FUNCTION private.guard_variant_metadata_links()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  -- Preserve the schema's existing tenant purge cascades in canonical context.
  -- API deletion of historical metadata remains forbidden while its tenant exists.
  IF TG_OP<>'INSERT' AND current_user='postgres'
     AND NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.inventory i WHERE i.id=OLD.inventory_item_id AND i.stock_quantity<>0)
       OR EXISTS (SELECT 1 FROM public.inventory_movements m WHERE m.inventory_item_id=OLD.inventory_item_id) THEN
      RAISE EXCEPTION 'Variant with stock/history requires soft deactivation' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  -- Only new/reassigned links are validated; legacy metadata can still be
  -- edited/deactivated without rewriting its historical relationship.
  IF TG_OP='INSERT' OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    IF NEW.inventory_item_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.inventory p JOIN public.inventory c ON c.parent_id=p.id
      WHERE p.id=NEW.product_id AND c.id=NEW.inventory_item_id
        AND p.business_id=NEW.business_id AND c.business_id=NEW.business_id
        AND p.has_variants IS TRUE AND p.parent_id IS NULL AND p.stock_quantity=0
        AND c.has_variants IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'Variant requires a same-tenant grouping parent and linked inventory child' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.stock<>0 AND (TG_OP='INSERT' OR NEW.stock IS DISTINCT FROM OLD.stock) THEN
    RAISE EXCEPTION 'Legacy variant stock must remain zero; use canonical inventory RPC' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_variant_metadata_links() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER variants_v2_metadata_links BEFORE INSERT OR UPDATE OR DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION private.guard_variant_metadata_links();

-- A grouping parent cannot acquire a balance, including through a canonical
-- document/RPC. This validates identity; it does not implement a stock writer.
CREATE OR REPLACE FUNCTION private.guard_variant_grouping_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.business_id IS DISTINCT FROM OLD.business_id)
     AND EXISTS (SELECT 1 FROM public.product_variants v WHERE v.inventory_item_id=OLD.id
       AND (v.product_id IS DISTINCT FROM NEW.parent_id OR v.business_id IS DISTINCT FROM NEW.business_id)) THEN
    RAISE EXCEPTION 'Linked variant inventory cannot be detached or moved to another tenant/family' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.has_variants IS TRUE AND NEW.has_variants IS NOT TRUE THEN
    RAISE EXCEPTION 'Grouping identity is immutable; deactivate the family instead' USING ERRCODE='23514';
  END IF;
  IF NEW.has_variants IS TRUE THEN
    IF (TG_OP='INSERT' OR NEW.has_variants IS DISTINCT FROM OLD.has_variants
        OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity
        OR NEW.stock IS DISTINCT FROM OLD.stock)
       AND (NEW.parent_id IS NOT NULL OR NEW.stock_quantity<>0 OR coalesce(NEW.stock,0)<>0) THEN
      RAISE EXCEPTION 'Grouping parent must be a root with zero stock' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_variant_grouping_parent() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER zzzz_variants_v2_grouping_parent BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION private.guard_variant_grouping_parent();
NOTIFY pgrst, 'reload schema';
COMMIT;
