-- ═══════════════════════════════════════════════════════════════════════════
-- P0-P6 · CIERRE FINAL — lectura de `public.cajas` por capacidad.
--
-- ───────────────────────────────────────────────────────────────────────────
-- LO QUE QUEDABA ABIERTO
-- ───────────────────────────────────────────────────────────────────────────
-- El hotfix de frontend (ccc8eac) dejó de PEDIR la caja para quien no puede
-- operarla, y su smoke humano pasó: el técnico ya no ve nada de caja y el owner
-- la gestiona normalmente.
--
-- Pero la tabla seguía legible por acceso directo. Su única policy era:
--
--     cajas_select : (current_business_id() = business_id) AND is_staff()
--
-- e `is_staff()` devuelve true para los SIETE roles del negocio, así que era
-- «cualquier miembro». MEDIDO en producción: un `tech` sin permisos de caja
-- leía 81 filas fabricando una consulta a PostgREST.
--
-- Los importes NO estaban expuestos —`financial_movements` y
-- `business_finance_entries` ya exigen capacidad desde 20260826120000— pero
-- P0-P6 pide autorización completa también en el acceso directo, no sólo en la
-- interfaz. Esconder la pantalla nunca fue el gate.
--
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÉ NO ALCANZA CON `finance`
-- ───────────────────────────────────────────────────────────────────────────
-- Gatear esto sólo con `current_user_can('finance')` rompería el POS.
--
-- Un `sales` tiene `finance = false` pero `comprobantes = true`, y necesita
-- CONOCER la caja abierta porque el POS manda `caja_id` al crear el
-- comprobante. Sin esa lectura seguiría vendiendo, pero sus ventas se
-- registrarían con `caja_id = NULL` y quedarían FUERA DEL ARQUEO: sería un
-- cambio de comportamiento CONTABLE disfrazado de cambio de permisos.
--
-- Son dos preguntas distintas, y el frontend ya las separa así desde ccc8eac:
--
--     operar la caja   -> finance                     (UI: canUseCaja)
--     conocer la caja  -> finance OR comprobantes     (fetch)
--
-- Esta migración pone la MISMA regla del lado del servidor. El helper es el
-- canónico de P0-P6, así que defaults por rol y overrides por usuario siguen
-- valiendo: un `tech` con `finance: true` explícito entra, y un `cashier` con
-- `finance: false` explícito no.
--
-- No se toca el ledger, ni las RPC financieras, ni las policies de escritura,
-- ni una sola fila de datos.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. SELECT sobre `public.cajas` — tenant AND capacidad
-- ───────────────────────────────────────────────────────────────────────────
-- Se REEMPLAZA la policy vieja en vez de agregar una nueva al lado.
--
-- Dos policies PERMISSIVE se combinan con OR, así que dejar `cajas_select`
-- viva junto a una más estricta no cerraría nada: la laxa seguiría alcanzando
-- para leer. Es el mismo error que hubo que evitar con `financial_movements`,
-- que tenía DOS permissive de SELECT.
--
-- Discovery previo (producción, 2026-08-24): `public.cajas` tenía exactamente
-- UNA policy —`cajas_select`, PERMISSIVE, para SELECT— y CERO policies de
-- INSERT/UPDATE/DELETE. Los grants de escritura existen pero sin policy la RLS
-- los deniega: abrir y cerrar caja pasa por RPC SECURITY DEFINER. Por eso acá
-- sólo se toca SELECT.
DROP POLICY IF EXISTS cajas_select            ON public.cajas;
-- También la nueva: `CREATE POLICY` no admite `IF NOT EXISTS`, así que sin esto
-- la migración no se puede reaplicar sobre un stack que ya la corrió.
DROP POLICY IF EXISTS cajas_select_capability ON public.cajas;

CREATE POLICY cajas_select_capability
  ON public.cajas FOR SELECT TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND (
      public.current_user_can('finance')
      OR public.current_user_can('comprobantes')
    )
  );

-- Nota sobre el cambio de helper de tenant: la policy vieja usaba
-- `current_business_id()` y ésta usa `current_user_business_id()`. Las dos
-- resuelven la identidad canónica `COALESCE(user_id, id) = auth.uid()`; la
-- segunda además exige `is_active` y ordena de forma determinista, así que es
-- estrictamente más estricta. Es la que ya usan las policies financieras de
-- 20260826120000: un solo criterio de tenant en toda la superficie sensible.
--
-- Y el rol pasa de `{public}` a `authenticated`. `anon` nunca podía leer nada
-- igual (sin sesión `current_user_business_id()` es NULL), así que esto sólo
-- hace explícito lo que ya era cierto.

