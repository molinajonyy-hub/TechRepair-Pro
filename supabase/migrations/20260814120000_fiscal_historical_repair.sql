-- ============================================================================
-- REPARACION HISTORICA FISCAL — evidencia ARCA del 2026-08-13
--
-- Reconciliacion read-only ejecutada con afip-fe-query (FECompConsultar /
-- FECompUltimoAutorizado) desde una sesion owner. Resultado, que es la
-- evidencia sobre la que se apoya TODO lo que hace esta migracion:
--
--   Factura C (CbteTipo 11) / PV 1  -> ultimo_autorizado = 0
--     El punto de venta 1 NUNCA emitio una Factura C. Por lo tanto los 53
--     comprobantes que declaraban identidad 0001-* no pueden estar
--     autorizados: no hay serie donde vivan.
--
--   Factura C (CbteTipo 11) / PV 10 -> ultimo_autorizado = 146
--     Los 146 numeros consultados uno por uno: todos found, resultado A,
--     PtoVta 10, CbteTipo 11, sin huecos.
--
--   Cruce por fecha+importe de los 53 contra las 146 identidades reales:
--     CERO coincidencias. Ninguno duplica una emision real.
--
--   Hueco de la serie local: el numero 45. ARCA lo tiene autorizado y la
--     venta existe localmente sin CAE: el CAE nunca se persistio.
--
-- QUE HACE
--   1. Agrega el estado 'sin_autorizacion_fiscal' al CHECK (forward-only).
--   2. Reconcilia el #45 con su identidad fiscal REAL.
--   3. Retira la identidad fiscal SIMULADA de los 53.
--   4. Deja traza en electronic_invoice_log (el mecanismo canonico fiscal;
--      NO se usa finance_audit_log, que es de movimientos economicos).
--
-- QUE NO HACE — ni una sola escritura economica
--   No toca estado, estado_comercial, numero, total, items, pagos,
--   inventario, ledger, caja, ordenes ni cuentas corrientes. La migracion
--   verifica esa promesa con un snapshot economico pre/post y ABORTA si algo
--   cambio.
--
-- BEGIN/COMMIT explicitos: las migraciones de Supabase corren en AUTOCOMMIT,
-- asi que sin transaccion propia un RAISE posterior no revertiria lo ya
-- escrito.
-- ============================================================================
BEGIN;

-- ── 1. Estado nuevo ─────────────────────────────────────────────────────────
-- Semantica: operacion comercial preservada, creada con intencion fiscal, para
-- la que ARCA confirma que NO existe autorizacion valida. Es TERMINAL: no es
-- "rechazado", no es "pendiente de reintento", y no es "no fiscal".
ALTER TABLE public.comprobantes DROP CONSTRAINT IF EXISTS comprobantes_estado_fiscal_check;
ALTER TABLE public.comprobantes ADD CONSTRAINT comprobantes_estado_fiscal_check
  CHECK (estado_fiscal = ANY (ARRAY[
    'no_fiscal', 'pendiente_emision', 'pendiente_conciliacion',
    'emitido', 'error_emision', 'anulado_fiscal',
    'sin_autorizacion_fiscal'
  ]));

-- ── 2. Lista CERRADA de los 53 ──────────────────────────────────────────────
-- Explicita a proposito. Un UPDATE por patron (length(cae)=15) alcanzaria
-- filas nuevas que nadie reconcilio contra ARCA.
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

