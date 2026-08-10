-- ============================================================================
-- M8 A — contrato de vencimientos de compras a proveedor
--
-- Desbloquea la regla `supplier_crunch` del motor M8. La regla pide
-- "compromisos proximos 14 dias"; `supplier_purchases` solo tenia
-- `purchase_date`, y `v_finance_payables_aging` bucketea por ANTIGUEDAD DE
-- COMPRA, que es "hace cuanto compre", no "cuando tengo que pagar". Derivar el
-- vencimiento (p. ej. purchase_date + 30d) habria sido una heuristica inventada
-- disparando severidad `critical` sobre un dato que nadie cargo.
--
-- Esta migracion agrega el dato real y una vista canonica que lo expone.
--
-- ── ALCANCE (deliberadamente minimo) ────────────────────────────────────────
--   · ADD COLUMN supplier_purchases.due_date date NULL — opcional, SIN DEFAULT.
--   · CHECK due_date IS NULL OR due_date >= purchase_date.
--   · CREATE VIEW v_finance_payables_due (security_invoker).
--
-- ── LO QUE NO HACE ──────────────────────────────────────────────────────────
--   · CERO backfill. Ninguna compra historica recibe due_date. Quedan todas en
--     NULL y se reportan como `undated` — que es la verdad: no se acordo fecha.
--   · No toca total_amount, paid_amount ni pending_amount.
--   · No genera movimientos financieros ni asientos.
--   · No modifica v_finance_payables_aging: su semantica (antiguedad) queda
--     intacta y sus consumidores no cambian.
--   · No modifica periodos historicos ni importes.
--
-- ── PERMISOS ────────────────────────────────────────────────────────────────
-- No se crea policy nueva. La columna hereda `rls_supplier_purchases`
-- (baseline 20260628190324): FOR ALL TO authenticated
-- USING business_id = current_business_id() AND is_staff().
-- O sea: editable exactamente por los roles que hoy administran compras, con el
-- mismo aislamiento multi-tenant. `anon` no tiene acceso a la tabla.
--
-- ── INDICE ──────────────────────────────────────────────────────────────────
-- NO se crea indice en este lote. El candidato
--   (business_id, due_date) WHERE due_date IS NOT NULL AND pending_amount > 0
-- se evalua DESPUES de medir: hoy 0 filas tienen due_date, asi que un indice
-- parcial sobre un predicado vacio no puede demostrar beneficio. Se agrega en
-- una migracion posterior si la medicion lo justifica.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin este
-- bloque los SET LOCAL son no-op y una postcondicion fallida dejaria la tabla a
-- medio migrar (columna nueva sin constraint) en vez de abortar limpio.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ============================================================================
-- 0. PRECONDICIONES
-- ============================================================================
DO $pre$
BEGIN
  IF to_regclass('public.supplier_purchases') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: no existe public.supplier_purchases';
  END IF;

  -- La columna no debe existir todavia (si existe, alguien la agrego fuera de
  -- migraciones y hay que mirarlo a mano antes de seguir).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.supplier_purchases'::regclass
                AND attname = 'due_date' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDICION P1: supplier_purchases.due_date ya existe';
  END IF;

  IF to_regproc('public.ar_today') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P2: falta public.ar_today() (M1)';
  END IF;
END
$pre$;

-- Baseline de sesion: permite exigir en la postcondicion que este lote NO
-- escribio ninguna fila de datos.
DROP TABLE IF EXISTS _m8a_baseline;
CREATE TEMP TABLE _m8a_baseline AS
SELECT
  (SELECT count(*) FROM public.supplier_purchases)                      AS purchases_total,
  (SELECT COALESCE(sum(total_amount),0) FROM public.supplier_purchases) AS sum_total,
  (SELECT COALESCE(sum(paid_amount),0) FROM public.supplier_purchases)  AS sum_paid,
  (SELECT COALESCE(sum(pending_amount),0) FROM public.supplier_purchases) AS sum_pending;

-- ============================================================================
-- 1. COLUMNA
-- ============================================================================
-- NULL-able y SIN DEFAULT a proposito: "no se acordo fecha" es un estado real y
-- distinto de cualquier fecha que pudieramos inventar. Un DEFAULT convertiria
-- toda compra nueva en un compromiso datado que el usuario nunca declaro.
ALTER TABLE public.supplier_purchases
  ADD COLUMN due_date date;

-- Se valida al vuelo: todas las filas existentes tienen due_date NULL, asi que
-- el CHECK pasa trivialmente y no hay scan costoso.
ALTER TABLE public.supplier_purchases
  ADD CONSTRAINT supplier_purchases_due_date_check
  CHECK (due_date IS NULL OR due_date >= purchase_date);

COMMENT ON COLUMN public.supplier_purchases.due_date IS
  'M8 — fecha de pago acordada con el proveedor. NULL = no se acordo fecha '
  '(no significa "vence ya"). Se permite fecha pasada: representa deuda ya '
  'vencida. Nunca puede ser anterior a purchase_date. Sin backfill historico.';

