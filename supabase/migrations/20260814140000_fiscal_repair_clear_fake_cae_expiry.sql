-- ============================================================================
-- REPARACION HISTORICA FISCAL — COMPLEMENTO: retirar el vencimiento simulado
--
-- La migracion 20260814120000 le saco a los 53 comprobantes historicos el CAE
-- fabricado y su numero_fiscal, y los dejo en 'sin_autorizacion_fiscal'. Se le
-- paso `cae_vencimiento`.
--
-- Eso no es cosmetico. `cae_vencimiento` es la fecha hasta la cual un CAE es
-- valido: si el CAE nunca existio, su vencimiento tampoco. Dejarlo es conservar
-- metadata fiscal inventada colgando de un comprobante que ARCA no autorizo, y
-- el smoke productivo mostro la consecuencia — la pantalla decia
-- "Sin autorización fiscal" y "Venc. CAE 15/7/2026" al mismo tiempo.
--
-- QUE HACE
--   Una sola cosa: `cae_vencimiento = NULL` en los MISMOS 53 uuid.
--
-- QUE NO HACE
--   No toca ninguna otra columna, ni reescribe las 54 trazas de la reparacion
--   principal. Deja su propia traza complementaria y verifica el invariante
--   economico igual que la anterior.
--
-- BEGIN/COMMIT explicitos: las migraciones de Supabase corren en AUTOCOMMIT.
-- ============================================================================
BEGIN;

