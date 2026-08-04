-- ============================================================================
-- P0 Seguridad — FASE 2: lockdown de la lectura publica de `public.businesses`
--
-- Cierra definitivamente el acceso directo publico y cross-tenant a la tabla,
-- preservando el portal mayorista via las RPC publicas allowlisted que la FASE 1
-- (20260803120000) y el lockdown SECDEF (20260804120000) ya dejaron en
-- produccion.
--
-- ── POR QUE UNA MIGRACION NUEVA Y NO LA VIEJA ───────────────────────────────
-- La FASE 2 se habia escrito como 20260803130000. Produccion ya tiene aplicada
-- 20260804120000, o sea una migracion POSTERIOR: reutilizar aquel timestamp
-- dejaria la historia fuera de orden. Este archivo la reemplaza; el viejo no se
-- copia ni se referencia como fuente.
--
-- ── CAUSA (medida, no inferida) ─────────────────────────────────────────────
-- El baseline 20260628190324 creo la policy SIN clausula TO:
--
--   CREATE POLICY "businesses_portal_public_read" ON "public"."businesses"
--     FOR SELECT USING (("wholesale_portal_enabled" = true));
--
-- Sin TO, polroles queda en '{0}' = PUBLIC, o sea `anon` Y `authenticated`. Y
-- una policy RLS filtra FILAS, nunca COLUMNAS: con GRANT SELECT sobre la tabla
-- entera, la policy expone las 34 columnas de todo negocio con el portal
-- encendido. Reproducido en local (212 migraciones, paridad con prod):
--
--   [1] anon        -> lee mp_payer_email / mp_preapproval_id.            LEAK
--   [2] anon        -> ENUMERA los portales activos sin conocer un slug.  LEAK
--   [3] authenticated de OTRO tenant -> lee la misma fila y la misma PII. LEAK
--       (las policies permisivas se combinan con OR: `businesses_select` da lo
--        propio y `businesses_portal_public_read` agrega lo ajeno)
--
-- ── CONTRATO DE ACCESO DESPUES DE ESTA MIGRACION ────────────────────────────
--   anon                     -> ningun SELECT directo sobre la tabla, ni de
--                               tabla ni por columna. Solo
--                               get_wholesale_portal_public(text) y
--                               get_wholesale_portal_features(text).
--   authenticated NO miembro -> lo mismo que anon: `businesses_select` exige
--                               id = current_user_business_id(), asi que no
--                               alcanza la fila ajena.
--   authenticated miembro    -> conserva su negocio COMPLETO via
--                               `businesses_select` (subscriptionService
--                               necesita mp_* del negocio propio).
--   service_role             -> intacto (BYPASSRLS + GRANT propio). Las edge
--                               functions mp-subscription / mp-webhook usan la
--                               service key, no la anon key.
--
-- No crea policies nuevas. No crea vistas. No modifica datos. No toca
-- Realtime (ninguna ALTER PUBLICATION), ni finance_health_check_v2, ni P0-A/P0-B.
-- Idempotente.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS, igual que 20260804120000 y por la misma razon
-- medida: el CLI aplica cada archivo en AUTOCOMMIT. Sin este bloque los
-- `SET LOCAL` emiten "SET LOCAL can only be used in transaction blocks" y no
-- tienen efecto, y una postcondicion fallida dejaria el DROP POLICY aplicado
-- con los REVOKE a medias en vez de abortar limpio.
BEGIN;

-- DROP POLICY y REVOKE toman ACCESS EXCLUSIVE sobre `businesses`, que es la
-- tabla que lee CADA request autenticado. 3s de espera maxima: si hay una
-- transaccion larga encima, preferimos abortar y reintentar antes que encolar
-- a toda la app detras del lock.
SET LOCAL lock_timeout = '3s';
-- La migracion es puro DDL de catalogo sobre 20 filas; 60s es holgado y ademas
-- acota el bloque de postcondiciones, que recorre las 34 columnas.
SET LOCAL statement_timeout = '60s';


-- ============================================================================
-- 0. BASELINE — para poder exigir "no se agregan grants nuevos"
-- ============================================================================
-- Se dropea al final. Temp de SESION (no ON COMMIT DROP) por el mismo motivo
-- que en 20260804120000: sobrevive tanto al CLI como a un `psql -f` manual.
DROP TABLE IF EXISTS _biz_lockdown_baseline;
CREATE TEMP TABLE _biz_lockdown_baseline AS
SELECT x.grantee, x.privilege_type
FROM pg_catalog.pg_class c, aclexplode(c.relacl) x
WHERE c.oid = 'public.businesses'::regclass;


