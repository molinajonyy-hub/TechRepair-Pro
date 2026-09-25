-- ============================================================================
-- G2-C.3A1 · Autoridad atomica para ajustes de stock (ADITIVA)
--
-- Discovery: docs/g2c3-stock-authority-and-wholesale-idempotency-discovery.md
-- (G2-C.3, reproducido contra un replay aislado con los servicios reales).
--
-- EL BUG QUE ESTO PREPARA PARA CERRAR. Hoy el navegador es autoridad del saldo:
--   · registerMovement hace SELECT stock -> calculo JS -> UPDATE absoluto ->
--     INSERT movimiento. Dos llamadas concurrentes pierden updates (10, +3 y -2
--     -> 8, esperado 11) y, si el INSERT falla, el rollback absoluto del
--     navegador pisa una venta que entro en el medio.
--   · El import de Excel hace UPDATE stock_quantity = <celda>: un archivo viejo
--     borra del saldo las ventas posteriores al export, sin movimiento.
--   · El alta fuera de Inventario crea stock sin movimiento.
-- Los documentos (venta, anulacion, compra, borrado de compra, reparacion y
-- repuesto de orden) YA tienen su writer server-side correcto (W1-W7). Lo que
-- falta es UNA autoridad para el stock que NO nace de un documento: stock
-- inicial, import/conteo y ajuste manual futuro.
--
-- QUE AGREGA (nada existente cambia):
--   · private.inventory_stock_adjustment_requests: idempotencia server-side,
--     UNIQUE (business_id, idempotency_key), respuesta persistida. Sin acceso
--     de API (schema private, sin grants, RLS habilitada sin policies).
--   · private.apply_inventory_stock_adjustments_impl(...): la mutacion. SECURITY
--     INVOKER sin EXECUTE de API: solo corre dentro del wrapper (owner postgres).
--   · public.apply_inventory_stock_adjustments_atomic(p_business_id, p_items,
--     p_source, p_reason, p_idempotency_key) RETURNS jsonb: SECURITY DEFINER,
--     authenticated. Autoridad = private.has_action_authority(biz, 'inventory')
--     (actor autenticado, tenant canonico = p_business_id, capability
--     inventory; decision D5: sin rediseno de RBAC, sales la conserva).
--
-- CONTRATO DE p_items (cada item: inventory_id + EXACTAMENTE un modo):
--   {inventory_id, delta}             nuevo = actual + delta
--   {inventory_id, target[, expected]} nuevo = target; quantity = target - actual
--                                      SIEMPRE calculado aca, nunca del cliente.
--   initial_stock -> solo delta. import -> target + expected obligatorios.
--   manual -> delta, o target con expected opcional.
--   expected <> stock actual bajo lock -> la fila NO se aplica y vuelve 'stale'
--   (decision D1: sin overwrite silencioso, sin resolucion automatica). El
--   resto de las filas validas SI se aplica: resultado parcial determinista.
--   delta 0 / target = actual -> 'noop', sin movimiento.
--   Stock negativo PERMITIDO (contrato G2-C): sin clamp, sin GREATEST.
--
-- ORDEN DE LOCKS (G2-C.2; no hay fecha economica, no hay advisory de periodo):
--   idempotencia (INSERT ... ON CONFLICT sobre el UNIQUE)
--   -> private.lock_inventory_rows(biz, TODOS los ids): ORDER BY id,
--      FOR NO KEY UPDATE, acotado al negocio; count <> N -> 42501
--   -> relectura bajo lock -> UPDATE stock -> INSERT inventory_movements.
--
-- QUE NO HACE (A2/A3/B*): no toca grants de inventory ni de
-- inventory_movements, no toca el frontend, no agrega triggers de revoke, no
-- reescribe ningun writer canonico, no reconcilia historia (no hay CHECK
-- stock = SUM(movimientos), ni opening_balance, ni backfill).
--
-- FAIL-CLOSED: si una precondicion no se cumple, nada se aplica.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. PRECONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $pre$
DECLARE
  v_helper oid := to_regprocedure('private.lock_inventory_rows(uuid,uuid[])');
  v_def    text;
  v_n      bigint;
  v_sig    text;
  v_src    text;
