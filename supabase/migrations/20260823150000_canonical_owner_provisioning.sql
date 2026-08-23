-- ============================================================================
-- P0-P1 FASE A — `provision_my_business()`: autoridad canónica de provisioning
--
-- QUÉ RESUELVE
--   Hoy el tenant inicial lo crea `handle_new_user()` desde un trigger de
--   `auth.users`. Eso acopla TRES cosas que no tienen por qué viajar juntas:
--   crear una identidad, confirmar un correo, y fundar una empresa. Las
--   consecuencias medidas en el discovery de provisioning (2026-08-23):
--
--     · el portal mayorista fabrica un tenant SaaS por cada cliente (2 de 2);
--     · un invitado crea un tenant que abandona al aceptar la invitación;
--     · `raw_user_meta_data->>'role'` —que lo escribe el navegador— define el
--       rol, y un valor fuera del CHECK aborta la transacción de confirmación,
--       dejando al usuario SIN poder confirmar nunca más;
--     · las dos RPC que insertan perfiles omiten `profiles.id`, que es FK a
--       `auth.users(id)`, así que sus ramas de creación mueren con 23503 y no
--       existe camino de recuperación.
--
-- CONTRATO NUEVO
--   Crear el tenant pasa a ser una ACCIÓN EXPLÍCITA del usuario ya autenticado
--   y con correo confirmado, no un efecto secundario de existir en auth.users:
--
--       auth signup / OAuth  ->  usuario autenticado y confirmado
--                            ->  acción explícita "crear mi taller"
--                            ->  provision_my_business()
--                            ->  business + profile owner
--
--   Google y email+password CONVERGEN acá después de autenticarse. No hay —ni
--   debe haber— una rama por proveedor: la única señal es `email_confirmed_at`,
--   que Google trae poblado desde el INSERT.
--
-- ⚠️ ESTA MIGRACIÓN NO APAGA NADA
--   Los triggers `on_auth_user_created` / `on_auth_user_email_confirmed` siguen
--   activos a propósito. Es la mitad A de un rollout en dos fases: primero se
--   AGREGA la RPC (inerte para el frontend viejo), después se despliega el
--   frontend que la usa, y recién entonces la fase B retira el provisioning
--   automático. Invertir el orden deja una ventana en la que un owner nuevo se
--   queda sin negocio.
--
--   Durante esa ventana el trigger ya creó business+profile, así que
--   `provision_my_business()` encuentra el perfil existente y lo DEVUELVE sin
--   crear un segundo tenant. Esa es la propiedad que hace seguro el rollout.
--
-- NO SE TOCA
--   · Los DEFAULT de `businesses.subscription_status` ('trialing') y
--     `trial_ends_at` (now() + 14 días). El trial sigue naciendo con la fila del
--     negocio, que es donde semánticamente corresponde: signup ≠ trial,
--     confirmación ≠ trial, provisioning exitoso = trial.
--   · `accept_business_invitation()` — es P0-P2.
--   · `handle_new_user()` / los triggers — es la fase B.
--   · Los GRANT de tabla: `anon` y `authenticated` siguen SIN DML estructural
--     sobre `profiles` y `businesses`. Esa invariante es la que obliga a que
--     toda escritura pase por una SECURITY DEFINER como esta.
--
-- Ver tests/sql/canonical_owner_provisioning.test.sql para el contrato de
-- comportamiento. Acá las postcondiciones son ESTRUCTURALES.
--
-- NOTA: sin `\set ON_ERROR_STOP` — es un meta-comando de psql y el CLI de
-- Supabase manda este archivo directo al servidor. El corte lo da el
-- BEGIN/COMMIT de abajo, imprescindible porque las migraciones de Supabase
-- corren en AUTOCOMMIT.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

