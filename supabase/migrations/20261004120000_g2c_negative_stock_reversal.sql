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
-- Escritores ACTIVOS de stock encontrados: 9. De ellos, los que representan
-- una SALIDA reversible que admite sobreventa son exactamente DOS, y son los
-- unicos que toca esta migracion:
--
--   1. private.create_comprobante_checkout_atomic  (venta por POS/comprobante)
--   2. public.adjust_stock_on_order_item           (repuesto de orden: INSERT y UPDATE)
--
-- NO se tocan, con motivo:
--   · private.sec08e_annul_comprobante_impl — la reversa YA era aritmetica
--     (`v_prev_stock + cantidad`). Es la mitad sana de la asimetria.
--   · public.repair_missing_stock_movements — su resta YA es aritmetica; su
--     `p_allow_negative=false` no es un clamp silencioso sino un SKIP
--     deliberado que ademas se reporta en `items_sin_stock_suficiente`.
--     Herramienta manual conservadora: no fabrica unidades. Se deja igual y se
--     prueban sus dos ramas en la matriz (caso 17).
--   · public.delete_supplier_purchase_safe — clampa igual, pero es reversion
--     de una COMPRA, no una venta con sobreventa. Fuera del alcance declarado
--     de G2-C. Queda reportado como hallazgo con su query de diagnostico.
--   · portalService._processWholesaleStock — mismo defecto, pero es una
--     escritura CLIENT-SIDE del portal mayorista (dominio aparte, apagado por
--     `wholesale_portal_enabled`). Arreglarlo bien implica moverlo server-side:
--     es otro lote, no un cambio de clamp.
--   · inventoryMovementsService.registerMovement — no clampa; BLOQUEA negativo
--     de forma explicita. Es alta de producto y ajuste manual, no una venta.
--
-- COMO se aplica el cambio
-- ------------------------
-- `create_comprobante_checkout_atomic` tiene ~700 lineas. Reescribirla entera
-- para cambiar una expresion invita a un drift silencioso justo en la funcion
-- mas critica del producto. En vez de eso se parchea sobre
-- `pg_get_functiondef()`, que devuelve la definicion COMPLETA y vigente, y se
-- reemplaza unicamente la expresion del clamp. Eso garantiza —y deja
-- demostrable— que el resto del cuerpo es identico byte a byte.
--
-- Es fail-closed: si el patron no aparece exactamente una vez, la migracion
-- aborta en vez de aplicar un cambio parcial. Las postcondiciones al final
-- verifican el resultado contra el catalogo.
--
-- Lo que se preserva (verificado en la matriz):
--   · `FOR UPDATE` del checkout;
--   · marcadores `stock_processed` / `stock_processed_at` / `stock_movement_id`;
--   · `SECURITY DEFINER`, owner, search_path y grants (CREATE OR REPLACE);
--   · autoridad de tenant y RLS;
--   · el guard de inmutabilidad de G2-B sobre `comprobante_items`;
--   · que una nota de credito nunca mueva stock.
-- ============================================================================

BEGIN;

-- ── 1. VENTA · private.create_comprobante_checkout_atomic ───────────────────
DO $g2c$
DECLARE
  v_def      text;
  v_nuevo    text;
  v_viejo    text := 'GREATEST(0, v_prev_stock - (v_item->>''cantidad'')::numeric)::integer';
  v_reemplazo text := '(v_prev_stock - (v_item->>''cantidad'')::numeric)::integer';
  v_ocurrencias int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'private' AND p.proname = 'create_comprobante_checkout_atomic';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'G2-C: no existe private.create_comprobante_checkout_atomic';
  END IF;

  -- Fail-closed: exactamente una ocurrencia, ni cero ni dos.
  v_ocurrencias := (length(v_def) - length(replace(v_def, v_viejo, ''))) / length(v_viejo);
  IF v_ocurrencias <> 1 THEN
    RAISE EXCEPTION
      'G2-C: se esperaba 1 clamp de stock en el checkout y se encontraron %. '
      'La implementacion cambio: revisar a mano antes de seguir.', v_ocurrencias;
  END IF;

  v_nuevo := replace(v_def, v_viejo, v_reemplazo);

  -- El unico cambio permitido es quitar `GREATEST(0, ` y su `)`.
  IF length(v_def) - length(v_nuevo) <> length(v_viejo) - length(v_reemplazo) THEN
    RAISE EXCEPTION 'G2-C: el reemplazo en el checkout altero mas de lo previsto';
  END IF;

  EXECUTE v_nuevo;
  RAISE NOTICE 'G2-C: checkout parcheado (1 clamp de stock eliminado)';