-- ── 3. Snapshot economico PRE ───────────────────────────────────────────────
-- Si la reparacion toca un solo peso, el assert final aborta la transaccion.
CREATE TEMP TABLE _econ_pre AS
SELECT 'financial_movements' AS t, count(*)::numeric AS filas, COALESCE(sum(amount),0) AS suma FROM public.financial_movements
UNION ALL SELECT 'business_finance_entries', count(*), COALESCE(sum(amount),0) FROM public.business_finance_entries
UNION ALL SELECT 'comprobante_payments',     count(*), COALESCE(sum(amount),0) FROM public.comprobante_payments
-- account_movements lleva debit/credit, no amount: se suma el neto.
UNION ALL SELECT 'account_movements',        count(*), COALESCE(sum(debit),0) - COALESCE(sum(credit),0) FROM public.account_movements
UNION ALL SELECT 'inventory_stock',          count(*), COALESCE(sum(stock_quantity),0) FROM public.inventory
UNION ALL SELECT 'comprobantes_total',       count(*), COALESCE(sum(total),0) FROM public.comprobantes
UNION ALL SELECT 'comprobantes_cobrado',     count(*), COALESCE(sum(total_cobrado),0) FROM public.comprobantes
UNION ALL SELECT 'orders',                   count(*), 0 FROM public.orders;

-- ── 4. Precondiciones ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_n int; v_con_nf int; v_sin_nf int; v_no_15 int;
BEGIN
  SELECT count(*) INTO v_n FROM _legacy_53;
  IF v_n <> 53 THEN RAISE EXCEPTION 'PRE: la lista cerrada tiene % ids (esperado 53)', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id;
  IF v_n <> 53 THEN RAISE EXCEPTION 'PRE: solo % de los 53 ids existen en comprobantes', v_n; END IF;

  -- Todos deben seguir teniendo el CAE simulado de 15 digitos. Si alguno ya
  -- fue tocado, la evidencia del 2026-08-13 ya no lo describe.
  SELECT count(*) INTO v_no_15
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id
  WHERE c.cae IS NULL OR length(c.cae) <> 15;
  IF v_no_15 <> 0 THEN
    RAISE EXCEPTION 'PRE: % de los 53 ya no tienen el CAE simulado de 15 digitos', v_no_15;
  END IF;

  SELECT count(*) FILTER (WHERE c.numero_fiscal IS NOT NULL),
         count(*) FILTER (WHERE c.numero_fiscal IS NULL)
    INTO v_con_nf, v_sin_nf
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id;
  IF v_con_nf <> 38 OR v_sin_nf <> 15 THEN
    RAISE EXCEPTION 'PRE: reparto inesperado con/sin numero_fiscal: %/% (esperado 38/15)', v_con_nf, v_sin_nf;
  END IF;

  -- Las precondiciones del #45 viven en su propio bloque, junto al UPDATE que
  -- protegen: separarlas invitaria a que una sobreviva sin la otra.
  RAISE NOTICE 'PRE OK: 53 ids presentes, 38/15 con y sin numero_fiscal, CAE simulado intacto.';
END $$;

-- ── 5. Reparacion del #45 — identidad ARCA real ─────────────────────────────
DO $$
DECLARE
  v_id   uuid;
  v      public.comprobantes%ROWTYPE;
  v_prev jsonb;
