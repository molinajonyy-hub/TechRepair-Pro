-- ============================================================================
-- P0 - CONTRATO CANONICO DEL PUNTO DE VENTA FISCAL
--
-- Corre contra el stack LOCAL (NUNCA produccion), con 20260814150000 aplicada.
--
-- REQUISITO: el seed E2E tiene que estar aplicado (negocio, perfil y caja), o
-- el checkout responde FORBIDDEN antes de llegar al punto de venta:
--   npm run e2e:prepare
--   docker exec -i supabase_db_techrepair-vite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/sql/fiscal_sales_point_contract.test.sql
--
-- Todo ocurre dentro de UNA transaccion que termina en ROLLBACK: no deja
-- fixtures, ni arca_config, ni comprobantes.
--
-- FIXTURE ADVERSARIAL (el caso que bloqueo el lote):
--   sales_points.numero      = 7   (predeterminado, lo que muestra el POS)
--   arca_config.punto_venta  = 3   (la fuente fiscal real, la que usa el CAE)
--
-- El cliente SIEMPRE manda '0007' en el payload. Lo que se verifica es que
-- gane el 3 en toda factura fiscal y que el 7 sobreviva solo en el remito.
--
--   F01  factura_c            -> PV 0003 (no 0007)
--   F02  factura_a            -> PV 0003
--   F03  nota_credito generica -> fail-closed antes de cualquier escritura
--   F04  remito               -> emitir ARCA falla; sin ARCA usa PV 0007
--   F05  numero local lleva el prefijo fiscal 0003, no 0007
--   F06  SPOOFING: es_fiscal=false + tipo=factura_c -> fiscal completo pendiente
--   F07  arca_config ausente o PV <= 0 + emitir=true -> ARCA_NOT_CONFIGURED
--   F08  sin arca_config + emitir_en_arca=false -> 0001, nunca 0007
--   F09  cross-business: no se puede cobrar contra un negocio ajeno
--   F10  el remito sigue tomando el PV del payload aun con arca_config presente
--   F11  original sin CbteTipo -> RPC de NC fail-closed, sin insertar borrador
--   F12  Factura C y NC-C pueden compartir numero_fiscal: distinta FiscalIdentity
--   F13  NC sin arca_config valida -> fail-closed sin insertar
--   F14  tipo comercial/CbteTipo incoherente -> fail-closed sin insertar
--   F15  claim diferido con PV 0 -> sin attempt y sin WSFE posible
--   F16  finalizacion NC -> original + FM/BFE atomicos e idempotentes
-- ============================================================================
BEGIN;

-- notice: los RAISE NOTICE de cada caso son la salida legible del test.
SET LOCAL client_min_messages = notice;

-- ── Contexto de autenticacion: el owner del negocio E2E ─────────────────────
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000e2e0001","role":"authenticated"}',
  true);

-- ── El usuario de Auth tiene que existir ────────────────────────────────────
-- comprobantes.created_by referencia auth.users. En la corrida normal esa fila
-- la crea el globalSetup de Playwright por la API de Auth, que no existe acá:
-- sobre una base recién reseteada el test fallaría con un FK opaco. Se asegura
-- de forma idempotente y se deshace con el ROLLBACK final.
INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-0000-0000-00000e2e0001', 'owner@e2e.local')
ON CONFLICT (id) DO NOTHING;

-- ── Fixture adversarial ─────────────────────────────────────────────────────
INSERT INTO public.sales_points (business_id, numero, nombre, activo, predeterminado)
VALUES ('00000000-0000-0000-0000-00000e2eb001', 7, 'Casa Central', true, true);

INSERT INTO public.arca_config (business_id, cuit_emisor, ambiente, punto_venta)
VALUES ('00000000-0000-0000-0000-00000e2eb001', '20111111112', 'homologacion', 3);