END
$g2c$;

-- ── 2. REPUESTOS DE ORDEN · public.adjust_stock_on_order_item ───────────────
-- Dos clamps: el INSERT (agregar repuesto) y el UPDATE (subir la cantidad).
-- El DELETE ya era aritmetico (`v_prev_stock + OLD.cantidad`) — esa rama es la
-- que hacia visible la asimetria y no se toca.
DO $g2c$
DECLARE
  v_def   text;
  v_nuevo text;
  v_pares text[][] := ARRAY[
    ['GREATEST(v_prev_stock - NEW.cantidad, 0)', 'v_prev_stock - NEW.cantidad'],
    ['GREATEST(v_prev_stock - v_qty_change, 0)', 'v_prev_stock - v_qty_change']
  ];
  v_par   text[];
  v_ocurrencias int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'adjust_stock_on_order_item';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'G2-C: no existe public.adjust_stock_on_order_item';
  END IF;

  v_nuevo := v_def;
  FOREACH v_par SLICE 1 IN ARRAY v_pares LOOP
    v_ocurrencias := (length(v_nuevo) - length(replace(v_nuevo, v_par[1], ''))) / length(v_par[1]);
    IF v_ocurrencias <> 1 THEN
      RAISE EXCEPTION
        'G2-C: se esperaba 1 ocurrencia de "%" en adjust_stock_on_order_item y hay %',
        v_par[1], v_ocurrencias;
    END IF;
    v_nuevo := replace(v_nuevo, v_par[1], v_par[2]);
  END LOOP;

  EXECUTE v_nuevo;
  RAISE NOTICE 'G2-C: trigger de repuestos parcheado (2 clamps de stock eliminados)';
END
$g2c$;

-- ── 3. POSTCONDICIONES ──────────────────────────────────────────────────────
-- Se verifican contra el CATALOGO, que es lo que efectivamente corre.
DO $post$
DECLARE
  v_src      text;
  v_secdef   boolean;
BEGIN
  -- [1] El checkout ya no clampa la salida de stock.
  SELECT p.prosrc, p.prosecdef INTO v_src, v_secdef
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'private' AND p.proname = 'create_comprobante_checkout_atomic';

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
  SELECT p.prosrc INTO v_src
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'adjust_stock_on_order_item';

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

  RAISE NOTICE 'G2-C OK · salida de stock aritmetica · sobreventa permitida · reversa exacta';
END
$post$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, si hiciera falta volver al comportamiento anterior)
--
--   Reaplicar el clamp sobre las mismas dos funciones:
--     · private.create_comprobante_checkout_atomic
--         (v_prev_stock - (v_item->>'cantidad')::numeric)::integer
--       ->  GREATEST(0, v_prev_stock - (v_item->>'cantidad')::numeric)::integer
--     · public.adjust_stock_on_order_item
--         v_prev_stock - NEW.cantidad   ->  GREATEST(v_prev_stock - NEW.cantidad, 0)
--         v_prev_stock - v_qty_change   ->  GREATEST(v_prev_stock - v_qty_change, 0)
--
-- OJO: revertir REINTRODUCE la fabricacion de unidades. Y no repara el stock
-- que haya quedado negativo mientras G2-C estuvo activo: ese negativo es dato
-- legitimo, no corrupcion.
-- ============================================================================
