-- Local PostgreSQL matrix; everything rolls back, including fixtures and RPCs.
BEGIN;
CREATE FUNCTION pg_temp.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION pg_temp.denied(statement text,label text,expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE; END;
  PERFORM pg_temp.assert(actual_state=expected_state,label || ' [' || coalesce(actual_state,'unexpected success') || ']');
END $$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-0000000f1001'),('00000000-0000-0000-0000-0000000f1002');
INSERT INTO businesses(id,name,owner_user_id) VALUES
 ('00000000-0000-0000-0000-0000000f1b01','Variants V2 SQL A','00000000-0000-0000-0000-0000000f1001'),
 ('00000000-0000-0000-0000-0000000f1b02','Variants V2 SQL B','00000000-0000-0000-0000-0000000f1002');
INSERT INTO profiles(id,user_id,business_id,role,is_active) VALUES
 ('00000000-0000-0000-0000-0000000f1001','00000000-0000-0000-0000-0000000f1001','00000000-0000-0000-0000-0000000f1b01','owner',true),
 ('00000000-0000-0000-0000-0000000f1002','00000000-0000-0000-0000-0000000f1002','00000000-0000-0000-0000-0000000f1b02','owner',true);
INSERT INTO inventory(id,business_id,name,code,category,cost_price,sale_price,has_variants,parent_id) VALUES
 ('00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1b01','Family A','PV2-SQL-A','Otros',0,1000,true,NULL),
 ('00000000-0000-0000-0000-0000000f1d02','00000000-0000-0000-0000-0000000f1b01','Family A','PV2-SQL-A-1','Otros',100,1000,false,'00000000-0000-0000-0000-0000000f1d01'),
 ('00000000-0000-0000-0000-0000000f1d03','00000000-0000-0000-0000-0000000f1b01','Family A','PV2-SQL-A-2','Otros',100,1000,false,'00000000-0000-0000-0000-0000000f1d01'),
 ('00000000-0000-0000-0000-0000000f1d04','00000000-0000-0000-0000-0000000f1b02','Family B','PV2-SQL-B','Otros',0,1000,true,NULL),
 ('00000000-0000-0000-0000-0000000f1d05','00000000-0000-0000-0000-0000000f1b02','Family B','PV2-SQL-B-1','Otros',100,1000,false,'00000000-0000-0000-0000-0000000f1d04'),
 ('00000000-0000-0000-0000-0000000f1d06','00000000-0000-0000-0000-0000000f1b01','Simple','PV2-SQL-SIMPLE','Otros',100,1000,false,NULL);
SET LOCAL session_replication_role=origin;
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.product_variants','stock','INSERT'),'no legacy stock write privilege');
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.product_variants','stock','SELECT'),'no legacy stock read privilege');
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.product_variants','cost_price_ars','SELECT'),'no compatibility cost read privilege');
SELECT pg_temp.assert(NOT has_table_privilege('anon','public.product_variants','SELECT'),'anonymous metadata closed');

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000f1001',true);
SET LOCAL ROLE authenticated;
INSERT INTO product_variants(business_id,product_id,inventory_item_id,name,attributes) VALUES
 ('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1d02','Negro','{"Color":"Negro"}'),
 ('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1d03','Azul','{"Color":"Azul"}');
SELECT pg_temp.assert((SELECT count(*)=2 FROM product_variants WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'authorized linked metadata creation');
SELECT pg_temp.denied($q$SELECT cost_price_ars FROM product_variants$q$,'cost selection closed','42501');
SELECT pg_temp.denied($q$SELECT stock FROM product_variants$q$,'legacy balance selection closed','42501');
SELECT pg_temp.denied($q$INSERT INTO product_variants(business_id,product_id,name) VALUES('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','orphan')$q$,'orphan rejected','23514');
SELECT pg_temp.denied($q$INSERT INTO product_variants(business_id,product_id,inventory_item_id,name) VALUES('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1d05','foreign child')$q$,'cross-tenant link rejected','23514');
SELECT pg_temp.denied($q$INSERT INTO product_variants(business_id,product_id,inventory_item_id,name) VALUES('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1d06','unlinked child')$q$,'unlinked inventory rejected','23514');
SELECT pg_temp.denied($q$INSERT INTO product_variants(business_id,product_id,inventory_item_id,name) VALUES('00000000-0000-0000-0000-0000000f1b01','00000000-0000-0000-0000-0000000f1d01','00000000-0000-0000-0000-0000000f1d02','duplicate')$q$,'duplicate child metadata rejected','23505');
SELECT pg_temp.denied($q$UPDATE product_variants SET inventory_item_id=NULL$q$,'API cannot unlink a child','42501');
SELECT pg_temp.denied($q$UPDATE inventory SET parent_id=NULL WHERE id='00000000-0000-0000-0000-0000000f1d02'$q$,'linked inventory cannot be detached','23514');
SELECT pg_temp.denied($q$UPDATE inventory SET parent_id='00000000-0000-0000-0000-0000000f1d04' WHERE id='00000000-0000-0000-0000-0000000f1d02'$q$,'linked inventory cannot move to foreign family','23514');
SELECT pg_temp.denied($q$UPDATE inventory SET has_variants=false WHERE id='00000000-0000-0000-0000-0000000f1d01'$q$,'grouping identity immutable','23514');
DO $$
DECLARE first_result jsonb; replay jsonb; items jsonb := '[{"inventory_id":"00000000-0000-0000-0000-0000000f1d02","delta":3},{"inventory_id":"00000000-0000-0000-0000-0000000f1d03","delta":5}]';
BEGIN
  first_result := public.apply_inventory_stock_adjustments_atomic('00000000-0000-0000-0000-0000000f1b01',items,'initial_stock','Alta de variantes','initial-stock:pv2-sql');
  replay := public.apply_inventory_stock_adjustments_atomic('00000000-0000-0000-0000-0000000f1b01',items,'initial_stock','Alta de variantes','initial-stock:pv2-sql');
  PERFORM pg_temp.assert(first_result->>'status'='created' AND replay->>'status'='existing','one canonical batch and idempotent retry');
  PERFORM pg_temp.assert((SELECT stock_quantity=3 FROM inventory WHERE id='00000000-0000-0000-0000-0000000f1d02'),'first child stock 3');
  PERFORM pg_temp.assert((SELECT stock_quantity=5 FROM inventory WHERE id='00000000-0000-0000-0000-0000000f1d03'),'second child stock 5');
  PERFORM pg_temp.assert((SELECT count(*)=2 FROM inventory_movements WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'retry adds no movement');
END $$;
SELECT pg_temp.denied($q$SELECT public.apply_inventory_stock_adjustments_atomic('00000000-0000-0000-0000-0000000f1b01','[{"inventory_id":"00000000-0000-0000-0000-0000000f1d02","delta":7},{"inventory_id":"00000000-0000-0000-0000-0000000f1d01","delta":1}]','initial_stock','forbidden parent','pv2-parent')$q$,'parent balance rejected atomically','23514');
SELECT pg_temp.assert((SELECT stock_quantity=3 FROM inventory WHERE id='00000000-0000-0000-0000-0000000f1d02'),'failed batch preserves child');
SELECT pg_temp.assert((SELECT stock_quantity=0 FROM inventory WHERE id='00000000-0000-0000-0000-0000000f1d01'),'parent remains zero');
SELECT pg_temp.denied($q$DELETE FROM product_variants WHERE inventory_item_id='00000000-0000-0000-0000-0000000f1d02'$q$,'historical variant cannot be hard deleted','23514');
UPDATE inventory SET is_active=false WHERE id='00000000-0000-0000-0000-0000000f1d02';
UPDATE product_variants SET active=false WHERE inventory_item_id='00000000-0000-0000-0000-0000000f1d02';
SELECT pg_temp.assert((SELECT count(*)=2 FROM inventory_movements WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'soft deactivation preserves history');
UPDATE inventory SET is_active=true WHERE id='00000000-0000-0000-0000-0000000f1d02';
UPDATE product_variants SET active=true WHERE inventory_item_id='00000000-0000-0000-0000-0000000f1d02';
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000f1002',true);
SELECT pg_temp.assert((SELECT count(*)=0 FROM product_variants WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'other tenant cannot read metadata');
RESET ROLE;
SELECT pg_temp.assert((SELECT bool_and(stock=0) FROM product_variants WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'compatibility stock stays at default zero');
DELETE FROM businesses WHERE id='00000000-0000-0000-0000-0000000f1b01';
SELECT pg_temp.assert((SELECT count(*)=0 FROM product_variants WHERE business_id='00000000-0000-0000-0000-0000000f1b01'),'canonical tenant purge preserves existing cascades');
ROLLBACK;