-- ───────────────────────────────────────────────────────────────────────────
-- 2. POSTCONDICIONES
-- ───────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n    int;
  v_pol  text;
BEGIN
  -- P1. EXACTAMENTE una policy de SELECT. Es la postcondición que impide
  --     repetir el problema: dos permissive se combinan con OR y la más laxa
  --     gana, así que «agregar una estricta» sin sacar la vieja no cierra nada.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd='SELECT';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSTCOND P1: public.cajas tiene % policies de SELECT, se esperaba 1', v_n;
  END IF;

  -- P2. Y esa policy exige capacidad, con las DOS ramas.
  SELECT coalesce(qual,'') INTO v_pol
    FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd='SELECT';

  IF v_pol NOT LIKE '%current_user_can%' THEN
    RAISE EXCEPTION 'POSTCOND P2: la policy de SELECT de cajas no chequea capacidad -> %', v_pol;
  END IF;
  IF v_pol NOT LIKE '%finance%' THEN
    RAISE EXCEPTION 'POSTCOND P2b: falta la rama finance -> %', v_pol;
  END IF;
  IF v_pol NOT LIKE '%comprobantes%' THEN
    -- Sin esta rama el POS de un `sales` mandaría caja_id NULL y sus ventas
    -- quedarían fuera del arqueo.
    RAISE EXCEPTION 'POSTCOND P2c: falta la rama comprobantes (rompería el POS) -> %', v_pol;
  END IF;

  -- P3. Sigue habiendo aislamiento de tenant. Capacidad sin tenant sería peor
  --     que el problema original: dejaría a un cashier leer cajas ajenas.
  IF v_pol NOT LIKE '%current_user_business_id%' THEN
    RAISE EXCEPTION 'POSTCOND P3: la policy perdió el filtro de tenant -> %', v_pol;
  END IF;

  -- P4. Ninguna policy de SELECT puede volver a apoyarse en `is_staff()`, que
  --     es «cualquiera de los 7 roles» y fue exactamente el agujero.
  IF v_pol LIKE '%is_staff%' THEN
    RAISE EXCEPTION 'POSTCOND P4: la policy de SELECT vuelve a usar is_staff() -> %', v_pol;
  END IF;

  -- P5. RLS sigue encendida. Una policy perfecta sobre una tabla con RLS
  --     apagada no protege nada.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cajas'::regclass) THEN
    RAISE EXCEPTION 'POSTCOND P5: RLS apagada en public.cajas';
  END IF;

  -- P6. No se agregaron policies de escritura. Abrir/cerrar caja sigue pasando
  --     por RPC SECURITY DEFINER, como antes de esta migración.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname='public' AND tablename='cajas' AND cmd <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCOND P6: aparecieron % policies de escritura en cajas', v_n;
  END IF;

  -- P7. Las policies financieras de 20260826120000 siguen intactas: este lote
  --     no puede aflojar lo que aquél cerró.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname='public'
     AND tablename IN ('financial_movements','business_finance_entries','comprobante_payments')
     AND cmd='SELECT'
     AND coalesce(qual,'') LIKE '%current_user_can%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'POSTCOND P7: % de 3 policies financieras conservan el chequeo de capacidad', v_n;
  END IF;

  -- P8. El helper canónico sigue existiendo y con su ACL mínima.
  IF to_regprocedure('public.current_user_can(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P8: desapareció current_user_can';
  END IF;
  IF has_function_privilege('anon','public.current_user_can(text)','EXECUTE')
     OR has_function_privilege('public','public.current_user_can(text)','EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P8b: anon/PUBLIC pueden ejecutar current_user_can';
  END IF;

  -- P9. El cliente sigue SIN DML estructural sobre profiles/businesses
  --     (invariante de P0-P1/P0-P2/P0-P5/P0-P6).
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('profiles','businesses')
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P9: se repusieron % grants de DML sobre profiles/businesses', v_n;
  END IF;

  RAISE NOTICE 'P0-P6 cajas: 9 postcondiciones OK';
END;
$post$;

COMMIT;