BEGIN
  -- PRECONDICION 1 · el helper canonico de G2-C.2 existe.
  IF v_helper IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: falta private.lock_inventory_rows(uuid,uuid[]) (G2-C.2 no esta aplicada)';
  END IF;

  -- PRECONDICION 2 · el helper conserva su contrato: INVOKER, owner postgres,
  -- search_path minimo, sin EXECUTE de API, NO KEY UPDATE ORDER BY id por negocio.
  IF (SELECT p.prosecdef OR pg_get_userbyid(p.proowner) <> 'postgres'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        FROM pg_proc p WHERE p.oid = v_helper) THEN
    RAISE EXCEPTION 'PRECONDICION 2: private.lock_inventory_rows cambio de owner/SECURITY/search_path';
  END IF;
  IF has_function_privilege('anon', v_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', v_helper, 'EXECUTE')
     OR has_function_privilege('service_role', v_helper, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDICION 2: private.lock_inventory_rows es ejecutable por un rol de API';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_helper;
  IF v_src !~* 'i\.business_id\s*=\s*p_business_id'
     OR v_src !~* 'order\s+by\s+i\.id\s+for\s+no\s+key\s+update' THEN
    RAISE EXCEPTION 'PRECONDICION 2: private.lock_inventory_rows perdio el filtro de negocio o el orden/modo del lock';
  END IF;

  -- PRECONDICION 3 · inventory tiene las columnas que se escriben, con su tipo.
  SELECT count(*) INTO v_n
    FROM (VALUES ('id','uuid'), ('business_id','uuid'), ('stock','integer'),
                 ('stock_quantity','integer'), ('updated_at','timestamp with time zone')) AS e(col, typ)
    JOIN pg_attribute a ON a.attrelid = 'public.inventory'::regclass AND a.attname = e.col
                        AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = e.typ;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'PRECONDICION 3: public.inventory no tiene id/business_id/stock/stock_quantity/updated_at con los tipos esperados';
  END IF;

  -- PRECONDICION 4 · inventory_movements tiene las columnas que se escriben.
  SELECT count(*) INTO v_n
    FROM (VALUES ('business_id','uuid', true), ('inventory_item_id','uuid', true),
                 ('movement_type','text', true), ('quantity','integer', true),
                 ('previous_stock','integer', true), ('new_stock','integer', true),
                 ('reference_type','text', false), ('reference_id','uuid', false),
                 ('note','text', false), ('created_by','uuid', false)) AS e(col, typ, req)
    JOIN pg_attribute a ON a.attrelid = 'public.inventory_movements'::regclass AND a.attname = e.col
                        AND NOT a.attisdropped AND format_type(a.atttypid, a.atttypmod) = e.typ
                        AND a.attnotnull = e.req;
  IF v_n <> 10 THEN
    RAISE EXCEPTION 'PRECONDICION 4: public.inventory_movements cambio de columnas/tipos/NOT NULL';
  END IF;

  -- PRECONDICION 5 · CHECK real de movement_type: admite in / out / adjustment,
  -- y quantity <> 0 sigue vigente (por eso un noop no escribe movimiento).
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.inventory_movements'::regclass AND c.contype = 'c'
     AND c.conname = 'inventory_movements_type_check';
  IF v_def IS NULL OR position('''in''::text' IN v_def) = 0 OR position('''out''::text' IN v_def) = 0
     OR position('''adjustment''::text' IN v_def) = 0 THEN
    RAISE EXCEPTION 'PRECONDICION 5: el CHECK de movement_type no admite in/out/adjustment (%)', v_def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.inventory_movements'::regclass AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) ~ 'quantity\s*<>\s*0') THEN
    RAISE EXCEPTION 'PRECONDICION 5: desaparecio el CHECK quantity <> 0 de inventory_movements';
  END IF;

  -- PRECONDICION 6 · autoridad canonica: has_action_authority (Lote 3 fase B) y
  -- el resolver de capacidades con el default que D5 conserva (sales SI tiene
  -- inventory; tech NO).
  IF to_regprocedure('private.has_action_authority(uuid,text,text,text)') IS NULL
     OR NOT (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
               FROM pg_proc p WHERE p.oid = to_regprocedure('private.has_action_authority(uuid,text,text,text)')) THEN
    RAISE EXCEPTION 'PRECONDICION 6: falta private.has_action_authority o cambio de SECURITY/owner';
  END IF;
  IF to_regprocedure('public.current_user_can(text)') IS NULL
     OR to_regprocedure('private.capability_resolve(text,jsonb,text)') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 6: falta current_user_can / capability_resolve / auth.uid';
  END IF;
  IF private.capability_resolve('sales', NULL::jsonb, 'inventory') IS NOT TRUE
     OR private.capability_resolve('tech', NULL::jsonb, 'inventory') IS NOT FALSE
     OR private.capability_resolve('owner', NULL::jsonb, 'inventory') IS NOT TRUE THEN
    RAISE EXCEPTION 'PRECONDICION 6: el resolver de la capability inventory cambio (D5 asume owner/admin/manager/sales SI, tech NO)';
  END IF;

  -- PRECONDICION 7 · no existe ninguna funcion con estos nombres (ni overloads).
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE (n.nspname = 'public'  AND p.proname = 'apply_inventory_stock_adjustments_atomic')
      OR (n.nspname = 'private' AND p.proname = 'apply_inventory_stock_adjustments_impl');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'PRECONDICION 7: ya existe una funcion apply_inventory_stock_adjustments_* (% firma(s)): no se pisa', v_n;
  END IF;

  -- PRECONDICION 8 · no existe una tabla de requests con ese nombre en ningun schema.
  IF to_regclass('private.inventory_stock_adjustment_requests') IS NOT NULL
     OR to_regclass('public.inventory_stock_adjustment_requests') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDICION 8: ya existe una tabla inventory_stock_adjustment_requests';
  END IF;

  -- PRECONDICION 9 · catalogo G2-C.2 / G2-C.3B0 presente: los 7 writers
  -- documentales existen, bloquean inventario FOR NO KEY UPDATE y ninguno con
  -- FOR UPDATE; la reparacion ya no procesa pedidos mayoristas (B0); y no hay
  -- un writer de stock desconocido.
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
      RAISE EXCEPTION 'PRECONDICION 9: falta el writer canonico %', v_sig;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF position('private.lock_inventory_rows(' IN v_src) = 0
       AND v_src !~* 'order\s+by\s+(i\.)?id\s+for\s+no\s+key\s+update' THEN
      RAISE EXCEPTION 'PRECONDICION 9: % perdio el lock canonico de G2-C.2', v_sig;
    END IF;
    IF v_src ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y' THEN
      RAISE EXCEPTION 'PRECONDICION 9: % bloquea inventory con FOR UPDATE (G2-C.2R)', v_sig;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.repair_missing_stock_movements(uuid,boolean)')) ~* 'wholesale' THEN
    RAISE EXCEPTION 'PRECONDICION 9: G2-C.3B0 no esta aplicada (la reparacion sigue procesando pedidos mayoristas)';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'PRECONDICION 9: se esperaban exactamente 7 writers de stock server-side, hay %', v_n;
  END IF;

  -- PRECONDICION 10 · el alias stock <-> stock_quantity sigue sincronizado por
  -- trigger SOLO en UPDATE OF stock_quantity (por eso este writer escribe los dos).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.inventory'::regclass AND t.tgname = 'trg_sync_inventory_stock'
                    AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'PRECONDICION 10: falta el trigger trg_sync_inventory_stock (alias stock/stock_quantity)';
  END IF;

  -- PRECONDICION 11 · schema private cerrado a la API.
  IF to_regnamespace('private') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 11: falta el schema private';
  END IF;
  IF has_schema_privilege('anon', 'private', 'USAGE') OR has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'PRECONDICION 11: el schema private es usable por anon/authenticated';
  END IF;
END
$pre$;

-- Snapshot de lo que A1 NO puede tocar: los 7 writers documentales y los
-- privilegios de inventory / inventory_movements (tabla y columna). Se compara
-- contra si mismo al final: no se fijan md5 de objetos que A1 no reescribe.
CREATE TEMP TABLE _g2c3a1_writers ON COMMIT DROP AS
SELECT f.firma, p.oid, md5(p.prosrc) AS src_md5, p.prosecdef, p.proowner, p.proconfig, p.proacl
  FROM unnest(ARRAY[
    'private.create_comprobante_checkout_atomic(uuid,text,text,jsonb)',
    'private.create_quick_inventory_purchase_atomic(uuid,text,uuid,text,text,date,text,numeric,numeric,jsonb)',
    'private.sec08e_annul_comprobante_impl(uuid,text,text,boolean,text)',
    'private.create_supplier_purchase_atomic(uuid,uuid,uuid,text,date,text,numeric,numeric,text,text,jsonb,text)',
    'public.delete_supplier_purchase_safe(uuid,uuid,uuid)',
    'public.repair_missing_stock_movements(uuid,boolean)',
    'public.adjust_stock_on_order_item()'
  ]) AS f(firma)
  JOIN pg_proc p ON p.oid = to_regprocedure(f.firma);

CREATE TEMP TABLE _g2c3a1_acl ON COMMIT DROP AS
SELECT c.relname, NULL::text AS attname, c.relacl::text AS acl, c.relrowsecurity AS rls
  FROM pg_class c
 WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
UNION ALL
SELECT c.relname, a.attname, a.attacl::text, NULL
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass);

CREATE TEMP TABLE _g2c3a1_policies ON COMMIT DROP AS
SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements');

CREATE TEMP TABLE _g2c3a1_triggers ON COMMIT DROP AS
SELECT t.tgrelid::regclass::text AS rel, t.tgname, t.tgfoid, t.tgenabled, t.tgtype
  FROM pg_trigger t
 WHERE t.tgrelid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
   AND NOT t.tgisinternal;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. IDEMPOTENCIA · private.inventory_stock_adjustment_requests
-- ════════════════════════════════════════════════════════════════════════════
-- El UNIQUE (business_id, idempotency_key) ES el lock de idempotencia: una
-- segunda transaccion con la misma clave espera en el INSERT hasta que la
-- primera termina, y despues ve su fila ya completada (replay) o ninguna fila
-- (la primera fallo y se revirtio entera). El estado 'processing' nunca es
-- visible para otra transaccion: la fila se completa en la MISMA transaccion
-- que mueve el stock.
--
-- request_hash lo calcula SIEMPRE el servidor sobre el payload canonico: el
-- cliente no manda hash y no puede mentir sobre el.
CREATE TABLE private.inventory_stock_adjustment_requests (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  idempotency_key text        NOT NULL,
  request_hash    text        NOT NULL,
  source          text        NOT NULL,
  created_by      uuid        NOT NULL,
  item_count      integer     NOT NULL,
  status          text        NOT NULL DEFAULT 'processing',
  response        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT inventory_stock_adjustment_requests_key_uq UNIQUE (business_id, idempotency_key),
  CONSTRAINT inventory_stock_adjustment_requests_key_ck CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT inventory_stock_adjustment_requests_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inventory_stock_adjustment_requests_source_ck CHECK (source IN ('initial_stock', 'import', 'manual')),
  CONSTRAINT inventory_stock_adjustment_requests_items_ck CHECK (item_count BETWEEN 1 AND 5000),
  CONSTRAINT inventory_stock_adjustment_requests_status_ck CHECK (status IN ('processing', 'completed')),
  CONSTRAINT inventory_stock_adjustment_requests_completed_ck
    CHECK ((status = 'completed') = (response IS NOT NULL AND completed_at IS NOT NULL))
);

ALTER TABLE private.inventory_stock_adjustment_requests OWNER TO postgres;
ALTER TABLE private.inventory_stock_adjustment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.inventory_stock_adjustment_requests FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE private.inventory_stock_adjustment_requests IS
  'G2-C.3A1: idempotencia server-side de apply_inventory_stock_adjustments_atomic. '
  'UNIQUE (business_id, idempotency_key) es el lock; request_hash (sha256 del payload canonico) '
  'lo calcula el servidor; response es la respuesta persistida que devuelve un replay. '
  'Sin acceso de API: solo la escribe la RPC.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. IMPLEMENTACION · private.apply_inventory_stock_adjustments_impl
-- ════════════════════════════════════════════════════════════════════════════
-- SECURITY INVOKER a proposito: solo se llama desde el wrapper SECURITY DEFINER
-- (owner postgres). Si alguna vez recibiera EXECUTE un rol de API, correria
-- como ese rol y no podria usar el schema private: queda inerte.
CREATE FUNCTION private.apply_inventory_stock_adjustments_impl(
  p_business_id     uuid,
  p_items           jsonb,
  p_source          text,
  p_reason          text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  -- Tope por lote: el listado de Inventario carga hasta 5000 productos
  -- (useInventory.ts, .limit(5000)); un export/import del catalogo completo
  -- entra en UNA llamada.
  c_max_items  constant integer := 5000;
  c_key_max    constant integer := 200;
  c_reason_max constant integer := 500;
  c_int_min    constant bigint  := -2147483648;
  c_int_max    constant bigint  :=  2147483647;
  v_actor      uuid := auth.uid();
  v_key        text;
  v_reason     text;
  v_n          integer;
  v_elem       jsonb;
  v_idx        integer;
  v_id         uuid;
  v_mode       text;
  v_num        numeric;
  v_delta      bigint;
  v_target     bigint;
  v_expected   bigint;
  v_norm       jsonb := '[]'::jsonb;
  v_dup        uuid;
  v_ids        uuid[];
  v_hash       text;
  v_req_id     uuid;
  v_prev_hash  text;
  v_prev_state text;
  v_prev_resp  jsonb;
  v_locked     integer;
  v_it         record;
  v_prev       integer;
  v_new        bigint;
  v_qty        bigint;
  v_status     text;
  v_mov_type   text;
  v_mov_id     uuid;
  v_rows       integer;
  v_note       text;
  v_out        jsonb := '[]'::jsonb;
  v_applied    integer := 0;
  v_stale      integer := 0;
  v_noop       integer := 0;
  v_response   jsonb;
BEGIN
  -- ── 1. Parametros escalares ────────────────────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('initial_stock', 'import', 'manual') THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_SOURCE: %', COALESCE(p_source, '(null)') USING ERRCODE = '22023';
  END IF;

  v_key := btrim(p_idempotency_key);
  IF v_key IS NULL OR v_key = '' OR length(v_key) > c_key_max OR v_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_IDEMPOTENCY_KEY: obligatoria, 1-% caracteres, sin caracteres de control', c_key_max
      USING ERRCODE = '22023';
  END IF;

  -- Motivo: espacios/saltos colapsados, vacio = NULL, largo acotado, sin control.
  v_reason := NULLIF(btrim(regexp_replace(COALESCE(p_reason, ''), '[[:space:]]+', ' ', 'g')), '');
  IF v_reason IS NOT NULL AND (length(v_reason) > c_reason_max OR v_reason ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_REASON: hasta % caracteres, sin caracteres de control', c_reason_max
      USING ERRCODE = '22023';
  END IF;

  -- ── 2. Payload: validacion estricta, TODO antes de escribir ────────────────
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_ITEMS_REQUIRED: p_items debe ser un array JSON' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_ITEMS_REQUIRED: p_items esta vacio' USING ERRCODE = '22023';
  END IF;
  IF v_n > c_max_items THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_TOO_MANY_ITEMS: % items (maximo %)', v_n, c_max_items USING ERRCODE = '22023';
  END IF;

  FOR v_elem, v_idx IN
    SELECT e.value, (e.ordinality - 1)::integer
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ordinality)
  LOOP
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_ITEM: el item % no es un objeto', v_idx USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_elem) AS k(name)
                WHERE k.name NOT IN ('inventory_id', 'delta', 'target', 'expected')) THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_ITEM: el item % trae claves no permitidas (solo inventory_id, delta, target, expected)', v_idx
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_elem -> 'inventory_id') IS DISTINCT FROM 'string'
       OR (v_elem ->> 'inventory_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_ITEM: el item % no tiene un inventory_id UUID valido', v_idx USING ERRCODE = '22023';
    END IF;
    v_id := (v_elem ->> 'inventory_id')::uuid;

    -- Exactamente UN modo.
    IF (v_elem ? 'delta') = (v_elem ? 'target') THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_AMBIGUOUS_ITEM: el item % necesita exactamente uno de delta o target', v_idx
        USING ERRCODE = '22023';
    END IF;
    v_mode := CASE WHEN v_elem ? 'delta' THEN 'delta' ELSE 'target' END;
    IF v_mode = 'delta' AND v_elem ? 'expected' THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_AMBIGUOUS_ITEM: el item % trae expected con delta (expected solo acompana a target)', v_idx
        USING ERRCODE = '22023';
    END IF;

    -- Reglas por origen.
    IF p_source = 'initial_stock' AND v_mode <> 'delta' THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_MODE_NOT_ALLOWED: initial_stock solo admite delta (item %)', v_idx USING ERRCODE = '22023';
    END IF;
    IF p_source = 'import' AND (v_mode <> 'target' OR NOT (v_elem ? 'expected')) THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_MODE_NOT_ALLOWED: import exige target y expected (item %)', v_idx USING ERRCODE = '22023';
    END IF;

    -- Enteros int4 (numero JSON, sin decimales). Stock negativo PERMITIDO.
    v_delta := NULL; v_target := NULL; v_expected := NULL;
    IF v_mode = 'delta' THEN
      IF jsonb_typeof(v_elem -> 'delta') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: delta del item % debe ser un numero entero', v_idx USING ERRCODE = '22023';
      END IF;
      v_num := (v_elem ->> 'delta')::numeric;
      IF v_num <> trunc(v_num) OR v_num < c_int_min OR v_num > c_int_max THEN
        RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: delta del item % debe ser entero de 32 bits', v_idx USING ERRCODE = '22023';
      END IF;
      v_delta := v_num::bigint;
    ELSE
      IF jsonb_typeof(v_elem -> 'target') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: target del item % debe ser un numero entero', v_idx USING ERRCODE = '22023';
      END IF;
      v_num := (v_elem ->> 'target')::numeric;
      IF v_num <> trunc(v_num) OR v_num < c_int_min OR v_num > c_int_max THEN
        RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: target del item % debe ser entero de 32 bits', v_idx USING ERRCODE = '22023';
      END IF;
      v_target := v_num::bigint;
      IF v_elem ? 'expected' THEN
        IF jsonb_typeof(v_elem -> 'expected') IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: expected del item % debe ser un numero entero', v_idx USING ERRCODE = '22023';
        END IF;
        v_num := (v_elem ->> 'expected')::numeric;
        IF v_num <> trunc(v_num) OR v_num < c_int_min OR v_num > c_int_max THEN
          RAISE EXCEPTION 'STOCK_ADJUSTMENT_INVALID_QUANTITY: expected del item % debe ser entero de 32 bits', v_idx USING ERRCODE = '22023';
        END IF;
        v_expected := v_num::bigint;
      END IF;
    END IF;

    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'inventory_id', v_id, 'mode', v_mode, 'delta', v_delta, 'target', v_target, 'expected', v_expected));
  END LOOP;

  -- Un producto repetido haria ambiguo el resultado ("target" dos veces): rechazo total.
  SELECT x.id INTO v_dup
    FROM (SELECT (e ->> 'inventory_id')::uuid AS id FROM jsonb_array_elements(v_norm) AS e) x
   GROUP BY x.id HAVING count(*) > 1
   ORDER BY x.id LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_DUPLICATE_ITEM: el producto % aparece mas de una vez', v_dup USING ERRCODE = '22023';
  END IF;

  -- ── 3. Hash canonico SERVER-SIDE ──────────────────────────────────────────
  -- Items normalizados (enteros, uuid en minuscula) y ordenados por producto:
  -- el orden del payload o la forma de escribir un numero (5 vs 5.0) no generan
  -- falsos conflictos; un cambio real de producto, modo, cantidad, expected,
  -- origen o motivo si.
  v_hash := encode(pg_catalog.sha256(convert_to(jsonb_build_object(
      'op', 'inventory_stock_adjustment', 'v', 1,
      'business_id', p_business_id, 'source', p_source, 'reason', v_reason,
      'items', (SELECT jsonb_agg(e ORDER BY (e ->> 'inventory_id')::uuid) FROM jsonb_array_elements(v_norm) AS e)
    )::text, 'UTF8')), 'hex');

  -- ── 4. Idempotencia (primer lock: la reserva de la clave) ──────────────────
  INSERT INTO private.inventory_stock_adjustment_requests
    (business_id, idempotency_key, request_hash, source, created_by, item_count)
  VALUES (p_business_id, v_key, v_hash, p_source, v_actor, v_n)
  ON CONFLICT (business_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_req_id;

  IF v_req_id IS NULL THEN
    SELECT r.request_hash, r.status, r.response
      INTO v_prev_hash, v_prev_state, v_prev_resp
      FROM private.inventory_stock_adjustment_requests r
     WHERE r.business_id = p_business_id AND r.idempotency_key = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_IDEMPOTENCY_RETRY: la clave cambio de estado durante la reserva; reintentar'
        USING ERRCODE = '40001';
    END IF;
    IF v_prev_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: esta clave ya se uso con un ajuste distinto' USING ERRCODE = '23505';
    END IF;
    IF v_prev_state IS DISTINCT FROM 'completed' OR v_prev_resp IS NULL THEN
      RAISE EXCEPTION 'STOCK_ADJUSTMENT_IDEMPOTENCY_RETRY: la solicitud previa no esta completa; reintentar'
        USING ERRCODE = '40001';
    END IF;
    -- Replay: la MISMA respuesta persistida; no se relee ni se mueve stock.
    RETURN v_prev_resp || jsonb_build_object('status', 'existing');
  END IF;

  -- ── 5. Lock canonico G2-C.2: TODOS los productos, ORDER BY id, del negocio ──
  SELECT array_agg(x.id ORDER BY x.id) INTO v_ids
    FROM (SELECT (e ->> 'inventory_id')::uuid AS id FROM jsonb_array_elements(v_norm) AS e) x;
  v_locked := private.lock_inventory_rows(p_business_id, v_ids);
  IF v_locked <> v_n THEN
    -- Producto de otro negocio o inexistente: no se filtra en silencio.
    RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH: % de % producto(s) no pertenecen al negocio', v_n - v_locked, v_n
      USING ERRCODE = '42501';
  END IF;

  v_note := CASE p_source
              WHEN 'initial_stock' THEN 'Stock inicial'
              WHEN 'import'        THEN 'Importación de stock (conteo)'
              ELSE                      'Ajuste manual de stock'
            END || COALESCE(': ' || v_reason, '');

  -- ── 6. Aplicar: relectura bajo lock -> UPDATE -> INSERT movimiento ─────────
  FOR v_it IN
    SELECT (e ->> 'inventory_id')::uuid AS inventory_id,
           e ->> 'mode'                 AS mode,
           (e ->> 'delta')::bigint      AS delta,
           (e ->> 'target')::bigint     AS target,
           (e ->> 'expected')::bigint   AS expected
      FROM jsonb_array_elements(v_norm) AS e
     ORDER BY (e ->> 'inventory_id')::uuid
  LOOP
    SELECT COALESCE(i.stock_quantity, 0) INTO v_prev
      FROM public.inventory i
     WHERE i.id = v_it.inventory_id AND i.business_id = p_business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
    END IF;

    v_mov_id := NULL; v_mov_type := NULL;
    IF v_it.expected IS NOT NULL AND v_prev::bigint <> v_it.expected THEN
      -- D1: la base sobre la que trabajo el usuario ya no es la actual. No se
      -- aplica y se informa; ni overwrite ni resolucion automatica.
      v_status := 'stale'; v_new := v_prev; v_qty := 0;
    ELSE
      v_new := CASE WHEN v_it.mode = 'delta' THEN v_prev::bigint + v_it.delta ELSE v_it.target END;
      v_qty := v_new - v_prev;
      IF v_new < c_int_min OR v_new > c_int_max OR v_qty < c_int_min OR v_qty > c_int_max THEN
        RAISE EXCEPTION 'STOCK_ADJUSTMENT_OUT_OF_RANGE: el stock resultante de % no entra en 32 bits', v_it.inventory_id
          USING ERRCODE = '22003';
      END IF;
      v_status := CASE WHEN v_qty = 0 THEN 'noop' ELSE 'applied' END;
    END IF;

    IF v_status = 'applied' THEN
      v_mov_type := CASE
                      WHEN p_source = 'initial_stock' AND v_qty > 0 THEN 'in'
                      WHEN p_source = 'initial_stock'               THEN 'out'
                      ELSE 'adjustment'
                    END;
      UPDATE public.inventory
         SET stock_quantity = v_new::integer,
             stock          = v_new::integer,
             updated_at     = now()
       WHERE id = v_it.inventory_id AND business_id = p_business_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'INVENTORY_NOT_FOUND_OR_TENANT_MISMATCH' USING ERRCODE = '42501';
      END IF;
      INSERT INTO public.inventory_movements
        (business_id, inventory_item_id, movement_type, quantity, previous_stock, new_stock,
         reference_type, reference_id, note, created_by)
      VALUES
        (p_business_id, v_it.inventory_id, v_mov_type, v_qty::integer, v_prev, v_new::integer,
         p_source, v_req_id, v_note, v_actor)
      RETURNING id INTO v_mov_id;
      v_applied := v_applied + 1;
    ELSIF v_status = 'stale' THEN
      v_stale := v_stale + 1;
    ELSE
      v_noop := v_noop + 1;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'inventory_id',   v_it.inventory_id,
      'status',         v_status,
      'mode',           v_it.mode,
      'delta',          v_it.delta,
      'target',         v_it.target,
      'expected',       v_it.expected,
      'current_stock',  v_prev,
      'previous_stock', v_prev,
      'new_stock',      v_new,
      'quantity',       v_qty,
      'movement_type',  v_mov_type,
      'movement_id',    v_mov_id));
  END LOOP;

  -- ── 7. Respuesta persistida (lo que devuelve un replay) ────────────────────
  v_response := jsonb_build_object(
    'ok',              true,
    'status',          'created',
    'request_id',      v_req_id,
    'business_id',     p_business_id,
    'idempotency_key', v_key,
    'source',          p_source,
    'reason',          v_reason,
    'item_count',      v_n,
    'applied_count',   v_applied,
    'stale_count',     v_stale,
    'noop_count',      v_noop,
    'items',           v_out);

  UPDATE private.inventory_stock_adjustment_requests
     SET status = 'completed', response = v_response, completed_at = now()
   WHERE id = v_req_id;

  RETURN v_response;
END;
$fn$;

ALTER FUNCTION private.apply_inventory_stock_adjustments_impl(uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.apply_inventory_stock_adjustments_impl(uuid, jsonb, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION private.apply_inventory_stock_adjustments_impl(uuid, jsonb, text, text, text) IS
  'G2-C.3A1: mutacion de stock sin documento (initial_stock/import/manual). Idempotencia -> '
  'private.lock_inventory_rows -> relectura -> UPDATE stock y alias -> INSERT inventory_movements. '
  'Negativos permitidos; expected desfasado = stale por fila. Sin EXECUTE de API: solo el wrapper.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. WRAPPER PUBLICO · public.apply_inventory_stock_adjustments_atomic
-- ════════════════════════════════════════════════════════════════════════════
-- Autoridad ANTES de cualquier validacion de payload, lock o efecto.
-- has_action_authority (Lote 3 fase B) resuelve el actor por identidad
-- canonica (get_my_profile), exige que su negocio sea p_business_id y la
-- capability inventory por el resolver canonico (D5). Se usa el PREDICADO y se
-- levanta el 42501 aca, como pide Lote 3 fase B para los wrappers nuevos.
CREATE FUNCTION public.apply_inventory_stock_adjustments_atomic(
  p_business_id     uuid,
  p_items           jsonb,
  p_source          text,
  p_reason          text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'STOCK_ADJUSTMENT_BUSINESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF private.has_action_authority(p_business_id, 'inventory', NULL, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN private.apply_inventory_stock_adjustments_impl(
    p_business_id, p_items, p_source, p_reason, p_idempotency_key);
END;
$fn$;

ALTER FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text)
  TO authenticated;
COMMENT ON FUNCTION public.apply_inventory_stock_adjustments_atomic(uuid, jsonb, text, text, text) IS
  'G2-C.3A1: UNICA autoridad server-side para stock que no nace de un documento (initial_stock, '
  'import, manual). Items {inventory_id, delta} | {inventory_id, target, expected?}; import exige '
  'target+expected y devuelve stale por fila si el stock cambio. Idempotente por '
  '(business_id, idempotency_key) con hash server-side. Autoridad: capability inventory del tenant canonico.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. POSTCONDICIONES
-- ════════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_wrap oid := to_regprocedure('public.apply_inventory_stock_adjustments_atomic(uuid,jsonb,text,text,text)');
  v_impl oid := to_regprocedure('private.apply_inventory_stock_adjustments_impl(uuid,jsonb,text,text,text)');
  v_tab  oid := to_regclass('private.inventory_stock_adjustment_requests');
  v_src  text;
  v_n    bigint;
  v_role text;
  v_priv text;
  s      record;
  v_now  record;
BEGIN
  -- POSTCONDICION 1 · firmas exactas, owner, SECURITY, volatilidad, search_path, retorno.
  IF v_wrap IS NULL OR v_impl IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 1: falta la firma exacta del wrapper o del impl';
  END IF;
  IF NOT (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres' AND p.provolatile = 'v'
                 AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND p.prorettype = 'jsonb'::regtype
            FROM pg_proc p WHERE p.oid = v_wrap) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: el wrapper no es SECURITY DEFINER/postgres/VOLATILE/search_path=pg_catalog, pg_temp/jsonb';
  END IF;
  IF NOT (SELECT NOT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres' AND p.provolatile = 'v'
                 AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp'] AND p.prorettype = 'jsonb'::regtype
            FROM pg_proc p WHERE p.oid = v_impl) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: el impl no es SECURITY INVOKER/postgres/VOLATILE/search_path=pg_catalog, pg_temp/jsonb';
  END IF;

  -- POSTCONDICION 2 · ACL: wrapper solo authenticated (+ owner); impl sin API.
  IF NOT has_function_privilege('authenticated', v_wrap, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: authenticated no puede ejecutar el wrapper';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_wrap, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % puede ejecutar el wrapper', v_role;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_impl, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICION 2: % puede ejecutar el impl privado', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid IN (v_wrap, v_impl) AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDICION 2: PUBLIC conserva EXECUTE sobre el wrapper o el impl';
  END IF;
  IF (SELECT p.proacl FROM pg_proc p WHERE p.oid = v_wrap) IS NULL
     OR (SELECT p.proacl FROM pg_proc p WHERE p.oid = v_impl) IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 2: ACL implicito (default = EXECUTE a PUBLIC)';
  END IF;

  -- POSTCONDICION 3 · tabla de requests: UNIQUE (business_id, idempotency_key),
  -- RLS habilitada, cero privilegios de API y schema cerrado.
  IF v_tab IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 3: falta private.inventory_stock_adjustment_requests';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = v_tab AND c.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
           = ARRAY['business_id', 'idempotency_key']) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: falta el UNIQUE (business_id, idempotency_key)';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tab) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: la tabla de requests no tiene RLS habilitada';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v_tab) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: la tabla de requests tiene policies (debe ser solo-RPC)';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, v_tab, v_priv) THEN
        RAISE EXCEPTION 'POSTCONDICION 3: % tiene % sobre la tabla de requests', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = v_tab AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POSTCONDICION 3: PUBLIC tiene privilegios sobre la tabla de requests';
  END IF;
  IF has_schema_privilege('anon', 'private', 'USAGE') OR has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el schema private quedo usable por la API';
  END IF;

  -- POSTCONDICION 4 · el wrapper exige autenticacion y la autoridad inventory
  -- del tenant ANTES de llamar al impl.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_wrap;
  IF position('auth.uid() IS NULL' IN v_src) = 0
     OR position('private.has_action_authority(p_business_id, ''inventory''' IN v_src) = 0
     OR position('private.apply_inventory_stock_adjustments_impl(' IN v_src) = 0
     OR position('private.has_action_authority(' IN v_src) > position('private.apply_inventory_stock_adjustments_impl(' IN v_src) THEN
    RAISE EXCEPTION 'POSTCONDICION 4: el wrapper perdio la autenticacion o la autoridad inventory previa al impl';
  END IF;

  -- POSTCONDICION 5 · contrato del impl (estructural):
  --   idempotencia -> lock canonico -> UN solo UPDATE de stock (stock y alias)
  --   -> UN solo INSERT de movimiento; sin FOR UPDATE de inventory, sin clamp,
  --   sin "stock insuficiente", sin UPDATE/DELETE de movimientos ni DELETE de
  --   productos.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_impl;
  IF position('ON CONFLICT (business_id, idempotency_key) DO NOTHING' IN v_src) = 0
     OR position('IDEMPOTENCY_CONFLICT' IN v_src) = 0
     OR position('pg_catalog.sha256(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el impl perdio la idempotencia server-side (reserva, conflicto o hash)';
  END IF;
  IF position('private.lock_inventory_rows(p_business_id, v_ids)' IN v_src) = 0
     OR position('v_locked <> v_n' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el impl no toma el lock canonico con conteo exacto';
  END IF;
  IF NOT (position('ON CONFLICT (business_id, idempotency_key)' IN v_src)
            < position('private.lock_inventory_rows(' IN v_src)
          AND position('private.lock_inventory_rows(' IN v_src)
            < position('UPDATE public.inventory' IN v_src)
          AND position('UPDATE public.inventory' IN v_src)
            < position('INSERT INTO public.inventory_movements' IN v_src)) THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el orden no es idempotencia -> lock -> UPDATE stock -> INSERT movimiento';
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'update\s+public\.inventory\y', 'gi');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: se esperaba UN solo UPDATE de public.inventory en el impl (hay %)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'insert\s+into\s+public\.inventory_movements\y', 'gi');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 5: se esperaba UN solo INSERT de inventory_movements en el impl (hay %)', v_n;
  END IF;
  IF v_src !~* 'set\s+stock_quantity\s*=\s*v_new::integer,\s*stock\s*=\s*v_new::integer' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el UPDATE de stock no escribe stock_quantity y el alias stock juntos';
  END IF;
  IF v_src ~* 'from\s+(public\.)?inventory\y[^;]*\yfor\s+update\y' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el impl bloquea inventory con FOR UPDATE (G2-C.2R)';
  END IF;
  IF v_src ~* '\y(greatest|least)\s*\(' OR v_src ~* 'insuficiente' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el impl clampa el stock o rechaza stock insuficiente (contrato G2-C: negativos permitidos)';
  END IF;
  IF v_src ~* '(update|delete\s+from)\s+(public\.)?inventory_movements\y' OR v_src ~* 'delete\s+from\s+(public\.)?inventory\y' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: el impl reescribe/borra movimientos o borra productos';
  END IF;

  -- POSTCONDICION 6 · los 7 writers documentales quedaron EXACTAMENTE igual.
  IF (SELECT count(*) FROM _g2c3a1_writers) <> 7 THEN
    RAISE EXCEPTION 'POSTCONDICION 6: el snapshot de writers no tiene 7 filas';
  END IF;
  FOR s IN SELECT * FROM _g2c3a1_writers LOOP
    SELECT md5(p.prosrc) AS src_md5, p.prosecdef, p.proowner, p.proconfig, p.proacl INTO v_now
      FROM pg_proc p WHERE p.oid = s.oid;
    IF NOT FOUND OR v_now.src_md5 IS DISTINCT FROM s.src_md5 OR v_now.prosecdef IS DISTINCT FROM s.prosecdef
       OR v_now.proowner IS DISTINCT FROM s.proowner OR v_now.proconfig IS DISTINCT FROM s.proconfig
       OR v_now.proacl IS DISTINCT FROM s.proacl THEN
      RAISE EXCEPTION 'POSTCONDICION 6: el writer canonico % cambio', s.firma;
    END IF;
  END LOOP;

  -- POSTCONDICION 7 · A1 es ADITIVO: grants de tabla/columna, RLS, policies y
  -- triggers de inventory e inventory_movements intactos (eso es A3).
  IF EXISTS (
    (SELECT c.relname, NULL::text, c.relacl::text, c.relrowsecurity FROM pg_class c
      WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
     UNION ALL
     SELECT c.relname, a.attname, a.attacl::text, NULL FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass))
    EXCEPT SELECT relname, attname, acl, rls FROM _g2c3a1_acl
  ) OR EXISTS (
    SELECT relname, attname, acl, rls FROM _g2c3a1_acl
    EXCEPT
    (SELECT c.relname, NULL::text, c.relacl::text, c.relrowsecurity FROM pg_class c
      WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
     UNION ALL
     SELECT c.relname, a.attname, a.attacl::text, NULL FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.oid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass))
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 7: cambiaron grants/RLS de inventory o inventory_movements (A1 es aditivo)';
  END IF;
  IF EXISTS (SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
              WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')
             EXCEPT SELECT * FROM _g2c3a1_policies)
     OR EXISTS (SELECT * FROM _g2c3a1_policies
                EXCEPT SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
                        WHERE schemaname = 'public' AND tablename IN ('inventory', 'inventory_movements')) THEN
    RAISE EXCEPTION 'POSTCONDICION 7: cambiaron las policies de inventory o inventory_movements (A1 es aditivo)';
  END IF;
  IF EXISTS (SELECT t.tgrelid::regclass::text, t.tgname, t.tgfoid, t.tgenabled, t.tgtype FROM pg_trigger t
              WHERE t.tgrelid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
                AND NOT t.tgisinternal
             EXCEPT SELECT * FROM _g2c3a1_triggers)
     OR EXISTS (SELECT * FROM _g2c3a1_triggers
                EXCEPT SELECT t.tgrelid::regclass::text, t.tgname, t.tgfoid, t.tgenabled, t.tgtype FROM pg_trigger t
                        WHERE t.tgrelid IN ('public.inventory'::regclass, 'public.inventory_movements'::regclass)
                          AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'POSTCONDICION 7: cambiaron los triggers de inventory o inventory_movements (A1 es aditivo)';
  END IF;

  -- POSTCONDICION 8 · writers de stock server-side: los 7 documentales + esta
  -- autoridad, y todos bloquean con el contrato G2-C.2.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?inventory\y[^;]*\yset\y[^;]*\ystock(_quantity)?\y\s*=';
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'POSTCONDICION 8: se esperaban 8 writers de stock (7 documentales + G2-C.3A1), hay %', v_n;
  END IF;

  -- POSTCONDICION 9 · el helper de lock sigue sin EXECUTE de API.
  IF has_function_privilege('anon', 'private.lock_inventory_rows(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.lock_inventory_rows(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.lock_inventory_rows(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 9: el helper de lock quedo ejecutable por la API';
  END IF;

  RAISE NOTICE 'G2-C.3A1 OK · public.apply_inventory_stock_adjustments_atomic (DEFINER, authenticated, autoridad inventory del tenant) '
    '-> private.apply_inventory_stock_adjustments_impl (INVOKER, sin API) · idempotencia server-side en '
    'private.inventory_stock_adjustment_requests (UNIQUE business_id+key, hash sha256, respuesta persistida) '
    '· lock canonico G2-C.2 con conteo exacto · delta/target/expected con stale por fila · negativos permitidos '
    '· 1 UPDATE de stock + alias -> 1 movimiento · writers W1-W7, grants, policies y triggers de inventario intactos (aditivo).';
END
$post$;

COMMIT;