-- ── 1. La MISMA lista cerrada ───────────────────────────────────────────────
-- Repetida a proposito. Un UPDATE por patron (cae IS NULL AND cae_vencimiento
-- IS NOT NULL) hoy da los mismos 53, pero mañana alcanzaria cualquier fila que
-- caiga en ese estado por otro motivo.
CREATE TEMP TABLE _legacy_53 (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _legacy_53 (id) VALUES
  ('9488be82-d47a-4a20-b133-5100e306cc2a'),
  ('3719f704-31a4-428b-b23c-00ed093a9696'),
  ('3e22e6d3-b2a1-464d-abdf-b35efc0e9ecb'),
  ('683bf3a9-fb9e-4776-85c8-240e63f6d1e7'),
  ('8f5520b9-05a8-4954-8f61-16659742046c'),
  ('aa9d3513-f3da-4d6d-a394-b29d0c1122b2'),
  ('def266d0-a851-43e5-851f-f5908ceddf2d'),
  ('42900f13-608b-4bc3-9a79-bf224cd06638'),
  ('9827b2a2-1172-4763-83bd-4f3f14b7aeca'),
  ('31df8719-9c2a-46e0-b777-d2515a7f3064'),
  ('90d73b2c-e79a-4033-9af8-9471186d4398'),
  ('22381a16-81ba-42cb-ab27-7c0f4e7b725c'),
  ('335a127c-1759-4358-a8c5-0d75d0541b43'),
  ('c3b6b4f7-ad15-400e-9843-560fca749c58'),
  ('056f876d-9095-482a-8250-6b019855509d'),
  ('c19f04a0-4819-4d60-97b3-f1c5860b98d1'),
  ('d77d62ad-b12e-444c-874d-f8b71c27908c'),
  ('c820352d-426f-4b39-8e9f-0009f5437a18'),
  ('01545f69-e3ca-4d27-b116-e5839cb89639'),
  ('5e63db6a-7993-4d89-8a06-4a4ebe86d401'),
  ('0b19312a-ed71-4a06-b6a3-00d26020757b'),
  ('9daaafa6-1f53-4ba0-aea1-d1964fc4cb2f'),
  ('9ed5f382-54b0-4df3-b330-5d5fc6791a49'),
  ('ff0feed6-252a-467a-8df7-663758be2349'),
  ('c819d5c3-5628-4036-8cb5-50d871e50b3a'),
  ('9d5b4c7c-cd78-4457-bf16-583d607aa6e9'),
  ('df7e6adf-858d-447f-8942-5a82d6daed7e'),
  ('95151a03-2f50-42e2-bb22-06a338fdf19b'),
  ('344d42b6-f887-443b-a051-8eff0fd7f1b3'),
  ('4a918380-079c-4c30-b7f7-716957461a0c'),
  ('8ba1161f-8e90-49a7-ba8b-9dfc9583c101'),
  ('bc3ef032-9287-4c0a-bb42-724b46dc25e4'),
  ('2a9604e5-5db8-43f3-80c3-bee4a130be29'),
  ('14c5470f-e5d6-4811-85bb-92ca6101888a'),
  ('871d2001-a165-43c0-bfc3-a1e3bd65f4ce'),
  ('e92d9f5f-c659-4154-a7a2-2cef80393e47'),
  ('fc8356b9-eee1-44b0-bfb7-31d511162086'),
  ('f69ed145-55ab-4882-8094-b6cbbdc71a81'),
  ('1f2956ec-f52e-42a2-9618-ecfca7c07429'),
  ('ff5204f4-57e1-4782-8566-7418541e4d8f'),
  ('641c8257-8cb3-4452-935d-34b6fccf1f3c'),
  ('5b9089ad-0b43-4286-aea6-2fd7fb4a30a1'),
  ('d86713c9-992e-4c62-8a04-6cd786e43732'),
  ('7ee6ffd8-b18a-497e-aecd-6b8d274df3ff'),
  ('b69d7ac2-6b49-43ae-a219-d6c2e27f113d'),
  ('61fb8f8d-76c2-4128-8e99-8d1c958acd75'),
  ('33ee3b08-85d0-43c4-af6d-9977a2233c21'),
  ('cbc1b1b8-bddf-4b5f-8db5-b84ab2fe42ef'),
  ('25025d77-d83c-426b-852f-e0290bf86f1b'),
  ('dc99098c-fde0-4612-819c-c613712f503a'),
  ('9e05444d-e99f-46ef-bbaa-39b17673b38b'),
  ('1eedc52d-bc26-4b78-8524-b6c8dd64c5e5'),
  ('ff3dc175-ce67-478b-867b-b84f09a0a4b4');

-- ── 2. Snapshot economico PRE ───────────────────────────────────────────────
CREATE TEMP TABLE _econ_pre2 AS
SELECT 'financial_movements' AS t, count(*)::numeric AS filas, COALESCE(sum(amount),0) AS suma FROM public.financial_movements
UNION ALL SELECT 'business_finance_entries', count(*), COALESCE(sum(amount),0) FROM public.business_finance_entries
UNION ALL SELECT 'comprobante_payments',     count(*), COALESCE(sum(amount),0) FROM public.comprobante_payments
UNION ALL SELECT 'account_movements',        count(*), COALESCE(sum(debit),0) - COALESCE(sum(credit),0) FROM public.account_movements
UNION ALL SELECT 'inventory_stock',          count(*), COALESCE(sum(stock_quantity),0) FROM public.inventory
UNION ALL SELECT 'comprobantes_total',       count(*), COALESCE(sum(total),0) FROM public.comprobantes
UNION ALL SELECT 'comprobantes_cobrado',     count(*), COALESCE(sum(total_cobrado),0) FROM public.comprobantes
UNION ALL SELECT 'orders',                   count(*), 0 FROM public.orders;

-- Foto de las columnas que esta migracion NO puede tocar. Un checksum sobre
-- to_jsonb menos `cae_vencimiento` y `updated_at` prueba, byte a byte, que lo
-- unico que se movio es el vencimiento.
CREATE TEMP TABLE _filas_pre AS
SELECT md5(COALESCE(string_agg(
         (to_jsonb(c) - 'cae_vencimiento' - 'updated_at')::text, '|' ORDER BY c.id::text), '')) AS h
FROM public.comprobantes c;

-- ── 3. Alcance por entorno ──────────────────────────────────────────────────
-- Mismo criterio que la migracion principal: 0 presentes = base limpia (db
-- reset, CI, alta nueva) y se saltea; 53 = produccion y se repara; cualquier
-- otra cosa aborta.
CREATE TEMP TABLE _scope2 (aplica boolean NOT NULL) ON COMMIT DROP;

DO $$
DECLARE
  v_n int; v_estado int; v_cae int; v_nf int; v_venc int;
BEGIN
  SELECT count(*) INTO v_n FROM _legacy_53;
  IF v_n <> 53 THEN RAISE EXCEPTION 'PRE: la lista cerrada tiene % ids (esperado 53)', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id;

  IF v_n = 0 THEN
    INSERT INTO _scope2 VALUES (false);
    RAISE NOTICE 'Entorno sin los comprobantes historicos: no-op.';
    RETURN;
  END IF;

  IF v_n <> 53 THEN
    RAISE EXCEPTION 'PRE: hay % de los 53 ids (ni 0 ni 53). Estado inesperado.', v_n;
  END IF;

  -- La reparacion principal tiene que haber corrido: si estas filas no estan
  -- en el estado que dejo 20260814120000, esta migracion no es la que sigue.
  SELECT count(*) FILTER (WHERE c.estado_fiscal = 'sin_autorizacion_fiscal'),
         count(*) FILTER (WHERE c.cae IS NULL),
         count(*) FILTER (WHERE c.numero_fiscal IS NULL),
         count(*) FILTER (WHERE c.cae_vencimiento IS NOT NULL)
    INTO v_estado, v_cae, v_nf, v_venc
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id;

  IF v_estado <> 53 THEN
    RAISE EXCEPTION 'PRE: % de 53 en sin_autorizacion_fiscal (falta la reparacion principal?)', v_estado;
  END IF;
  IF v_cae <> 53 THEN RAISE EXCEPTION 'PRE: % de 53 con cae IS NULL', v_cae; END IF;
  IF v_nf  <> 53 THEN RAISE EXCEPTION 'PRE: % de 53 con numero_fiscal IS NULL', v_nf; END IF;

  -- El vencimiento simulado tiene que estar presente en los 53. Si ya se
  -- limpio, no hay nada que hacer y reaplicar seria un no-op silencioso: se
  -- prefiere decirlo.
  IF v_venc = 0 THEN
    INSERT INTO _scope2 VALUES (false);
    RAISE NOTICE 'Los 53 ya no tienen cae_vencimiento: no-op (migracion ya aplicada).';
    RETURN;
  END IF;
  IF v_venc <> 53 THEN
    RAISE EXCEPTION 'PRE: % de 53 con cae_vencimiento (esperado 53 o 0)', v_venc;
  END IF;

  INSERT INTO _scope2 VALUES (true);
  RAISE NOTICE 'PRE OK: 53 sin autorizacion fiscal, sin CAE, sin numero_fiscal, con vencimiento simulado.';
END $$;

-- ── 4. Traza complementaria ─────────────────────────────────────────────────
-- No se toca ninguna de las 54 trazas anteriores: se agrega una nueva por fila.
-- `estado` reusa el vocabulario ya establecido por la reparacion principal, y
-- el payload deja explicito que NO hubo consulta a ARCA: esto es una limpieza
-- de metadata derivada de un CAE que la evidencia del 2026-08-13 ya invalido.
INSERT INTO public.electronic_invoice_log
  (business_id, comprobante_id, punto_venta, tipo_comprobante, numero_comprobante,
   accion, estado, request_data, response_data)
SELECT c.business_id, c.id, 1, '11', NULL,
       'reconciliacion_historica', 'sin_autorizacion_fiscal',
       jsonb_build_object(
         'motivo', 'Se retira el vencimiento del CAE simulado: sin CAE valido no hay vencimiento que registrar',
         'complemento_de', '20260814120000_fiscal_historical_repair',
         'evidencia', 'derivado de FECompUltimoAutorizado 2026-08-13 (PV1, CbteTipo 11) = 0 — sin nueva consulta a ARCA',
         'sin_efecto_economico', true,
         'cae_vencimiento_previo', c.cae_vencimiento),
       jsonb_build_object('cae_vencimiento', NULL)
FROM public.comprobantes c
JOIN _legacy_53 l ON l.id = c.id
WHERE (SELECT aplica FROM _scope2);

-- ── 5. La unica escritura ───────────────────────────────────────────────────
UPDATE public.comprobantes c SET
  cae_vencimiento = NULL,
  updated_at      = now()
FROM _legacy_53 l
WHERE l.id = c.id
  AND (SELECT aplica FROM _scope2);

-- ── 6. Postcondiciones ──────────────────────────────────────────────────────
DO $$
DECLARE v_n int; v_h_pre text; v_h_post text;
BEGIN
  IF NOT (SELECT aplica FROM _scope2) THEN RETURN; END IF;

  SELECT count(*) INTO v_n
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id
  WHERE c.cae_vencimiento IS NULL;
  IF v_n <> 53 THEN RAISE EXCEPTION 'POST: % de 53 quedaron sin cae_vencimiento', v_n; END IF;

  -- Los 53 siguen exactamente como los dejo la reparacion principal.
  SELECT count(*) INTO v_n
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id
  WHERE c.estado_fiscal = 'sin_autorizacion_fiscal'
    AND c.cae IS NULL AND c.numero_fiscal IS NULL AND c.estado = 'emitido';
  IF v_n <> 53 THEN RAISE EXCEPTION 'POST: la limpieza movio algo mas que el vencimiento (% de 53)', v_n; END IF;

  -- El #45 conserva su vencimiento real: no esta en la lista y no debe tocarse.
  SELECT count(*) INTO v_n FROM public.comprobantes
   WHERE numero_fiscal = '0010-00000045' AND cae_vencimiento = DATE '2026-06-26';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST: el #45 perdio su vencimiento real'; END IF;

  -- Nadie mas quedo con vencimiento huerfano.
  SELECT count(*) INTO v_n FROM public.comprobantes
   WHERE cae IS NULL AND cae_vencimiento IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST: quedan % comprobantes con vencimiento sin CAE', v_n; END IF;

  -- Checksum byte a byte de TODAS las columnas menos la que cambio.
  SELECT h INTO v_h_pre FROM _filas_pre;
  SELECT md5(COALESCE(string_agg(
           (to_jsonb(c) - 'cae_vencimiento' - 'updated_at')::text, '|' ORDER BY c.id::text), ''))
    INTO v_h_post FROM public.comprobantes c;
  IF v_h_pre IS DISTINCT FROM v_h_post THEN
    RAISE EXCEPTION 'POST: cambio alguna columna ademas de cae_vencimiento';
  END IF;
END $$;

-- ── 7. Invariante economico ─────────────────────────────────────────────────
DO $$
DECLARE v_dif text;
BEGIN
  IF NOT (SELECT aplica FROM _scope2) THEN RETURN; END IF;

  CREATE TEMP TABLE _econ_post2 AS
  SELECT 'financial_movements' AS t, count(*)::numeric AS filas, COALESCE(sum(amount),0) AS suma FROM public.financial_movements
  UNION ALL SELECT 'business_finance_entries', count(*), COALESCE(sum(amount),0) FROM public.business_finance_entries
  UNION ALL SELECT 'comprobante_payments',     count(*), COALESCE(sum(amount),0) FROM public.comprobante_payments
  UNION ALL SELECT 'account_movements',        count(*), COALESCE(sum(debit),0) - COALESCE(sum(credit),0) FROM public.account_movements
  UNION ALL SELECT 'inventory_stock',          count(*), COALESCE(sum(stock_quantity),0) FROM public.inventory
  UNION ALL SELECT 'comprobantes_total',       count(*), COALESCE(sum(total),0) FROM public.comprobantes
  UNION ALL SELECT 'comprobantes_cobrado',     count(*), COALESCE(sum(total_cobrado),0) FROM public.comprobantes
  UNION ALL SELECT 'orders',                   count(*), 0 FROM public.orders;

  SELECT string_agg(format('%s: %s/%s -> %s/%s', a.t, a.filas, a.suma, b.filas, b.suma), ' | ')
    INTO v_dif
  FROM _econ_pre2 a JOIN _econ_post2 b USING (t)
  WHERE a.filas IS DISTINCT FROM b.filas OR a.suma IS DISTINCT FROM b.suma;

  IF v_dif IS NOT NULL THEN
    RAISE EXCEPTION 'INVARIANTE ECONOMICO ROTO — la limpieza movio cifras: %', v_dif;
  END IF;
  RAISE NOTICE 'Invariante economico intacto: ninguna cifra se movio.';
END $$;

COMMIT;