-- ── 1 · La RPC canónica ─────────────────────────────────────────────────────
--
-- FIRMA MÍNIMA. El único parámetro es un dato NO privilegiado (el nombre a
-- mostrar). Deliberadamente NO recibe —ni podría honrar— `user_id`,
-- `profile_id`, `owner_user_id`, `business_id`, `role` ni un email usado como
-- identidad: todo eso se deriva de `auth.uid()` server-side. Un parámetro que
-- el cliente controla y el servidor obedece es exactamente el patrón que este
-- lote viene a eliminar.
--
-- `pg_temp` va ÚLTIMO en search_path a propósito: omitirlo lo pone PRIMERO en
-- el orden efectivo y habilita el bypass por objetos temporales.
CREATE OR REPLACE FUNCTION public.provision_my_business(
  p_business_name text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_email      text;
  v_confirmado timestamptz;
  v_full_name  text;
  v_nombre     text;
  v_biz        uuid;
  v_profile    uuid;
  v_existe_biz integer;
BEGIN
  -- (a) Identidad. SIEMPRE del JWT, nunca de un argumento.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- (b) Estado real del auth user, leído server-side. El email NO viaja como
  --     parámetro: si el cliente pudiera mandarlo, sería un oráculo y un vector
  --     de suplantación (es la falla que ya se corrigió en
  --     bootstrap_owner_profile, 20260804120000).
  SELECT lower(btrim(u.email)),
         u.email_confirmed_at,
         NULLIF(btrim(u.raw_user_meta_data->>'full_name'), '')
    INTO v_email, v_confirmado, v_full_name
    FROM auth.users u
   WHERE u.id = v_uid;

  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- (c) Fail-closed sobre el correo. Es la MISMA señal canónica y
  --     provider-agnostic que usa el resto del sistema: Google llega con el
  --     timestamp ya poblado y pasa por acá sin ninguna rama especial.
  IF v_confirmado IS NULL THEN
    RAISE EXCEPTION 'EMAIL_NOT_CONFIRMED' USING ERRCODE = '42501';
  END IF;

  -- (d) BARRERA DE CONCURRENCIA REAL.
  --     Un `IF EXISTS` solo no alcanza: bajo READ COMMITTED dos llamadas
  --     simultáneas del mismo usuario lo pasarían las dos e insertarían DOS
  --     negocios; recién chocarían en `profiles_pkey`, abortando una de las dos
  --     transacciones enteras. El lock las serializa ANTES, así que la segunda
  --     ve el trabajo de la primera y devuelve el mismo negocio en vez de
  --     fallar. `profiles_pkey` sigue siendo la red de seguridad de último
  --     recurso, no la barrera principal.
  --
  --     Es xact: se libera solo al terminar la transacción, sin unlock manual.
  --     La forma de dos int4 namespacea el lock para que no colisione con otros
  --     usos de advisory locks en el esquema.
  PERFORM pg_advisory_xact_lock(hashtext('provision_my_business'), hashtext(v_uid::text));

  -- (e) ¿Ya está provisionado? La identidad canónica es la misma que usan
  --     current_user_business_id(), current_user_role() y las 96+ policies.
  SELECT p.id, p.business_id
    INTO v_profile, v_biz
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  IF v_profile IS NOT NULL THEN
    -- Coherencia: `profiles.business_id` es NOT NULL con FK, así que esto no
    -- debería poder fallar. Se verifica igual y se falla con un código propio:
    -- un estado imposible tiene que gritar, no devolver NULL en silencio.
    IF v_biz IS NULL THEN
      RAISE EXCEPTION 'INCONSISTENT_PROFILE' USING ERRCODE = 'TRPRV';
    END IF;

    SELECT count(*) INTO v_existe_biz FROM public.businesses b WHERE b.id = v_biz;
    IF v_existe_biz <> 1 THEN
      RAISE EXCEPTION 'INCONSISTENT_PROFILE' USING ERRCODE = 'TRPRV';
    END IF;

    -- IDEMPOTENTE Y NO DESTRUCTIVO: se devuelve lo que hay.
    -- NO se toca `role` (sería la escalada de privilegios que tiene hoy
    -- bootstrap_owner_profile), NO se mueve `business_id` (sería robar una
    -- membresía) y NO se reclama `owner_user_id` de un negocio ajeno.
    RETURN jsonb_build_object(
      'business_id', v_biz,
      'created',     false,
      'status',      'ALREADY_PROVISIONED'
    );
  END IF;

  -- (f) Invitación pendiente: este usuario NO es un owner nuevo, es alguien a
  --     quien invitaron. Crear un tenant propio acá es justamente el defecto
  --     que produce negocios huérfanos. Se falla con un código semántico para
  --     que el frontend lo distinga de un error real y ofrezca aceptar la
  --     invitación.
  --
  --     El email sale de `auth.users` (paso b), NUNCA del cliente, y la
  --     comparación es case-insensitive sobre ambos lados.
  --     La incorporación efectiva al tenant sigue siendo responsabilidad de
  --     accept_business_invitation() — acá sólo se BLOQUEA la creación.
  IF EXISTS (
    SELECT 1
      FROM public.business_invitations bi
     WHERE lower(btrim(bi.email)) = v_email
       AND bi.status = 'pending'
       AND bi.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'INVITATION_PENDING' USING ERRCODE = 'TRINV';
  END IF;

  -- (g) Creación. Todo dentro de la MISMA transacción: si el INSERT del perfil
  --     falla, el negocio se va con él y no queda un huérfano.
  v_nombre := NULLIF(btrim(COALESCE(p_business_name, '')), '');
  IF v_nombre IS NULL THEN
    v_nombre := 'Mi Negocio';
  END IF;
  v_nombre := left(v_nombre, 120);

  INSERT INTO public.businesses (name, owner_user_id)
  VALUES (v_nombre, v_uid)
  RETURNING id INTO v_biz;

  -- `id = v_uid` EXPLÍCITO. Es el punto entero de esta migración: `profiles.id`
  -- es FK a `auth.users(id)`, así que dejar que tome el DEFAULT
  -- `gen_random_uuid()` produce un uuid que jamás está en auth.users y falla con
  -- 23503. Ese es el bug que hace irrecuperable a un usuario sin perfil hoy.
  --
  -- `role` es el literal 'owner'. NO sale de `raw_user_meta_data`: ahí lo
  -- escribe el navegador, y un valor fuera del CHECK de la tabla abortaría la
  -- transacción. `full_name` sí viene de la metadata porque es un dato de
  -- PRESENTACIÓN —el usuario puede cambiarlo cuando quiera— y nunca una
  -- autoridad; el CHECK no lo alcanza y no puede romper nada.
  INSERT INTO public.profiles (id, business_id, role, is_active, full_name, email)
  VALUES (
    v_uid,
    v_biz,
    'owner',
    TRUE,
    COALESCE(v_full_name, split_part(v_email, '@', 1)),
    v_email
  );

  RETURN jsonb_build_object(
    'business_id', v_biz,
    'created',     true,
    'status',      'CREATED'
  );
END;
$$;

ALTER FUNCTION public.provision_my_business(text) OWNER TO postgres;

COMMENT ON FUNCTION public.provision_my_business(text) IS
  'AUTORIDAD CANÓNICA para crear el tenant inicial de un owner SaaS. Deriva la '
  'identidad y el email de auth.uid() server-side; el único parámetro es el '
  'nombre a mostrar. Exige correo confirmado. Idempotente y serializada por '
  'advisory xact lock: devuelve el negocio existente sin tocar role ni '
  'business_id. Falla con TRINV (INVITATION_PENDING) si hay una invitación '
  'vigente para ese correo. No ejecutable por anon.';

-- ACL EXPLÍCITA. Esto es un `CREATE` de una función nueva, así que nace con
-- EXECUTE para PUBLIC — el default de PostgreSQL. Sin estos REVOKE quedaría
-- abierta a anon.
REVOKE ALL     ON FUNCTION public.provision_my_business(text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.provision_my_business(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.provision_my_business(text) TO authenticated;

-- ============================================================================
-- POSTCONDICIONES — se leen del CATÁLOGO, no del texto de arriba.
-- ============================================================================
DO $$
DECLARE
  v_oid  oid := 'public.provision_my_business(text)'::regprocedure::oid;
  v_src  text;
  v_t    text;
BEGIN
  -- 1. SECURITY DEFINER, owner postgres, search_path endurecido con pg_temp
  --    AL FINAL.
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: provision_my_business no es SECURITY DEFINER';
  END IF;
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) <> 'postgres' THEN
    RAISE EXCEPTION 'POSTCONDICION 1: owner inesperado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p, unnest(p.proconfig) c
     WHERE p.oid = v_oid AND c = 'search_path=pg_catalog, public, pg_temp'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION 1: search_path inesperado';
  END IF;

  -- 2. ACL: authenticated sí; PUBLIC, anon y service_role no.
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: PUBLIC puede ejecutar provision_my_business';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: anon puede ejecutar provision_my_business';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICION 2: authenticated NO puede ejecutar provision_my_business';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  -- 3. La identidad se deriva de auth.uid(). Sin esto la función no tiene
  --    anclaje y cualquier parámetro pasaría a ser autoridad.
  IF v_src !~ 'auth\.uid\(\)' THEN
    RAISE EXCEPTION 'POSTCONDICION 3: no deriva la identidad de auth.uid()';
  END IF;

  -- 4. Fail-closed sobre el correo confirmado.
  IF v_src !~ 'email_confirmed_at' THEN
    RAISE EXCEPTION 'POSTCONDICION 4: no verifica email_confirmed_at';
  END IF;

  -- 5. Barrera de concurrencia REAL, no un simple IF EXISTS.
  IF v_src !~ 'pg_advisory_xact_lock' THEN
    RAISE EXCEPTION 'POSTCONDICION 5: falta la barrera de concurrencia';
  END IF;

  -- 6. El INSERT de profiles pasa `id` explícito. Si alguien lo quitara,
  --    volvería el 23503 que hace irrecuperable al usuario sin perfil.
  IF v_src !~ 'INSERT INTO public\.profiles \(id,' THEN
    RAISE EXCEPTION 'POSTCONDICION 6: el INSERT de profiles no pasa id explicito';
  END IF;

  -- 7. El rol NO se toma de metadata del cliente.
  IF v_src ~* 'raw_user_meta_data\s*->>\s*''role''' THEN
    RAISE EXCEPTION 'POSTCONDICION 7: el rol sale de metadata controlada por el cliente';
  END IF;

  -- 8. Bloqueo por invitación vigente.
  IF v_src !~ 'INVITATION_PENDING' THEN
    RAISE EXCEPTION 'POSTCONDICION 8: no bloquea ante invitacion pendiente';
  END IF;

  -- 9. NO se reponen GRANT de DML estructural al cliente. Es la invariante que
  --    obliga a que todo pase por SECURITY DEFINER; se asevera acá porque una
  --    migración futura podría reponerlos sin que nadie lo note.
  FOREACH v_t IN ARRAY ARRAY['public.profiles', 'public.businesses'] LOOP
    IF has_table_privilege('authenticated', v_t, 'INSERT')
       OR has_table_privilege('authenticated', v_t, 'UPDATE')
       OR has_table_privilege('authenticated', v_t, 'DELETE')
       OR has_table_privilege('anon', v_t, 'INSERT')
       OR has_table_privilege('anon', v_t, 'UPDATE')
       OR has_table_privilege('anon', v_t, 'DELETE') THEN
      RAISE EXCEPTION 'POSTCONDICION 9: hay DML estructural directo sobre %', v_t;
    END IF;
  END LOOP;

  -- 10. FASE A: los triggers de provisioning siguen ACTIVOS. Si ya no están,
  --     esta migración se aplicó fuera de orden y el rollout perdió su red.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname = 'auth' AND c.relname = 'users'
       AND t.tgname = 'on_auth_user_created'
  ) THEN
    RAISE EXCEPTION
      'POSTCONDICION 10: on_auth_user_created ya no existe. La FASE A debe aplicarse ANTES de la B.';
  END IF;

  RAISE NOTICE 'P0-P1 FASE A: 10/10 postcondiciones OK. provision_my_business lista; triggers viejos intactos.';
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual, forward-only por convención del repo)
--   `DROP FUNCTION public.provision_my_business(text);`
--   Es seguro mientras el frontend que la invoca no esté desplegado: en FASE A
--   la función es aditiva y nadie depende de ella. El provisioning sigue
--   ocurriendo por los triggers, que esta migración no toca.
-- ============================================================================
