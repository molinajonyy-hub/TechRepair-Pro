-- ============================================================================
-- G2-C.3B0 · StockRepairTool sin autoridad sobre pedidos mayoristas
--
-- Discovery: docs/g2c3-stock-authority-and-wholesale-idempotency-discovery.md
-- (worktree g2-c3-authority-discovery, base eebccff), seccion 9.
--
-- EL BUG. public.preview_missing_stock_movements y
-- public.repair_missing_stock_movements (W6) trataban como "venta sin stock
-- descontado" a TODO wholesale_order_items con stock_processed = false cuyo
-- pedido no estuviera cancelled/rejected. Desde G2-C.1 (PEDIDO MAYORISTA =
-- ESTADO COMERCIAL; COMPROBANTE = UNICA AUTORIDAD ECONOMICA Y DE STOCK) ningun
-- camino marca esos items, asi que todo pedido no cancelado quedaba candidato
-- para siempre. Reproducido sobre un replay limpio de eebccff:
--   · pedido pending_whatsapp, nunca convertido      10 -> 8
--   · pedido ya convertido (el checkout desconto 3)  10 -> 7 -> 4  (doble salida)
--   · pedido marcado invoiced sin comprobante         10 -> 9
--   · pedido reparado y despues cancelado             10 -> 6, sin reversa
-- y la reparacion escribia los marcadores stock_* de wholesale_order_items que
-- G2-C.1 dejo congelados.
--
-- Ademas la rama de comprobantes procesaba lineas con inventory_id aunque su
-- tipo_linea fuera 'servicio' u 'otro'. El checkout canonico solo mueve stock
-- para COALESCE(tipo_linea, 'producto') IN ('producto', 'repuesto') (la
-- PRECONDICION 3 lo verifica sobre su cuerpo vivo): la herramienta "reparaba"
-- justo lo que el checkout omite a proposito.
--
-- EL CONTRATO. La herramienta solo reconstruye salidas de COMPROBANTES, y solo
-- de las lineas que el checkout habria descontado. Ningun pedido mayorista
-- mueve stock, tampoco por reparacion.
--
-- QUE CAMBIA (diff funcional minimo, cuerpo canonico completo):
--   preview: se elimina la rama UNION ALL 'wholesale_order'; la rama de
--            comprobantes gana el filtro de tipo_linea.
--   repair : se elimina la rama wholesale del conjunto de productos a bloquear
--            y el loop wholesale entero; el conjunto y el loop de comprobantes
--            ganan el mismo filtro de tipo_linea.
--
-- QUE NO CAMBIA. Firmas, OID, owner, SECURITY DEFINER, volatilidad (preview
-- STABLE, repair VOLATILE), search_path, ACL, autoridad (owner/admin +
-- capability inventory sobre el tenant canonico), lock canonico G2-C.2
-- (private.lock_inventory_rows, por negocio, ORDER BY id, FOR NO KEY UPDATE,
-- ANTES de leer o escribir stock), SKIP LOCKED sobre las lineas,
-- p_allow_negative, marcadores de comprobante, idempotencia, notas de los
-- movimientos (mojibake heredado incluido, byte a byte) y forma de la
-- respuesta: la clave pedidos_mayoristas_procesados sigue presente y vale 0.
-- El checkout canonico y G2-C.1 no se tocan. No se repara, compensa ni
-- rellena stock historico (produccion: 0 pedidos mayoristas).
--
-- Cuerpos: tomados del texto que dejo en el repo la ultima migracion que
-- definio cada funcion (preview: 20260907120000; repair: 20261006120000), con
-- SOLO las ediciones de arriba. La POSTCONDICION 4 fija el md5 del resultado.
--
-- FAIL-CLOSED: si una precondicion no se cumple, nada se aplica.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_sig text;
  v_n   bigint;