BEGIN
  SELECT id INTO v_id FROM public.comprobantes
   WHERE id::text LIKE '67a4245d-%';
  IF v_id IS NULL THEN RAISE EXCEPTION 'PRE #45: no se encontro la fila 67a4245d-*'; END IF;

  SELECT * INTO v FROM public.comprobantes WHERE id = v_id;

  IF v.tipo <> 'factura_c'            THEN RAISE EXCEPTION 'PRE #45: tipo=% (esperado factura_c)', v.tipo; END IF;
  IF v.fecha::date <> DATE '2026-06-16' THEN RAISE EXCEPTION 'PRE #45: fecha=% (esperado 2026-06-16)', v.fecha::date; END IF;
  IF v.total <> 35000                 THEN RAISE EXCEPTION 'PRE #45: total=% (esperado 35000)', v.total; END IF;
  IF v.numero_fiscal IS NOT NULL      THEN RAISE EXCEPTION 'PRE #45: ya tiene numero_fiscal=%', v.numero_fiscal; END IF;
  IF v.cae IS NOT NULL                THEN RAISE EXCEPTION 'PRE #45: ya tiene cae'; END IF;
  IF v.estado_fiscal <> 'error_emision' THEN RAISE EXCEPTION 'PRE #45: estado_fiscal=% (esperado error_emision)', v.estado_fiscal; END IF;

  -- Nadie mas puede estar ocupando la identidad (PV10, tipo 11, nro 45).
  IF EXISTS (SELECT 1 FROM public.comprobantes
             WHERE numero_fiscal = '0010-00000045'
               AND COALESCE(tipo_comprobante_fiscal,'11') = '11') THEN
    RAISE EXCEPTION 'PRE #45: ya existe una fila con la identidad (PV10, 11, 45)';
  END IF;

  v_prev := jsonb_build_object('punto_venta', v.punto_venta, 'numero_fiscal', v.numero_fiscal,
                               'cae', v.cae, 'estado_fiscal', v.estado_fiscal,
                               'tipo_comprobante_fiscal', v.tipo_comprobante_fiscal);

  UPDATE public.comprobantes SET
    punto_venta             = '0010',
    tipo_comprobante_fiscal = '11',
    numero_fiscal           = '0010-00000045',
    cae                     = '86249909766646',
    cae_vencimiento         = DATE '2026-06-26',
    estado_fiscal           = 'emitido',
    updated_at              = now()
  WHERE id = v_id;

  INSERT INTO public.electronic_invoice_log
    (business_id, comprobante_id, punto_venta, tipo_comprobante, numero_comprobante,
     accion, estado, request_data, response_data)
  SELECT c.business_id, c.id, 10, '11', '0010-00000045',
         'reconciliacion_historica', 'emitido',
         jsonb_build_object(
           'motivo', 'ARCA autorizo el comprobante y el CAE nunca se persistio localmente',
           'evidencia', 'FECompConsultar 2026-08-13 (PV10, CbteTipo 11, CbteNro 45)',
           'identidad_previa', v_prev),
         jsonb_build_object(
           'punto_venta', 10, 'cbte_tipo', 11, 'cbte_nro', 45,
           'cae', '86249909766646', 'cae_vencimiento', '2026-06-26',
           'fecha_comprobante', '2026-06-16', 'importe_total', 35000, 'resultado', 'A')
  FROM public.comprobantes c WHERE c.id = v_id;

  RAISE NOTICE '#45 reconciliado con la identidad ARCA (PV10, 11, 45).';
END $$;

-- ── 6. Reparacion de los 53 — retirar identidad fiscal simulada ─────────────
-- Traza ANTES de perder los valores.
INSERT INTO public.electronic_invoice_log
  (business_id, comprobante_id, punto_venta, tipo_comprobante, numero_comprobante,
   accion, estado, request_data, response_data)
SELECT c.business_id, c.id, 1, '11', c.numero_fiscal,
       'reconciliacion_historica', 'sin_autorizacion_fiscal',
       jsonb_build_object(
         'motivo', 'ARCA confirma que el punto de venta 1 nunca emitio una Factura C',
         'evidencia', 'FECompUltimoAutorizado 2026-08-13 (PV1, CbteTipo 11) = 0',
         'cruce', 'sin equivalente por fecha+importe entre las 146 identidades reales de PV10',
         'identidad_previa', jsonb_build_object(
           'punto_venta', c.punto_venta, 'numero_fiscal', c.numero_fiscal,
           'cae_simulado_digitos', length(c.cae), 'estado_fiscal', c.estado_fiscal)),
       jsonb_build_object('ultimo_autorizado_pv1_tipo11', 0)
FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id;

UPDATE public.comprobantes c SET
  cae            = NULL,
  numero_fiscal  = NULL,
  estado_fiscal  = 'sin_autorizacion_fiscal',
  updated_at     = now()
FROM _legacy_53 l
WHERE l.id = c.id;

