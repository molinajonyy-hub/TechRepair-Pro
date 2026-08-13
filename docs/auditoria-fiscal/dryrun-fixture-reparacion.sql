-- Fixture SANITIZADO para el dry-run local de la reparacion historica.
-- Replica la FORMA de los casos productivos (ids reales, importes/fechas
-- reales de la evidencia ARCA) sin arrastrar clientes ni items.
BEGIN;
SET LOCAL session_replication_role = 'replica';

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000e2e0001','owner@e2e.local') ON CONFLICT (id) DO NOTHING;

DELETE FROM public.electronic_invoice_log WHERE business_id='00000000-0000-0000-0000-00000e2eb001';
DELETE FROM public.comprobantes WHERE business_id='00000000-0000-0000-0000-00000e2eb001';

-- ── #45: venta real, ARCA autorizo, CAE nunca persistido ────────────────────
INSERT INTO public.comprobantes
 (id, business_id, tipo, punto_venta, numero, numero_fiscal, cae, estado, estado_fiscal,
  es_fiscal, total, subtotal, impuestos, fecha, created_by, condicion_fiscal)
VALUES
 ('67a4245d-1111-4111-8111-111111111111','00000000-0000-0000-0000-00000e2eb001','factura_c',
  '0001','0001-00759033',NULL,NULL,'borrador','error_emision',true,35000,35000,0,
  '2026-06-16','00000000-0000-0000-0000-00000e2e0001','Consumidor Final');

-- ── Caso #1: Factura C (11) + NC (13) con el MISMO numero_fiscal ────────────
INSERT INTO public.comprobantes
 (id, business_id, tipo, tipo_comprobante_fiscal, punto_venta, numero, numero_fiscal, cae,
  estado, estado_fiscal, es_fiscal, total, subtotal, impuestos, fecha, created_by, condicion_fiscal)
VALUES
 ('95cbf330-1111-4111-8111-111111111111','00000000-0000-0000-0000-00000e2eb001','factura_c','11',
  '0010','0001-00758985','0010-00000001','86215551111793','anulado','anulado_fiscal',true,13050,13050,0,
  '2026-05-21','00000000-0000-0000-0000-00000e2e0001','Consumidor Final'),
 ('1abfc1a1-1111-4111-8111-111111111111','00000000-0000-0000-0000-00000e2eb001','nota_credito','13',
  '0010','0010-00000001','0010-00000001','86215551111166','emitido','emitido',true,13050,13050,0,
  '2026-05-21','00000000-0000-0000-0000-00000e2e0001','Consumidor Final');

-- ── #98: mismatch de fecha por cruce de medianoche ──────────────────────────
INSERT INTO public.comprobantes
 (id, business_id, tipo, tipo_comprobante_fiscal, punto_venta, numero, numero_fiscal, cae,
  estado, estado_fiscal, es_fiscal, total, subtotal, impuestos, fecha, created_by, condicion_fiscal)
VALUES
 ('d959dbfa-1111-4111-8111-111111111111','00000000-0000-0000-0000-00000e2eb001','factura_c','11',
  '0010','0001-00759125','0010-00000098','86295551111358','emitido','emitido',true,18000,18000,0,
  '2026-07-21','00000000-0000-0000-0000-00000e2e0001','Consumidor Final');

-- ── Los 53: 38 con numero_fiscal simulado + 15 sin ──────────────────────────
-- CAE simulado de 15 digitos, como en produccion.
INSERT INTO public.comprobantes
 (id, business_id, tipo, punto_venta, numero, numero_fiscal, cae, estado, estado_fiscal,
  es_fiscal, total, subtotal, impuestos, fecha, created_by, condicion_fiscal)
SELECT v.id::uuid, '00000000-0000-0000-0000-00000e2eb001','factura_c','0001',
       '0001-0000'||lpad(n::text,4,'0'),
       CASE WHEN n <= 38 THEN '0001-0090'||lpad(n::text,4,'0') ELSE NULL END,
       '7'||lpad((100000000000000 + n)::text, 14, '0'),
       'emitido',
       CASE WHEN n <= 38 THEN 'emitido' WHEN n <= 45 THEN 'pendiente_emision' ELSE 'error_emision' END,
       true, 1000 + n, 1000 + n, 0, '2026-05-01'::date + n, '00000000-0000-0000-0000-00000e2e0001',
       'Consumidor Final'