BEGIN
  -- PRECONDICION 1 · las firmas exactas resuelven, y G2-C.2 esta aplicado
  -- (el helper de lock existe: W6 depende de el).
  FOREACH v_sig IN ARRAY ARRAY[
    'public.preview_missing_stock_movements(uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'private.lock_inventory_rows(uuid,uuid[])',
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PRECONDICION 1: la firma % no resuelve a ninguna funcion', v_sig;
    END IF;
  END LOOP;

  -- PRECONDICION 2 · contrato de tablas y columnas que usan los dos cuerpos.
  SELECT count(*) INTO v_n
    FROM (VALUES
      ('comprobante_items', 'id'), ('comprobante_items', 'comprobante_id'),
      ('comprobante_items', 'business_id'), ('comprobante_items', 'inventory_id'),
      ('comprobante_items', 'cantidad'), ('comprobante_items', 'tipo_linea'),
      ('comprobante_items', 'stock_processed'), ('comprobante_items', 'stock_processed_at'),
      ('comprobante_items', 'stock_movement_id'),
      ('comprobantes', 'id'), ('comprobantes', 'business_id'), ('comprobantes', 'estado'),
      ('comprobantes', 'status'), ('comprobantes', 'estado_comercial'), ('comprobantes', 'created_at'),
      ('inventory', 'id'), ('inventory', 'business_id'), ('inventory', 'name'),
      ('inventory', 'stock_quantity'), ('inventory', 'updated_at'),
      ('inventory_movements', 'business_id'), ('inventory_movements', 'inventory_item_id'),
      ('inventory_movements', 'movement_type'), ('inventory_movements', 'quantity'),
      ('inventory_movements', 'previous_stock'), ('inventory_movements', 'new_stock'),
      ('inventory_movements', 'reference_type'), ('inventory_movements', 'reference_id'),
      ('inventory_movements', 'note')
    ) AS e(tabla, columna)
    JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.table_name = e.tabla AND c.column_name = e.columna;
  IF v_n <> 29 THEN
    RAISE EXCEPTION 'PRECONDICION 2: el contrato de columnas cambio (% de 29 columnas presentes)', v_n;
  END IF;

  -- PRECONDICION 3 · el filtro nuevo replica una regla VIVA: el checkout
  -- canonico solo mueve stock para producto/repuesto con tipo_linea NULL
  -- tratado como producto. Si esa regla cambio, este contrato hay que revisarlo.
  IF position($r$COALESCE(v_item->>'tipo_linea', 'producto') IN ('producto', 'repuesto')$r$ IN
       (SELECT prosrc FROM pg_proc
         WHERE oid = to_regprocedure('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)'))) = 0 THEN
    RAISE EXCEPTION 'PRECONDICION 3: el checkout ya no restringe el stock a producto/repuesto: revisar el contrato de la reparacion';
  END IF;
END
$pre$;

-- Snapshot de lo que CREATE OR REPLACE debe preservar, por OID.
--   orig_md5 = md5 del cuerpo en eebccff SIN retornos de carro (verificado
--              igual en produccion, lectura read-only del 2026-09-24).
--   new_md5  = md5 del cuerpo que instala esta migracion.
CREATE TEMP TABLE _g2c3b0_snapshot ON COMMIT DROP AS
SELECT p.oid, f.firma, f.orig_md5, f.new_md5,
       p.prosecdef, p.proowner, p.proconfig, p.proacl, p.provolatile,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)    AS result,
       md5(replace(p.prosrc, E'\r', '')) AS src_md5,
       (regexp_match(p.prosrc, $r$'(Reparaci[^']*venta anterior)'$r$))[1] AS nota_comprobante
  FROM (VALUES
    ('public.preview_missing_stock_movements(uuid)',            'a3ca860a28915f324081243449b4a619', 'b9845861197bb73951fb2a5ca8e50508'),
    ('public.repair_missing_stock_movements(uuid,boolean)',     '5574996aa52ce4e8ac1a22242c591fad',  '618fbf5a7683134c93fb49e73b0cbca9')
  ) AS f(firma, orig_md5, new_md5)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.firma);

-- Catalogo de G2-C.2: los 7 writers de stock server-side + el helper. Esta
-- migracion solo puede cambiar el cuerpo de W6.
CREATE TEMP TABLE _g2c3b0_writers ON COMMIT DROP AS
SELECT p.oid, p.oid::regprocedure::text AS firma, md5(replace(p.prosrc, E'\r', '')) AS src_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
   AND (p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*='
        OR p.oid = to_regprocedure('private.lock_inventory_rows(uuid,uuid[])'));

