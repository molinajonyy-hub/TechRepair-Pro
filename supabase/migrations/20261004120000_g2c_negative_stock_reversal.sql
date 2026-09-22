-- ============================================================================
-- G2-C · Stock simetrico: la salida deja de clampar a cero.
--
-- EL BUG (reproducido en discovery de BETA-GATE-2)
-- ------------------------------------------------
-- La SALIDA de stock clampaba a cero y la REVERSA era aritmetica pura, asi que
-- una venta con sobreventa seguida de su anulacion FABRICABA unidades:
--
--     stock inicial   2
--     venta       5   ->  GREATEST(2 - 5, 0) =  0        <- se pierden 3
--     reversa    +5   ->  0 + 5              =  5        <- aparecen 3 de la nada
--
-- El fisico era 2 y el sistema termina diciendo 5.
--
-- Peor todavia: la fila del movimiento quedaba internamente inconsistente,
-- porque `quantity` NO se clampaba pero `new_stock` si:
--
--     quantity = -5 , previous_stock = 2 , new_stock = 0
--     new_stock - previous_stock = -2  !=  quantity = -5
--
-- Es decir, el propio libro de inventario dejaba de cerrar. Por eso la matriz
-- de G2-C valida movimientos y no solo `inventory.stock_quantity`.
--
-- CONTRATO DE PRODUCTO
-- --------------------
-- La sobreventa esta PERMITIDA de forma explicita: si el usuario confirma una
-- cantidad mayor al stock, la operacion NO se bloquea y el stock puede quedar
-- NEGATIVO. El stock negativo es informacion real (debo unidades), no un error
-- a esconder. Invariantes:
--
--     new_stock - previous_stock == quantity          (por cada movimiento)
--     operacion + su reversa exacta => stock_final == stock_inicial
--
-- ALCANCE (discovery sobre el CATALOGO VIVO, no sobre nombres historicos)
-- ----------------------------------------------------------------------
-- Escritores ACTIVOS de stock encontrados: 9. Los que restan stock por un
-- camino alcanzable desde producto y pueden quedar en deficit legitimo son
-- TRES, y son los que toca esta migracion:
--
--   1. private.create_comprobante_checkout_atomic  (venta por POS/comprobante)
--   2. public.adjust_stock_on_order_item           (repuesto de orden: INSERT y UPDATE)
--   3. public.delete_supplier_purchase_safe        (eliminar una compra)
--
-- El tercero entro en la REVISION HUMANA del PR #143. El primer discovery lo
-- habia dejado fuera por ser "reversion de una compra y no una venta con
-- sobreventa", y esa lectura era equivocada: es exactamente el mismo P0.
-- Comprar 5 (0->5), vender 5 (5->0) y despues eliminar la compra da
-- `GREATEST(0, 0-5) = 0` cuando la historia economica exige -5, y el
-- movimiento se escribe igual con `quantity = -5`. Vuelve a romper el
-- invariante y vuelve a fabricar unidades. Ademas es un camino VIVO del modulo
-- core de Proveedores:
--     src/pages/Suppliers.tsx -> suppliersService.deletePurchaseSafe()
--                             -> rpc('delete_supplier_purchase_safe')
--
-- NO se tocan, con motivo:
--   · private.sec08e_annul_comprobante_impl — la reversa YA era aritmetica
--     (`v_prev_stock + cantidad`). Es la mitad sana de la asimetria.
--   · public.repair_missing_stock_movements — su resta YA es aritmetica; su
--     `p_allow_negative=false` no es un clamp silencioso sino un SKIP
--     deliberado que ademas se reporta en `items_sin_stock_suficiente`.
--     Herramienta manual conservadora: no fabrica unidades. Se deja igual y se
--     prueban sus dos ramas en la matriz (caso 17).
--   · portalService._processWholesaleStock — MISMO defecto, pero es una
--     escritura CLIENT-SIDE del portal mayorista. Queda como G2-C.1 y BLOQUEA
--     el cierre definitivo de BETA-GATE-2. NO se parchea superficialmente
--     cambiando `Math.max` por una resta: la correccion correcta es moverlo
--     server-side, atomico, con lock, idempotencia y autoridad. Es un lote
--     propio. Ver docs/g2c-stock-discovery.md.
--   · inventoryMovementsService.registerMovement — no clampa; BLOQUEA negativo
--     de forma explicita. Es alta de producto y ajuste manual, no una venta.
--
-- COMO se aplica el cambio
-- ------------------------
-- Estas funciones son grandes (el checkout tiene ~700 lineas). Reescribirlas
-- enteras para cambiar una expresion invita a un drift silencioso justo en el
-- codigo mas critico del producto. En vez de eso se parchea sobre
-- `pg_get_functiondef()`, que devuelve la definicion COMPLETA y vigente, y se
-- reemplaza unicamente la expresion del clamp. Eso garantiza —y deja
-- demostrable— que el resto del cuerpo es identico byte a byte.
--
-- El objetivo se resuelve por FIRMA EXACTA con `to_regprocedure`, no por
-- schema+nombre: un overload futuro haria ambigua la busqueda por nombre y
-- podria parchear la funcion equivocada. Ya hay precedente de esa trampa en
-- este mismo lote — existe `public.create_comprobante_checkout_atomic` ademas
-- de la `private`, y la que corre es la segunda.
--
-- Es fail-closed en cuatro puntos: si la firma no resuelve, si el OID cambia
-- al recrear, si el patron no aparece exactamente una vez, o si el reemplazo
-- altera mas caracteres de los previstos, la migracion aborta.
--
-- Y se verifica que `CREATE OR REPLACE` conservo la configuracion: owner,
-- `prosecdef`, `proconfig` (search_path) y `proacl` se capturan ANTES y se
-- comparan DESPUES, por funcion.
-- ============================================================================