FROM (VALUES
  ('9488be82-d47a-4a20-b133-5100e306cc2a',1),('3719f704-31a4-428b-b23c-00ed093a9696',2),
  ('3e22e6d3-b2a1-464d-abdf-b35efc0e9ecb',3),('683bf3a9-fb9e-4776-85c8-240e63f6d1e7',4),
  ('8f5520b9-05a8-4954-8f61-16659742046c',5),('aa9d3513-f3da-4d6d-a394-b29d0c1122b2',6),
  ('def266d0-a851-43e5-851f-f5908ceddf2d',7),('42900f13-608b-4bc3-9a79-bf224cd06638',8),
  ('9827b2a2-1172-4763-83bd-4f3f14b7aeca',9),('31df8719-9c2a-46e0-b777-d2515a7f3064',10),
  ('90d73b2c-e79a-4033-9af8-9471186d4398',11),('22381a16-81ba-42cb-ab27-7c0f4e7b725c',12),
  ('335a127c-1759-4358-a8c5-0d75d0541b43',13),('c3b6b4f7-ad15-400e-9843-560fca749c58',14),
  ('056f876d-9095-482a-8250-6b019855509d',15),('c19f04a0-4819-4d60-97b3-f1c5860b98d1',16),
  ('d77d62ad-b12e-444c-874d-f8b71c27908c',17),('c820352d-426f-4b39-8e9f-0009f5437a18',18),
  ('01545f69-e3ca-4d27-b116-e5839cb89639',19),('5e63db6a-7993-4d89-8a06-4a4ebe86d401',20),
  ('0b19312a-ed71-4a06-b6a3-00d26020757b',21),('9daaafa6-1f53-4ba0-aea1-d1964fc4cb2f',22),
  ('9ed5f382-54b0-4df3-b330-5d5fc6791a49',23),('ff0feed6-252a-467a-8df7-663758be2349',24),
  ('c819d5c3-5628-4036-8cb5-50d871e50b3a',25),('9d5b4c7c-cd78-4457-bf16-583d607aa6e9',26),
  ('df7e6adf-858d-447f-8942-5a82d6daed7e',27),('95151a03-2f50-42e2-bb22-06a338fdf19b',28),
  ('344d42b6-f887-443b-a051-8eff0fd7f1b3',29),('4a918380-079c-4c30-b7f7-716957461a0c',30),
  ('8ba1161f-8e90-49a7-ba8b-9dfc9583c101',31),('bc3ef032-9287-4c0a-bb42-724b46dc25e4',32),
  ('2a9604e5-5db8-43f3-80c3-bee4a130be29',33),('14c5470f-e5d6-4811-85bb-92ca6101888a',34),
  ('871d2001-a165-43c0-bfc3-a1e3bd65f4ce',35),('e92d9f5f-c659-4154-a7a2-2cef80393e47',36),
  ('fc8356b9-eee1-44b0-bfb7-31d511162086',37),('f69ed145-55ab-4882-8094-b6cbbdc71a81',38),
  ('1f2956ec-f52e-42a2-9618-ecfca7c07429',39),('ff5204f4-57e1-4782-8566-7418541e4d8f',40),
  ('641c8257-8cb3-4452-935d-34b6fccf1f3c',41),('5b9089ad-0b43-4286-aea6-2fd7fb4a30a1',42),
  ('d86713c9-992e-4c62-8a04-6cd786e43732',43),('7ee6ffd8-b18a-497e-aecd-6b8d274df3ff',44),
  ('b69d7ac2-6b49-43ae-a219-d6c2e27f113d',45),('61fb8f8d-76c2-4128-8e99-8d1c958acd75',46),
  ('33ee3b08-85d0-43c4-af6d-9977a2233c21',47),('cbc1b1b8-bddf-4b5f-8db5-b84ab2fe42ef',48),
  ('25025d77-d83c-426b-852f-e0290bf86f1b',49),('dc99098c-fde0-4612-819c-c613712f503a',50),
  ('9e05444d-e99f-46ef-bbaa-39b17673b38b',51),('1eedc52d-bc26-4b78-8524-b6c8dd64c5e5',52),
  ('ff3dc175-ce67-478b-867b-b84f09a0a4b4',53)
) AS v(id, n);

SET LOCAL session_replication_role = 'origin';
COMMIT;

SELECT 'fixture' AS x, count(*) AS comprobantes,
       count(*) FILTER (WHERE length(cae)=15) AS cae15,
       count(*) FILTER (WHERE length(cae)=15 AND numero_fiscal IS NOT NULL) AS cae15_con_nf
FROM public.comprobantes WHERE business_id='00000000-0000-0000-0000-00000e2eb001';