-- ============================================================================
-- 2. VISTA CANONICA DE VENCIMIENTOS
-- ============================================================================
-- security_invoker = true: respeta rls_supplier_purchases igual que el resto de
-- las vistas canonicas (20260704120000). El usuario ve exactamente las compras
-- de su negocio, ni una mas.
--
-- NOTA SOBRE "COMPRAS ANULADAS": supplier_purchases no tiene estado de
-- anulacion — no existe columna `estado`/`anulado`. El unico camino de baja es
-- delete_supplier_purchase_safe(), que borra la fila. Por eso "excluir anuladas"
-- se cumple por construccion: una compra anulada no esta en la tabla. Lo que si
-- se excluye explicitamente es la deuda ya saldada.
CREATE OR REPLACE VIEW public.v_finance_payables_due
  WITH (security_invoker = true) AS
SELECT
  sp.business_id,
  sp.id                AS supplier_purchase_id,
  sp.supplier_id,
  sp.purchase_date,
  sp.due_date,
  sp.pending_amount,
  sp.payment_status,
  CASE WHEN sp.due_date IS NULL THEN NULL
       ELSE (sp.due_date - public.ar_today()) END AS days_to_due,
  CASE
    WHEN sp.due_date IS NULL                             THEN 'undated'
    WHEN sp.due_date <  public.ar_today()                THEN 'overdue'
    WHEN sp.due_date <= public.ar_today() + 14           THEN 'due_soon'
    ELSE                                                      'future'
  END AS due_status
FROM public.supplier_purchases sp
WHERE sp.pending_amount > 0.01
  AND sp.payment_status <> 'paid';

COMMENT ON VIEW public.v_finance_payables_due IS
  'M8 — vencimientos de CxP por compra. Complementa (no reemplaza) '
  'v_finance_payables_aging, que mide ANTIGUEDAD de compra, no fecha de pago. '
  'Excluye deuda saldada. due_status=undated significa "sin fecha acordada", '
  'nunca "vence pronto". No expone PII del proveedor: solo supplier_id.';

REVOKE ALL ON public.v_finance_payables_due FROM PUBLIC;
GRANT SELECT ON public.v_finance_payables_due TO authenticated, service_role;

-- ============================================================================
-- 3. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_b        record;
  v_n        bigint;
  v_notnull  boolean;
  v_default  text;
BEGIN
  SELECT * INTO v_b FROM _m8a_baseline;

  -- R1. La columna quedo NULL-able y SIN DEFAULT.
  SELECT a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    INTO v_notnull, v_default
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.supplier_purchases'::regclass
     AND a.attname = 'due_date' AND NOT a.attisdropped;
  IF v_notnull IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTCONDICION R1a: due_date no quedo NULL-able';
  END IF;
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R1b: due_date quedo con DEFAULT (%)', v_default;
  END IF;

  -- R2. El CHECK existe.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public.supplier_purchases'::regclass
                    AND conname = 'supplier_purchases_due_date_check') THEN
    RAISE EXCEPTION 'POSTCONDICION R2: falta supplier_purchases_due_date_check';
  END IF;

  -- R3. CERO BACKFILL. Ni una sola fila historica recibio due_date.
  SELECT count(*) INTO v_n FROM public.supplier_purchases WHERE due_date IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDICION R3: % fila(s) recibieron due_date — hubo backfill', v_n;
  END IF;

  -- R4. CERO cambios de importes y de cardinalidad.
  IF (SELECT count(*) FROM public.supplier_purchases) <> v_b.purchases_total THEN
    RAISE EXCEPTION 'POSTCONDICION R4a: cambio la cantidad de compras';
  END IF;
  IF (SELECT COALESCE(sum(total_amount),0)   FROM public.supplier_purchases) <> v_b.sum_total
  OR (SELECT COALESCE(sum(paid_amount),0)    FROM public.supplier_purchases) <> v_b.sum_paid
  OR (SELECT COALESCE(sum(pending_amount),0) FROM public.supplier_purchases) <> v_b.sum_pending THEN
    RAISE EXCEPTION 'POSTCONDICION R4b: cambiaron importes historicos';
  END IF;

  -- R5. La vista existe y es security_invoker.
  IF to_regclass('public.v_finance_payables_due') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R5a: no se creo v_finance_payables_due';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid = 'public.v_finance_payables_due'::regclass
       AND c.reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R5b: v_finance_payables_due no quedo security_invoker';
  END IF;

  -- R6. anon no puede leer la vista.
  IF has_table_privilege('anon', 'public.v_finance_payables_due', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION R6: anon puede leer v_finance_payables_due';
  END IF;

  -- R7. v_finance_payables_aging sigue existiendo con su semantica intacta.
  IF to_regclass('public.v_finance_payables_aging') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R7: se perdio v_finance_payables_aging';
  END IF;

  RAISE NOTICE 'M8-A OK — due_date opcional, cero backfill, vista de vencimientos publicada.';
END
$post$;

DROP TABLE IF EXISTS _m8a_baseline;

COMMIT;

-- PostgREST cachea el esquema: sin recarga, la columna nueva responde 400
-- PGRST204 al primer UPDATE que la mande.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (documentado)
--   DROP VIEW IF EXISTS public.v_finance_payables_due;
--   ALTER TABLE public.supplier_purchases
--     DROP CONSTRAINT IF EXISTS supplier_purchases_due_date_check;
--   ALTER TABLE public.supplier_purchases DROP COLUMN IF EXISTS due_date;
-- Es seguro: la columna es aditiva y nadie depende de ella fuera de M8. Al no
-- haber backfill, revertir no pierde ningun dato cargado por el sistema (solo
-- las fechas que el usuario haya tipeado despues del deploy).
-- ============================================================================