-- ── 7. Postcondiciones ──────────────────────────────────────────────────────
DO $$
DECLARE v_n int; v45 public.comprobantes%ROWTYPE;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.comprobantes c JOIN _legacy_53 l ON l.id = c.id
  WHERE c.estado_fiscal = 'sin_autorizacion_fiscal' AND c.cae IS NULL AND c.numero_fiscal IS NULL;
  IF v_n <> 53 THEN RAISE EXCEPTION 'POST: solo % de 53 quedaron sin autorizacion fiscal', v_n; END IF;

  SELECT * INTO v45 FROM public.comprobantes WHERE numero_fiscal = '0010-00000045';
  IF v45.id IS NULL THEN RAISE EXCEPTION 'POST: el #45 no quedo reconciliado'; END IF;
  IF v45.cae <> '86249909766646' THEN RAISE EXCEPTION 'POST #45: CAE inesperado'; END IF;
  IF v45.tipo_comprobante_fiscal <> '11' THEN RAISE EXCEPTION 'POST #45: CbteTipo inesperado'; END IF;
  IF v45.punto_venta <> '0010' THEN RAISE EXCEPTION 'POST #45: punto_venta inesperado'; END IF;
  IF v45.estado_fiscal <> 'emitido' THEN RAISE EXCEPTION 'POST #45: estado_fiscal inesperado'; END IF;

  SELECT count(*) INTO v_n FROM public.comprobantes
   WHERE numero_fiscal = '0010-00000045' AND COALESCE(tipo_comprobante_fiscal,'11') = '11';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST: % filas representan la identidad (PV10,11,45)', v_n; END IF;

  -- El caso #1 NO se toca: Factura C (11) y NC (13) comparten numero_fiscal a
  -- proposito, porque son series distintas.
  SELECT count(*) INTO v_n FROM public.comprobantes WHERE numero_fiscal = '0010-00000001';
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST: el caso #1 dejo de tener sus 2 filas (tiene %)', v_n; END IF;

  -- Ya no debe quedar ningun CAE simulado de 15 digitos.
  SELECT count(*) INTO v_n FROM public.comprobantes WHERE cae IS NOT NULL AND length(cae) <> 14;
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST: quedan % CAE que no tienen 14 digitos', v_n; END IF;
END $$;

-- ── 8. INVARIANTE ECONOMICO — la promesa central ────────────────────────────
DO $$
DECLARE v_dif text;
BEGIN
  CREATE TEMP TABLE _econ_post AS
  SELECT 'financial_movements' AS t, count(*)::numeric AS filas, COALESCE(sum(amount),0) AS suma FROM public.financial_movements
  UNION ALL SELECT 'business_finance_entries', count(*), COALESCE(sum(amount),0) FROM public.business_finance_entries
  UNION ALL SELECT 'comprobante_payments',     count(*), COALESCE(sum(amount),0) FROM public.comprobante_payments
  -- account_movements lleva debit/credit, no amount: se suma el neto.
UNION ALL SELECT 'account_movements',        count(*), COALESCE(sum(debit),0) - COALESCE(sum(credit),0) FROM public.account_movements
  UNION ALL SELECT 'inventory_stock',          count(*), COALESCE(sum(stock_quantity),0) FROM public.inventory
  UNION ALL SELECT 'comprobantes_total',       count(*), COALESCE(sum(total),0) FROM public.comprobantes
  UNION ALL SELECT 'comprobantes_cobrado',     count(*), COALESCE(sum(total_cobrado),0) FROM public.comprobantes
  UNION ALL SELECT 'orders',                   count(*), 0 FROM public.orders;

  SELECT string_agg(format('%s: %s/%s -> %s/%s', a.t, a.filas, a.suma, b.filas, b.suma), ' | ')
    INTO v_dif
  FROM _econ_pre a JOIN _econ_post b USING (t)
  WHERE a.filas IS DISTINCT FROM b.filas OR a.suma IS DISTINCT FROM b.suma;

  IF v_dif IS NOT NULL THEN
    RAISE EXCEPTION 'INVARIANTE ECONOMICO ROTO — la reparacion movio cifras: %', v_dif;
  END IF;
  RAISE NOTICE 'Invariante economico intacto: ninguna cifra se movio.';
END $$;

COMMIT;