DO $pre4$
DECLARE s record;
BEGIN
  IF (SELECT count(*) FROM _g2c3b0_snapshot) <> 2 THEN
    RAISE EXCEPTION 'PRECONDICION 4: se esperaban 2 funciones en el snapshot, hay %', (SELECT count(*) FROM _g2c3b0_snapshot);
  END IF;

  FOR s IN SELECT * FROM _g2c3b0_snapshot LOOP
    -- PRECONDICION 4 · SIN DRIFT: el cuerpo es exactamente el de eebccff.
    IF s.src_md5 IS DISTINCT FROM s.orig_md5 THEN
      RAISE EXCEPTION 'PRECONDICION 4: % tiene drift (md5 % <> eebccff %): no se pisa, revisar antes', s.firma, s.src_md5, s.orig_md5;
    END IF;

    -- PRECONDICION 5 · owner, SECURITY DEFINER, search_path y ACL esperados.
    IF pg_get_userbyid(s.proowner) <> 'postgres' OR s.prosecdef IS NOT TRUE
       OR s.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'PRECONDICION 5: % cambio owner/SECURITY DEFINER/search_path (%, %, %)',
        s.firma, pg_get_userbyid(s.proowner), s.prosecdef, s.proconfig;
    END IF;
    IF (SELECT array_agg(g.v ORDER BY g.v)
          FROM (SELECT format('%s:%s', CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                              a.privilege_type) AS v
                  FROM aclexplode(s.proacl) a) g)
       IS DISTINCT FROM ARRAY['authenticated:EXECUTE', 'postgres:EXECUTE', 'service_role:EXECUTE'] THEN
      RAISE EXCEPTION 'PRECONDICION 5: % cambio su ACL (%)', s.firma, s.proacl;
    END IF;
  END LOOP;

  -- PRECONDICION 6 · forma exacta de firma y respuesta, y volatilidad.
  IF (SELECT args FROM _g2c3b0_snapshot WHERE firma LIKE 'public.preview%') <> 'p_business_id uuid'
     OR (SELECT result FROM _g2c3b0_snapshot WHERE firma LIKE 'public.preview%') <>
        'TABLE(source text, sale_id uuid, item_id uuid, inventory_id uuid, product_name text, quantity numeric, current_stock integer, can_deduct boolean, sale_date timestamp with time zone)'
     OR (SELECT provolatile FROM _g2c3b0_snapshot WHERE firma LIKE 'public.preview%') <> 's' THEN
    RAISE EXCEPTION 'PRECONDICION 6: cambio la firma, la respuesta o la volatilidad de preview_missing_stock_movements';
  END IF;
  IF (SELECT args FROM _g2c3b0_snapshot WHERE firma LIKE 'public.repair%') <> 'p_business_id uuid, p_allow_negative boolean DEFAULT false'
     OR (SELECT result FROM _g2c3b0_snapshot WHERE firma LIKE 'public.repair%') <> 'jsonb'
     OR (SELECT provolatile FROM _g2c3b0_snapshot WHERE firma LIKE 'public.repair%') <> 'v' THEN
    RAISE EXCEPTION 'PRECONDICION 6: cambio la firma, la respuesta o la volatilidad de repair_missing_stock_movements';
  END IF;

  -- PRECONDICION 7 · catalogo G2-C.2: 7 writers de stock + helper, W6 entre ellos.
  IF (SELECT count(*) FROM _g2c3b0_writers) <> 8
     OR NOT EXISTS (SELECT 1 FROM _g2c3b0_writers
                     WHERE oid = to_regprocedure('public.repair_missing_stock_movements(uuid,boolean)')) THEN
    RAISE EXCEPTION 'PRECONDICION 7: el catalogo de writers de stock de G2-C.2 cambio (% filas, se esperaban 7 + helper)',
      (SELECT count(*) FROM _g2c3b0_writers);
  END IF;