-- ============================================================================
-- 1. PRECONDICIONES — abortar antes de cerrar nada
-- ============================================================================
DO $precond$
DECLARE
  v_pub  CONSTANT text := 'public.get_wholesale_portal_public(text)';
  v_feat CONSTANT text := 'public.get_wholesale_portal_features(text)';
  -- Allowlist publica aprobada. Es el contrato de PortalBusiness
  -- (src/portal/types.ts) y de PORTAL_PUBLIC_COLUMNS
  -- (src/portal/portalPublicContract.ts). Ordenada para comparar como conjunto.
  v_allow CONSTANT text[] := ARRAY[
    'id','logo_url','name','wholesale_portal_enabled',
    'wholesale_portal_slug','wholesale_portal_theme','wholesale_whatsapp'
  ];
  v_cols        text[];
  v_keys        text[];
  v_secdef      boolean;
  v_retset      boolean;
  v_rettype     oid;
  v_probe_id    uuid := gen_random_uuid();
  v_probe_slug  text;
  v_max_applied text;
  v_cnt         int;
BEGIN
  ---------------------------------------------------------------------------
  -- [1] y [2] Las dos RPC publicas existen
  ---------------------------------------------------------------------------
  IF to_regprocedure(v_pub) IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: falta %. Aplicar antes 20260803120000.', v_pub;
  END IF;
  IF to_regprocedure(v_feat) IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 2: falta %. Aplicar antes 20260804120000.', v_feat;
  END IF;

  ---------------------------------------------------------------------------
  -- [3] Firma esperada de las dos: SECURITY DEFINER + EXECUTE para los dos
  --     roles publicos. Sin esto, cerrar la tabla deja al portal sin ninguna
  --     via de lectura (el lector puede ser anon O authenticated: PortalContext
  --     llama a la RPC en cada mount, tambien con sesion iniciada).
  ---------------------------------------------------------------------------
  SELECT p.prosecdef, p.proretset, p.prorettype
    INTO v_secdef, v_retset, v_rettype
  FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_pub);
  IF NOT v_secdef OR NOT v_retset OR v_rettype <> 'pg_catalog.record'::regtype THEN
    RAISE EXCEPTION
      'PRECONDICION 3: % cambio de firma (secdef=%, retset=%, rettype=%)',
      v_pub, v_secdef, v_retset, v_rettype::regtype;
  END IF;

  SELECT p.prosecdef, p.proretset, p.prorettype
    INTO v_secdef, v_retset, v_rettype
  FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_feat);
  IF NOT v_secdef OR v_retset OR v_rettype <> 'pg_catalog.jsonb'::regtype THEN
    RAISE EXCEPTION
      'PRECONDICION 3: % cambio de firma (secdef=%, retset=%, rettype=%)',
      v_feat, v_secdef, v_retset, v_rettype::regtype;
  END IF;

  FOREACH v_probe_slug IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF NOT has_function_privilege(v_probe_slug, v_pub, 'EXECUTE') THEN
      RAISE EXCEPTION 'PRECONDICION 3: % no puede EXECUTE %', v_probe_slug, v_pub;
    END IF;
    IF NOT has_function_privilege(v_probe_slug, v_feat, 'EXECUTE') THEN
      RAISE EXCEPTION 'PRECONDICION 3: % no puede EXECUTE %', v_probe_slug, v_feat;
    END IF;
  END LOOP;
  v_probe_slug := NULL;

  ---------------------------------------------------------------------------
  -- [4] get_wholesale_portal_public devuelve EXACTAMENTE la allowlist publica.
  --     Se lee del catalogo (proargnames/proargmodes con modo 't' = TABLE), no
  --     del texto del cuerpo: una columna agregada al RETURNS TABLE aparece
  --     aca aunque el comentario diga otra cosa.
  ---------------------------------------------------------------------------
  SELECT array_agg(s.nm ORDER BY s.nm) INTO v_cols
  FROM (
    SELECT unnest(p.proargnames) AS nm, unnest(p.proargmodes) AS md
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_pub)
  ) s
  WHERE s.md = 't';

  IF v_cols IS DISTINCT FROM v_allow THEN
    RAISE EXCEPTION
      'PRECONDICION 4: % no devuelve la allowlist publica aprobada. esperado=% obtenido=%',
      v_pub, v_allow, v_cols;
  END IF;

  ---------------------------------------------------------------------------
  -- [5] get_wholesale_portal_features devuelve EXACTAMENTE {active, mayorista}.
  --
  --     Devuelve jsonb, asi que el catalogo no alcanza y parsear `prosrc` seria
  --     fragil (los literales 'trialing'/'suspended'/'canceled' del cuerpo se
  --     confundirian con claves). Se ejecuta de verdad contra una fila SONDA
  --     insertada en un subbloque que se revierte: el handler deshace el INSERT
  --     y las variables PL/pgSQL conservan su valor, asi que la migracion no
  --     modifica datos ni deja rastro. El slug lleva un UUID para no poder
  --     colisionar con el UNIQUE de wholesale_portal_slug.
  ---------------------------------------------------------------------------
  v_probe_slug := '__lockdown_probe_' || replace(v_probe_id::text, '-', '');
  BEGIN
    INSERT INTO public.businesses
      (id, name, subscription_status, subscription_plan,
       wholesale_portal_enabled, wholesale_portal_slug)
    VALUES (v_probe_id, '__lockdown_probe__', 'active', 'full', true, v_probe_slug);

    SELECT array_agg(k ORDER BY k) INTO v_keys
    FROM jsonb_object_keys(public.get_wholesale_portal_features(v_probe_slug)) k;

    -- SQLSTATE propio: si el INSERT o la RPC fallaran por otra causa, ese error
    -- NO casa con el handler y se propaga (que es lo correcto: la precondicion
    -- no puede tapar un fallo real).
    RAISE EXCEPTION 'sonda' USING ERRCODE = 'ZZ001';
  EXCEPTION WHEN SQLSTATE 'ZZ001' THEN
    NULL;  -- el subbloque revierte el INSERT de la sonda
  END;

  IF v_keys IS DISTINCT FROM ARRAY['active','mayorista']::text[] THEN
    RAISE EXCEPTION
      'PRECONDICION 5: % no devuelve exactamente {active, mayorista}: %',
      v_feat, COALESCE(v_keys::text, '(null)');
  END IF;

  -- La sonda no puede haber sobrevivido.
  IF EXISTS (SELECT 1 FROM public.businesses WHERE id = v_probe_id) THEN
    RAISE EXCEPTION 'PRECONDICION 5: la fila sonda no se revirtio';
  END IF;

  ---------------------------------------------------------------------------
  -- [6] O existe la policy vulnerable, o el estado ya es idempotentemente
  --     seguro. Lo que NO se acepta es un tercer estado: la policy ausente
  --     pero `anon` conservando SELECT (o al reves), que seria una FASE 2 a
  --     medio aplicar.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
  FROM pg_catalog.pg_policy
  WHERE polrelid = 'public.businesses'::regclass
    AND polname  = 'businesses_portal_public_read';

  IF v_cnt = 0
     AND (has_table_privilege('anon',   'public.businesses', 'SELECT')
       OR has_table_privilege('public', 'public.businesses', 'SELECT')) THEN
    RAISE EXCEPTION
      'PRECONDICION 6: estado inconsistente — la policy ya no esta pero anon/PUBLIC conservan SELECT';
  END IF;

  ---------------------------------------------------------------------------
  -- [7] `authenticated` conserva una policy interna de membresia valida. Sin
  --     ella, cerrar la superficie publica dejaria a los miembros sin acceso a
  --     su propio negocio (configuracion, suscripcion, Mercado Pago, ARCA).
  ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public.businesses'::regclass
      AND p.polname  = 'businesses_select'
      AND p.polcmd   = 'r'
      AND p.polpermissive
      AND p.polroles = ARRAY['authenticated'::regrole::oid]
      AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%current_user_business_id%'
  ) THEN
    RAISE EXCEPTION
      'PRECONDICION 7: falta la policy interna `businesses_select` TO authenticated con scope de membresia';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'PRECONDICION 7: `authenticated` ya no tiene SELECT sobre businesses';
  END IF;

  ---------------------------------------------------------------------------
  -- [8] Sin migracion aplicada POSTERIOR a esta. El PK de schema_migrations ya
  --     impide dos filas con el mismo timestamp; lo que este check agrega es
  --     detectar que este archivo se aplique fuera de orden (la colision de
  --     timestamps en el REPO la cubre guard-secdef-exposure R6).
  ---------------------------------------------------------------------------
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version) FROM supabase_migrations.schema_migrations'
      INTO v_max_applied;
    IF v_max_applied IS NOT NULL AND v_max_applied > '20260804130000' THEN
      RAISE EXCEPTION
        'PRECONDICION 8: ya hay una migracion posterior aplicada (%). Esta iria fuera de orden.',
        v_max_applied;
    END IF;
  END IF;

  RAISE NOTICE 'PRECONDICIONES OK — RPC publicas presentes, allowlist intacta, membresia interna viva.';