BEGIN;

-- ── 1..3 · Parche aritmetico sobre los tres writers del contrato ────────────
DO $g2c$
DECLARE
  t            record;
  v_par        text[];
  v_oid        oid;
  v_oid_post   oid;
  v_def        text;
  v_nuevo      text;
  v_ocurrencias int;
  v_delta_esperado int;
  -- Estado a preservar, capturado antes de recrear.
  v_secdef     boolean; v_owner oid; v_config text[]; v_acl aclitem[];
  v_secdef2    boolean; v_owner2 oid; v_config2 text[]; v_acl2 aclitem[];
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      -- Venta por POS / comprobante.
      ('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
       ARRAY[ARRAY['GREATEST(0, v_prev_stock - (v_item->>''cantidad'')::numeric)::integer',
                   '(v_prev_stock - (v_item->>''cantidad'')::numeric)::integer']]),
      -- Repuesto de orden: INSERT (alta) y UPDATE (subir cantidad).
      -- El DELETE ya era aritmetico y es la rama que hacia visible la asimetria.
      ('public.adjust_stock_on_order_item()',
       ARRAY[ARRAY['GREATEST(v_prev_stock - NEW.cantidad, 0)', 'v_prev_stock - NEW.cantidad'],
             ARRAY['GREATEST(v_prev_stock - v_qty_change, 0)', 'v_prev_stock - v_qty_change']]),
      -- Eliminar una compra: devuelve al proveedor lo que habia entrado.
      ('public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
       ARRAY[ARRAY['GREATEST(0, COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer)',
                   'COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer']])
    ) AS x(firma, pares)
  LOOP
    -- [a] Firma exacta o nada.
    v_oid := to_regprocedure(t.firma);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'G2-C: la firma % no resuelve a ninguna funcion', t.firma;
    END IF;

    -- [b] Estado que CREATE OR REPLACE tiene que conservar.
    SELECT p.prosecdef, p.proowner, p.proconfig, p.proacl
      INTO v_secdef, v_owner, v_config, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

    v_def   := pg_get_functiondef(v_oid);
    v_nuevo := v_def;
    v_delta_esperado := 0;

    -- [c] Cada reemplazo tiene que aparecer EXACTAMENTE una vez.
    FOREACH v_par SLICE 1 IN ARRAY t.pares LOOP
      v_ocurrencias := (length(v_nuevo) - length(replace(v_nuevo, v_par[1], ''))) / length(v_par[1]);
      IF v_ocurrencias <> 1 THEN
        RAISE EXCEPTION
          'G2-C: se esperaba 1 ocurrencia de "%" en % y hay %. '
          'La implementacion cambio: revisar a mano antes de seguir.',
          v_par[1], t.firma, v_ocurrencias;
      END IF;
      v_nuevo := replace(v_nuevo, v_par[1], v_par[2]);
      v_delta_esperado := v_delta_esperado + (length(v_par[1]) - length(v_par[2]));
    END LOOP;

    -- [d] Y no puede haber cambiado nada mas que eso.
    IF length(v_def) - length(v_nuevo) <> v_delta_esperado THEN
      RAISE EXCEPTION 'G2-C: el reemplazo en % altero mas de lo previsto', t.firma;
    END IF;

    EXECUTE v_nuevo;

    -- [e] Misma funcion (CREATE OR REPLACE conserva el OID) y misma config.
    v_oid_post := to_regprocedure(t.firma);
    IF v_oid_post IS DISTINCT FROM v_oid THEN
      RAISE EXCEPTION 'G2-C: % dejo de ser la misma funcion tras el parche', t.firma;
    END IF;

    SELECT p.prosecdef, p.proowner, p.proconfig, p.proacl
      INTO v_secdef2, v_owner2, v_config2, v_acl2
      FROM pg_catalog.pg_proc p WHERE p.oid = v_oid_post;

    IF v_secdef2 IS DISTINCT FROM v_secdef THEN
      RAISE EXCEPTION 'G2-C: % cambio su SECURITY DEFINER', t.firma;
    END IF;
    IF v_owner2 IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'G2-C: % cambio de owner (% -> %)',
        t.firma, pg_get_userbyid(v_owner), pg_get_userbyid(v_owner2);
    END IF;
    IF v_config2 IS DISTINCT FROM v_config THEN
      RAISE EXCEPTION 'G2-C: % cambio su search_path (% -> %)',
        t.firma, v_config::text, v_config2::text;
    END IF;
    IF v_acl2::text IS DISTINCT FROM v_acl::text THEN
      RAISE EXCEPTION 'G2-C: % cambio su ACL (% -> %)',
        t.firma, COALESCE(v_acl::text,'(default)'), COALESCE(v_acl2::text,'(default)');
    END IF;

    RAISE NOTICE 'G2-C: % parcheada (% clamp(s) de stock eliminado(s); owner/secdef/search_path/ACL intactos)',
      t.firma, array_length(t.pares, 1);
  END LOOP;
