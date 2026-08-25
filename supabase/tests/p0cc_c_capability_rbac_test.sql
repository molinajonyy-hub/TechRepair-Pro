-- ============================================================================
-- P0-CC · CC-C — Capacidad financiera y blindaje de `accounts.balance`.
--
-- READ-ONLY: todo dentro de BEGIN … ROLLBACK.
--
-- Mide el contrato COMPLETO por rol, no una muestra:
--   owner / admin / cashier  -> pueden leer, cobrar y editar metadatos;
--   manager / sales / tech / viewer -> no leen, no escriben, no cobran.
--
-- Y las dos barreras que no dependen del rol:
--   `accounts.balance` no es escribible por NADIE desde el cliente;
--   otro tenant no ve nada, y sin sesión tampoco.
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

\set biz   '00000000-0000-0000-0000-00000ccc0001'
\set biz2  '00000000-0000-0000-0000-00000ccc0002'
\set own   '00000000-0000-0000-0000-00000ccc00a1'
\set adm   '00000000-0000-0000-0000-00000ccc00a2'
\set mgr   '00000000-0000-0000-0000-00000ccc00a3'
\set csh   '00000000-0000-0000-0000-00000ccc00a4'
\set sls   '00000000-0000-0000-0000-00000ccc00a5'
\set tch   '00000000-0000-0000-0000-00000ccc00a6'
\set vwr   '00000000-0000-0000-0000-00000ccc00a7'
\set own2  '00000000-0000-0000-0000-00000ccc00b1'
\set cust  '00000000-0000-0000-0000-00000ccc00c1'
\set caja  '00000000-0000-0000-0000-00000ccc0061'
\set ord1  '00000000-0000-0000-0000-00000ccc00f1'

SET LOCAL session_replication_role='replica';
INSERT INTO auth.users(id) VALUES (:'own'),(:'adm'),(:'mgr'),(:'csh'),(:'sls'),(:'tch'),(:'vwr'),(:'own2');
INSERT INTO businesses(id,name,owner_user_id) VALUES (:'biz','CC-C A',:'own'), (:'biz2','CC-C B',:'own2');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES
  (:'biz',:'own','owner',true), (:'biz',:'adm','admin',true), (:'biz',:'mgr','manager',true),
  (:'biz',:'csh','cashier',true), (:'biz',:'sls','sales',true), (:'biz',:'tch','tech',true),
  (:'biz',:'vwr','viewer',true), (:'biz2',:'own2','owner',true);
INSERT INTO customers(id,business_id,name,phone,customer_type) VALUES (:'cust',:'biz','Cliente','+540009','minorista');
INSERT INTO cajas(id,business_id,opened_by,status,efectivo_inicial,transferencia_inicial,tarjeta_inicial,usd_inicial)
  VALUES (:'caja',:'biz',:'own','abierta',0,0,0,0);
INSERT INTO orders(id,business_id,status,created_by) VALUES (:'ord1',:'biz','repair',:'own');
SET LOCAL session_replication_role='origin';

-- Deuda 100.000 a CC (por RPC SECDEF: no depende de la RLS del cliente).
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated; SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000ccc00a1';
  r := create_comprobante_checkout_atomic('00000000-0000-0000-0000-00000ccc0001'::uuid,'CCCK1','h1',
    jsonb_build_object(
      'tipo','factura_c','punto_venta','0001','condicion_fiscal','Consumidor Final',
      'customer_id','00000000-0000-0000-0000-00000ccc00c1',
      'order_id','00000000-0000-0000-0000-00000ccc00f1','es_fiscal',false,'cc_total',100000,
      'items', jsonb_build_array(jsonb_build_object(
        'descripcion','Servicio','tipo_linea','servicio','cantidad',1,
        'precio_unitario',100000,'descuento_linea',0,'costo_unitario',0,
        'currency','ARS','exchange_rate',1,'inventory_id',NULL)),
      'pagos','[]'::jsonb));
  PERFORM pg_temp.assert(r->>'status'='created','S0 deuda creada ('||COALESCE(r->>'error','')||')');
  RESET ROLE;
  PERFORM set_config('t.acc',(SELECT id::text FROM accounts
    WHERE business_id='00000000-0000-0000-0000-00000ccc0001'
      AND entity_id='00000000-0000-0000-0000-00000ccc00c1' LIMIT 1), true);
