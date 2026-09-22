-- ─────────────────────────────────────────────────────────────────────────────
-- G2-B · INMUTABILIDAD DE ÍTEMS CON IMPACTO ECONÓMICO  (cierra G2-P0-1)
--        + period lock sobre `comprobante_items`       (cierra G2-P1-C)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── EL DEFECTO, REPRODUCIDO ─────────────────────────────────────────────────
-- Medido en el discovery de BETA-GATE-2 contra un stack local, con un actor
-- `authenticated` normal y un UPDATE directo por PostgREST sobre
-- `comprobante_items` (1 × 1000 → 5 × 1000):
--
--   total             1000 → 5000     (lo recalcula trg_recalcular_totales)
--   total_cobrado     1000 → 1000     (lo dueña trig_comprobante_payment_sync)
--   saldo_pendiente      0 →    0     MIENTE: faltan 4000 por cobrar
--   estado_comercial pagado → pagado  MIENTE
--   CAJA              1000 → 1000     el sintoma reportado por el usuario
--   ledger devengado  1000 → 5000     revenue REESCRITO sin contrapartida
--   COGS               600 →  600     margen falseado
--
-- La venta y sus efectos economicos quedan divorciados en silencio. No hay
-- asiento compensatorio, no hay auditoria, no hay idempotencia: es corrupcion,
-- no una operacion.
--
-- ── CAUSA RAIZ ──────────────────────────────────────────────────────────────
-- `comprobante_items` conservaba autoridad de escritura del cliente:
--     GRANT SELECT,INSERT,DELETE,UPDATE ... TO authenticated   (baseline:14004)
-- con policies que solo piden tenant + is_staff()/can_manage() (baseline:12182).
-- A diferencia de `account_movements` —donde P0-CC-E revoco el INSERT— aca
-- nunca se cerro. El frontend gateaba por `estado === 'borrador'`, pero el
-- frontend no es autoridad.
--
-- ── CONTRATO IMPLEMENTADO ───────────────────────────────────────────────────
-- Una vez que un comprobante produjo CUALQUIER impacto economico real, sus
-- items son INMUTABLES: no se agregan, no se editan, no se borran.
-- Corregir una venta ya impactada se hace por el camino canonico:
-- ANULACION / REVERSA + NUEVO COMPROBANTE. No se implementa reapertura.
--
-- ── POR QUE NO SE REUSA `v_finance_effective_comprobantes` TAL CUAL ─────────
-- Esa vista es la definicion canonica de "venta efectiva" para el LEDGER, y su
-- predicado incluye `status IN ('issued','emitido')`. Pero `estado` es un
-- ESTADO, no un efecto: desde G2-A toda Nota de Pedido nace `estado='emitido'`
-- en la MISMA transaccion en la que se insertan sus items. Usar ese predicado
-- como gate de escritura bloquearia al checkout creando sus propios items.
--
-- Por eso el gate se construye con los EFECTOS REALES —las seis huellas que
-- dejan las RPC canonicas— y deliberadamente NO mira `estado`, `status` ni
-- `estado_comercial`. Es la lectura conservadora que pide el contrato: si hay
-- impacto real, no se muta; si todavia no lo hay, el borrador sigue siendo
-- editable.
--
-- ── EL ORDEN TRANSACCIONAL, QUE ES LA TRAMPA DE ESTE LOTE ───────────────────
-- `create_comprobante_checkout_atomic` procesa el stock DENTRO del loop de
-- items (ver 20260814150000, lineas 714-771):
--
--     FOR cada item LOOP
--       INSERT INTO comprobante_items ...
--       UPDATE inventory ... ; INSERT INTO inventory_movements ...
--       UPDATE comprobante_items SET stock_processed = true ...
--     END LOOP;
--
-- O sea: cuando se INSERTA el item #2, el item #1 YA dejo un inventory_movement
-- y YA tiene stock_processed=true. Un guard ingenuo rechazaria la segunda linea
-- de toda venta multi-item, y ademas rechazaria el propio UPDATE de
-- `stock_processed`. Lo mismo vale para `annul_comprobante_atomic`, que vuelve
-- a poner `stock_processed=false` al restituir stock.
--
-- La exencion NO es una excepcion al contrato: es reconocer que la autoridad ya
-- la resolvio la RPC canonica (gateada por capacidad, idempotente y auditada).
-- Se usa el discriminador que este repo ya establecio en SEC-08B Fase C:
--
--     PostgREST directo    → current_user = 'authenticated'
--     dentro de una SECDEF → current_user = 'postgres' (dueño de la funcion)
--
-- y por eso el trigger es SECURITY INVOKER: un trigger DEFINER veria siempre a
-- su propio dueño y el discriminador quedaria inerte.
--
-- ── ALCANCE ─────────────────────────────────────────────────────────────────
--   · CERO DML. No reescribe ni una fila existente. No hay backfill.
--   · No toca grants, policies, RLS ni el modelo contable.
--   · No toca el checkout, la anulacion, ni ninguna RPC canonica.
--   · No toca stock (G2-C), estados comerciales (G2-D) ni UI (G2-E).
-- ROLLBACK documentado al final.
-- ─────────────────────────────────────────────────────────────────────────────

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin esto,
-- una postcondicion fallida dejaria el trigger a medio crear en vez de abortar.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ============================================================================
-- 1. PREDICADO DE IMPACTO ECONOMICO
-- ============================================================================
-- SECURITY DEFINER a proposito. Si se evaluara con los privilegios del actor,
-- un rol sin capacidad de ver pagos o finanzas (SEC-08A/08C restringieron esas
-- lecturas) obtendria `false` por FALTA DE VISIBILIDAD y el guard lo dejaria
-- pasar: un fail-OPEN, que es justo lo contrario de lo que este lote promete.
--
-- Devuelve tambien la fecha economica para no obligar al trigger INVOKER a leer
-- `comprobantes` por su cuenta (misma razon de visibilidad).
-- AUTORIDAD DE TENANT (revision humana, Blocker 2): es SECDEF y `authenticated`
-- puede invocarla por PostgREST, asi que sin gate seria un oraculo cross-tenant
-- («¿el comprobante X de otro negocio ya cobro?»). Se exige pertenencia ACTIVA
-- al negocio con el helper canonico `_require_business_member` —el mismo que usa
-- `repair_missing_stock_movements`— y ademas se scopea CADA huella por
-- `business_id`: la pertenencia autoriza el negocio, el scope impide que un
-- comprobante ajeno conteste a traves de un negocio propio.
--
-- El gate es de PERTENENCIA, no de capacidad financiera: un rol sin
-- `finance`/`inventory_view_costs` debe seguir obteniendo la respuesta, porque
-- la UI la necesita para decidir si ofrece editar.
CREATE OR REPLACE FUNCTION public.comprobante_impacto_economico(
  p_business_id    uuid,
  p_comprobante_id uuid
) RETURNS TABLE (tiene_impacto boolean, fecha_economica date)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- `pg_temp` explicito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  -- Fail-closed. `_require_business_member` lanza 42501 'Not authenticated' sin
  -- auth.uid() y 42501 'Forbidden' si el actor no es miembro activo, con mensaje
  -- deliberadamente generico (no confirma si el negocio existe).
  PERFORM public._require_business_member(p_business_id, NULL);

  -- El comprobante tiene que ser DE ese negocio. Si no lo es, se responde igual
  -- que si no existiera: sin revelar existencia ni impacto.
  IF NOT EXISTS (SELECT 1 FROM public.comprobantes c
                  WHERE c.id = p_comprobante_id AND c.business_id = p_business_id) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    (
      -- 1. Cobros registrados sobre el documento. Se cuentan TAMBIEN los
      --    reemplazados (`replaced_at IS NOT NULL`): la plata se movio igual.
      -- Cada huella va scopeada por business_id ademas de por comprobante.
      EXISTS (SELECT 1 FROM public.comprobante_payments p
               WHERE p.comprobante_id = p_comprobante_id
                 AND p.business_id    = p_business_id)
      -- 2. Caja / tesoreria.
      OR EXISTS (SELECT 1 FROM public.financial_movements fm
                  WHERE fm.comprobante_id = p_comprobante_id
                    AND fm.business_id    = p_business_id)
      -- 3. Clasificacion economica y COGS devengado.
      OR EXISTS (SELECT 1 FROM public.business_finance_entries bfe
                  WHERE bfe.reference_comprobante_id = p_comprobante_id
                    AND bfe.business_id              = p_business_id)
      -- 4. Deuda de cuenta corriente del cliente.
      OR EXISTS (SELECT 1 FROM public.account_movements am
                  WHERE am.reference_type = 'comprobante'
                    AND am.reference_id   = p_comprobante_id
                    AND am.business_id    = p_business_id)
      -- 5. Movimiento de inventario imputado al comprobante.
      OR EXISTS (SELECT 1 FROM public.inventory_movements im
                  WHERE im.reference_type = 'comprobante'
                    AND im.reference_id   = p_comprobante_id
                    AND im.business_id    = p_business_id)
      -- 6. Marcador de stock ya procesado en alguna linea.
      OR EXISTS (SELECT 1 FROM public.comprobante_items ci
                  WHERE ci.comprobante_id = p_comprobante_id
                    AND ci.business_id    = p_business_id
                    AND ci.stock_processed = true)
      -- 7. Imputaciones de pago de cuenta corriente contra este documento.
      OR EXISTS (SELECT 1 FROM public.customer_account_payment_allocations al
                  WHERE al.comprobante_id = p_comprobante_id
                    AND al.business_id    = p_business_id)
      -- 8. Anulacion registrada: el documento ya es historia compensada.
      OR EXISTS (SELECT 1 FROM public.comprobante_annulments an
                  WHERE an.comprobante_id = p_comprobante_id
                    AND an.business_id    = p_business_id)
    ) AS tiene_impacto,
    (SELECT (COALESCE(c.fecha, c.date, c.created_at)
               AT TIME ZONE 'America/Argentina/Cordoba')::date
       FROM public.comprobantes c
      WHERE c.id = p_comprobante_id AND c.business_id = p_business_id)
      AS fecha_economica;
