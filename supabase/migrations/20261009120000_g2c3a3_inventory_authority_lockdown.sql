-- ============================================================================
-- G2-C.3A3 · Lockdown en base de datos de la autoridad de stock
--
-- A1 (20261008120000) creo la autoridad canonica para el stock que no nace de
-- un documento: public.apply_inventory_stock_adjustments_atomic. A2 migro el
-- frontend a esa autoridad (sin migracion de base). A3 cierra EN LA BASE todo
-- camino directo que quedaba desde la API hacia el saldo y el libro:
--
--   frontend / PostgREST / DevTools / bundle viejo
--        |  NO puede escribir el saldo ni el libro
--        v
--   A1 + W1-W7 (SECURITY DEFINER, owner postgres) = writers server-side
--        v
--   inventory.stock / stock_quantity  +  inventory_movements (append-only)
--
-- DISCOVERY (replay local aislado de main = efae8a1, catalogo real):
--   inventory            relacl {postgres=arwdDxtm, anon=awdDxt, authenticated=awdDxt}
--                        -> INSERT/UPDATE de TABLA para anon y authenticated; las
--                           columnas solo tienen SELECT (SEC-08B); service_role nada.
--   inventory_movements  relacl {postgres=arwdDxtm, authenticated=awd}; SELECT por
--                        columna (unit_cost oculto, SEC-08B); anon/service_role nada.
--   policies             inventory: insert/update (tenant + capability inventory),
--                        delete (can_manage), select, wholesale_portal_read.
--                        inventory_movements: insert (capability inventory),
--                        update/delete (can_manage), select.
--   FK                   inventory_movements_inventory_item_id_fkey
--                        -> inventory(id) ON DELETE CASCADE.
--   Reproducido (BEGIN/ROLLBACK, SET ROLE authenticated + jwt sub):
--     · sales (capability inventory) UPDATE stock_quantity 10 -> 9999: OK.
--     · sales INSERT producto con stock_quantity 50: OK (y el alias queda en 0).
--     · sales INSERT inventory_movements inventado: OK.
--     · owner UPDATE de un movimiento (quantity 77): OK.
--     · owner DELETE del producto: sus movimientos se borran por cascade.
--
-- ESTRATEGIA (A + B, las dos, porque se cubren entre si):
--   A. PRIVILEGIOS (la barrera fuerte, en el chequeo de permisos, antes de tocar
--      una fila). inventory tenia INSERT/UPDATE de TABLA: un REVOKE de columna no
--      alcanza. Se revoca INSERT/UPDATE de tabla y se reconstruye para
--      authenticated EXACTAMENTE la lista de columnas del snapshot menos stock y
--      stock_quantity (la lista se valida contra el catalogo vivo, no se inventa).
--      anon no tiene ninguna policy de escritura en inventory: sus INSERT/UPDATE
--      eran privilegios muertos y no se reconstruyen. inventory_movements pierde
--      INSERT/UPDATE/DELETE de authenticated y sus tres policies de escritura
--      (quedarian muertas: sin policy, un GRANT futuro sigue sin abrir nada).
--   B. GUARDS fail-closed (defensa ante un GRANT futuro que reabra la tabla):
--      · zz_inventory_stock_authority_guard: si el saldo cambia (UPDATE) o nace
--        distinto de 0 (INSERT) y el rol efectivo NO es el contexto canonico
--        (postgres: writers SECURITY DEFINER, migraciones; o superusuario) -> 42501.
--        La autoridad es el ROL de base, nunca auth.uid(). Es el ultimo BEFORE
--        trigger (orden alfabetico): valida la fila final.
--      · trg_inventory_movements_append_only: INSERT solo desde el contexto
--        canonico; UPDATE y DELETE rechazados salvo las acciones referenciales
--        que el propio esquema ya declara (ON DELETE SET NULL de created_by /
--        supplier_id / variant_id / product_id, y el purge del tenant por
--        ON DELETE CASCADE de business_id), y solo en contexto canonico.
--        TRUNCATE rechazado.
--   C. FK del historial: ON DELETE CASCADE -> ON DELETE RESTRICT (mismo nombre,
--      mismas columnas, validada). Un producto con movimientos no se puede
--      borrar en duro; sin movimientos, igual que antes. Soft-delete intacto.
--
-- QUE NO HACE: no cambia la logica de stock, no crea otra autoridad, no toca
-- W1-W7 ni A1 (md5 antes/despues), no toca product_variants, no agrega CHECK
-- stock >= 0 (negativos permitidos por contrato), no reconcilia historia (los
-- productos sin movimiento y los no reconciliados quedan como opening point),
-- no escribe ni una fila (cero DML), no amplia SELECT ni toca SEC-08B.
--
-- FAIL-CLOSED: si una precondicion no coincide con el discovery, RAISE y nada
-- se aplica. No hay adaptacion.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_wrap   oid := to_regprocedure('public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)');
  v_impl   oid := to_regprocedure('private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)');
  v_lock   oid := to_regprocedure('private.lock_inventory_rows(uuid,uuid[])');
  v_inv    oid := to_regclass('public.inventory');
  v_mov    oid := to_regclass('public.inventory_movements');
  v_sig    text;
  v_src    text;
  v_n      bigint;
  v_names  text[];
  v_bad    text;
  v_role   text;
