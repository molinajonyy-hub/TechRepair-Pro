-- ============================================================================
-- M7 7E.1 — Sacarle CREATE sobre `public` a los roles de cliente.
--
-- ┌── QUE SE ARREGLA ────────────────────────────────────────────────────────┐
-- │ El ACL de `public` traía `=UC/postgres`: el pseudo-rol PUBLIC con USAGE   │
-- │ **y CREATE**. Como PUBLIC alcanza a todos, `anon`, `authenticated` y      │
-- │ `service_role` podían crear objetos arbitrarios dentro de `public`.       │
-- │                                                                          │
-- │ Verificado en el stack local ANTES de esta migración: con `SET ROLE       │
-- │ authenticated`, un `CREATE TABLE public.zz_evil_probe(...)` y un          │
-- │ `CREATE FUNCTION public.finance_hc_mk(...)` (overload) se ejecutaron sin  │
-- │ error. La primitiva era real, no teórica.                                │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- POR QUE IMPORTA, DICHO CON PRECISION:
--
-- 120 funciones SECURITY DEFINER llevan `search_path = public, pg_temp`. Que un
-- rol de cliente pueda escribir en `public` es justamente la precondición que
-- convierte a ese `public` del path en superficie de ataque: alcanza con
-- plantar un objeto que gane la resolución de nombres para que una SECDEF
-- ejecute código ajeno con los privilegios de su owner (postgres).
--
-- HONESTIDAD SOBRE EL ALCANCE: NO se logró reproducir una escalada real hoy.
--   · El shadowing por tabla temporal ya está cerrado (7C.1a puso pg_temp al
--     final del path).
--   · El intento de hijack por overload sobre `finance_hc_mk` FALLA: la firma
--     canónica declara `p_count bigint` y quien la llama pasa una variable
--     `bigint`, así que la coincidencia exacta le gana a un overload plantado
--     con `integer`.
--
-- O sea: esto es defensa en profundidad, no un P0 explotable. Lo que se cierra
-- es la *precondición*. Con CREATE sobre public, el sistema queda a una sola
-- discordancia de tipos de distancia de ser explotable, y esa discordancia la
-- puede introducir cualquier refactor futuro sin que nadie lo note. Cuesta una
-- línea evitarlo; no cuesta nada dejarlo puesto hasta que duela.
--
-- POR QUE ESTO Y NO REESCRIBIR LAS 120 FUNCIONES:
-- Pasar esas 120 a `search_path = pg_catalog, pg_temp` obliga a calificar
-- TODAS sus referencias. Son RPC financieras grandes (varias de 300-600
-- líneas). Hacerlo en masa arriesga justo lo que no se puede romper —la
-- semántica contable— a cambio de un vector que esta migración ya deja
-- inalcanzable. La calificación por función queda como trabajo escalonado y
-- verificable, con el guard midiendo el avance.
--
-- QUE NO CAMBIA:
--   · `postgres` conserva CREATE por grant PROPIO (`postgres=UC/postgres`), no
--     por el de PUBLIC: las migraciones siguen funcionando igual.
--   · `anon`, `authenticated` y `service_role` conservan su USAGE explícito:
--     leer y ejecutar en `public` sigue intacto. Sólo pierden CREATE.
--   · Ninguna función, permiso funcional ni regla contable se toca.
-- ============================================================================

-- El grant que reparte CREATE a todo el mundo.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Explícito y fail-closed: si mañana alguien vuelve a otorgarlo directo a un
-- rol de cliente, estas líneas dejan asentado que no corresponde. Hoy son
-- no-ops (esos roles sólo tienen USAGE explícito).
REVOKE CREATE ON SCHEMA public FROM anon;
REVOKE CREATE ON SCHEMA public FROM authenticated;
REVOKE CREATE ON SCHEMA public FROM service_role;

-- El owner de las migraciones mantiene lo suyo, dicho explícitamente para que
-- no dependa de un default heredado.
GRANT USAGE, CREATE ON SCHEMA public TO postgres;

-- Los clientes siguen pudiendo USAR el esquema (resolver nombres); lo que
-- pierden es poder crear objetos dentro.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

COMMENT ON SCHEMA public IS
  'M7 7E.1: sin CREATE para roles de cliente. Ver 20260714100000. '
  'Es la precondición que hace explotable a `public` dentro del search_path de '
  'las funciones SECURITY DEFINER; no volver a otorgarlo.';

-- ── Verificación dentro de la propia migración ──────────────────────────────
-- Si el REVOKE no tuvo efecto, la migración falla acá y no queda un estado
-- "aplicado" que en realidad no protege nada.
DO $$
BEGIN
  IF has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.1: authenticated TODAVIA puede crear en public';
  END IF;
  IF has_schema_privilege('anon', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.1: anon TODAVIA puede crear en public';
  END IF;
  IF has_schema_privilege('service_role', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.1: service_role TODAVIA puede crear en public';
  END IF;
  IF NOT has_schema_privilege('postgres', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.1: postgres PERDIO CREATE en public (rompe migraciones)';
  END IF;
  IF NOT has_schema_privilege('authenticated', 'public', 'USAGE') THEN
    RAISE EXCEPTION '7E.1: authenticated perdio USAGE en public (rompe la app)';
  END IF;
  RAISE NOTICE '7E.1 OK: CREATE revocado a roles de cliente; USAGE y postgres intactos';
END $$;