END;
$fn$;

ALTER FUNCTION public.comprobante_impacto_economico(uuid, uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.comprobante_impacto_economico(uuid, uuid) IS
  'G2-B — ¿este comprobante ya produjo efectos economicos reales? Mira las ocho '
  'huellas que dejan las RPC canonicas (pagos, caja, BFE/COGS, cuenta corriente, '
  'movimientos de inventario, stock_processed, imputaciones y anulacion). NO mira '
  '`estado` ni `estado_comercial`: un estado no es un efecto. SECDEF para no '
  'fail-OPEN ante un actor sin visibilidad financiera.';

-- El trigger es INVOKER y corre como `authenticated`: necesita EXECUTE. `anon`
-- no escribe comprobantes, asi que no lo necesita.
REVOKE ALL ON FUNCTION public.comprobante_impacto_economico(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.comprobante_impacto_economico(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.comprobante_impacto_economico(uuid, uuid) TO authenticated;

-- ============================================================================
-- 2. ASERCION COMPLETA (impacto + periodo)
-- ============================================================================
-- Tambien SECURITY DEFINER, y por una razon MEDIDA: `assert_period_open` no es
-- ejecutable por `authenticated`, asi que si el guard INVOKER la llamara
-- directamente reventaria con 42501 en el camino LEGITIMO (un borrador sin
-- impacto quedaria imposible de editar). Alternativa descartada: otorgarle
-- EXECUTE a `authenticated` — eso ampliaria una superficie de seguridad
-- existente para resolver un problema de estructura. La parte privilegiada vive
-- donde corresponde: dentro de la SECDEF.
CREATE OR REPLACE FUNCTION public.assert_comprobante_items_mutable(
  p_business_id    uuid,
  p_comprobante_id uuid,
  p_op             text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_impacto boolean;
  v_fecha   date;
BEGIN
  SELECT i.tiene_impacto, i.fecha_economica
    INTO v_impacto, v_fecha
    FROM public.comprobante_impacto_economico(p_business_id, p_comprobante_id) i;

  IF COALESCE(v_impacto, false) THEN
    RAISE EXCEPTION
      'COMPROBANTE_ITEMS_INMUTABLE: el comprobante % ya produjo impacto economico; '
      'sus items no se pueden %. Para corregir la venta usa la anulacion/reversa '
      'canonica y emiti un comprobante nuevo.',
      p_comprobante_id,
      CASE p_op WHEN 'INSERT' THEN 'agregar'
                WHEN 'UPDATE' THEN 'modificar'
                ELSE 'eliminar' END
      USING ERRCODE = '0A000';
  END IF;

  -- Period lock (G2-P1-C). Se reutiliza la autoridad canonica, no una segunda
  -- logica. Ver la nota de alcance en el guard.
  IF v_fecha IS NOT NULL THEN
    PERFORM public.assert_period_open(p_business_id, v_fecha);
  END IF;
END;
$$;

ALTER FUNCTION public.assert_comprobante_items_mutable(uuid, uuid, text) OWNER TO postgres;

COMMENT ON FUNCTION public.assert_comprobante_items_mutable(uuid, uuid, text) IS
  'G2-B — lanza si el comprobante ya produjo impacto economico, y exige que su '
  'periodo financiero siga abierto. SECDEF porque `assert_period_open` no es '
  'ejecutable por `authenticated` y el guard que la llama es INVOKER. La '
  'autoridad de tenant NO se duplica: la primera sentencia delega en '
  'comprobante_impacto_economico, que exige pertenencia activa al negocio y que '
  'el comprobante sea de ese negocio (fail-closed, 42501).';

REVOKE ALL ON FUNCTION public.assert_comprobante_items_mutable(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_comprobante_items_mutable(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_comprobante_items_mutable(uuid, uuid, text) TO authenticated;

-- ============================================================================
-- 3. GUARD
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_comprobante_items_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
-- INVOKER a proposito: es la UNICA forma de ver el rol externo real. Ver la
-- cabecera, seccion "EL ORDEN TRANSACCIONAL". No hace falta privilegio extra:
-- OLD/NEW los entrega el ejecutor, y la parte privilegiada vive en la SECDEF.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- Se evalua SIEMPRE el documento de ORIGEN (OLD) en UPDATE/DELETE. Tomar NEW
  -- era el bypass del Blocker 1: ver el bloque A2.
  v_business uuid := COALESCE(OLD.business_id, NEW.business_id);
  v_comp     uuid := COALESCE(OLD.comprobante_id, NEW.comprobante_id);
BEGIN
  -- ── A. Contexto que NO es el navegador ────────────────────────────────────
  -- Dentro de una SECDEF canonica (checkout, anulacion, notas de credito) la
  -- autoridad ya se resolvio por capacidad, con idempotencia y auditoria. Ahi
  -- este guard no tiene nada que agregar — y si opinara, romperia la segunda
  -- linea de toda venta multi-item.
  --
  -- AUDITADO (revision humana): los UNICOS escritores de `comprobante_items` son
  -- private.create_comprobante_checkout_atomic, private.create_credit_note_from_comprobante,
  -- private.delete_comprobante_with_finance, private.sec08e_annul_comprobante_impl
  -- —los cuatro en el schema `private`, sin USAGE para authenticated/anon, y
  -- alcanzables solo por su wrapper publico gateado (require_action_authority /
  -- current_user_can)— y public.repair_missing_stock_movements, gateada por
  -- `_require_business_member`. No hay writer SECDEF generico, asi que el
  -- discriminador por `current_user` alcanza y no hace falta un scope
  -- transaction-local.
  IF auth.uid() IS NULL OR current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- ── A2. Reparenting: la linea no se muda de documento ni de negocio ───────
  -- BLOCKER 1. Antes se evaluaba `COALESCE(NEW..., OLD...)`, y en UPDATE NEW
  -- gana siempre. Eso permitia: comprobante A con impacto (inmutable) y B
  -- borrador limpio del mismo negocio; el actor hacia
  -- `UPDATE comprobante_items SET comprobante_id = B WHERE id = <item de A>`,
  -- el guard evaluaba B —mutable— y dejaba pasar la operacion, retirando de
  -- hecho una linea de A. Eso vacia una venta ya cobrada y ademas evade el
  -- period lock del ORIGEN.
  --
  -- Ningun escritor canonico reparenta lineas (el checkout y la nota de credito
  -- INSERTAN filas nuevas; la anulacion y el borrado operan sobre el mismo
  -- documento), asi que la pertenencia de un item es INMUTABLE.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.comprobante_id IS DISTINCT FROM OLD.comprobante_id THEN
      RAISE EXCEPTION
        'COMPROBANTE_ITEMS_REPARENT_PROHIBIDO: un item no puede cambiar de comprobante '
        '(% -> %). Para mover una linea, anula el comprobante y emiti uno nuevo.',
        OLD.comprobante_id, NEW.comprobante_id
        USING ERRCODE = '0A000';
    END IF;
    IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
      RAISE EXCEPTION
        'COMPROBANTE_ITEMS_REPARENT_PROHIBIDO: un item no puede cambiar de negocio (% -> %).',
        OLD.business_id, NEW.business_id
        USING ERRCODE = '0A000';
    END IF;
  END IF;

  -- ── A3. Marcadores de stock: son SERVER-OWNED ─────────────────────────────
  -- Los escribe el checkout al descontar y la anulacion al restituir. Si el
  -- navegador pudiera fabricarlos sobre un borrador limpio —donde el guard de
  -- impacto todavia no aplica— el daño seria real y silencioso:
  -- `stock_processed = true` es una de las senales de
  -- `v_finance_effective_comprobantes`, asi que un borrador SIN venta entraria
  -- al ledger devengado como venta efectiva; ademas haria que cualquier rutina
  -- de descuento lo saltee por idempotencia y el stock nunca baje.
  -- "Es un borrador" no habilita a inventar estado del servidor.
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.stock_processed, false) IS TRUE
       OR NEW.stock_processed_at IS NOT NULL
       OR NEW.stock_movement_id IS NOT NULL THEN
      RAISE EXCEPTION
        'COMPROBANTE_ITEMS_MARCADOR_SERVER_OWNED: stock_processed / stock_processed_at / '
        'stock_movement_id los escribe el servidor al procesar el stock; no se pueden declarar.'
        USING ERRCODE = '0A000';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.stock_processed    IS DISTINCT FROM OLD.stock_processed
       OR NEW.stock_processed_at IS DISTINCT FROM OLD.stock_processed_at
       OR NEW.stock_movement_id  IS DISTINCT FROM OLD.stock_movement_id THEN
      RAISE EXCEPTION
        'COMPROBANTE_ITEMS_MARCADOR_SERVER_OWNED: stock_processed / stock_processed_at / '
        'stock_movement_id los escribe el servidor al procesar el stock; no se pueden modificar.'
        USING ERRCODE = '0A000';
    END IF;
  END IF;

  -- Una fila sin comprobante no puede evaluarse; que la rechace el FK.
  IF v_comp IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- ── B. Inmutabilidad + period lock (G2-P1-C) ──────────────────────────────
  -- El guard de periodo existente cubre `comprobante_payments` y
  -- `account_movements`, nunca `comprobante_items`. Se reutiliza la autoridad
  -- canonica (`assert_period_open`), no una segunda logica.
  --
  -- Ambas se aplican SOLO en esta rama —la del navegador— a proposito: las RPC
  -- canonicas ya traen su propia semantica de periodo, incluida la regla
  -- documentada de que una reversa valida el periodo de HOY y no reabre el mes
  -- del asiento original. Imponer aqui el periodo del comprobante romperia la
  -- anulacion legitima de un documento viejo.
  PERFORM public.assert_comprobante_items_mutable(v_business, v_comp, TG_OP);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

ALTER FUNCTION public.tg_comprobante_items_immutability_guard() OWNER TO postgres;

COMMENT ON FUNCTION public.tg_comprobante_items_immutability_guard() IS
  'G2-B — cierra INSERT/UPDATE/DELETE de comprobante_items cuando el comprobante '
  'ya produjo impacto economico, y extiende el period lock a esta superficie. '
  'INVOKER a proposito: un trigger DEFINER no puede ver el rol externo.';

DROP TRIGGER IF EXISTS trg_comprobante_items_immutability
  ON public.comprobante_items;

-- BEFORE: corta antes de que `trg_recalcular_totales_comprobante_items` (AFTER)
-- llegue a recalcular `comprobantes.total` con una linea adulterada.
CREATE TRIGGER trg_comprobante_items_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON public.comprobante_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_comprobante_items_immutability_guard();

-- ============================================================================
-- 4. POSTCONDICIONES — la migracion ABORTA si alguna falla
-- ============================================================================
DO $post$
DECLARE
  v_secdef boolean;
  v_invoker boolean;
  v_n int;
BEGIN
  -- [1] El trigger existe y cubre las tres operaciones.
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  WHERE c.relname = 'comprobante_items'
    AND t.tgname = 'trg_comprobante_items_immutability'
    AND NOT t.tgisinternal;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICION 1: el trigger de inmutabilidad no quedo instalado (n=%)', v_n;
  END IF;

  -- [2] El predicado es SECURITY DEFINER (si no, fail-OPEN por visibilidad).
  SELECT p.prosecdef INTO v_secdef FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'comprobante_impacto_economico';
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICION 2: comprobante_impacto_economico debe ser SECURITY DEFINER';
  END IF;

  -- [3] El guard NO es SECURITY DEFINER (si lo fuera, current_user seria
  --     siempre postgres y el discriminador quedaria inerte: fail-OPEN total).
  SELECT p.prosecdef INTO v_invoker FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'tg_comprobante_items_immutability_guard';
  IF v_invoker IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTCONDICION 3: el guard debe ser SECURITY INVOKER para ver el rol real';
  END IF;

  -- [4] `anon` no puede ejecutar el predicado.
  IF has_function_privilege('anon', 'public.comprobante_impacto_economico(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 4: anon conserva EXECUTE sobre el predicado';
  END IF;

  -- [5] `authenticated` SI puede: el guard INVOKER corre con su rol y lo llama.
  IF NOT has_function_privilege('authenticated', 'public.comprobante_impacto_economico(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 5: authenticated perdio EXECUTE y el guard no podria evaluar';
  END IF;

  -- [6] La autoridad de periodo que se reutiliza sigue existiendo.
  IF to_regprocedure('public.assert_period_open(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION 6: falta assert_period_open(uuid,date)';
  END IF;

  -- [7] La asercion tambien es SECDEF: es la que puede llamar a
  --     assert_period_open, que `authenticated` no puede ejecutar. Si dejara de
  --     serlo, el camino LEGITIMO (borrador sin impacto) moriria con 42501.
  SELECT p.prosecdef INTO v_secdef FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'assert_comprobante_items_mutable';
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICION 7: assert_comprobante_items_mutable debe ser SECURITY DEFINER';
  END IF;

  -- [8] Y `authenticated` puede invocarla (el guard INVOKER la llama con su rol).
  IF NOT has_function_privilege('authenticated', 'public.assert_comprobante_items_mutable(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 8: authenticated no puede invocar la asercion';
  END IF;
  IF has_function_privilege('anon', 'public.assert_comprobante_items_mutable(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 8b: anon conserva EXECUTE sobre la asercion';
  END IF;

  -- [9] BLOCKER 2 — el predicado exige autoridad de tenant ANTES de leer nada.
  --     Sin esto vuelve a ser un oraculo cross-tenant.
  --     Se exige la LLAMADA, no la mencion: `prosrc` incluye los comentarios
  --     del cuerpo, y uno de ellos nombra el helper. Buscar solo el nombre
  --     dejaria pasar un cuerpo al que le sacaron el PERFORM y le dejaron el
  --     comentario — medido con el self-test del guard estructural.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'comprobante_impacto_economico'
      AND p.prosrc LIKE '%PERFORM public._require_business_member(p_business_id%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 9: el predicado perdio la autoridad de tenant';
  END IF;

  -- [10] BLOCKER 1 — el guard rechaza el reparenting de una linea.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tg_comprobante_items_immutability_guard'
      AND p.prosrc LIKE '%COMPROBANTE_ITEMS_REPARENT_PROHIBIDO%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 10: el guard dejo de rechazar el reparenting de items';
  END IF;

  -- [11] Y evalua el documento de ORIGEN, no el destino.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tg_comprobante_items_immutability_guard'
      AND p.prosrc LIKE '%COALESCE(OLD.comprobante_id, NEW.comprobante_id)%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 11: el guard volvio a evaluar el comprobante DESTINO';
  END IF;

  RAISE NOTICE 'G2-B OK · inmutabilidad de comprobante_items + period lock instalados';
END;
$post$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--   DROP TRIGGER IF EXISTS trg_comprobante_items_immutability ON public.comprobante_items;
--   DROP FUNCTION IF EXISTS public.tg_comprobante_items_immutability_guard();
--   DROP FUNCTION IF EXISTS public.assert_comprobante_items_mutable(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.comprobante_impacto_economico(uuid, uuid);
-- ─────────────────────────────────────────────────────────────────────────────