END
$precond$;


-- ============================================================================
-- 2. LOCKDOWN
-- ============================================================================

-- ── 2.a La policy sin clausula TO ───────────────────────────────────────────
-- Aplicaba a PUBLIC sobre las 34 columnas. Es el vector [1][2][3].
DROP POLICY IF EXISTS "businesses_portal_public_read" ON "public"."businesses";

-- ── 2.b El GRANT de tabla ───────────────────────────────────────────────────
-- El DROP de arriba ya deja a `anon` sin filas visibles, pero GRANT y RLS son
-- capas distintas y PostgreSQL corta en la primera: sin este REVOKE, cualquier
-- policy permisiva que alguien agregue mañana sobre businesses reabre el leak
-- sola. Se cierran las dos capas.
--
-- `FROM PUBLIC` ademas de `FROM anon` a proposito: mientras exista el grant a
-- PUBLIC, revocarle a `anon` no cierra nada (lo hereda igual). Hoy no hay grant
-- a PUBLIC sobre esta tabla —a diferencia de las funciones, donde EXECUTE a
-- PUBLIC SI es el default de PG—, asi que este REVOKE es defensivo y no-op.
REVOKE SELECT ON TABLE "public"."businesses" FROM "anon";
REVOKE SELECT ON TABLE "public"."businesses" FROM PUBLIC;