END $$;

-- ── Sondas por rol ──────────────────────────────────────────────────────────
-- Cuántas cuentas VE este actor (RLS SELECT).
CREATE OR REPLACE FUNCTION pg_temp.ve_cuentas(p_uid text)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  SELECT count(*) INTO n FROM accounts;
  RESET ROLE;
  RETURN n;
END $$;

-- ¿Puede INSERTAR en el ledger? Devuelve 'ok' o el SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.escribe_ledger(p_uid text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  BEGIN
    INSERT INTO account_movements (business_id, account_id, date, type, description, debit, credit, balance_after, created_by)
    VALUES ('00000000-0000-0000-0000-00000ccc0001'::uuid, current_setting('t.acc')::uuid,
            public.ar_today(), 'ajuste','sonda',1,0,0, p_uid::uuid);
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; END;
  RESET ROLE;
  RETURN v;
END $$;

-- ¿Puede pisar el saldo? Devuelve 'ok' o el SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.pisa_saldo(p_uid text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  BEGIN
    UPDATE accounts SET balance = 0 WHERE id = current_setting('t.acc')::uuid;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE; END;
  RESET ROLE;
  RETURN v;
END $$;

-- ¿Puede cobrar por la RPC? Devuelve el error_code o 'ok'.
CREATE OR REPLACE FUNCTION pg_temp.cobra(p_uid text, p_key text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  r := record_customer_account_payment_atomic('00000000-0000-0000-0000-00000ccc0001'::uuid,
        current_setting('t.acc')::uuid, 100, 'sonda', p_uid::uuid,
        'transferencia', public.ar_today(), NULL, p_key);
  RESET ROLE;
  RETURN CASE WHEN (r->>'ok')::boolean THEN 'ok' ELSE r->>'error_code' END;
END $$;

-- ════════════════ 1. Roles CON capacidad financiera ═════════════════════════
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'own')=1, 'R1 owner LEE la cuenta corriente');
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'adm')=1, 'R2 admin LEE la cuenta corriente');
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'csh')=1, 'R3 cashier LEE la cuenta corriente');
SELECT pg_temp.assert(pg_temp.cobra(:'own','CCC-OWN')='ok',     'R4 owner COBRA');
SELECT pg_temp.assert(pg_temp.cobra(:'adm','CCC-ADM')='ok',     'R5 admin COBRA');
SELECT pg_temp.assert(pg_temp.cobra(:'csh','CCC-CSH')='ok',     'R6 cashier COBRA');

-- ════════════════ 2. Roles SIN capacidad financiera ═════════════════════════
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'tch')=0, 'R7 tech NO ve cuentas corrientes');
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'vwr')=0, 'R8 viewer NO ve cuentas corrientes');
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'sls')=0, 'R9 sales sin finance NO ve cuentas corrientes');
-- Cambio de comportamiento DOCUMENTADO: manager pierde el acceso por default,
-- igual que ya le pasaba en /caja y /expenses. Se recupera con override.
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'mgr')=0, 'R10 manager sin override NO ve (alineado con /caja)');

SELECT pg_temp.assert(pg_temp.escribe_ledger(:'vwr')<>'ok', 'R11 viewer NO escribe en el ledger');
SELECT pg_temp.assert(pg_temp.escribe_ledger(:'tch')<>'ok', 'R12 tech NO escribe en el ledger');

