-- ============================================================================
-- P0 - CONTRATO CANONICO DEL PUNTO DE VENTA FISCAL
--
-- Corre contra el stack LOCAL (NUNCA produccion), con 20260813120000 aplicada.
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
-- gane el 3 en todo comprobante fiscal y que el 7 sobreviva solo en el remito.
--
--   F01  factura_c            -> PV 0003 (no 0007)
--   F02  factura_a            -> PV 0003
--   F03  nota_credito         -> PV 0003
--   F04  remito               -> PV 0007 (local legitimo)
--   F05  numero local lleva el prefijo fiscal 0003, no 0007
--   F06  SPOOFING: es_fiscal=false + tipo=factura_c -> igual 0003
--   F07  sin arca_config + emitir_en_arca=true  -> fail-closed ARCA_NOT_CONFIGURED
--   F08  sin arca_config + emitir_en_arca=false -> 0001, nunca 0007
--   F09  cross-business: no se puede cobrar contra un negocio ajeno
--   F10  el remito sigue tomando el PV del payload aun con arca_config presente
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

-- ── F03 · nota_credito ──────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('nota_credito', true, false, '0007', 'k-f03');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0003' THEN
    RAISE EXCEPTION 'F03: nota_credito quedo con PV % (esperado 0003)', pv;
  END IF;
  RAISE NOTICE 'F03 OK - nota_credito persiste PV 0003.';
END $$;

-- ── F04 · remito: el PV local sigue siendo legitimo ─────────────────────────
DO $$
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('remito', false, false, '0007', 'k-f04');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0007' THEN
    RAISE EXCEPTION 'F04: el remito debe conservar el PV local 0007, quedo %', pv;
  END IF;
  RAISE NOTICE 'F04 OK - el remito conserva el PV local 0007.';
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
DECLARE r jsonb; pv text;
BEGIN
  r := pg_temp.cobrar('factura_c', false, false, '0007', 'k-f06');
  pv := pg_temp.pv_de(r);
  IF pv IS DISTINCT FROM '0003' THEN
    RAISE EXCEPTION 'F06: declarando es_fiscal=false el cliente se quedo con el PV % ', pv;
  END IF;
  RAISE NOTICE 'F06 OK - la fiscalidad se deriva del tipo; es_fiscal del payload no manda.';
END $$;

-- ── F07 · fail-closed sin arca_config y pidiendo CAE ────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  DELETE FROM public.arca_config WHERE business_id = '00000000-0000-0000-0000-00000e2eb001';
  r := pg_temp.cobrar('factura_c', true, true, '0007', 'k-f07');
  IF r->>'error_code' IS DISTINCT FROM 'ARCA_NOT_CONFIGURED' THEN
    RAISE EXCEPTION 'F07: esperaba ARCA_NOT_CONFIGURED, obtuvo %', r;
  END IF;
  -- Se acota a ESTE checkout: el remito de F04 conserva 0007 a proposito, y la
  -- base local puede traer comprobantes viejos con PV local ya persistido.
  IF r ? 'comprobante_id' AND r->>'comprobante_id' IS NOT NULL THEN
    RAISE EXCEPTION 'F07: el checkout fallido igual devolvio un comprobante: %', r;
  END IF;
  RAISE NOTICE 'F07 OK - sin arca_config y pidiendo CAE, falla cerrado y no persiste nada.';
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

ROLLBACK;