-- ── 2.c Cualquier SELECT por COLUMNA equivalente ────────────────────────────
-- Hoy `businesses` tiene 15 columnas con ACL explicita y las 15 son UPDATE a
-- service_role: no hay ni un SELECT de columna a anon/PUBLIC. El bloque queda
-- igual porque un GRANT SELECT(col) sobrevive al REVOKE de tabla y volveria a
-- exponer justo lo que este archivo cierra. Recorre attacl, no
-- information_schema.column_privileges: esa vista incluye los privilegios
-- DERIVADOS del grant de tabla y, corrida antes de 2.b, listaria las 34
-- columnas como si tuvieran ACL propia.
DO $col$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.attname,
           CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE x.grantee::regrole::text END AS rol
    FROM pg_catalog.pg_attribute a,
         aclexplode(a.attacl) x
    WHERE a.attrelid = 'public.businesses'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attacl IS NOT NULL
      AND x.privilege_type = 'SELECT'
      AND (x.grantee = 0 OR x.grantee = 'anon'::regrole::oid)
  LOOP
    EXECUTE format('REVOKE SELECT (%I) ON TABLE public.businesses FROM %s',
                   r.attname, CASE WHEN r.rol = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r.rol) END);
    RAISE NOTICE 'Revocado SELECT(%) a % sobre businesses', r.attname, r.rol;
  END LOOP;
END
$col$;

-- NO se crea ninguna policy publica alternativa, ninguna vista sobre
-- businesses, ningun GRANT nuevo y ningun DML. La superficie publica que queda
-- es exactamente la de las dos RPC allowlisted, que esta migracion no toca.


-- ============================================================================
-- 3. POSTCONDICIONES — POLICIES
-- ============================================================================
DO $polpost$
DECLARE
  v_bad text;