-- La RPC es SECURITY DEFINER: no la cubre la RLS. Sin el guard interno, un
-- viewer podría cobrar llamando a PostgREST aunque no pueda leer la cuenta.
SELECT pg_temp.assert(pg_temp.cobra(:'vwr','CCC-VWR')='FORBIDDEN', 'R13 viewer NO cobra por la RPC (guard interno)');
SELECT pg_temp.assert(pg_temp.cobra(:'tch','CCC-TCH')='FORBIDDEN', 'R14 tech NO cobra por la RPC');
SELECT pg_temp.assert(pg_temp.cobra(:'sls','CCC-SLS')='FORBIDDEN', 'R15 sales NO cobra por la RPC');

-- ════════════════ 3. `accounts.balance` es intocable ════════════════════════
SELECT pg_temp.assert(pg_temp.pisa_saldo(:'vwr')='42501', 'R16 viewer NO pisa el saldo (42501, no 0 filas)');
SELECT pg_temp.assert(pg_temp.pisa_saldo(:'tch')='42501', 'R17 tech NO pisa el saldo');
-- Y tampoco el owner: no es una cuestión de jerarquía, la columna la mantiene
-- el ledger y nadie más.
SELECT pg_temp.assert(pg_temp.pisa_saldo(:'own')='42501', 'R18 ni el OWNER pisa el saldo desde el cliente');
SELECT pg_temp.assert(pg_temp.pisa_saldo(:'adm')='42501', 'R19 ni el admin');

-- El error tiene que ser EXPLÍCITO (42501), no un UPDATE silencioso de 0 filas:
-- un 0-filas se ve igual que un éxito desde el cliente.
SELECT pg_temp.assert(NOT has_column_privilege('authenticated','public.accounts','balance','UPDATE'),
  'R20 authenticated no tiene UPDATE sobre la columna balance');
SELECT pg_temp.assert(has_column_privilege('authenticated','public.accounts','credit_limit','UPDATE'),
  'R21 …pero SÍ sobre credit_limit: el lockdown no rompió la edición de metadatos');

-- ════════════════ 4. El saldo real quedó intacto ════════════════════════════
SELECT pg_temp.assert(
  (SELECT balance FROM accounts WHERE id=current_setting('t.acc')::uuid)
  = (SELECT COALESCE(SUM(debit-credit),0) FROM account_movements WHERE account_id=current_setting('t.acc')::uuid),
  'R22 accounts.balance == SUM(debit-credit) tras todas las sondas');

-- ════════════════ 5. Tenant y sesión ════════════════════════════════════════
SELECT pg_temp.assert(pg_temp.ve_cuentas(:'own2')=0, 'R23 el owner de OTRO negocio no ve esta cuenta');
SELECT pg_temp.assert(pg_temp.cobra(:'own2','CCC-X')='FORBIDDEN', 'R24 otro tenant no puede cobrar acá');

DO $$
DECLARE n int;
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO n FROM accounts;
  EXCEPTION WHEN OTHERS THEN n := -1; END;
  RESET ROLE;
  PERFORM pg_temp.assert(n <= 0, 'R25 anon (sin sesión) no lee cuentas corrientes');
END $$;

-- ════════════════ 6. Estructura de las policies ═════════════════════════════
SELECT pg_temp.assert((SELECT count(*) FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('accounts','account_movements')
    AND COALESCE(qual,'')||COALESCE(with_check,'') LIKE '%is_staff%')=0,
  'R26 ninguna policy de CC sigue usando is_staff()');
SELECT pg_temp.assert((SELECT count(*) FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('accounts','account_movements')
    AND COALESCE(qual,'')||COALESCE(with_check,'') NOT LIKE '%current_user_can%')=0,
  'R27 TODAS exigen capacidad (dos PERMISSIVE se OR-ean: una laxa anularía al resto)');
SELECT pg_temp.assert(NOT EXISTS (SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='accounts' AND cmd IN ('DELETE','ALL')),
  'R28 accounts no tiene policy de DELETE ni FOR ALL');

ROLLBACK;
