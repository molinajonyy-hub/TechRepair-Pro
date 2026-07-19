-- ============================================================================
-- HOTFIX CRITICO — Retirar `get_finance_summary` de la API publica.
--
-- NO TOCA NI UN DATO. No cambia el cuerpo de la funcion, ni tablas, ni RLS.
-- Solo cierra su superficie de ejecucion.
--
-- ── El defecto ──────────────────────────────────────────────────────────────
-- public.get_finance_summary(uuid, date, date) es SECURITY DEFINER, propiedad
-- de `postgres`, y NO valida la identidad de quien la llama: filtra unicamente
-- por el `p_business_id` que le pasa el propio llamador. Como corre con los
-- privilegios del owner, el RLS de `business_finance_entries` y de `orders` no
-- se aplica.
--
-- Estaba expuesta como RPC de PostgREST con EXECUTE efectivo para `anon`. O sea:
-- cualquiera con la publishable key —que viaja en el bundle del frontend, es
-- publica por diseño— podia leer el resumen financiero de CUALQUIER negocio
-- pasando su UUID, sin autenticarse.
--
-- Reproducido por el camino publico real (POST /rest/v1/rpc/get_finance_summary,
-- header `apikey` solo, SIN `Authorization`): HTTP 200, una fila, los 7 campos
-- financieros con valores distintos de cero. No hizo falta ningun rol
-- privilegiado para reproducirlo.
--
-- ── Por que hay que revocar de PUBLIC y no de `anon` ────────────────────────
-- La ACL era:
--
--     {=X/postgres, postgres=X/postgres, authenticated=X/postgres}
--      ^^^ grantee vacio = PUBLIC
--
-- `anon` NO aparecia con un grant propio: heredaba EXECUTE de **PUBLIC**. Un
-- `REVOKE EXECUTE ... FROM anon` habria pasado la revision de un vistazo y no
-- habria cerrado nada, porque el grant a PUBLIC alcanza a todo rol presente y
-- futuro. Por eso se revoca de PUBLIC explicitamente, y ademas de cada rol de
-- cliente por si alguno tuviera un grant directo.
--
-- ── Por que REVOKE y no un auth check ──────────────────────────────────────
-- La funcion no tiene ningun consumidor:
--   · ninguna otra funcion de la base la llama (barrido de prosrc);
--   · no tiene dependencias en pg_depend;
--   · en el repo solo aparece en el baseline remoto, en la migracion que le
--     fijo el search_path (20260713310000) y en supabase/_archive/;
--   · cero referencias en src/, en supabase/functions/ y en scripts/.
-- Meterle un `auth.uid()` seria endurecer codigo muerto y dejarlo publicado.
-- Lo correcto es sacarlo de la API.
--
-- ── Por que NO se hace DROP ─────────────────────────────────────────────────
-- Un DROP es irreversible y no aporta seguridad por encima del REVOKE: sin
-- EXECUTE la funcion es inalcanzable via PostgREST. Se deja el objeto para que
-- el cambio sea trivialmente reversible y auditable. El DROP, si se decide, es
-- una limpieza aparte.
--
-- ── service_role ────────────────────────────────────────────────────────────
-- Tambien se revoca. Tenia EXECUTE solo por herencia de PUBLIC, no por un grant
-- propio, y no se encontro ningun consumidor server-side: ni Edge Functions, ni
-- scripts, ni webhooks. No se demostro necesidad activa, asi que se cierra
-- tambien. Si mañana aparece un consumidor legitimo, el grant se agrega
-- explicito y documentado, que es justamente la diferencia con heredarlo sin
-- que nadie lo haya decidido.
-- ============================================================================

REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM anon;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_finance_summary(uuid, date, date) FROM service_role;

COMMENT ON FUNCTION public.get_finance_summary(uuid, date, date) IS
  'RETIRADA DE LA API PUBLICA (hotfix 20260719130000). SECURITY DEFINER sin '
  'validacion de identidad: filtra solo por el p_business_id que recibe, y al '
  'correr con privilegios del owner ignora el RLS de business_finance_entries y '
  'orders. Estuvo expuesta como RPC con EXECUTE heredado de PUBLIC, lo que '
  'permitia leer el resumen financiero de cualquier negocio SIN autenticacion. '
  'Sin consumidores conocidos. No volver a otorgar EXECUTE a PUBLIC/anon/'
  'authenticated: si se necesita, reescribirla con auth.uid() y filtro de '
  'membresia server-side, como finance_dashboard_summary.';

-- ── Post-condicion dura ─────────────────────────────────────────────────────
-- Si algun rol de cliente conserva EXECUTE, la migracion falla y NO se marca
-- como aplicada. Una migracion de seguridad que se aplica a medias y reporta
-- exito es peor que una que no corre.
--
-- Se usa has_function_privilege, que resuelve la herencia: es la pregunta
-- correcta ("¿puede ejecutarla?"), no "¿tiene un grant propio?". Con la segunda
-- este bug no se habria detectado nunca.
DO $$
DECLARE
  v_oid   oid := 'public.get_finance_summary(uuid,date,date)'::regprocedure;
  v_malos text[] := '{}';
  v_rol   text;
BEGIN
  FOREACH v_rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(v_rol, v_oid, 'EXECUTE') THEN
      v_malos := v_malos || v_rol;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    v_malos := v_malos || 'PUBLIC';
  END IF;

  IF array_length(v_malos, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'HOTFIX incompleto: todavia pueden ejecutar get_finance_summary → %',
      array_to_string(v_malos, ', ');
  END IF;

  RAISE NOTICE 'HOTFIX: get_finance_summary fuera de la API publica (PUBLIC/anon/authenticated/service_role sin EXECUTE).';
END $$;