BEGIN
  ---------------------------------------------------------------------------
  -- Ninguna policy PERMISIVA de lectura alcanzable por PUBLIC o por anon.
  --
  --   · polcmd 'r' = FOR SELECT, '*' = FOR ALL. Las dos habilitan lectura, y
  --     el enunciado del P0 es "lectura", no "una policy llamada X": por eso
  --     no se mira polname en ningun lado. Una policy nueva con otro nombre
  --     cae en el mismo filtro.
  --   · polroles = '{0}' es PUBLIC. Se compara por OID 0, que es como PG lo
  --     almacena; el nombre 'public' no aparece en el catalogo.
  --   · pg_has_role cubre el caso indirecto: una policy `TO algun_rol` donde
  --     `anon` sea miembro de algun_rol seria igual de explotable y no se veria
  --     buscando el OID de anon en polroles.
  --   · polpermissive: una policy RESTRICTIVE no concede acceso, solo lo
  --     recorta. Marcarla seria un falso positivo.
  ---------------------------------------------------------------------------
  SELECT string_agg(format('%s(cmd=%s,roles=%s)', p.polname, p.polcmd,
                    CASE WHEN 0 = ANY (p.polroles) THEN 'PUBLIC'
                         ELSE (SELECT string_agg(r.rolname, '+')
                               FROM pg_catalog.pg_roles r WHERE r.oid = ANY (p.polroles)) END),
                    ', ' ORDER BY p.polname)
    INTO v_bad
  FROM pg_catalog.pg_policy p
  WHERE p.polrelid = 'public.businesses'::regclass
    AND p.polpermissive
    AND p.polcmd IN ('r', '*')
    AND (
      0 = ANY (p.polroles)
      OR EXISTS (
        SELECT 1 FROM unnest(p.polroles) AS pr(oid)
        WHERE pg_has_role('anon', pr.oid, 'USAGE')
      )
    );

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDICION P1: quedan policies de lectura alcanzables por PUBLIC/anon sobre businesses: %',
      v_bad;
  END IF;

  -- La policy concreta del P0 no puede seguir existiendo bajo ninguna forma.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.businesses'::regclass
      AND polname  = 'businesses_portal_public_read'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION P2: `businesses_portal_public_read` sigue existiendo';
  END IF;

  -- Y las policies internas legitimas siguen en pie: cerrar la superficie
  -- publica no puede haberse llevado puesto el acceso del miembro.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public.businesses'::regclass
      AND p.polname  = 'businesses_select'
      AND p.polcmd   = 'r'
      AND p.polpermissive
      AND p.polroles = ARRAY['authenticated'::regrole::oid]
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION P3: se perdio la policy interna `businesses_select`';
  END IF;

  -- RLS sigue activo: sin esto los grants de authenticated verian toda la tabla.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'public.businesses'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICION P4: RLS quedo deshabilitado sobre businesses';
  END IF;

  RAISE NOTICE 'POSTCONDICIONES de policies OK.';
END
$polpost$;


-- ============================================================================
-- 4. POSTCONDICIONES — GRANTS
-- ============================================================================
DO $grantpost$
DECLARE
  v_bad  text;
  v_col  text;
  v_cnt  int;
