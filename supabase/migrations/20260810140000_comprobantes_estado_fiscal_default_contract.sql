-- ============================================================================
-- P1-C — comprobantes.estado_fiscal: DEFAULT que su propio CHECK rechaza.
--
-- ── EL DEFECTO ─────────────────────────────────────────────────────────────
--   columna : public.comprobantes.estado_fiscal   (text, NULLABLE)
--   DEFAULT : 'borrador'
--   CHECK   : estado_fiscal = ANY (ARRAY[
--               'no_fiscal', 'pendiente_emision', 'pendiente_conciliacion',
--               'emitido', 'error_emision', 'anulado_fiscal'])
--
-- 'borrador' NO esta en el dominio. Cualquier INSERT que se apoye en el DEFAULT
-- falla con comprobantes_estado_fiscal_check aunque no haya violado ninguna
-- intencion de negocio.
--
-- ── POR QUE NO EXPLOTA HOY ─────────────────────────────────────────────────
-- Los dos unicos escritores vivos setean la columna explicitamente:
--   create_comprobante_checkout_atomic  -> es_fiscal ? 'pendiente_emision' : 'no_fiscal'
--   create_credit_note_from_comprobante -> 'pendiente_emision'
-- El DEFAULT nunca se ejerce. Es una bomba con el pin puesto: la arma cualquier
-- INSERT nuevo que omita la columna (un fixture, un script de datos, una RPC
-- futura).
--
-- ── EVIDENCIA: 'borrador' NO ES UN ESTADO DEL DOMINIO FISCAL ────────────────
-- Medido en produccion 2026-08-10, 318 comprobantes:
--   emitido 177 · pendiente_emision 106 · no_fiscal 18 · error_emision 15 ·
--   anulado_fiscal 2 · pendiente_conciliacion 0 · 'borrador' 0 · NULL 0
-- Ninguna fila lo usa, ni la mas vieja. Ademas:
--   · el tipo del frontend (comprobanteService.EstadoFiscal) enumera los 6
--     valores del CHECK y NO incluye 'borrador';
--   · el COMMENT de la columna (migracion 20260701140000) documenta el
--     significado de los 6 y no menciona 'borrador';
--   · la columna VECINA `estado` — el estado DOCUMENTAL, no el fiscal — tiene
--     DEFAULT 'borrador' y un CHECK que SI lo admite
--     (borrador|emitido|anulado), y el checkout canonico escribe las dos en la
--     misma sentencia:
--         estado        := es_fiscal ? 'borrador'          : 'emitido'
--         estado_fiscal := es_fiscal ? 'pendiente_emision' : 'no_fiscal'
--
-- Conclusion: el DEFAULT de estado_fiscal es una copia del DEFAULT de `estado`.
-- Es un default legacy incorrecto (caso B), no un estado legitimo al que le
-- falte lugar en el CHECK. Por eso se corrige el DEFAULT y NO se amplia el
-- CHECK: agregar 'borrador' al dominio fiscal solo para que pase un default
-- heredado inventaria un estado que ningun consumidor sabe interpretar.
--
-- ── POR QUE 'no_fiscal' ────────────────────────────────────────────────────
-- El estado inicial canonico no es uno solo: depende de si el comprobante es
-- fiscal. Un DEFAULT de columna no puede leer otra columna, asi que tiene que
-- ser el valor seguro:
--   · Coherencia con los demas defaults de la fila: `es_fiscal` ya tiene
--     DEFAULT false. Un INSERT que no declara intencion fiscal queda
--     es_fiscal=false + estado_fiscal='no_fiscal'. Consistente.
--   · Fail-safe: 'pendiente_emision' anunciaria un comprobante como pendiente
--     de emitirse en ARCA sin que nadie lo haya pedido. 'no_fiscal' no habilita
--     ningun camino fiscal — claim_comprobante_arca_emission corta por
--     `cae IS NOT NULL OR estado_fiscal = 'emitido'`, nunca por 'no_fiscal'.
--   · Los caminos que SI son fiscales siguen escribiendo el valor explicito,
--     igual que antes. Este DEFAULT no los toca.
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
--   · ALTER COLUMN ... SET DEFAULT. Nada mas.
--   · CERO DML. No reescribe ni una fila existente. No hay backfill.
--   · No toca el CHECK, ni el dominio, ni los estados ya validos.
--   · No cambia la nulabilidad (ver RIESGO RESIDUAL).
--   · No toca emision ARCA, notas de credito ni anulacion.
--
-- ── RIESGO RESIDUAL (declarado, fuera del alcance de este lote) ────────────
-- La columna sigue siendo NULLABLE, y un CHECK se satisface con NULL: un INSERT
-- con `estado_fiscal => NULL` explicito lo atraviesa. Hoy no hay ninguna fila
-- NULL en produccion (0 de 318) y ningun escritor manda NULL. Cerrarlo pide un
-- NOT NULL, que es un endurecimiento de esquema con su propio riesgo sobre la
-- emision ARCA: no entra en un lote de cierre de P1.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin esto,
-- una postcondicion fallida no revierte el ALTER.
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ============================================================================
-- 0. PRECONDICIONES
-- ============================================================================
DO $pre$
DECLARE
  v_default text;
  v_check   text;
  v_rows    bigint;