-- ── Helper: dispara un checkout y devuelve el resultado ─────────────────────
CREATE OR REPLACE FUNCTION pg_temp.cobrar(
  p_tipo text, p_es_fiscal boolean, p_emitir boolean, p_pv_cliente text, p_key text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_payload jsonb;
  v_pagos   jsonb;
  v_iva     numeric;
  v_total   numeric;
BEGIN
  -- El IVA lo calcula el servidor: factura_a suma 21% sobre el neto. Si el pago
  -- no cubre ESE total, el checkout se rechaza antes de llegar al PV.
  v_iva   := CASE WHEN p_tipo = 'factura_a' THEN 21 ELSE 0 END;
  v_total := 100 + v_iva;

  -- Una NC no lleva pagos; el resto cobra el total en efectivo.
  v_pagos := CASE WHEN p_tipo = 'nota_credito' THEN '[]'::jsonb ELSE jsonb_build_array(
    jsonb_build_object('payment_method','efectivo','amount',v_total,'currency','ARS',
                       'amount_ars',v_total,'exchange_rate',1,'commission_rate',0,
                       'commission_amount',0,'net_amount',v_total)) END;

  v_payload := jsonb_build_object(
    'tipo', p_tipo,
    'punto_venta', p_pv_cliente,
    'condicion_fiscal', 'Consumidor Final',
    'es_fiscal', p_es_fiscal,
    'emitir_en_arca', p_emitir,
    'exchange_rate', 1,
    'skip_finance_entry', true,
    'caja_id', '00000000-0000-0000-0000-00000e2e6001',
    'subtotal_ars', 100, 'tax', v_iva, 'total', v_total, 'total_usd', 0,
    'descuento_total', 0, 'costo_total_ars', 0,
    'total_comisiones', 0, 'total_neto', v_total, 'total_bruto', v_total,
    'cc_total', 0,
    'items', jsonb_build_array(jsonb_build_object(
      'descripcion','Servicio de prueba','tipo_linea','servicio','cantidad',1,
      'precio_unitario',100,'descuento_linea',0,'subtotal',100,
      'costo_unitario',0,'costo_total',0,'currency','ARS','exchange_rate',1,
      'inventory_id',NULL,'orden',0)),
    'pagos', v_pagos);

  RETURN public.create_comprobante_checkout_atomic(
    '00000000-0000-0000-0000-00000e2eb001', p_key,
    public.compute_checkout_intent_hash('00000000-0000-0000-0000-00000e2eb001', v_payload),
    v_payload);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.pv_de(p_res jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT punto_venta FROM public.comprobantes WHERE id = (p_res->>'comprobante_id')::uuid;
$$;

CREATE OR REPLACE FUNCTION pg_temp.num_de(p_res jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT numero FROM public.comprobantes WHERE id = (p_res->>'comprobante_id')::uuid;
$$;

-- ── F01 · factura_c: gana el PV fiscal ──────────────────────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f01');
  IF r->>'status' NOT IN ('created') THEN
    RAISE EXCEPTION 'F01: el checkout no se creo: %', r;
  END IF;
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0003' THEN
    RAISE EXCEPTION 'F01: factura_c quedo con PV % (esperado 0003, el de arca_config)', pv;
  END IF;
  RAISE NOTICE 'F01 OK - factura_c persiste PV 0003 y descarta el 0007 del cliente.';
END $$;

-- ── F02 · factura_a ─────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('factura_a', true, false, '0007', 'k-f02');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0003' THEN
    RAISE EXCEPTION 'F02: factura_a quedo con PV % (esperado 0003)', pv;
  END IF;
  RAISE NOTICE 'F02 OK - factura_a persiste PV 0003.';
END $$;

-- ── F03 · una NC generica no puede eludir CbtesAsoc/original ────────────────
DO $$
DECLARE
  r jsonb;
  v_requests_before integer;
  v_requests_after integer;
  v_comprobantes_before integer;
  v_comprobantes_after integer;
BEGIN
  SELECT count(*) INTO v_requests_before
    FROM public.comprobante_checkout_requests
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  SELECT count(*) INTO v_comprobantes_before
    FROM public.comprobantes
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';

  r := pg_temp.cobrar('nota_credito', true, false, '0007', 'k-f03');
  IF r->>'status' IS DISTINCT FROM 'failed_final'
     OR r->>'error_code' IS DISTINCT FROM 'CREDIT_NOTE_REQUIRES_ORIGINAL' THEN
    RAISE EXCEPTION 'F03: la NC generica no fallo cerrado: %', r;
  END IF;

  SELECT count(*) INTO v_requests_after
    FROM public.comprobante_checkout_requests
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  SELECT count(*) INTO v_comprobantes_after
    FROM public.comprobantes
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';

  IF v_requests_after <> v_requests_before OR v_comprobantes_after <> v_comprobantes_before THEN
    RAISE EXCEPTION 'F03: el rechazo dejo escrituras: requests=%->%, comprobantes=%->%',
      v_requests_before, v_requests_after, v_comprobantes_before, v_comprobantes_after;
  END IF;
  RAISE NOTICE 'F03 OK - la NC generica falla antes de idempotencia y de insertar comprobantes.';
END $$;

-- ── F04 · remito: ARCA prohibida; local permitido con PV local ──────────────
DO $$
DECLARE
  r jsonb;
  pv text;
  v_es_fiscal boolean;
  v_emitir boolean;
  v_estado_fiscal text;
BEGIN
  r := pg_temp.cobrar('remito', true, true, '0007', 'k-f04');
  IF r->>'status' IS DISTINCT FROM 'failed_final'
     OR r->>'error_code' IS DISTINCT FROM 'NON_FISCAL_ARCA_NOT_ALLOWED' THEN
    RAISE EXCEPTION 'F04: remito + emitir ARCA no fallo cerrado: %', r;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.comprobante_checkout_requests
     WHERE business_id = '00000000-0000-0000-0000-00000e2eb001'
       AND idempotency_key = 'k-f04'
  ) OR r ? 'comprobante_id' THEN
    RAISE EXCEPTION 'F04: el remito invalido dejo escritura: %', r;
  END IF;

  r := pg_temp.cobrar('remito', false, false, '0007', 'k-f04-local');
  SELECT punto_venta, es_fiscal, emitir_en_arca, estado_fiscal
    INTO pv, v_es_fiscal, v_emitir, v_estado_fiscal
    FROM public.comprobantes
   WHERE id = (r->>'comprobante_id')::uuid;
  IF pv IS DISTINCT FROM '0007' THEN
    RAISE EXCEPTION 'F04: el remito debe conservar el PV local 0007, quedo %', pv;
  END IF;
  IF v_es_fiscal IS DISTINCT FROM false
     OR v_emitir IS DISTINCT FROM false
     OR v_estado_fiscal IS DISTINCT FROM 'no_fiscal' THEN
    RAISE EXCEPTION 'F04: remito quedo fiscal: es_fiscal=%, emitir=%, estado_fiscal=%',
      v_es_fiscal, v_emitir, v_estado_fiscal;
  END IF;
  RAISE NOTICE 'F04 OK - remito no puede pedir ARCA y, en modo local, conserva PV 0007.';
END $$;

-- ── F05 · el numero local lleva el prefijo FISCAL ───────────────────────────
DO $$
DECLARE r jsonb; num text;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f05');
  num := pg_temp.num_de(r);
  IF num NOT LIKE '0003-%' THEN
    RAISE EXCEPTION 'F05: el numero local quedo % (esperado prefijo 0003-)', num;
  END IF;
  IF num LIKE '0007-%' THEN
    RAISE EXCEPTION 'F05: el numero local conserva el PV del cliente: %', num;
  END IF;
  RAISE NOTICE 'F05 OK - numero local %, con prefijo fiscal.', num;
END $$;

-- ── F06 · SPOOFING: es_fiscal=false sobre un tipo fiscal ────────────────────
DO $$
DECLARE
  r jsonb;
  pv text;
  v_es_fiscal boolean;
  v_emitir boolean;
  v_estado text;
  v_status text;
  v_estado_fiscal text;
  v_cae text;
  v_cae_vencimiento date;
  v_numero_fiscal text;
BEGIN
  r := pg_temp.cobrar('factura_c', false, false, '0007', 'k-f06');
  SELECT punto_venta, es_fiscal, emitir_en_arca, estado, status, estado_fiscal,
         cae, cae_vencimiento, numero_fiscal
    INTO pv, v_es_fiscal, v_emitir, v_estado, v_status, v_estado_fiscal,
         v_cae, v_cae_vencimiento, v_numero_fiscal
    FROM public.comprobantes
   WHERE id = (r->>'comprobante_id')::uuid;
  IF pv IS DISTINCT FROM '0003' THEN
    RAISE EXCEPTION 'F06: declarando es_fiscal=false el cliente se quedo con el PV % ', pv;
  END IF;
  IF v_es_fiscal IS DISTINCT FROM true
     OR v_emitir IS DISTINCT FROM false
     OR v_estado IS DISTINCT FROM 'borrador'
     OR v_status IS DISTINCT FROM 'draft'
     OR v_estado_fiscal IS DISTINCT FROM 'pendiente_emision'
     OR v_cae IS NOT NULL
     OR v_cae_vencimiento IS NOT NULL
     OR v_numero_fiscal IS NOT NULL THEN
    RAISE EXCEPTION
      'F06: fiscalidad persistida inconsistente: es_fiscal=%, emitir=%, estado=%, status=%, estado_fiscal=%, cae=%, venc=%, numero_fiscal=%',
      v_es_fiscal, v_emitir, v_estado, v_status, v_estado_fiscal,
      v_cae, v_cae_vencimiento, v_numero_fiscal;
  END IF;
  RAISE NOTICE 'F06 OK - tipo fiscal manda en PV, flags y estados; queda pendiente, sin identidad ARCA.';
END $$;

-- ── F07 · fail-closed con config invalida/ausente y pidiendo CAE ────────────
DO $$
DECLARE r jsonb;
BEGIN
  UPDATE public.arca_config
     SET punto_venta = 0
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';

  r := pg_temp.cobrar('factura_c', true, true, '0007', 'k-f07-invalid');
  IF r->>'error_code' IS DISTINCT FROM 'ARCA_NOT_CONFIGURED' THEN
    RAISE EXCEPTION 'F07: PV 0 debe ser config invalida; obtuvo %', r;
  END IF;
  IF r ? 'comprobante_id' AND r->>'comprobante_id' IS NOT NULL THEN
    RAISE EXCEPTION 'F07: config invalida igual devolvio un comprobante: %', r;
  END IF;

  DELETE FROM public.arca_config WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  r := pg_temp.cobrar('factura_c', true, true, '0007', 'k-f07-missing');
  IF r->>'error_code' IS DISTINCT FROM 'ARCA_NOT_CONFIGURED' THEN
    RAISE EXCEPTION 'F07: esperaba ARCA_NOT_CONFIGURED, obtuvo %', r;
  END IF;
  -- Se acota a ESTE checkout: el remito de F04 conserva 0007 a proposito, y la
  -- base local puede traer comprobantes viejos con PV local ya persistido.
  IF r ? 'comprobante_id' AND r->>'comprobante_id' IS NOT NULL THEN
    RAISE EXCEPTION 'F07: el checkout fallido igual devolvio un comprobante: %', r;
  END IF;
  RAISE NOTICE 'F07 OK - PV 0 o arca_config ausente fallan cerrado y no crean comprobante.';
END $$;

-- ── F08 · sin arca_config y SIN CAE: 0001, nunca 0007 ───────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f08');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0001' THEN
    RAISE EXCEPTION 'F08: esperaba el default 0001, obtuvo %', pv;
  END IF;
  RAISE NOTICE 'F08 OK - sin ARCA el fiscal cae al default 0001 y nunca al PV local.';
END $$;

-- ── F09 · cross-business ────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; v_payload jsonb;
BEGIN
  v_payload := jsonb_build_object('tipo','factura_c','punto_venta','0007','es_fiscal',true,
    'items','[]'::jsonb,'pagos','[]'::jsonb);
  r := public.create_comprobante_checkout_atomic(
        '00000000-0000-0000-0000-00000e2eb002', 'k-f09', 'hash', v_payload);
  IF r->>'error_code' IS DISTINCT FROM 'FORBIDDEN' THEN
    RAISE EXCEPTION 'F09: se pudo cobrar contra un negocio ajeno: %', r;
  END IF;
  RAISE NOTICE 'F09 OK - no se puede cobrar contra un negocio ajeno.';
END $$;

-- ── F10 · el remito no se contamina con el PV fiscal ────────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  INSERT INTO public.arca_config (business_id, cuit_emisor, ambiente, punto_venta)
  VALUES ('00000000-0000-0000-0000-00000e2eb001', '20111111112', 'homologacion', 3);
  r := pg_temp.cobrar('remito', false, false, '0009', 'k-f10');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0009' THEN
    RAISE EXCEPTION 'F10: el remito debe usar el PV del payload (0009), quedo %', pv;
  END IF;
  RAISE NOTICE 'F10 OK - con arca_config presente el remito sigue usando su PV local.';
END $$;

-- ── F11 · NC sin CbteTipo original: fail-closed server-side ─────────────────
DO $$
DECLARE
  r jsonb;
  nc jsonb;
  original_id uuid;
  v_nc_count integer;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f11');
  original_id := (r->>'comprobante_id')::uuid;

  UPDATE public.comprobantes
     SET estado_fiscal = 'emitido',
         cae = '11111111111111',
         numero_fiscal = '0003-00000001',
         tipo_comprobante_fiscal = NULL
   WHERE id = original_id;

  nc := public.create_credit_note_from_comprobante(original_id);
  IF nc->>'success' IS DISTINCT FROM 'false'
     OR nc->>'error_code' IS DISTINCT FROM 'FISCAL_IDENTITY_INCOMPLETE' THEN
    RAISE EXCEPTION 'F11: original sin CbteTipo no fallo cerrado: %', nc;
  END IF;

  SELECT count(*) INTO v_nc_count
    FROM public.comprobantes
   WHERE comprobante_original_id = original_id;
  IF v_nc_count <> 0 THEN
    RAISE EXCEPTION 'F11: la RPC fail-closed igual inserto % NC', v_nc_count;
  END IF;
  RAISE NOTICE 'F11 OK - sin CbteTipo original no se crea NC ni se inventa NC-C.';
END $$;

-- ── F12 · mismo numero_fiscal, distinta terna por CbteTipo ──────────────────
DO $$
DECLARE
  r jsonb;
  nc jsonb;
  original_id uuid;
  nc_id uuid;
  v_count integer;
  v_nc_pv text;
  v_emitir boolean;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f12');
  original_id := (r->>'comprobante_id')::uuid;

  UPDATE public.comprobantes
     SET estado_fiscal = 'emitido',
         cae = '22222222222222',
         numero_fiscal = '0003-00000002',
         tipo_comprobante_fiscal = '11'
   WHERE id = original_id;

  nc := public.create_credit_note_from_comprobante(original_id);
  IF nc->>'success' IS DISTINCT FROM 'true' OR nc->>'nc_tipo_fiscal' IS DISTINCT FROM '13' THEN
    RAISE EXCEPTION 'F12: Factura C no resolvio NC-C (13): %', nc;
  END IF;
  nc_id := (nc->>'nc_id')::uuid;

  SELECT punto_venta, emitir_en_arca INTO v_nc_pv, v_emitir
    FROM public.comprobantes WHERE id = nc_id;
  IF v_nc_pv IS DISTINCT FROM '0003' OR v_emitir IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'F12: la NC no heredo la serie ARCA server-side: pv=%, emitir=%',
      v_nc_pv, v_emitir;
  END IF;

  -- El texto de numero puede repetirse porque la identidad incluye CbteTipo.
  UPDATE public.comprobantes
     SET numero_fiscal = '0003-00000002'
   WHERE id = nc_id;

  SELECT count(*) INTO v_count
    FROM public.comprobantes
   WHERE numero_fiscal = '0003-00000002'
     AND tipo_comprobante_fiscal IN ('11', '13');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'F12: no coexistieron Factura C y NC-C con mismo numero: count=%', v_count;
  END IF;
  RAISE NOTICE 'F12 OK - 0003-00000002 coexiste como CbteTipo 11 y 13.';
END $$;

-- ── F13 · NC sin configuracion ARCA valida no deja borrador ────────────────
DO $$
DECLARE
  r jsonb;
  nc jsonb;
  original_id uuid;
  v_nc_count integer;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f13');
  original_id := (r->>'comprobante_id')::uuid;
  UPDATE public.comprobantes
     SET estado_fiscal = 'emitido', cae = '33333333333333',
         numero_fiscal = '0003-00000003', tipo_comprobante_fiscal = '11'
   WHERE id = original_id;

  UPDATE public.arca_config SET punto_venta = 0
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  nc := public.create_credit_note_from_comprobante(original_id);
  IF nc->>'success' IS DISTINCT FROM 'false'
     OR nc->>'error_code' IS DISTINCT FROM 'ARCA_NOT_CONFIGURED' THEN
    RAISE EXCEPTION 'F13: PV ARCA 0 no fallo cerrado al crear NC: %', nc;
  END IF;
  SELECT count(*) INTO v_nc_count FROM public.comprobantes
   WHERE comprobante_original_id = original_id;
  IF v_nc_count <> 0 THEN
    RAISE EXCEPTION 'F13: config invalida dejo % borradores NC', v_nc_count;
  END IF;

  DELETE FROM public.arca_config
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  nc := public.create_credit_note_from_comprobante(original_id);
  IF nc->>'success' IS DISTINCT FROM 'false'
     OR nc->>'error_code' IS DISTINCT FROM 'ARCA_NOT_CONFIGURED' THEN
    RAISE EXCEPTION 'F13: config ARCA ausente no fallo cerrado al crear NC: %', nc;
  END IF;
  SELECT count(*) INTO v_nc_count FROM public.comprobantes
   WHERE comprobante_original_id = original_id;
  IF v_nc_count <> 0 THEN
    RAISE EXCEPTION 'F13: config ausente dejo % borradores NC', v_nc_count;
  END IF;

  INSERT INTO public.arca_config (business_id, cuit_emisor, ambiente, punto_venta)
  VALUES ('00000000-0000-0000-0000-00000e2eb001', '20111111112', 'homologacion', 3);
  RAISE NOTICE 'F13 OK - PV ARCA 0 o ausente bloquea la NC sin insertar.';
END $$;

-- ── F14 · tipo comercial y CbteTipo deben ser coherentes ───────────────────
DO $$
DECLARE
  r jsonb;
  nc jsonb;
  original_id uuid;
  original_nc_id uuid;
  v_nc_count integer;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f14-a');
  original_id := (r->>'comprobante_id')::uuid;
  UPDATE public.comprobantes
     SET estado_fiscal = 'emitido', cae = '44444444444444',
         numero_fiscal = '0003-00000004', tipo_comprobante_fiscal = '1'
   WHERE id = original_id;
  nc := public.create_credit_note_from_comprobante(original_id);
  IF nc->>'success' IS DISTINCT FROM 'false'
     OR nc->>'error_code' IS DISTINCT FROM 'UNSUPPORTED_ORIGINAL_CBTE_TYPE' THEN
    RAISE EXCEPTION 'F14: factura_c con CbteTipo 1 no fallo cerrado: %', nc;
  END IF;

  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f14-b');
  original_nc_id := (r->>'comprobante_id')::uuid;
  UPDATE public.comprobantes
     SET tipo = 'nota_credito', type = 'nota_credito',
         estado_fiscal = 'emitido', cae = '55555555555555',
         numero_fiscal = '0003-00000005', tipo_comprobante_fiscal = '11'
   WHERE id = original_nc_id;
  nc := public.create_credit_note_from_comprobante(original_nc_id);
  IF nc->>'success' IS DISTINCT FROM 'false'
     OR nc->>'error_code' IS DISTINCT FROM 'UNSUPPORTED_ORIGINAL_CBTE_TYPE' THEN
    RAISE EXCEPTION 'F14: una NC usada como original no fallo cerrado: %', nc;
  END IF;

  SELECT count(*) INTO v_nc_count FROM public.comprobantes
   WHERE comprobante_original_id IN (original_id, original_nc_id);
  IF v_nc_count <> 0 THEN
    RAISE EXCEPTION 'F14: identidad incoherente dejo % borradores NC', v_nc_count;
  END IF;
  RAISE NOTICE 'F14 OK - tipo comercial/CbteTipo incoherente y NC como original fallan cerrado.';
END $$;

-- ── F15 · un claim diferido tampoco acepta PV 0 ────────────────────────────
DO $$
DECLARE
  r jsonb;
  claim_result jsonb;
  comp_id uuid;
  v_check_failed boolean := false;
  v_attempts integer;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f15');
  comp_id := (r->>'comprobante_id')::uuid;
  UPDATE public.arca_config SET punto_venta = 0
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';

  BEGIN
    claim_result := public.claim_comprobante_arca_emission(comp_id, 'f15-pv-invalido');
  EXCEPTION WHEN check_violation THEN
    v_check_failed := true;
  END;

  IF NOT v_check_failed AND claim_result->>'result' IS NOT DISTINCT FROM 'acquired' THEN
    RAISE EXCEPTION 'F15: claim con PV 0 fue adquirido: %', claim_result;
  END IF;
  SELECT count(*) INTO v_attempts FROM public.arca_emission_attempts
   WHERE comprobante_id = comp_id;
  IF v_attempts <> 0 THEN
    RAISE EXCEPTION 'F15: claim con PV 0 dejo % attempts', v_attempts;
  END IF;

  UPDATE public.arca_config SET punto_venta = 3
   WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  RAISE NOTICE 'F15 OK - el constraint server-side bloquea PV 0 sin persistir attempt.';
END $$;

-- ── F16 · finalizacion economica y comercial de NC en una RPC ──────────────
DO $$
DECLARE
  r jsonb;
  nc jsonb;
  fin jsonb;
  snapshot jsonb;
  snapshot_replay jsonb;
  invalid_snapshot jsonb;
  replay jsonb;
  original_id uuid;
  nc_id uuid;
  attempt_id uuid;
  invoice_attempt_id uuid;
  v_estado text;
  v_estado_fiscal text;
  v_fm integer;
  v_bfe integer;
  v_snapshot_count integer;
BEGIN
  r := pg_temp.cobrar('factura_c', true, false, '0007', 'k-f16');
  original_id := (r->>'comprobante_id')::uuid;
  UPDATE public.comprobantes
     SET estado_fiscal = 'emitido', cae = '66666666666666',
         numero_fiscal = '0003-00000006', tipo_comprobante_fiscal = '11'
   WHERE id = original_id;

  nc := public.create_credit_note_from_comprobante(original_id);
  nc_id := (nc->>'nc_id')::uuid;
  UPDATE public.comprobantes
     SET estado = 'emitido', status = 'issued', estado_fiscal = 'emitido',
         cae = '77777777777777', numero_fiscal = '0003-00000016'
   WHERE id = nc_id;

  -- Un CAE escrito en la fila, sin attempt ARCA terminal ni snapshot, no es
  -- evidencia suficiente para anular el original o tocar libros.
  fin := public.create_credit_note_finance_reversal(nc_id);
  SELECT estado, estado_fiscal INTO v_estado, v_estado_fiscal
    FROM public.comprobantes WHERE id = original_id;
  SELECT count(*) INTO v_fm FROM public.financial_movements
   WHERE comprobante_id = nc_id AND sign = -1;
  SELECT count(*) INTO v_bfe FROM public.business_finance_entries
   WHERE reference_comprobante_id = nc_id AND amount_ars < 0 AND source = 'comprobante';
  IF fin->>'ok' IS DISTINCT FROM 'false'
     OR fin->>'error_code' IS DISTINCT FROM 'ARCA_ATTEMPT_PROOF_MISSING'
     OR v_estado = 'anulado'
     OR v_estado_fiscal = 'anulado_fiscal'
     OR v_fm <> 0 OR v_bfe <> 0 THEN
    RAISE EXCEPTION
      'F16: CAE sin attempt no fallo cerrado: result=%, estado=%, fiscal=%, FM=%, BFE=%',
      fin, v_estado, v_estado_fiscal, v_fm, v_bfe;
  END IF;

  INSERT INTO public.arca_emission_attempts (
    comprobante_id, business_id, correlation_id,
    ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
  ) VALUES (
    original_id, '00000000-0000-0000-0000-00000e2eb001', 'f16-factura',
    'homologacion', '20111111112', 3, 11, 'claimed'
  ) RETURNING id INTO invoice_attempt_id;
  invalid_snapshot := public.snapshot_arca_nc_cbtes_asoc(
    invoice_attempt_id, original_id, original_id, 11, 3, 6);
  IF invalid_snapshot->>'success' IS DISTINCT FROM 'false'
     OR invalid_snapshot->>'error_code' IS DISTINCT FROM 'ATTEMPT_NOT_NC_C' THEN
    RAISE EXCEPTION 'F16: la RPC snapshot acepto una factura: %', invalid_snapshot;
  END IF;
  UPDATE public.arca_emission_attempts
     SET status = 'abandoned', completed_at = now(), updated_at = now()
   WHERE id = invoice_attempt_id;

  -- La RPC solo puede fijar el snapshot mientras el attempt NC-C esta activo.
  INSERT INTO public.arca_emission_attempts (
    comprobante_id, business_id, correlation_id,
    ambiente, cuit_emisor, punto_venta, tipo_comprobante, status
  ) VALUES (
    nc_id, '00000000-0000-0000-0000-00000e2eb001', 'f16-snapshot',
    'homologacion', '20111111112', 3, 13, 'claimed'
  ) RETURNING id INTO attempt_id;

  snapshot := public.snapshot_arca_nc_cbtes_asoc(
    attempt_id, nc_id, original_id, 11, 3, 6);
  snapshot_replay := public.snapshot_arca_nc_cbtes_asoc(
    attempt_id, nc_id, original_id, 11, 3, 6);
  IF snapshot->>'success' IS DISTINCT FROM 'true'
     OR snapshot->>'replay' IS DISTINCT FROM 'false'
     OR snapshot_replay->>'success' IS DISTINCT FROM 'true'
     OR snapshot_replay->>'replay' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'F16: snapshot/replay exacto fallo: first=%, replay=%',
      snapshot, snapshot_replay;
  END IF;

  SELECT count(*) INTO v_snapshot_count
    FROM public.arca_emission_attempts
   WHERE id = attempt_id
     AND cbte_asoc_original_id = original_id
     AND cbte_asoc_tipo = 11
     AND cbte_asoc_punto_venta = 3
     AND cbte_asoc_numero = 6;
  IF v_snapshot_count <> 1 THEN
    RAISE EXCEPTION 'F16: el snapshot all-or-none no quedo persistido';
  END IF;

  -- Simula complete_arca_attempt: solo el estado terminal con CAE/numero de la
  -- propia NC habilita ahora el cierre comercial/economico.
  UPDATE public.arca_emission_attempts
     SET status = 'authorized',
         numero_intentado = 16,
         cae = '77777777777777',
         completed_at = now(),
         updated_at = now()
   WHERE id = attempt_id;

  invalid_snapshot := public.snapshot_arca_nc_cbtes_asoc(
    attempt_id, nc_id, original_id, 11, 3, 6);
  IF invalid_snapshot->>'success' IS DISTINCT FROM 'false'
     OR invalid_snapshot->>'error_code' IS DISTINCT FROM 'ATTEMPT_NOT_ACTIVE' THEN
    RAISE EXCEPTION 'F16: la RPC snapshot acepto un attempt terminal: %', invalid_snapshot;
  END IF;

  fin := public.create_credit_note_finance_reversal(nc_id);
  IF fin->>'ok' IS DISTINCT FROM 'true' OR fin->>'original_finalized' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'F16: finalizacion con prueba ARCA completa fallo: %', fin;
  END IF;
  SELECT estado, estado_fiscal INTO v_estado, v_estado_fiscal
    FROM public.comprobantes WHERE id = original_id;
  SELECT count(*) INTO v_fm FROM public.financial_movements
   WHERE comprobante_id = nc_id AND sign = -1;
  SELECT count(*) INTO v_bfe FROM public.business_finance_entries
   WHERE reference_comprobante_id = nc_id AND amount_ars < 0 AND source = 'comprobante';
  IF v_estado IS DISTINCT FROM 'anulado'
     OR v_estado_fiscal IS DISTINCT FROM 'anulado_fiscal'
     OR v_fm <> 1 OR v_bfe <> 1 THEN
    RAISE EXCEPTION 'F16: cierre parcial: estado=%, fiscal=%, FM=%, BFE=%',
      v_estado, v_estado_fiscal, v_fm, v_bfe;
  END IF;

  IF has_function_privilege(
       'anon',
       'public.snapshot_arca_nc_cbtes_asoc(uuid,uuid,uuid,integer,integer,integer)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.snapshot_arca_nc_cbtes_asoc(uuid,uuid,uuid,integer,integer,integer)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.snapshot_arca_nc_cbtes_asoc(uuid,uuid,uuid,integer,integer,integer)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'F16: privilegios RPC snapshot no son service_role-only';
  END IF;

  replay := public.create_credit_note_finance_reversal(nc_id);
  SELECT count(*) INTO v_fm FROM public.financial_movements
   WHERE comprobante_id = nc_id AND sign = -1;
  SELECT count(*) INTO v_bfe FROM public.business_finance_entries
   WHERE reference_comprobante_id = nc_id AND amount_ars < 0 AND source = 'comprobante';
  IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'replay' IS DISTINCT FROM 'true'
     OR v_fm <> 1 OR v_bfe <> 1 THEN
    RAISE EXCEPTION 'F16: replay duplico o fallo: result=%, FM=%, BFE=%', replay, v_fm, v_bfe;
  END IF;
  RAISE NOTICE 'F16 OK - CAE aislado no alcanza; attempt+snapshot exactos finalizan y replay no duplica.';
END $$;

ROLLBACK;