BEGIN
  ---------------------------------------------------------------------------
  -- Privilegios EFECTIVOS, no lectura cruda del ACL: has_table_privilege
  -- resuelve tambien la herencia (si `anon` fuera miembro de un rol con SELECT,
  -- buscar 'anon' en relacl no lo veria).
  ---------------------------------------------------------------------------
  IF has_table_privilege('anon', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION G1: `anon` conserva SELECT de tabla sobre businesses';
  END IF;
  IF has_table_privilege('public', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION G2: PUBLIC conserva SELECT de tabla sobre businesses';
  END IF;

  ---------------------------------------------------------------------------
  -- Por columna, las 34, para los dos. has_column_privilege devuelve true
  -- tanto por grant de columna como por grant de tabla: es el check que no se
  -- puede esquivar concediendo una sola columna.
  ---------------------------------------------------------------------------
  FOR v_col IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.businesses'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  LOOP
    IF has_column_privilege('anon', 'public.businesses', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICION G3: `anon` conserva SELECT sobre la columna %', v_col;
    END IF;
    IF has_column_privilege('public', 'public.businesses', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICION G4: PUBLIC conserva SELECT sobre la columna %', v_col;
    END IF;
  END LOOP;

  -- Y sin ACL de columna residual (defensa en profundidad sobre el mismo hecho:
  -- si el efectivo dice false pero quedo una entrada en attacl, algo raro pasa).
  SELECT count(*) INTO v_cnt
  FROM pg_catalog.pg_attribute a, aclexplode(a.attacl) x
  WHERE a.attrelid = 'public.businesses'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    AND x.privilege_type = 'SELECT'
    AND (x.grantee = 0 OR x.grantee = 'anon'::regrole::oid);
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'POSTCONDICION G5: quedan % ACL de columna con SELECT para anon/PUBLIC', v_cnt;
  END IF;

  ---------------------------------------------------------------------------
  -- Lo que TIENE que seguir estando.
  ---------------------------------------------------------------------------
  IF NOT has_table_privilege('authenticated', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION G6: `authenticated` perdio SELECT (rompe la app interna)';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.businesses', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICION G7: `service_role` perdio SELECT (rompe mp-webhook / mp-subscription)';
  END IF;

  ---------------------------------------------------------------------------
  -- Ningun grant NUEVO. Se comparan los pares (grantee, privilegio) contra el
  -- baseline de la seccion 0: esta migracion solo puede QUITAR.
  ---------------------------------------------------------------------------
  SELECT string_agg(format('%s:%s',
           CASE WHEN n.grantee = 0 THEN 'PUBLIC' ELSE n.grantee::regrole::text END,
           n.privilege_type), ', ' ORDER BY n.privilege_type)
    INTO v_bad
  FROM (
    SELECT x.grantee, x.privilege_type
    FROM pg_catalog.pg_class c, aclexplode(c.relacl) x
    WHERE c.oid = 'public.businesses'::regclass
  ) n
  LEFT JOIN _biz_lockdown_baseline b
    ON b.grantee = n.grantee AND b.privilege_type = n.privilege_type
  WHERE b.grantee IS NULL;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION G8: aparecieron grants nuevos sobre businesses: %', v_bad;
  END IF;

  ---------------------------------------------------------------------------
  -- `anon` tampoco puede ESCRIBIR. La policy `businesses_insert` tambien se
  -- creo sin clausula TO (aplica a PUBLIC) y queda fuera del alcance de esta
  -- migracion; es inerte precisamente porque anon no tiene el grant. Se fija
  -- esa premisa aca en vez de asumirla.
  ---------------------------------------------------------------------------
  FOREACH v_col IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
    IF has_table_privilege('anon', 'public.businesses', v_col) THEN
      RAISE EXCEPTION 'POSTCONDICION G9: `anon` tiene % sobre businesses', v_col;
    END IF;
    IF has_table_privilege('public', 'public.businesses', v_col) THEN
      RAISE EXCEPTION 'POSTCONDICION G9: PUBLIC tiene % sobre businesses', v_col;
    END IF;
  END LOOP;

  RAISE NOTICE 'POSTCONDICIONES de grants OK — anon y PUBLIC sin lectura; authenticated y service_role intactos.';
END
$grantpost$;

DROP TABLE IF EXISTS _biz_lockdown_baseline;

COMMIT;

-- Fuera de la transaccion: un NOTIFY no debe viajar en un rollback.
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- RECUPERACION — FORWARD-ONLY
-- ============================================================================
-- No hay rollback. Restaurar `businesses_portal_public_read` o devolverle
-- SELECT a `anon` reabre el P0 completo (PII de facturacion + enumeracion +
-- cross-tenant), asi que ninguna de las dos cosas es un procedimiento valido de
-- recuperacion y no se documentan como tal.
--
-- Si el portal publico necesitara un dato mas, el camino es una migracion NUEVA
-- que amplie la allowlist de `get_wholesale_portal_public` —columna por columna
-- y con revision— preservando la superficie SECURITY DEFINER. La tabla no
-- vuelve a abrirse.
--
-- Tampoco se edita a mano supabase_migrations.schema_migrations.
--
-- ── FUERA DE ALCANCE (deliberado) ───────────────────────────────────────────
--   · `businesses_insert` sigue siendo PUBLIC (polcmd 'a'). Es inerte: anon no
--     tiene GRANT INSERT (postcondicion G9 lo fija) y el WITH CHECK exige
--     owner_user_id = auth.uid(). Corresponde una migracion aparte que le ponga
--     TO authenticated; no se toca aca para no mezclar una policy de escritura
--     en un lockdown de lectura.
--   · Realtime: no se agrega businesses a supabase_realtime ni se toca ninguna
--     publicacion.
-- ============================================================================