END
$g2c$;

-- ── 4. POSTCONDICIONES ──────────────────────────────────────────────────────
-- Se verifican contra el CATALOGO, que es lo que efectivamente corre.
DO $post$
DECLARE
  v_src    text;
  v_oid    oid;
  v_secdef boolean;
BEGIN
  -- [1] El checkout ya no clampa la salida de stock.
  v_oid := to_regprocedure('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 1: se perdio la firma exacta del checkout';
  END IF;
  SELECT p.prosrc, p.prosecdef INTO v_src, v_secdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  IF v_src ~* 'GREATEST\s*\(\s*0\s*,\s*v_prev_stock' THEN
    RAISE EXCEPTION 'POSTCONDICION 1: el checkout sigue clampando la salida de stock a cero';
  END IF;

  -- [2] Y lo hace restando de verdad.
  IF v_src NOT LIKE '%(v_prev_stock - (v_item->>''cantidad'')::numeric)::integer%' THEN
    RAISE EXCEPTION 'POSTCONDICION 2: el checkout no quedo con la resta aritmetica esperada';
  END IF;

  -- [3] El parche no degrado la autoridad: sigue SECURITY DEFINER.
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el checkout dejo de ser SECURITY DEFINER';
  END IF;

  -- [4] El lock sobre la fila de inventario sigue ahi. Sin el, la aritmetica
  --     seria correcta pero no segura ante concurrencia.
  IF v_src !~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDICION 4: el checkout perdio el FOR UPDATE sobre inventory';
  END IF;

  -- [5] Los marcadores de G2-B siguen escribiendose.
  IF v_src NOT LIKE '%stock_processed%' OR v_src NOT LIKE '%stock_movement_id%' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el checkout dejo de escribir los marcadores de stock';
  END IF;

  -- [6] Y una nota de credito sigue sin mover stock.
  IF v_src NOT LIKE '%nota_credito%' THEN
    RAISE EXCEPTION 'POSTCONDICION 6: se perdio la exclusion de nota_credito del movimiento de stock';
  END IF;

  -- [7] El trigger de repuestos ya no clampa en ninguna de sus dos ramas.
  v_oid := to_regprocedure('public.adjust_stock_on_order_item()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 7: se perdio la firma exacta de adjust_stock_on_order_item';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  IF v_src ~* 'GREATEST\s*\([^;]{0,60}?v_prev_stock' THEN
    RAISE EXCEPTION 'POSTCONDICION 7: adjust_stock_on_order_item sigue clampando';
  END IF;

  -- [8] Y conserva sus tres ramas.
  IF v_src NOT LIKE '%v_prev_stock - NEW.cantidad%'
     OR v_src NOT LIKE '%v_prev_stock + OLD.cantidad%'
     OR v_src NOT LIKE '%v_prev_stock - v_qty_change%' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: adjust_stock_on_order_item perdio alguna de sus ramas';
  END IF;

  -- [9] El trigger sigue enganchado a order_items.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'order_items'
      AND t.tgname = 'trg_adjust_stock_on_order_item'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 9: se perdio el trigger trg_adjust_stock_on_order_item';
  END IF;

  -- [10] G2-B sigue en pie: el guard de inmutabilidad de comprobante_items no
  --      fue tocado por este lote.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relname = 'comprobante_items'
      AND t.tgname = 'trg_comprobante_items_immutability'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 10: G2-C rompio el trigger de inmutabilidad de G2-B';
  END IF;

  -- [11] La reversa de la anulacion sigue siendo aritmetica pura.
  SELECT p.prosrc INTO v_src
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'private' AND p.proname = 'sec08e_annul_comprobante_impl';

  IF v_src NOT LIKE '%v_prev_stock + v_item.cantidad%' THEN
    RAISE EXCEPTION 'POSTCONDICION 11: la reversa de la anulacion dejo de ser aritmetica';
  END IF;

  -- ── BLOCKER 1 de la revision humana: eliminar una compra ──────────────────
  -- [12] La eliminacion de compra ya no clampa.
  v_oid := to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 12: se perdio la firma exacta de delete_supplier_purchase_safe';
  END IF;
  SELECT p.prosrc, p.prosecdef INTO v_src, v_secdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  IF v_src ~* 'GREATEST\s*\(\s*0\s*,\s*COALESCE\(v_prev_stk' THEN
    RAISE EXCEPTION 'POSTCONDICION 12: delete_supplier_purchase_safe sigue clampando';
  END IF;

  -- [13] Y resta de verdad.
  IF v_src NOT LIKE '%COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer%' THEN
    RAISE EXCEPTION 'POSTCONDICION 13: delete_supplier_purchase_safe no quedo aritmetica';
  END IF;

  -- [14] Conserva autoridad de tenant, SECDEF y el bloqueo de compra pagada.
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICION 14: delete_supplier_purchase_safe dejo de ser SECURITY DEFINER';
  END IF;
  IF v_src NOT LIKE '%_require_business_member%' OR v_src NOT LIKE '%current_user_can%' THEN
    RAISE EXCEPTION 'POSTCONDICION 14: delete_supplier_purchase_safe perdio su autoridad de tenant';
  END IF;
  IF v_src NOT LIKE '%BLOCKED_PAID%' THEN
    RAISE EXCEPTION 'POSTCONDICION 14: se perdio el bloqueo de compra con pagos registrados';
  END IF;

  -- [15] Y su lock y su tombstone de idempotencia.
  IF v_src !~* 'FOR\s+UPDATE' THEN
    RAISE EXCEPTION 'POSTCONDICION 15: delete_supplier_purchase_safe perdio su FOR UPDATE';
  END IF;
  IF v_src NOT LIKE '%supplier_purchase_deletions%' OR v_src NOT LIKE '%ALREADY_DELETED%' THEN
    RAISE EXCEPTION 'POSTCONDICION 15: se perdio el tombstone de idempotencia de la eliminacion';
  END IF;

  -- [16] Owner y search_path esperados en las TRES funciones parcheadas.
  --      (Se comparan contra el valor observado en el catalogo antes del lote;
  --       el DO anterior ya probo que el parche no los movio. Esto ademas fija
  --       el contrato para quien lea la migracion.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)')
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND 'search_path=public, pg_temp' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 16: el checkout no tiene el owner/search_path esperados';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.adjust_stock_on_order_item()')
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND 'search_path=public, pg_temp' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 16: adjust_stock_on_order_item no tiene el owner/search_path esperados';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)')
      AND pg_get_userbyid(p.proowner) = 'postgres'
      AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 16: delete_supplier_purchase_safe no tiene el owner/search_path esperados';
  END IF;

  -- [17] La RPC de compras sigue siendo invocable por `authenticated` (es su
  --      unico camino desde producto) y `anon` sigue sin EXECUTE.
  IF NOT has_function_privilege('authenticated',
        to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 17: authenticated perdio EXECUTE sobre delete_supplier_purchase_safe';
  END IF;
  IF has_function_privilege('anon',
        to_regprocedure('public.delete_supplier_purchase_safe(uuid,uuid,uuid)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 17: anon gano EXECUTE sobre delete_supplier_purchase_safe';
  END IF;

  RAISE NOTICE 'G2-C OK · salida de stock aritmetica en los 3 writers · sobreventa permitida · reversa exacta';
END
$post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, si hiciera falta volver al comportamiento anterior)
--
--   Reaplicar el clamp sobre las mismas tres funciones:
--     · private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)
--         (v_prev_stock - (v_item->>'cantidad')::numeric)::integer
--       ->  GREATEST(0, v_prev_stock - (v_item->>'cantidad')::numeric)::integer
--     · public.adjust_stock_on_order_item()
--         v_prev_stock - NEW.cantidad   ->  GREATEST(v_prev_stock - NEW.cantidad, 0)
--         v_prev_stock - v_qty_change   ->  GREATEST(v_prev_stock - v_qty_change, 0)
--     · public.delete_supplier_purchase_safe(uuid,uuid,uuid)
--         COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer
--       ->  GREATEST(0, COALESCE(v_prev_stk, 0) - FLOOR(v_item.quantity)::integer)
--
-- OJO: revertir REINTRODUCE la fabricacion de unidades. Y no repara el stock
-- que haya quedado negativo mientras G2-C estuvo activo: ese negativo es dato
-- legitimo, no corrupcion.
-- ============================================================================