BEGIN
  IF v_inv IS NULL OR v_mov IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 0: faltan public.inventory o public.inventory_movements';
  END IF;

  -- PRECONDICION 1 · A1 existe con firma exacta y su contrato de ejecucion:
  -- wrapper DEFINER/postgres/search_path minimo con EXECUTE solo de authenticated;
  -- impl INVOKER/postgres sin EXECUTE de API.
  IF v_wrap IS NULL OR v_impl IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: falta A1 (apply_inventory_stock_adjustments_atomic/_impl con firma uuid,jsonb,text,text,text)';
  END IF;
  IF NOT (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
                 AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND p.prorettype = 'jsonb'::regtype
            FROM pg_proc p WHERE p.oid = v_wrap)
     OR NOT (SELECT NOT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
               FROM pg_proc p WHERE p.oid = v_impl) THEN
    RAISE EXCEPTION 'PRECONDICION 1: A1 cambio de SECURITY/owner/search_path/retorno';
  END IF;
  IF NOT has_function_privilege('authenticated', v_wrap, 'EXECUTE')
     OR has_function_privilege('anon', v_wrap, 'EXECUTE')
     OR has_function_privilege('service_role', v_wrap, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid IN (v_wrap, v_impl) AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PRECONDICION 1: el EXECUTE del wrapper A1 no es exactamente authenticated';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_impl, 'EXECUTE') THEN
      RAISE EXCEPTION 'PRECONDICION 1: % puede ejecutar el impl privado de A1', v_role;
    END IF;
  END LOOP;

  -- PRECONDICION 2 · el helper de lock G2-C.2 existe con su contrato.
  IF v_lock IS NULL
     OR (SELECT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres' FROM pg_proc p WHERE p.oid = v_lock)
     OR has_function_privilege('anon', v_lock, 'EXECUTE')
     OR has_function_privilege('authenticated', v_lock, 'EXECUTE')
     OR has_function_privilege('service_role', v_lock, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDICION 2: falta private.lock_inventory_rows(uuid,uuid[]) o cambio su contrato (INVOKER, postgres, sin API)';
  END IF;

  -- PRECONDICION 3 · W1-W7 existen, son SECURITY DEFINER de postgres (corren
  -- como el dueño de las tablas: el contexto canonico que A3 conserva), y el
  -- catalogo de writers es EXACTAMENTE el conocido: 8 que mueven stock (W1-W7 +
  -- impl A1), los mismos 8 insertan movimientos, y NINGUNA funcion reescribe,
  -- borra o trunca movimientos (append-only compatible).
  FOREACH v_sig IN ARRAY ARRAY[
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
    'private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',
    'private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PRECONDICION 3: falta el writer canonico %', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres' FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'PRECONDICION 3: % dejo de ser SECURITY DEFINER de postgres', v_sig;
    END IF;
  END LOOP;
  SELECT array_agg(n.nspname || '.' || p.proname ORDER BY n.nspname || '.' || p.proname COLLATE "C") INTO v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  IF v_names IS DISTINCT FROM ARRAY[
       'private.apply_inventory_stock_adjustments_impl', 'private.create_comprobante_checkout_atomic',
       'private.create_quick_inventory_purchase_atomic', 'private.create_supplier_purchase_atomic',
       'private.sec08e_annul_comprobante_impl', 'public.adjust_stock_on_order_item',
       'public.delete_supplier_purchase_safe', 'public.repair_missing_stock_movements'] THEN
    RAISE EXCEPTION 'PRECONDICION 3: el catalogo de writers de stock no es W1-W7 + A1: %', v_names;
  END IF;
  SELECT array_agg(n.nspname || '.' || p.proname ORDER BY n.nspname || '.' || p.proname COLLATE "C") INTO v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
     AND p.prosrc ~* 'insert\s+into\s+(public\.)?inventory_movements\y';
  IF v_names IS DISTINCT FROM ARRAY[
       'private.apply_inventory_stock_adjustments_impl', 'private.create_comprobante_checkout_atomic',
       'private.create_quick_inventory_purchase_atomic', 'private.create_supplier_purchase_atomic',
       'private.sec08e_annul_comprobante_impl', 'public.adjust_stock_on_order_item',
       'public.delete_supplier_purchase_safe', 'public.repair_missing_stock_movements'] THEN
    RAISE EXCEPTION 'PRECONDICION 3: los que insertan movimientos no son W1-W7 + A1: %', v_names;
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
     AND p.prosrc ~* '(update\s+(public\.)?inventory_movements\y|delete\s+from\s+(public\.)?inventory_movements\y|truncate[^;]*\yinventory_movements\y)';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 3: hay funciones que reescriben/borran movimientos (%): el append-only las romperia', v_bad;
  END IF;

  -- PRECONDICION 4 · A2 no requirio migracion: A1 es la ultima version aplicada
  -- y A3 no esta registrada (ni un A3 previo con otra version).
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 4: falta supabase_migrations.schema_migrations (no se puede probar el orden A1 -> A3)';
  END IF;
  EXECUTE 'SELECT max(version) FROM supabase_migrations.schema_migrations' INTO v_src;
  IF v_src IS DISTINCT FROM '20261008120000' THEN
    RAISE EXCEPTION 'PRECONDICION 4: la ultima migracion aplicada es % (se esperaba A1 = 20261008120000; A2 no lleva migracion)', v_src;
  END IF;
  EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name ~* ''g2c3a3''' INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'PRECONDICION 4: ya hay una migracion g2c3a3 registrada';
  END IF;

  -- PRECONDICION 5 · forma de inventory: owner postgres, RLS on (no forzada),
  -- columnas = snapshot del discovery, stock/stock_quantity integer default 0,
  -- sin columnas generadas, y SIN CHECK sobre el stock (negativos permitidos).
  IF (SELECT pg_get_userbyid(c.relowner) <> 'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity
        FROM pg_class c WHERE c.oid = v_inv)
     OR (SELECT pg_get_userbyid(c.relowner) <> 'postgres' OR NOT c.relrowsecurity OR c.relforcerowsecurity
           FROM pg_class c WHERE c.oid = v_mov) THEN
    RAISE EXCEPTION 'PRECONDICION 5: inventory/inventory_movements cambiaron de owner o de RLS';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C") INTO v_names
    FROM pg_attribute a WHERE a.attrelid = v_inv AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_names IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[
       'id', 'code', 'name', 'category', 'description', 'stock', 'min_stock', 'cost_price', 'sale_price',
       'supplier_id', 'created_at', 'updated_at', 'stock_quantity', 'reserved_quantity', 'is_active',
       'subcategory', 'max_stock', 'supplier_code', 'location', 'created_by', 'business_id', 'price_usd',
       'currency', 'base_currency', 'base_price', 'exchange_rate_used', 'auto_update_price', 'cost_price_usd',
       'linked_to_dolar', 'tipo', 'precio_mayorista', 'mayorista_enabled', 'variant_name', 'has_variants',
       'visible_in_wholesale', 'portal_title', 'portal_description', 'portal_description_full',
       'portal_compatibility', 'portal_tags', 'portal_featured', 'portal_is_new', 'portal_on_sale',
       'portal_sort_order', 'portal_condition', 'portal_warranty', 'portal_notes', 'portal_specs',
       'portal_min_qty', 'portal_main_image', 'portal_images', 'brand', 'model', 'barcode',
       'wholesale_price_ars', 'wholesale_price_usd', 'parent_id']) AS x) THEN
    RAISE EXCEPTION 'PRECONDICION 5: las columnas de inventory no coinciden con el snapshot del discovery (57): %', v_names;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_inv AND a.attnum > 0 AND NOT a.attisdropped
                AND (a.attgenerated <> '' OR a.attidentity <> '')) THEN
    RAISE EXCEPTION 'PRECONDICION 5: inventory tiene columnas generadas/identity (el snapshot no las tenia)';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = v_inv AND format_type(a.atttypid, a.atttypmod) = 'integer'
     AND ((a.attname = 'stock' AND a.attnotnull) OR a.attname = 'stock_quantity')
     AND pg_get_expr(d.adbin, d.adrelid) = '0';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'PRECONDICION 5: stock (integer NOT NULL DEFAULT 0) / stock_quantity (integer DEFAULT 0) cambiaron: un alta de metadata ya no naceria en 0';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_inv AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) ~* '\ystock(_quantity)?\y') THEN
    RAISE EXCEPTION 'PRECONDICION 5: existe un CHECK sobre el stock de inventory (el contrato G2-C permite negativos)';
  END IF;

  -- PRECONDICION 6 · triggers: inventory tiene EXACTAMENTE los 5 conocidos,
  -- incluido trg_sync_inventory_stock (BEFORE UPDATE OF stock_quantity, activo);
  -- inventory_movements no tiene triggers de usuario.
  SELECT array_agg(t.tgname::text ORDER BY t.tgname::text COLLATE "C") INTO v_names
    FROM pg_trigger t WHERE t.tgrelid = v_inv AND NOT t.tgisinternal;
  IF v_names IS DISTINCT FROM ARRAY['set_exchange_rate_on_product_save_trigger', 'trg_sync_inventory_stock',
       'trig_inventory_guard_cost_write', 'trig_inventory_inherit_variant_cost', 'update_inventory_updated_at'] THEN
    RAISE EXCEPTION 'PRECONDICION 6: los triggers de inventory no son los del discovery: %', v_names;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = v_inv AND t.tgname = 'trg_sync_inventory_stock' AND t.tgenabled = 'O'
                    AND p.oid = 'public.sync_inventory_stock_alias()'::regprocedure
                    AND pg_get_triggerdef(t.oid) ~* 'BEFORE UPDATE OF stock_quantity ON public\.inventory FOR EACH ROW') THEN
    RAISE EXCEPTION 'PRECONDICION 6: trg_sync_inventory_stock no esta activo como BEFORE UPDATE OF stock_quantity';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v_mov AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'PRECONDICION 6: inventory_movements ya tiene triggers de usuario (A3 parcial o desconocido)';
  END IF;

  -- PRECONDICION 7 · ACL exactos del discovery (comparados como conjuntos, no
  -- como texto). Tabla: inventory anon/authenticated = INSERT, UPDATE, DELETE,
  -- TRUNCATE, REFERENCES, TRIGGER; inventory_movements authenticated = INSERT,
  -- UPDATE, DELETE. Columnas: SOLO SELECT (SEC-08B), ningun INSERT/UPDATE de
  -- columna (no hay un A3 parcial). service_role sin nada. Ningun rol de API es
  -- miembro de postgres (el contexto canonico que distinguen los guards).
  IF EXISTS (
    (SELECT c.relname::text, a.grantee::regrole::text, a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid IN (v_inv, v_mov) AND a.grantee <> c.relowner
     EXCEPT
     SELECT * FROM (VALUES
       ('inventory', 'anon', 'INSERT'), ('inventory', 'anon', 'UPDATE'), ('inventory', 'anon', 'DELETE'),
       ('inventory', 'anon', 'TRUNCATE'), ('inventory', 'anon', 'REFERENCES'), ('inventory', 'anon', 'TRIGGER'),
       ('inventory', 'authenticated', 'INSERT'), ('inventory', 'authenticated', 'UPDATE'),
       ('inventory', 'authenticated', 'DELETE'), ('inventory', 'authenticated', 'TRUNCATE'),
       ('inventory', 'authenticated', 'REFERENCES'), ('inventory', 'authenticated', 'TRIGGER'),
       ('inventory_movements', 'authenticated', 'INSERT'), ('inventory_movements', 'authenticated', 'UPDATE'),
       ('inventory_movements', 'authenticated', 'DELETE')) AS e(rel, grantee, priv))
    UNION ALL
    (SELECT * FROM (VALUES
       ('inventory', 'anon', 'INSERT'), ('inventory', 'anon', 'UPDATE'), ('inventory', 'anon', 'DELETE'),
       ('inventory', 'anon', 'TRUNCATE'), ('inventory', 'anon', 'REFERENCES'), ('inventory', 'anon', 'TRIGGER'),
       ('inventory', 'authenticated', 'INSERT'), ('inventory', 'authenticated', 'UPDATE'),
       ('inventory', 'authenticated', 'DELETE'), ('inventory', 'authenticated', 'TRUNCATE'),
       ('inventory', 'authenticated', 'REFERENCES'), ('inventory', 'authenticated', 'TRIGGER'),
       ('inventory_movements', 'authenticated', 'INSERT'), ('inventory_movements', 'authenticated', 'UPDATE'),
       ('inventory_movements', 'authenticated', 'DELETE')) AS e(rel, grantee, priv)
     EXCEPT
     SELECT c.relname::text, a.grantee::regrole::text, a.privilege_type
       FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid IN (v_inv, v_mov) AND a.grantee <> c.relowner)
  ) THEN
    RAISE EXCEPTION 'PRECONDICION 7: los privilegios de TABLA de inventory/inventory_movements no son los del discovery';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
              WHERE att.attrelid IN (v_inv, v_mov) AND att.attnum > 0 AND NOT att.attisdropped
                AND a.privilege_type <> 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDICION 7: ya hay privilegios de columna distintos de SELECT (A3 parcial o drift)';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['service_role', 'anon', 'authenticated', 'authenticator'] LOOP
    IF pg_has_role(v_role, 'postgres', 'MEMBER') THEN
      RAISE EXCEPTION 'PRECONDICION 7: % es miembro de postgres (el contexto canonico dejaria de ser distinguible)', v_role;
    END IF;
  END LOOP;
  IF has_any_column_privilege('service_role', v_inv, 'SELECT, INSERT, UPDATE, REFERENCES')
     OR has_table_privilege('service_role', v_inv, 'DELETE, TRUNCATE, TRIGGER')
     OR has_any_column_privilege('service_role', v_mov, 'SELECT, INSERT, UPDATE, REFERENCES')
     OR has_table_privilege('service_role', v_mov, 'DELETE, TRUNCATE, TRIGGER')
     OR has_any_column_privilege('anon', v_mov, 'SELECT, INSERT, UPDATE, REFERENCES')
     OR has_table_privilege('anon', v_mov, 'DELETE, TRUNCATE, TRIGGER') THEN
    RAISE EXCEPTION 'PRECONDICION 7: service_role/anon tienen privilegios que el discovery no mostro';
  END IF;

  -- PRECONDICION 8 · policies = las 9 del discovery (nombre, comando, roles).
  IF EXISTS (
    (SELECT tablename::text, policyname::text, cmd, roles::text FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')
     EXCEPT
     SELECT * FROM (VALUES
       ('inventory', 'inventory_delete', 'DELETE', '{authenticated}'),
       ('inventory', 'inventory_insert', 'INSERT', '{authenticated}'),
       ('inventory', 'inventory_select', 'SELECT', '{authenticated}'),
       ('inventory', 'inventory_update', 'UPDATE', '{authenticated}'),
       ('inventory', 'inventory_wholesale_portal_read', 'SELECT', '{public}'),
       ('inventory_movements', 'inventory_movements_delete', 'DELETE', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_insert', 'INSERT', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_select', 'SELECT', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_update', 'UPDATE', '{authenticated}')) AS e(t, p, c, r))
    UNION ALL
    (SELECT * FROM (VALUES
       ('inventory', 'inventory_delete', 'DELETE', '{authenticated}'),
       ('inventory', 'inventory_insert', 'INSERT', '{authenticated}'),
       ('inventory', 'inventory_select', 'SELECT', '{authenticated}'),
       ('inventory', 'inventory_update', 'UPDATE', '{authenticated}'),
       ('inventory', 'inventory_wholesale_portal_read', 'SELECT', '{public}'),
       ('inventory_movements', 'inventory_movements_delete', 'DELETE', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_insert', 'INSERT', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_select', 'SELECT', '{authenticated}'),
       ('inventory_movements', 'inventory_movements_update', 'UPDATE', '{authenticated}')) AS e(t, p, c, r)
     EXCEPT
     SELECT tablename::text, policyname::text, cmd, roles::text FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements'))
  ) THEN
    RAISE EXCEPTION 'PRECONDICION 8: las policies de inventory/inventory_movements no son las 9 del discovery';
  END IF;

  -- PRECONDICION 9 · FKs de inventory_movements resueltas desde pg_catalog:
  -- inventory_item_id -> inventory(id) es UNA sola FK, ON DELETE CASCADE,
  -- validada, no diferible (lo que A3 corrige). Las demas son las que declaran
  -- las acciones referenciales que el append-only respeta: business_id CASCADE;
  -- created_by / supplier_id / variant_id / product_id SET NULL. Ninguna tiene
  -- accion ON UPDATE. Nadie referencia inventory_movements. Sin huerfanos.
  SELECT count(*) INTO v_n
    FROM pg_constraint c
   WHERE c.conrelid = v_mov AND c.contype = 'f' AND c.confrelid = v_inv
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_mov AND a.attname = 'inventory_item_id')]::int2[]
     AND c.confdeltype = 'c' AND c.confupdtype = 'a' AND c.convalidated AND NOT c.condeferrable;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PRECONDICION 9: no hay exactamente UNA FK inventory_item_id -> inventory(id) ON DELETE CASCADE validada (hay %): A3 ya aplicado o drift', v_n;
  END IF;
  SELECT string_agg(format('%s:%s.%s:%s', a.attname, rn.nspname, r.relname, c.confdeltype), ','
                    ORDER BY a.attname::text COLLATE "C") INTO v_src
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_class r ON r.oid = c.confrelid
    JOIN pg_namespace rn ON rn.oid = r.relnamespace
   WHERE c.conrelid = v_mov AND c.contype = 'f' AND a.attname <> 'inventory_item_id';
  IF v_src IS DISTINCT FROM 'business_id:public.businesses:c,created_by:auth.users:n,product_id:public.inventory:n,supplier_id:public.suppliers:n,variant_id:public.product_variants:n' THEN
    RAISE EXCEPTION 'PRECONDICION 9: las otras FKs de inventory_movements cambiaron: %', v_src;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_mov AND c.contype = 'f'
                AND (c.confupdtype <> 'a' OR cardinality(c.conkey) <> 1))
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = v_mov) THEN
    RAISE EXCEPTION 'PRECONDICION 9: hay FKs con accion ON UPDATE / compuestas, o alguien referencia inventory_movements';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_movements m
              WHERE NOT EXISTS (SELECT 1 FROM public.inventory i WHERE i.id = m.inventory_item_id)) THEN
    RAISE EXCEPTION 'PRECONDICION 9: hay movimientos huerfanos (la FK nueva no validaria; A3 no hace limpieza)';
  END IF;

  -- PRECONDICION 10 · CHECKs de inventory_movements: quantity <> 0 y el
  -- catalogo de movement_type siguen vigentes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_mov AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) ~ '^CHECK \(\(quantity <> 0\)\)$')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_mov AND c.contype = 'c'
                       AND c.conname = 'inventory_movements_type_check') THEN
    RAISE EXCEPTION 'PRECONDICION 10: falta el CHECK quantity <> 0 o el de movement_type en inventory_movements';
  END IF;

  -- PRECONDICION 11 · no existe un A3 previo parcial (funciones o triggers con
  -- estos nombres, en ningun schema).
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('tg_inventory_stock_authority_guard', 'tg_inventory_movements_append_only'))
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname IN ('zz_inventory_stock_authority_guard',
                  'trg_inventory_movements_append_only', 'trg_inventory_movements_no_truncate')) THEN
    RAISE EXCEPTION 'PRECONDICION 11: ya existe un guard/trigger de G2-C.3A3 (A3 parcial)';
  END IF;

  -- PRECONDICION 12 · SEC-08B intacto: el costo no es legible por la API
  -- (inventory.cost_price/cost_price_usd, inventory_movements.unit_cost), el
  -- guard de costo es INVOKER y la herencia de variante es DEFINER.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_column_privilege(v_role, v_inv, 'cost_price', 'SELECT')
       OR has_column_privilege(v_role, v_inv, 'cost_price_usd', 'SELECT')
       OR has_column_privilege(v_role, v_mov, 'unit_cost', 'SELECT') THEN
      RAISE EXCEPTION 'PRECONDICION 12: % puede leer costo (SEC-08B no esta aplicado)', v_role;
    END IF;
  END LOOP;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.tg_inventory_guard_cost_write()'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.tg_inventory_inherit_variant_cost()'::regprocedure) THEN
    RAISE EXCEPTION 'PRECONDICION 12: los triggers de costo de SEC-08B cambiaron de SECURITY';
  END IF;

  -- PRECONDICION 13 · el schema private sigue cerrado a los roles del navegador
  -- (los guards nuevos viven ahi y ademas no tienen EXECUTE de ningun rol de
  -- API; service_role conserva el USAGE que ya tenia, como en A1).
  IF to_regnamespace('private') IS NULL
     OR has_schema_privilege('anon', 'private', 'USAGE') OR has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'PRECONDICION 13: el schema private falta o es usable por la API';
  END IF;
END
$pre$;

-- ════════════════════════════════════════════════════════════════════════════
-- SNAPSHOTS · lo que A3 NO puede cambiar (se comparan al final)
-- ════════════════════════════════════════════════════════════════════════════
-- Funciones: W1-W7, A1 (wrapper + impl), helper de lock, alias de stock y los
-- triggers/funciones de SEC-08B y de inventory.
CREATE TEMP TABLE _g2c3a3_fns ON COMMIT DROP AS
SELECT f.firma, p.oid, md5(p.prosrc) AS src_md5, p.prosecdef, p.proowner, p.proconfig, p.proacl::text AS acl, p.provolatile
  FROM unnest(ARRAY[
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
    'private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',
    'private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()',
    'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)',
    'private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)',
    'private.lock_inventory_rows(uuid,uuid[])',
    'public.sync_inventory_stock_alias()',
    'public.tg_inventory_guard_cost_write()',
    'public.tg_inventory_inherit_variant_cost()',
    'public.can_view_inventory_cost(uuid)',
    'public.set_exchange_rate_on_product_save()',
    'public.update_timestamp()'
  ]) AS f(firma)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.firma);

-- Privilegios de SELECT por columna (SEC-08B) de las dos tablas.
CREATE TEMP TABLE _g2c3a3_colsel ON COMMIT DROP AS
SELECT c.relname::text AS rel, att.attname::text AS col, a.grantee::regrole::text AS grantee
  FROM pg_class c
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
  CROSS JOIN LATERAL aclexplode(att.attacl) a
 WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
   AND a.privilege_type = 'SELECT';

-- Privilegios de TABLA.
CREATE TEMP TABLE _g2c3a3_tblacl ON COMMIT DROP AS
SELECT c.relname::text AS rel, a.grantee::regrole::text AS grantee, a.privilege_type AS priv
  FROM pg_class c, aclexplode(c.relacl) a
 WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass);

CREATE TEMP TABLE _g2c3a3_policies ON COMMIT DROP AS
SELECT tablename::text AS t, policyname::text AS p, permissive, cmd, roles::text AS roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements');

CREATE TEMP TABLE _g2c3a3_triggers ON COMMIT DROP AS
SELECT t.tgrelid::regclass::text AS rel, t.tgname::text AS tgname, t.tgfoid, t.tgenabled, t.tgtype
  FROM pg_trigger t
 WHERE t.tgrelid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
   AND NOT t.tgisinternal;

-- FKs (todas las de inventory_movements y todas las que apuntan a inventory),
-- indices de inventory_movements y vistas de costo de SEC-08B.
CREATE TEMP TABLE _g2c3a3_fks ON COMMIT DROP AS
SELECT c.conname::text AS conname, c.conrelid AS relid, pg_get_constraintdef(c.oid) AS def, c.convalidated
  FROM pg_constraint c
 WHERE c.contype = 'f' AND (c.conrelid = 'public.inventory_movements'::regclass OR c.confrelid = 'public.inventory'::regclass);

CREATE TEMP TABLE _g2c3a3_idx ON COMMIT DROP AS
SELECT i.indexrelid::regclass::text AS idx, pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i WHERE i.indrelid = 'public.inventory_movements'::regclass;

CREATE TEMP TABLE _g2c3a3_views ON COMMIT DROP AS
SELECT c.oid::regclass::text AS v, c.relacl::text AS acl, md5(pg_get_viewdef(c.oid)) AS def_md5, c.reloptions::text AS opts
  FROM pg_class c
 WHERE c.oid IN ('public.v_inventory_costs'::regclass, 'public.v_inventory_movement_costs'::regclass);

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A3.1 · inventory: el saldo sale de la autoridad directa de la API
-- ════════════════════════════════════════════════════════════════════════════
-- Un GRANT UPDATE de TABLA vuelve inutil un REVOKE de columna: se revoca el
-- privilegio de tabla y se reconstruye para authenticated EXACTAMENTE la lista
-- de columnas vivas (ya validada contra el snapshot en la PRECONDICION 5) menos
-- stock y stock_quantity. INSERT de metadata sin stock -> defaults 0; UPDATE de
-- metadata (nombre, precios, categoria, min_stock, location, is_active, ...)
-- igual que antes; cualquier sentencia que nombre stock/stock_quantity -> 42501
-- en el chequeo de permisos, antes de tocar una fila. cost_price/cost_price_usd
-- conservan INSERT/UPDATE (su autoridad la decide el trigger de SEC-08B, que no
-- se toca) y siguen SIN SELECT.
-- anon no tiene policy de escritura en inventory: su INSERT/UPDATE era un
-- privilegio muerto y no se reconstruye. DELETE/TRUNCATE/REFERENCES/TRIGGER no
-- escriben saldo y quedan como estaban (fuera de alcance).
DO $grant$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.inventory'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('stock', 'stock_quantity');
  IF v_cols IS NULL OR v_cols ~ '(^|, )"?stock(_quantity)?"?(,|$)' THEN
    RAISE EXCEPTION 'A3.1: la lista de columnas de metadata no se pudo construir sin stock';
  END IF;

  REVOKE INSERT, UPDATE ON TABLE public.inventory FROM anon, authenticated;
  EXECUTE format('GRANT INSERT (%s), UPDATE (%s) ON TABLE public.inventory TO authenticated', v_cols, v_cols);
END
$grant$;

-- Defensa en profundidad ante un GRANT futuro que reabra la tabla: el saldo
-- solo cambia (o nace distinto de 0) desde el contexto canonico.
-- SECURITY INVOKER a proposito: es la unica forma de ver el rol efectivo real
-- (dentro de un writer SECURITY DEFINER es postgres; por PostgREST es
-- anon/authenticated). La autoridad es ese ROL, nunca auth.uid(): dentro de una
-- RPC canonica auth.uid() sigue siendo el usuario del navegador.
-- No necesita EXECUTE de la API: PostgreSQL no chequea EXECUTE de la funcion de
-- un trigger al dispararlo (medido en el discovery), y private no es usable.
CREATE FUNCTION private.tg_inventory_stock_authority_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Metadata: el saldo no cambia -> nada que decidir.
  IF TG_OP = 'INSERT' THEN
    IF NEW.stock IS NOT DISTINCT FROM 0 AND NEW.stock_quantity IS NOT DISTINCT FROM 0 THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.stock IS NOT DISTINCT FROM OLD.stock AND NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity THEN
      RETURN NEW;
    END IF;
  ELSE
    RAISE EXCEPTION 'INVENTORY_STOCK_GUARD_MISCONFIGURED: %', TG_OP USING ERRCODE = '42501';
  END IF;

  -- El saldo cambia: solo el contexto server-side canonico. Los writers W1-W7 y
  -- A1 son SECURITY DEFINER de postgres (dueño de la tabla); las migraciones
  -- corren como postgres; un superusuario es miembro de todo rol.
  IF pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'INVENTORY_STOCK_DIRECT_WRITE_FORBIDDEN: % directo de stock/stock_quantity por el rol %', TG_OP, current_user
    USING ERRCODE = '42501',
          HINT = 'El saldo lo mueven solo los writers canonicos: public.apply_inventory_stock_adjustments_atomic o el documento (venta, compra, anulacion, orden).';
END;
$fn$;

ALTER FUNCTION private.tg_inventory_stock_authority_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.tg_inventory_stock_authority_guard() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION private.tg_inventory_stock_authority_guard() IS
  'G2-C.3A3: guard fail-closed del saldo de inventory. UPDATE que cambia stock/stock_quantity o INSERT '
  'con saldo distinto de 0 -> 42501 salvo contexto canonico (rol miembro de postgres: writers SECURITY '
  'DEFINER W1-W7/A1, migraciones). INVOKER para ver el rol efectivo; nunca usa auth.uid().';

-- Nombre `zz_`: PostgreSQL dispara los BEFORE triggers en orden alfabetico;
-- este tiene que ser el ULTIMO para validar la fila final (despues de
-- trg_sync_inventory_stock, del guard de costo y de update_inventory_updated_at).
CREATE TRIGGER zz_inventory_stock_authority_guard
  BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION private.tg_inventory_stock_authority_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. A3.2 · inventory_movements: libro append-only, solo server-side
-- ════════════════════════════════════════════════════════════════════════════
-- La API pierde INSERT/UPDATE/DELETE. La LECTURA no cambia: el SELECT por
-- columna (unit_cost oculto) y la policy inventory_movements_select quedan
-- igual. Las tres policies de escritura quedarian muertas: se borran para que un
-- GRANT futuro tampoco abra nada (RLS sin policy = sin filas).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inventory_movements FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY inventory_movements_insert ON public.inventory_movements;
DROP POLICY inventory_movements_update ON public.inventory_movements;
DROP POLICY inventory_movements_delete ON public.inventory_movements;

-- Append-only con dos excepciones que NO son escrituras de negocio sino las
-- acciones referenciales que el esquema ya declara, y que PostgreSQL ejecuta
-- como el dueño de la tabla (postgres; medido en el discovery):
--   · ON DELETE SET NULL de created_by / supplier_id / variant_id / product_id
--     (borrar un usuario, un proveedor, una variante): el UPDATE solo pasa esas
--     columnas a NULL; cantidad, saldos, tipo, referencia, producto y negocio
--     quedan identicos.
--   · ON DELETE CASCADE de business_id (purge del tenant): el DELETE solo pasa
--     si el negocio ya no existe.
-- Todo lo demas (reescribir, borrar, truncar) -> 42501, tambien para postgres.
-- El INSERT solo desde el contexto canonico (W1-W7 + A1 corren como postgres).
-- INVOKER: necesita el rol efectivo real; el negocio se busca solo cuando ese
-- rol ya es el canonico (postgres, BYPASSRLS), asi que la busqueda no puede
-- quedar ciega por RLS.
CREATE FUNCTION private.tg_inventory_movements_append_only()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  c_detach    constant text[] := ARRAY['created_by', 'supplier_id', 'variant_id', 'product_id'];
  v_canonical boolean := pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER');
BEGIN
  IF TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'INVENTORY_MOVEMENTS_APPEND_ONLY: % de inventory_movements no esta permitido (libro append-only)', TG_OP
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_canonical THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'INVENTORY_MOVEMENTS_DIRECT_WRITE_FORBIDDEN: INSERT directo de movimientos por el rol %', current_user
      USING ERRCODE = '42501',
            HINT = 'Los movimientos los escriben solo los writers canonicos (A1, W1-W7).';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_canonical
       AND (to_jsonb(NEW) - c_detach) = (to_jsonb(OLD) - c_detach)
       AND (NEW.created_by  IS NOT DISTINCT FROM OLD.created_by  OR NEW.created_by  IS NULL)
       AND (NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id OR NEW.supplier_id IS NULL)
       AND (NEW.variant_id  IS NOT DISTINCT FROM OLD.variant_id  OR NEW.variant_id  IS NULL)
       AND (NEW.product_id  IS NOT DISTINCT FROM OLD.product_id  OR NEW.product_id  IS NULL)
       AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RETURN NEW;  -- ON DELETE SET NULL de una referencia secundaria
    END IF;
    RAISE EXCEPTION 'INVENTORY_MOVEMENTS_APPEND_ONLY: UPDATE de un movimiento (%) no esta permitido; se corrige con un movimiento compensatorio', OLD.id
      USING ERRCODE = '42501';
  END IF;

  -- DELETE
  IF v_canonical AND NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = OLD.business_id) THEN
    RETURN OLD;  -- ON DELETE CASCADE del negocio (purge del tenant)
  END IF;
  RAISE EXCEPTION 'INVENTORY_MOVEMENTS_APPEND_ONLY: DELETE de un movimiento (%) no esta permitido (libro append-only)', OLD.id
    USING ERRCODE = '42501';
END;
$fn$;

ALTER FUNCTION private.tg_inventory_movements_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.tg_inventory_movements_append_only() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION private.tg_inventory_movements_append_only() IS
  'G2-C.3A3: inventory_movements append-only. INSERT solo desde el contexto canonico (rol miembro de '
  'postgres). UPDATE/DELETE/TRUNCATE -> 42501, salvo las acciones referenciales declaradas: SET NULL de '
  'created_by/supplier_id/variant_id/product_id y CASCADE del negocio borrado.';

CREATE TRIGGER trg_inventory_movements_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION private.tg_inventory_movements_append_only();
CREATE TRIGGER trg_inventory_movements_no_truncate
  BEFORE TRUNCATE ON public.inventory_movements
  FOR EACH STATEMENT EXECUTE FUNCTION private.tg_inventory_movements_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- 3. A3.3 · el historial no se borra por cascade
-- ════════════════════════════════════════════════════════════════════════════
-- Misma FK (nombre resuelto desde pg_catalog, mismas columnas, validada) con
-- ON DELETE RESTRICT: un producto con movimientos no se puede borrar en duro
-- (23503); sin movimientos, igual que antes; soft-delete (is_active = false) no
-- toca la FK. DROP + ADD en UNA sentencia: no hay ventana sin FK. La validacion
-- no puede fallar: la FK anterior ya estaba validada sobre los mismos datos
-- (PRECONDICION 9). Los indices de inventory_item_id no dependen de la FK.
DO $fk$
DECLARE
  v_name text;
BEGIN
  SELECT c.conname INTO STRICT v_name
    FROM pg_constraint c
   WHERE c.conrelid = 'public.inventory_movements'::regclass AND c.contype = 'f'
     AND c.confrelid = 'public.inventory'::regclass
     AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                            WHERE a.attrelid = 'public.inventory_movements'::regclass
                              AND a.attname = 'inventory_item_id')]::int2[];
  EXECUTE format(
    'ALTER TABLE public.inventory_movements DROP CONSTRAINT %I, '
    'ADD CONSTRAINT %I FOREIGN KEY (inventory_item_id) REFERENCES public.inventory(id) ON UPDATE NO ACTION ON DELETE RESTRICT',
    v_name, v_name);
END
$fk$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_inv    oid := 'public.inventory'::regclass;
  v_mov    oid := 'public.inventory_movements'::regclass;
  v_role   text;
  v_col    text;
  v_priv   text;
  v_n      bigint;
  v_src    text;
  v_names  text[];
  s        record;
  v_now    record;
BEGIN
  -- POSTCONDICION P1 / P2 · authenticated (y anon) no puede escribir stock ni
  -- stock_quantity: ni por columna ni por tabla; y el guard esta montado.
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    FOREACH v_col IN ARRAY ARRAY['stock', 'stock_quantity'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE'] LOOP
        IF has_column_privilege(v_role, v_inv, v_col, v_priv) THEN
          RAISE EXCEPTION 'POSTCONDICION P1/P2: % conserva % sobre inventory.%', v_role, v_priv, v_col;
        END IF;
      END LOOP;
    END LOOP;
    IF has_table_privilege(v_role, v_inv, 'INSERT') OR has_table_privilege(v_role, v_inv, 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICION P1/P2: % conserva INSERT/UPDATE de TABLA sobre inventory (invalidaria el cierre por columna)', v_role;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = v_inv AND t.tgname = 'zz_inventory_stock_authority_guard' AND t.tgenabled = 'O'
                    AND t.tgfoid = 'private.tg_inventory_stock_authority_guard()'::regprocedure
                    AND pg_get_triggerdef(t.oid) ~ 'BEFORE INSERT OR UPDATE ON public\.inventory FOR EACH ROW') THEN
    RAISE EXCEPTION 'POSTCONDICION P1/P2: falta el guard zz_inventory_stock_authority_guard (BEFORE INSERT OR UPDATE, activo)';
  END IF;
  IF (SELECT max(t.tgname::text COLLATE "C") FROM pg_trigger t
       WHERE t.tgrelid = v_inv AND NOT t.tgisinternal AND (t.tgtype & 2) = 2) <> 'zz_inventory_stock_authority_guard' THEN
    RAISE EXCEPTION 'POSTCONDICION P1/P2: el guard de stock no es el ultimo BEFORE trigger de inventory';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'private.tg_inventory_stock_authority_guard()'::regprocedure;
  IF (SELECT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        FROM pg_proc p WHERE p.oid = 'private.tg_inventory_stock_authority_guard()'::regprocedure)
     OR position('pg_catalog.pg_has_role(current_user, ''postgres'', ''MEMBER'')' IN v_src) = 0
     OR position('NEW.stock IS NOT DISTINCT FROM OLD.stock AND NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity' IN v_src) = 0
     OR position('NEW.stock IS NOT DISTINCT FROM 0 AND NEW.stock_quantity IS NOT DISTINCT FROM 0' IN v_src) = 0
     OR position('ERRCODE = ''42501''' IN v_src) = 0
     OR v_src ~* 'auth\.uid' THEN
    RAISE EXCEPTION 'POSTCONDICION P1/P2: el guard de stock no tiene el contrato (INVOKER, rol canonico, 42501, sin auth.uid)';
  END IF;

  -- POSTCONDICION P3 / P4 / P14 · authenticated conserva INSERT y UPDATE en TODAS
  -- las columnas de metadata (incluidas is_active para el soft-delete y el costo,
  -- cuya autoridad sigue en SEC-08B); las policies de insert/update no cambiaron
  -- (se verifica en P16) y los defaults del saldo siguen en 0.
  SELECT count(*) INTO v_n
    FROM pg_attribute a
   WHERE a.attrelid = v_inv AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('stock', 'stock_quantity')
     AND has_column_privilege('authenticated', v_inv, a.attnum, 'INSERT')
     AND has_column_privilege('authenticated', v_inv, a.attnum, 'UPDATE');
  IF v_n <> 55 THEN
    RAISE EXCEPTION 'POSTCONDICION P3/P4: authenticated deberia tener INSERT+UPDATE en las 55 columnas de metadata (tiene %)', v_n;
  END IF;
  IF NOT has_column_privilege('authenticated', v_inv, 'is_active', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDICION P14: authenticated perdio UPDATE(is_active): el soft-delete se romperia';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = v_inv AND a.attname IN ('stock', 'stock_quantity') AND pg_get_expr(d.adbin, d.adrelid) = '0';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICION P3: los defaults de stock/stock_quantity dejaron de ser 0';
  END IF;

  -- POSTCONDICION P5 · anon no obtiene escrituras: sin INSERT/UPDATE en ninguna
  -- columna y sus privilegios de tabla son un subconjunto de los de antes.
  -- service_role sigue sin nada. PUBLIC sin nada.
  IF has_any_column_privilege('anon', v_inv, 'INSERT') OR has_any_column_privilege('anon', v_inv, 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDICION P5: anon tiene INSERT/UPDATE de columna sobre inventory';
  END IF;
  IF EXISTS (SELECT c.relname::text, a.grantee::regrole::text, a.privilege_type
               FROM pg_class c, aclexplode(c.relacl) a
              WHERE c.oid IN (v_inv, v_mov) AND a.grantee <> c.relowner
             EXCEPT SELECT rel, grantee, priv FROM _g2c3a3_tblacl) THEN
    RAISE EXCEPTION 'POSTCONDICION P5: A3 AGREGO privilegios de tabla sobre inventory/inventory_movements';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
              WHERE att.attrelid IN (v_inv, v_mov) AND att.attnum > 0 AND NOT att.attisdropped
                AND (a.grantee::regrole::text <> 'authenticated' AND a.privilege_type <> 'SELECT')) THEN
    RAISE EXCEPTION 'POSTCONDICION P5: hay privilegios de escritura por columna para un rol distinto de authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
              WHERE att.attrelid = v_mov AND att.attnum > 0 AND NOT att.attisdropped AND a.privilege_type <> 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION P5/P9: hay privilegios de escritura por columna sobre inventory_movements';
  END IF;
  IF has_any_column_privilege('service_role', v_inv, 'SELECT, INSERT, UPDATE, REFERENCES')
     OR has_table_privilege('service_role', v_inv, 'DELETE, TRUNCATE, TRIGGER')
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid IN (v_inv, v_mov) AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDICION P5: service_role o PUBLIC obtuvieron privilegios sobre inventory';
  END IF;

  -- POSTCONDICION P6 / P7 / P8 · A1, el helper de lock, W1-W7 y las funciones de
  -- SEC-08B / inventory quedaron EXACTAMENTE igual (cuerpo md5, SECURITY, owner,
  -- search_path, ACL, volatilidad). A1 conserva EXECUTE solo para authenticated.
  -- A1 y W1-W7 corren como postgres, que es el contexto que los guards dejan pasar.
  IF (SELECT count(*) FROM _g2c3a3_fns) <> 16 THEN
    RAISE EXCEPTION 'POSTCONDICION P8: el snapshot de funciones no tiene las 16 filas esperadas';
  END IF;
  FOR s IN SELECT * FROM _g2c3a3_fns LOOP
    SELECT md5(p.prosrc) AS src_md5, p.prosecdef, p.proowner, p.proconfig, p.proacl::text AS acl, p.provolatile INTO v_now
      FROM pg_proc p WHERE p.oid = s.oid;
    IF NOT FOUND OR v_now.src_md5 IS DISTINCT FROM s.src_md5 OR v_now.prosecdef IS DISTINCT FROM s.prosecdef
       OR v_now.proowner IS DISTINCT FROM s.proowner OR v_now.proconfig IS DISTINCT FROM s.proconfig
       OR v_now.acl IS DISTINCT FROM s.acl OR v_now.provolatile IS DISTINCT FROM s.provolatile THEN
      RAISE EXCEPTION 'POSTCONDICION P6/P7/P8: % cambio (A3 no toca writers, A1 ni SEC-08B)', s.firma;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION P6: el EXECUTE de A1 dejo de ser solo authenticated';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'POSTCONDICION P8: se esperaban los mismos 8 writers de stock (W1-W7 + A1), hay %', v_n;
  END IF;
  IF NOT pg_has_role('postgres', 'postgres', 'MEMBER') THEN
    RAISE EXCEPTION 'POSTCONDICION P7: postgres no es reconocido como contexto canonico';
  END IF;

  -- POSTCONDICION P9 · inventory_movements: la API no puede INSERT/UPDATE/DELETE
  -- (ni TRUNCATE); las tres policies de escritura ya no existen.
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(v_role, v_mov, v_priv) THEN
        RAISE EXCEPTION 'POSTCONDICION P9: % conserva % sobre inventory_movements', v_role, v_priv;
      END IF;
    END LOOP;
    IF has_any_column_privilege(v_role, v_mov, 'INSERT') OR has_any_column_privilege(v_role, v_mov, 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICION P9: % conserva INSERT/UPDATE de columna sobre inventory_movements', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory_movements' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION P9: quedan policies de escritura sobre inventory_movements';
  END IF;

  -- POSTCONDICION P10 / P11 / P12 · el append-only esta montado y su contrato es
  -- el esperado: INSERT solo canonico (los writers corren como postgres y
  -- siguen insertando), UPDATE/DELETE rechazados salvo acciones referenciales,
  -- TRUNCATE rechazado.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = v_mov AND t.tgname = 'trg_inventory_movements_append_only' AND t.tgenabled = 'O'
                    AND t.tgfoid = 'private.tg_inventory_movements_append_only()'::regprocedure
                    AND pg_get_triggerdef(t.oid) ~ 'BEFORE INSERT OR DELETE OR UPDATE ON public\.inventory_movements FOR EACH ROW')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t
                     WHERE t.tgrelid = v_mov AND t.tgname = 'trg_inventory_movements_no_truncate' AND t.tgenabled = 'O'
                       AND t.tgfoid = 'private.tg_inventory_movements_append_only()'::regprocedure
                       AND pg_get_triggerdef(t.oid) ~ 'BEFORE TRUNCATE ON public\.inventory_movements FOR EACH STATEMENT') THEN
    RAISE EXCEPTION 'POSTCONDICION P10/P11/P12: faltan los triggers append-only de inventory_movements';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'private.tg_inventory_movements_append_only()'::regprocedure;
  IF (SELECT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        FROM pg_proc p WHERE p.oid = 'private.tg_inventory_movements_append_only()'::regprocedure)
     OR position('pg_catalog.pg_has_role(current_user, ''postgres'', ''MEMBER'')' IN v_src) = 0
     OR position('(to_jsonb(NEW) - c_detach) = (to_jsonb(OLD) - c_detach)' IN v_src) = 0
     OR position('NOT EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = OLD.business_id)' IN v_src) = 0
     OR v_src ~* 'auth\.uid' THEN
    RAISE EXCEPTION 'POSTCONDICION P10/P11/P12: el append-only no tiene el contrato esperado';
  END IF;
  SELECT array_agg(t.tgname::text ORDER BY t.tgname::text COLLATE "C") INTO v_names
    FROM pg_trigger t WHERE t.tgrelid = v_mov AND NOT t.tgisinternal;
  IF v_names IS DISTINCT FROM ARRAY['trg_inventory_movements_append_only', 'trg_inventory_movements_no_truncate'] THEN
    RAISE EXCEPTION 'POSTCONDICION P10: inventory_movements tiene triggers inesperados: %', v_names;
  END IF;

  -- POSTCONDICION P13 · la FK del historial es RESTRICT: mismo nombre, mismas
  -- columnas, validada, no diferible. Las otras FKs, intactas. Indices, intactos.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN _g2c3a3_fks f ON f.conname = c.conname AND f.relid = v_mov
     WHERE c.conrelid = v_mov AND c.contype = 'f' AND c.confrelid = v_inv
       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_mov AND a.attname = 'inventory_item_id')]::int2[]
       AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = v_inv AND a.attname = 'id')]::int2[]
       AND c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated AND NOT c.condeferrable
       AND f.def ~ 'ON DELETE CASCADE') THEN
    RAISE EXCEPTION 'POSTCONDICION P13: la FK inventory_item_id no quedo ON DELETE RESTRICT (mismo nombre, validada)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint c
   WHERE c.conrelid = v_mov AND c.contype = 'f' AND c.confrelid = v_inv AND c.confdeltype = 'c';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION P13: queda una FK en CASCADE de inventory_movements hacia inventory';
  END IF;
  IF EXISTS (SELECT conname, relid, def, convalidated FROM _g2c3a3_fks
              WHERE NOT (relid = v_mov AND def ~ '^FOREIGN KEY \(inventory_item_id\) REFERENCES')
             EXCEPT
             SELECT c.conname::text, c.conrelid, pg_get_constraintdef(c.oid), c.convalidated
               FROM pg_constraint c
              WHERE c.contype = 'f' AND (c.conrelid = v_mov OR c.confrelid = v_inv))
     OR (SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND (c.conrelid = v_mov OR c.confrelid = v_inv))
        <> (SELECT count(*) FROM _g2c3a3_fks) THEN
    RAISE EXCEPTION 'POSTCONDICION P13: cambiaron otras FKs de inventory_movements o hacia inventory';
  END IF;
  IF EXISTS (SELECT idx, def FROM _g2c3a3_idx
             EXCEPT SELECT i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid = v_mov)
     OR EXISTS (SELECT i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid = v_mov
                EXCEPT SELECT idx, def FROM _g2c3a3_idx) THEN
    RAISE EXCEPTION 'POSTCONDICION P13: cambiaron los indices de inventory_movements';
  END IF;

  -- POSTCONDICION P15 · SEC-08B no cambio: el SELECT por columna de las dos
  -- tablas es identico (el costo sigue oculto), las vistas de costo identicas.
  IF EXISTS (SELECT rel, col, grantee FROM _g2c3a3_colsel
             EXCEPT
             SELECT c.relname::text, att.attname::text, a.grantee::regrole::text
               FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
               CROSS JOIN LATERAL aclexplode(att.attacl) a
              WHERE c.oid IN (v_inv, v_mov) AND a.privilege_type = 'SELECT')
     OR EXISTS (SELECT c.relname::text, att.attname::text, a.grantee::regrole::text
                  FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
                  CROSS JOIN LATERAL aclexplode(att.attacl) a
                 WHERE c.oid IN (v_inv, v_mov) AND a.privilege_type = 'SELECT'
                EXCEPT SELECT rel, col, grantee FROM _g2c3a3_colsel) THEN
    RAISE EXCEPTION 'POSTCONDICION P15: cambio el SELECT por columna (SEC-08B)';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_column_privilege(v_role, v_inv, 'cost_price', 'SELECT') OR has_column_privilege(v_role, v_inv, 'cost_price_usd', 'SELECT')
       OR has_column_privilege(v_role, v_mov, 'unit_cost', 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICION P15: % puede leer costo', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT v, acl, def_md5, opts FROM _g2c3a3_views
             EXCEPT SELECT c.oid::regclass::text, c.relacl::text, md5(pg_get_viewdef(c.oid)), c.reloptions::text
                      FROM pg_class c WHERE c.oid IN ('public.v_inventory_costs'::regclass, 'public.v_inventory_movement_costs'::regclass)) THEN
    RAISE EXCEPTION 'POSTCONDICION P15: cambiaron las vistas de costo de SEC-08B';
  END IF;

  -- POSTCONDICION P16 · policies: las de inventory identicas; en
  -- inventory_movements solo queda la de SELECT, identica. Ninguna nueva.
  IF EXISTS (SELECT tablename::text, policyname::text, permissive, cmd, roles::text, qual, with_check FROM pg_policies
              WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')
             EXCEPT SELECT * FROM _g2c3a3_policies) THEN
    RAISE EXCEPTION 'POSTCONDICION P16: A3 agrego o modifico policies';
  END IF;
  SELECT array_agg(p ORDER BY p COLLATE "C") INTO v_names
    FROM (SELECT p FROM _g2c3a3_policies
          EXCEPT SELECT policyname::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')) x;
  IF v_names IS DISTINCT FROM ARRAY['inventory_movements_delete', 'inventory_movements_insert', 'inventory_movements_update'] THEN
    RAISE EXCEPTION 'POSTCONDICION P16: las policies removidas no son exactamente las de escritura de movimientos: %', v_names;
  END IF;
  IF NOT (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid = v_inv)
     OR NOT (SELECT c.relrowsecurity AND NOT c.relforcerowsecurity FROM pg_class c WHERE c.oid = v_mov) THEN
    RAISE EXCEPTION 'POSTCONDICION P16: cambio la RLS de inventory/inventory_movements';
  END IF;

  -- POSTCONDICION P17 · los 5 triggers previos de inventory (incluido
  -- trg_sync_inventory_stock) siguen identicos y activos.
  IF EXISTS (SELECT * FROM _g2c3a3_triggers
             EXCEPT SELECT t.tgrelid::regclass::text, t.tgname::text, t.tgfoid, t.tgenabled, t.tgtype
                      FROM pg_trigger t WHERE t.tgrelid IN (v_inv, v_mov) AND NOT t.tgisinternal)
     OR (SELECT count(*) FROM _g2c3a3_triggers) <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v_inv AND t.tgname = 'trg_sync_inventory_stock' AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'POSTCONDICION P17: cambiaron los triggers previos de inventory (trg_sync_inventory_stock incluido)';
  END IF;

  -- POSTCONDICION P18 · negativos permitidos: sin CHECK sobre el stock; los
  -- guards nuevos no clampan ni rechazan por saldo insuficiente.
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = v_inv AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) ~* '\ystock(_quantity)?\y') THEN
    RAISE EXCEPTION 'POSTCONDICION P18: hay un CHECK sobre el stock (el contrato permite negativos)';
  END IF;
  SELECT string_agg(p.prosrc, ' ') INTO v_src FROM pg_proc p
   WHERE p.oid IN ('private.tg_inventory_stock_authority_guard()'::regprocedure, 'private.tg_inventory_movements_append_only()'::regprocedure);
  IF v_src ~* '\y(greatest|least)\s*\(' OR v_src ~* 'insuficiente' OR v_src ~* '(<|<=)\s*0\s*then' THEN
    RAISE EXCEPTION 'POSTCONDICION P18: un guard de A3 clampa o rechaza stock negativo';
  END IF;

  RAISE NOTICE 'G2-C.3A3 OK · inventory: INSERT/UPDATE de tabla revocados a anon/authenticated; authenticated reconstruido '
    'por columna (55 de metadata, sin stock/stock_quantity); guard zz_inventory_stock_authority_guard (rol canonico, 42501) '
    '· inventory_movements: sin INSERT/UPDATE/DELETE de API, sin policies de escritura, append-only (INSERT canonico; '
    'UPDATE/DELETE/TRUNCATE -> 42501 salvo SET NULL/CASCADE referenciales) · FK inventory_item_id ON DELETE RESTRICT '
    '· A1, W1-W7, SEC-08B, SELECT, trg_sync_inventory_stock, indices y otras FKs intactos · cero DML.';
END
$post$;

COMMIT;