BEGIN
  IF to_regclass('public.comprobantes') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P0: falta public.comprobantes';
  END IF;

  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_catalog.pg_attrdef d
  JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid='public.comprobantes'::regclass AND a.attname='estado_fiscal';

  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_catalog.pg_constraint
  WHERE conrelid='public.comprobantes'::regclass
    AND conname='comprobantes_estado_fiscal_check';

  IF v_check IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION P1: no existe comprobantes_estado_fiscal_check';
  END IF;

  -- El valor al que se migra tiene que ser parte del dominio ACTUAL. Si alguien
  -- cambio el CHECK, esta migracion no se aplica a ciegas.
  IF v_check NOT LIKE '%''no_fiscal''%' THEN
    RAISE EXCEPTION 'PRECONDICION P2: el CHECK ya no admite ''no_fiscal'': %', v_check;
  END IF;

  -- Si el default ya es valido, no hay nada que corregir y el diagnostico de
  -- este archivo dejo de aplicar. Se aborta en vez de pisar en silencio.
  IF v_default IS NULL OR v_default NOT LIKE '%''borrador''%' THEN
    RAISE EXCEPTION 'PRECONDICION P3: el DEFAULT de estado_fiscal ya no es ''borrador'' (es %). Revisar antes de aplicar.', COALESCE(v_default, '<sin default>');
  END IF;

  -- Ninguna fila puede estar usando el valor invalido: si la hubiera, cambiar
  -- el default no alcanzaria y haria falta decidir que hacer con esos datos.
  SELECT count(*) INTO v_rows FROM public.comprobantes WHERE estado_fiscal = 'borrador';
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'PRECONDICION P4: hay % comprobante(s) con estado_fiscal=''borrador''; este lote NO hace DML sobre datos historicos', v_rows;
  END IF;
END
$pre$;

-- Baseline para exigir cero DML.
DROP TABLE IF EXISTS _p1c_baseline;
CREATE TEMP TABLE _p1c_baseline AS
SELECT
  (SELECT count(*) FROM public.comprobantes)                          AS cmp_rows,
  (SELECT COALESCE(sum(total),0) FROM public.comprobantes)            AS cmp_total,
  (SELECT COALESCE(sum(total_cobrado),0) FROM public.comprobantes)    AS cmp_cobrado,
  (SELECT COALESCE(jsonb_object_agg(ef, n), '{}'::jsonb) FROM (
     SELECT COALESCE(estado_fiscal,'<null>') AS ef, count(*) AS n
     FROM public.comprobantes GROUP BY 1) t)                          AS cmp_por_estado;

-- ============================================================================
-- 1. LA REPARACION
-- ============================================================================
ALTER TABLE "public"."comprobantes"
  ALTER COLUMN "estado_fiscal" SET DEFAULT 'no_fiscal'::text;

COMMENT ON COLUMN "public"."comprobantes"."estado_fiscal" IS
  'no_fiscal=remito/no aplica (y DEFAULT de la columna: un INSERT que no declara '
  'intencion fiscal no tiene dimension fiscal). pendiente_emision=aun no se '
  'intento o se va a reintentar. pendiente_conciliacion=se envio FECAESolicitar '
  'y el resultado es ambiguo (timeout/502/503/504); requiere FECompConsultar '
  'antes de reintentar, NUNCA se debe re-emitir a ciegas. emitido=CAE confirmado '
  '(directo o por conciliacion). error_emision=ARCA rechazo el comprobante. '
  'anulado_fiscal=anulado con NC. NO confundir con la columna `estado`, que es '
  'el estado DOCUMENTAL (borrador|emitido|anulado): ''borrador'' pertenece a esa '
  'columna y nunca a esta.';

-- ============================================================================
-- 2. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_b       record;
  v_default text;
  v_check   text;
  v_probe   text;
