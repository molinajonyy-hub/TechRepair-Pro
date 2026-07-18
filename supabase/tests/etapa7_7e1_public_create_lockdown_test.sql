-- ============================================================================
-- M7 7E.1 — CREATE sobre `public` cerrado + higiene de SECURITY DEFINER.
--
-- No alcanza con mirar `proconfig`: este suite EJECUTA el ataque con el rol
-- real y exige que el motor lo rechace. Un test que sólo lee catálogo prueba
-- que alguien escribió la config, no que la config sirva.
--
-- RUN: docker exec -i ... psql -X -f  (una tx + ROLLBACK).
-- ============================================================================
BEGIN;
SET LOCAL client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.assert(cond boolean, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; ELSE RAISE NOTICE 'PASS: %', label; END IF; END; $$;

-- ══ 1. ACL del esquema public ═══════════════════════════════════════════════
SELECT pg_temp.assert(NOT has_schema_privilege('anon','public','CREATE'),
  'PC1 anon NO puede crear en public');
SELECT pg_temp.assert(NOT has_schema_privilege('authenticated','public','CREATE'),
  'PC2 authenticated NO puede crear en public');
SELECT pg_temp.assert(NOT has_schema_privilege('service_role','public','CREATE'),
  'PC3 service_role NO puede crear en public');

-- El pseudo-rol PUBLIC es el que repartía CREATE a todos: si vuelve, vuelve el
-- agujero para cualquier rol presente y futuro.
SELECT pg_temp.assert((SELECT count(*) FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) a
   WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE')=0,
  'PC4 el pseudo-rol PUBLIC no tiene CREATE sobre public');

-- ══ 2. Lo legítimo sigue intacto (el fix no puede romper la app) ════════════
SELECT pg_temp.assert(has_schema_privilege('postgres','public','CREATE'),
  'PC5 postgres CONSERVA CREATE (si no, se rompen las migraciones)');
SELECT pg_temp.assert(has_schema_privilege('authenticated','public','USAGE'),
  'PC6 authenticated conserva USAGE');
SELECT pg_temp.assert(has_schema_privilege('anon','public','USAGE'),
  'PC7 anon conserva USAGE');
SELECT pg_temp.assert(has_schema_privilege('service_role','public','USAGE'),
  'PC8 service_role conserva USAGE');

-- ══ 3. El ataque REAL, ejecutado con el rol real ════════════════════════════
DO $$
DECLARE e text;
BEGIN
  -- 3a. Crear una tabla en public (la primitiva que SI funcionaba antes de 7E.1)
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'CREATE TABLE public.zz_7e1_probe(id int)';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%permission denied%',
    'PC9 authenticated NO puede CREATE TABLE en public (obtuvo: '||COALESCE(NULLIF(e,''),'SIN ERROR — creó la tabla')||')');

  -- 3b. Plantar un overload para secuestrar la resolución de nombres dentro de
  --     una SECURITY DEFINER. Es el vector que justifica todo este lote.
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'CREATE FUNCTION public.zz_7e1_shadow(p integer) RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e LIKE '%permission denied%',
    'PC10 authenticated NO puede plantar funciones en public (obtuvo: '||COALESCE(NULLIF(e,''),'SIN ERROR — creó la función')||')');
END $$;

-- ══ 4. Las temp tables siguen permitidas ════════════════════════════════════
-- No dependen de CREATE sobre public, y hay flujos que las usan. Si esto
-- fallara, el fix habría sido demasiado ancho.
DO $$
DECLARE e text;
BEGIN
  e := '';
  BEGIN
    SET LOCAL ROLE authenticated;
    EXECUTE 'CREATE TEMP TABLE zz_7e1_temp(id int)';
  EXCEPTION WHEN OTHERS THEN e := SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.assert(e = '', 'PC11 las temp tables siguen permitidas ('||e||')');
END $$;

-- ══ 5. Higiene de search_path en las SECURITY DEFINER ═══════════════════════
-- Invariantes que 7C.1/7C.1a dejaron y que no deben retroceder.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.prosecdef AND n.nspname='public'
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'::text[])) x WHERE x LIKE 'search_path=%'))=0,
  'PC12 ninguna SECDEF de public sin search_path fijo');

SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.prosecdef AND n.nspname='public'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'::text[])) x
                  WHERE x LIKE 'search_path=%' AND x LIKE '%$user%'))=0,
  'PC13 ninguna SECDEF con "$user" en el search_path');

-- pg_temp omitido = se busca PRIMERO (doc PG 5.9.3). Cerrado en 7C.1a.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.prosecdef AND n.nspname='public'
     AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}'::text[])) x
                  WHERE x LIKE 'search_path=%' AND x NOT LIKE '%pg_temp%'))=0,
  'PC14 toda SECDEF nombra pg_temp explícitamente');

-- pg_temp SIEMPRE al final: si quedara primero, volvería el shadowing por
-- tabla temporal que cerró 7C.1a.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   CROSS JOIN LATERAL unnest(coalesce(p.proconfig,'{}'::text[])) x
   WHERE p.prosecdef AND n.nspname='public' AND x LIKE 'search_path=%'
     AND btrim(split_part(x, ',', 1), ' ') NOT IN ('search_path=pg_catalog','search_path=public')
     AND btrim(split_part(x, ',', 1), ' ') LIKE '%pg_temp%')=0,
  'PC15 pg_temp nunca es el primer esquema del search_path');

-- ══ 6. Owner uniforme ═══════════════════════════════════════════════════════
-- Una SECDEF corre con los privilegios de su owner: un owner inesperado cambia
-- en silencio el alcance de lo que la función puede hacer.
SELECT pg_temp.assert((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.prosecdef AND n.nspname='public' AND pg_get_userbyid(p.proowner) <> 'postgres')=0,
  'PC16 todas las SECDEF de public son de postgres');

ROLLBACK;