END
$pre4$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CUERPOS CANONICOS (CREATE OR REPLACE conserva OID, owner y ACL;
--    SECURITY DEFINER, STABLE y search_path se repiten tal cual)
-- ════════════════════════════════════════════════════════════════════════════

-- ── preview_missing_stock_movements ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_missing_stock_movements(p_business_id uuid)
 RETURNS TABLE(source text, sale_id uuid, item_id uuid, inventory_id uuid, product_name text, quantity numeric, current_stock integer, can_deduct boolean, sale_date timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
   SELECT * FROM (
     SELECT
       'comprobante'::text,
       ci.comprobante_id,
       ci.id,
       ci.inventory_id,
       COALESCE(inv.name, '(sin nombre)'),
       ci.cantidad,
       COALESCE(inv.stock_quantity, 0),
       (COALESCE(inv.stock_quantity, 0) >= ci.cantidad::integer),
       c.created_at
     FROM public.comprobante_items ci
     JOIN public.comprobantes c   ON c.id  = ci.comprobante_id AND c.business_id = p_business_id
     JOIN public.inventory    inv ON inv.id = ci.inventory_id AND inv.business_id = p_business_id
     WHERE ci.business_id   = p_business_id
       AND ci.inventory_id  IS NOT NULL
       AND ci.cantidad        > 0
       AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND c.estado          NOT IN ('anulado')
       AND c.status          NOT IN ('cancelled')
       AND c.estado_comercial NOT IN ('anulado')
       AND c.estado_comercial IS DISTINCT FROM NULL
       -- G2-C.3B0: solo las lineas que el checkout descuenta, y ningun pedido
       -- mayorista (PEDIDO MAYORISTA = ESTADO COMERCIAL; COMPROBANTE = STOCK).
       AND COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')
   ) sub
   ORDER BY sub.created_at;
END;
 $function$;

-- ── W6 · repair_missing_stock_movements ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.repair_missing_stock_movements(p_business_id uuid, p_allow_negative boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $function$
 DECLARE
   v_comp_count     int     := 0;
   v_ws_count       int     := 0;
   v_skip_stock     int     := 0;
   v_skip_product   int     := 0;
   v_total_units    numeric := 0;
   v_movement_id    uuid;
   v_prev_stock     int;
   v_new_stock      int;
   r                record;
   v_inv_ids        uuid[];
 BEGIN

  -- LOTE 2: actor -> canonical active tenant -> existing action authority.
  PERFORM public._require_business_member(p_business_id, ARRAY['owner', 'admin']);
  IF p_business_id IS DISTINCT FROM public.current_user_business_id()
     OR NOT public.current_user_can('inventory') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

   -- G2-C.2 · lock canonico de inventario: la union de productos candidatos se
   -- bloquea UNA vez, ORDER BY id, acotada al negocio, antes de mover stock. Los
   -- loops solo procesan lineas de productos de ese conjunto: una linea que
   -- aparezca despues queda para la proxima reparacion en vez de mutarse sin
   -- lock. Una reparacion concurrente espera aca y despues relee las lineas ya
   -- marcadas (stock_processed) sin duplicar impacto. Los productos que no son
   -- del negocio no se bloquean y siguen contando como no encontrados.
   SELECT COALESCE(array_agg(DISTINCT x.inventory_id), '{}'::uuid[])
     INTO v_inv_ids
     FROM (
       SELECT ci.inventory_id
         FROM public.comprobante_items ci
         JOIN public.comprobantes c ON c.id = ci.comprobante_id AND c.business_id = p_business_id
        WHERE ci.business_id   = p_business_id
          AND ci.inventory_id  IS NOT NULL
          AND ci.cantidad        > 0
          AND (ci.stock_processed = false OR ci.stock_processed IS NULL)
          AND c.estado          NOT IN ('anulado')
          AND c.status          NOT IN ('cancelled')
          AND c.estado_comercial NOT IN ('anulado')
          AND c.estado_comercial IS DISTINCT FROM NULL
          AND COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')
     ) x;
   PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);

   FOR r IN
     SELECT ci.id, ci.comprobante_id, ci.inventory_id, ci.cantidad
     FROM   public.comprobante_items ci
     JOIN   public.comprobantes c ON c.id = ci.comprobante_id AND c.business_id = p_business_id
     WHERE  ci.business_id   = p_business_id
       AND  ci.inventory_id  IS NOT NULL
       AND  ci.cantidad        > 0
       AND  (ci.stock_processed = false OR ci.stock_processed IS NULL)
       AND  c.estado          NOT IN ('anulado')
       AND  c.status          NOT IN ('cancelled')
       AND  c.estado_comercial NOT IN ('anulado')
       AND  c.estado_comercial IS DISTINCT FROM NULL
       AND  COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')
       AND  ci.inventory_id = ANY (v_inv_ids)
     FOR UPDATE OF ci SKIP LOCKED
   LOOP
     SELECT stock_quantity INTO v_prev_stock
     FROM public.inventory
     WHERE id = r.inventory_id AND business_id = p_business_id;

     IF NOT FOUND THEN v_skip_product := v_skip_product + 1; CONTINUE; END IF;

     IF v_prev_stock < r.cantidad::int AND NOT p_allow_negative THEN
       v_skip_stock := v_skip_stock + 1; CONTINUE;
     END IF;

     v_new_stock := v_prev_stock - r.cantidad::int;

     UPDATE public.inventory SET stock_quantity = v_new_stock, updated_at = now()
      WHERE id = r.inventory_id AND business_id = p_business_id;

     INSERT INTO public.inventory_movements
       (business_id, inventory_item_id, movement_type, quantity,
        previous_stock, new_stock, reference_type, reference_id, note)
     VALUES
       (p_business_id, r.inventory_id, 'sale', -r.cantidad::int,
        v_prev_stock, v_new_stock, 'comprobante', r.comprobante_id,
        'ReparaciÃ³n de stock â€” venta anterior')
     RETURNING id INTO v_movement_id;

     UPDATE public.comprobante_items
        SET stock_processed = true, stock_processed_at = now(), stock_movement_id = v_movement_id
      WHERE id = r.id;

     v_comp_count  := v_comp_count  + 1;
     v_total_units := v_total_units + r.cantidad;
   END LOOP;

   -- G2-C.3B0: sin loop de pedidos mayoristas. Un pedido es estado comercial y
   -- su unica salida de stock es el comprobante. pedidos_mayoristas_procesados
   -- queda en la respuesta por compatibilidad y vale siempre 0.

   RETURN jsonb_build_object(
     'comprobantes_procesados',         v_comp_count,
     'pedidos_mayoristas_procesados',   v_ws_count,
     'items_sin_stock_suficiente',      v_skip_stock,
     'items_producto_no_encontrado',    v_skip_product,
     'total_unidades_descontadas',      v_total_units
   );
 END;
 $function$;

-- No-op sobre un ACL ya materializado sin PUBLIC (la POSTCONDICION 2 lo compara
-- contra el snapshot); deja la constancia que exige guard:secdef-exposure (R2).
REVOKE ALL ON FUNCTION public.preview_missing_stock_movements(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_missing_stock_movements(uuid, boolean) FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  s       record;
  v_now   record;
  v_prev  text;
  v_rep   text;
  v_filt  constant text := $r$COALESCE(ci.tipo_linea, 'producto') IN ('producto', 'repuesto')$r$;
  v_n     int;
BEGIN
  FOR s IN SELECT * FROM _g2c3b0_snapshot LOOP
    SELECT p.oid, p.prosecdef, p.proowner, p.proconfig, p.proacl, p.provolatile,
           pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result,
           md5(replace(p.prosrc, E'\r', '')) AS src_md5
      INTO v_now
      FROM pg_proc p WHERE p.oid = to_regprocedure(s.firma);

    -- POSTCONDICION 1 · la firma sigue existiendo con el MISMO OID.
    IF v_now.oid IS DISTINCT FROM s.oid THEN
      RAISE EXCEPTION 'POSTCONDICION 1: % no resuelve al mismo OID (% -> %)', s.firma, s.oid, v_now.oid;
    END IF;
    -- POSTCONDICION 2 · owner, SECURITY DEFINER, search_path, ACL y volatilidad preservados.
    IF v_now.prosecdef   IS DISTINCT FROM s.prosecdef   THEN RAISE EXCEPTION 'POSTCONDICION 2: % cambio prosecdef', s.firma; END IF;
    IF v_now.proowner    IS DISTINCT FROM s.proowner    THEN RAISE EXCEPTION 'POSTCONDICION 2: % cambio proowner', s.firma; END IF;
    IF v_now.proconfig   IS DISTINCT FROM s.proconfig   THEN RAISE EXCEPTION 'POSTCONDICION 2: % cambio proconfig', s.firma; END IF;
    IF v_now.proacl      IS DISTINCT FROM s.proacl      THEN RAISE EXCEPTION 'POSTCONDICION 2: % cambio proacl', s.firma; END IF;
    IF v_now.provolatile IS DISTINCT FROM s.provolatile THEN RAISE EXCEPTION 'POSTCONDICION 2: % cambio su volatilidad', s.firma; END IF;
    -- POSTCONDICION 3 · misma firma y misma forma de respuesta.
    IF v_now.args IS DISTINCT FROM s.args OR v_now.result IS DISTINCT FROM s.result THEN
      RAISE EXCEPTION 'POSTCONDICION 3: % cambio su firma o su respuesta', s.firma;
    END IF;
    -- POSTCONDICION 4 · el cuerpo instalado es exactamente el de esta migracion.
    IF v_now.src_md5 IS DISTINCT FROM s.new_md5 THEN
      RAISE EXCEPTION 'POSTCONDICION 4: % quedo con un cuerpo inesperado (md5 % <> %)', s.firma, v_now.src_md5, s.new_md5;
    END IF;
    IF has_function_privilege('anon', s.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM aclexplode(v_now.proacl) a WHERE a.grantee = 0) THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % quedo ejecutable por anon/PUBLIC', s.firma;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_prev FROM pg_proc WHERE oid = to_regprocedure('public.preview_missing_stock_movements(uuid)');
  SELECT prosrc INTO v_rep  FROM pg_proc WHERE oid = to_regprocedure('public.repair_missing_stock_movements(uuid,boolean)');

  -- POSTCONDICION 5 · ningun rastro de pedidos mayoristas en ninguno de los dos:
  -- ni candidato, ni lectura, ni escritura de wholesale_order_items, ni
  -- movimientos con reference_type 'wholesale_order'.
  IF v_prev ~* 'wholesale' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: preview_missing_stock_movements todavia menciona pedidos mayoristas';
  END IF;
  IF v_rep ~* 'wholesale' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: repair_missing_stock_movements todavia menciona pedidos mayoristas';
  END IF;
  IF v_rep ~* 'update\s+(public\.)?wholesale_order_items' OR position($r$'wholesale_order'$r$ IN v_rep) > 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: la reparacion puede escribir items mayoristas o movimientos wholesale_order';
  END IF;

  -- POSTCONDICION 6 · el filtro de tipo_linea del checkout: 1 vez en preview,
  -- 2 veces en repair (conjunto a bloquear + loop).
  IF (length(v_prev) - length(replace(v_prev, v_filt, ''))) / length(v_filt) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 6: preview no filtra tipo_linea producto/repuesto exactamente una vez';
  END IF;
  IF (length(v_rep) - length(replace(v_rep, v_filt, ''))) / length(v_filt) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICION 6: repair no filtra tipo_linea producto/repuesto en el conjunto y en el loop';
  END IF;

  -- POSTCONDICION 7 · W6 conserva el lock canonico G2-C.2: conjunto DISTINCT,
  -- helper por negocio, y el lock ANTES de la primera lectura o escritura de stock.
  IF position('SELECT COALESCE(array_agg(DISTINCT x.inventory_id)' IN v_rep) = 0
     OR position('PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);' IN v_rep) = 0
     OR position('PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);' IN v_rep)
          > position('SELECT stock_quantity INTO v_prev_stock' IN v_rep)
     OR position('PERFORM private.lock_inventory_rows(p_business_id, v_inv_ids);' IN v_rep)
          > position('UPDATE public.inventory SET stock_quantity' IN v_rep) THEN
    RAISE EXCEPTION 'POSTCONDICION 7: W6 perdio el lock canonico o lo toma despues de leer/escribir stock';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.lock_inventory_rows(uuid,uuid[])'))
       !~* 'order\s+by\s+i\.id\s+for\s+no\s+key\s+update' THEN
    RAISE EXCEPTION 'POSTCONDICION 7: el helper de lock ya no es ORDER BY id FOR NO KEY UPDATE';
  END IF;

  -- POSTCONDICION 8 · ninguna lectura de inventory con FOR UPDATE (G2-C.2R).
  IF v_rep ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y'
     OR v_prev ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: aparecio un lock FOR UPDATE sobre inventory';
  END IF;

  -- POSTCONDICION 9 · forma de la respuesta de repair: las 5 claves, y
  -- pedidos_mayoristas_procesados atado a un contador que nunca se incrementa.
  IF position($r$'comprobantes_procesados'$r$ IN v_rep) = 0
     OR position($r$'pedidos_mayoristas_procesados'$r$ IN v_rep) = 0
     OR position($r$'items_sin_stock_suficiente'$r$ IN v_rep) = 0
     OR position($r$'items_producto_no_encontrado'$r$ IN v_rep) = 0
     OR position($r$'total_unidades_descontadas'$r$ IN v_rep) = 0
     OR v_rep !~ $r$'pedidos_mayoristas_procesados',\s+v_ws_count$r$
     OR v_rep !~ 'v_ws_count\s+int\s+:=\s+0;'
     OR v_rep ~ 'v_ws_count\s*:=\s*v_ws_count' THEN
    RAISE EXCEPTION 'POSTCONDICION 9: cambio la forma de la respuesta de repair o pedidos_mayoristas_procesados puede ser <> 0';
  END IF;
  -- preview conserva su unica rama, la de comprobantes.
  IF position($r$'comprobante'::text$r$ IN v_prev) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 9: preview perdio la rama de comprobantes';
  END IF;

  -- POSTCONDICION 10 · la nota de los movimientos de reparacion se conserva byte a byte.
  IF position((SELECT nota_comprobante FROM _g2c3b0_snapshot WHERE firma LIKE 'public.repair%') IN v_rep) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 10: cambio la nota de los movimientos de reparacion';
  END IF;

  -- POSTCONDICION 11 · catalogo G2-C.2 intacto salvo el cuerpo de W6: mismos
  -- 7 writers + helper, y los otros 7 objetos con el mismo cuerpo.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND (p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*='
          OR p.oid = to_regprocedure('private.lock_inventory_rows(uuid,uuid[])'))
     AND p.oid IN (SELECT oid FROM _g2c3b0_writers);
  IF v_n <> 8 OR (SELECT count(*)
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
                     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=') <> 7 THEN
    RAISE EXCEPTION 'POSTCONDICION 11: cambio el catalogo de writers de stock de G2-C.2';
  END IF;
  FOR s IN SELECT w.firma FROM _g2c3b0_writers w JOIN pg_proc p ON p.oid = w.oid
            WHERE w.oid <> to_regprocedure('public.repair_missing_stock_movements(uuid,boolean)')
              AND md5(replace(p.prosrc, E'\r', '')) IS DISTINCT FROM w.src_md5 LOOP
    RAISE EXCEPTION 'POSTCONDICION 11: % cambio su cuerpo (esta migracion solo toca W6 y preview)', s.firma;
  END LOOP;

  RAISE NOTICE 'G2-C.3B0 OK · preview/repair sin rama mayorista (0 candidatos, 0 movimientos wholesale_order, '
    'marcadores de wholesale_order_items intactos) · lineas de comprobante solo producto/repuesto como el checkout '
    '· W6 conserva el lock canonico G2-C.2 · firma/OID/owner/secdef/search_path/ACL/respuesta preservados '
    '· pedidos_mayoristas_procesados = 0 por compatibilidad';
END
$post$;

COMMIT;