BEGIN
  SELECT * INTO v_b FROM _p1c_baseline;

  -- R1. El DEFAULT quedo en el valor esperado.
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_catalog.pg_attrdef d
  JOIN pg_catalog.pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
  WHERE d.adrelid='public.comprobantes'::regclass AND a.attname='estado_fiscal';
  IF v_default IS DISTINCT FROM '''no_fiscal''::text' THEN
    RAISE EXCEPTION 'POSTCONDICION R1: el DEFAULT quedo en % (esperado ''no_fiscal''::text)', COALESCE(v_default,'<sin default>');
  END IF;

  -- R2. El CHECK NO se toco: mismo dominio, sin 'borrador'.
  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_catalog.pg_constraint
  WHERE conrelid='public.comprobantes'::regclass
    AND conname='comprobantes_estado_fiscal_check';
  IF v_check IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R2a: desaparecio comprobantes_estado_fiscal_check';
  END IF;
  IF v_check LIKE '%''borrador''%' THEN
    RAISE EXCEPTION 'POSTCONDICION R2b: se amplio el CHECK con ''borrador'' (prohibido: no es un estado fiscal)';
  END IF;
  FOREACH v_probe IN ARRAY ARRAY[
    'no_fiscal','pendiente_emision','pendiente_conciliacion',
    'emitido','error_emision','anulado_fiscal'
  ] LOOP
    IF v_check NOT LIKE '%''' || v_probe || '''%' THEN
      RAISE EXCEPTION 'POSTCONDICION R2c: el CHECK perdio el valor valido ''%''', v_probe;
    END IF;
  END LOOP;

  -- R3. DEFAULT y CHECK ahora son compatibles: una fila que se apoya en el
  -- default satisface la restriccion. Se prueba de verdad, sobre una tabla
  -- descartable que HEREDA la columna real con su default y su check.
  CREATE TEMP TABLE _p1c_probe (estado_fiscal text);
  -- El default y el check se copian de la columna REAL, no se transcriben a
  -- mano: si mañana cambia alguno, la prueba cambia con él.
  EXECUTE 'ALTER TABLE _p1c_probe ALTER COLUMN estado_fiscal SET DEFAULT ' || v_default;
  -- pg_get_constraintdef ya devuelve la clausula 'CHECK (...)' completa.
  EXECUTE 'ALTER TABLE _p1c_probe ADD CONSTRAINT _p1c_probe_check ' || v_check;
  INSERT INTO _p1c_probe DEFAULT VALUES;
  SELECT estado_fiscal INTO v_probe FROM _p1c_probe;
  IF v_probe IS DISTINCT FROM 'no_fiscal' THEN
    RAISE EXCEPTION 'POSTCONDICION R3: un INSERT apoyado en el default no produjo ''no_fiscal'' (produjo %)', COALESCE(v_probe,'<null>');
  END IF;
  DROP TABLE _p1c_probe;

  -- R4. CERO DML sobre datos historicos: ni una fila, ni un importe, ni un
  -- estado fiscal cambiado.
  IF (SELECT count(*) FROM public.comprobantes) <> v_b.cmp_rows THEN
    RAISE EXCEPTION 'POSTCONDICION R4a: cambio la cantidad de comprobantes';
  END IF;
  IF (SELECT COALESCE(sum(total),0) FROM public.comprobantes) <> v_b.cmp_total
  OR (SELECT COALESCE(sum(total_cobrado),0) FROM public.comprobantes) <> v_b.cmp_cobrado THEN
    RAISE EXCEPTION 'POSTCONDICION R4b: cambiaron importes de comprobantes';
  END IF;
  IF (SELECT COALESCE(jsonb_object_agg(ef, n), '{}'::jsonb) FROM (
        SELECT COALESCE(estado_fiscal,'<null>') AS ef, count(*) AS n
        FROM public.comprobantes GROUP BY 1) t) <> v_b.cmp_por_estado THEN
    RAISE EXCEPTION 'POSTCONDICION R4c: cambio la distribucion de estado_fiscal (backfill prohibido)';
  END IF;

  -- R5. Nadie quedo con el valor invalido.
  IF EXISTS (SELECT 1 FROM public.comprobantes WHERE estado_fiscal = 'borrador') THEN
    RAISE EXCEPTION 'POSTCONDICION R5: quedaron filas con estado_fiscal=''borrador''';
  END IF;

  RAISE NOTICE 'P1-C OK — DEFAULT ''borrador'' -> ''no_fiscal''. CHECK intacto, cero DML.';
END
$post$;

DROP TABLE IF EXISTS _p1c_baseline;

COMMIT;

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado)
--   ALTER TABLE public.comprobantes
--     ALTER COLUMN estado_fiscal SET DEFAULT 'borrador'::text;
-- Volver atras REINSTALA el defecto: cualquier INSERT que omita la columna
-- vuelve a fallar contra comprobantes_estado_fiscal_check. No hay datos que
-- revertir: esta migracion no escribio ninguna fila.
-- ============================================================================
