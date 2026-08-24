-- ═══════════════════════════════════════════════════════════════════════════
-- P0-P5 — Onboarding como CONFIGURACIÓN del business existente.
--
-- Principio: el onboarding NO crea tenants. `provision_my_business()` sigue
-- siendo la única autoridad que crea `businesses`; esta migración sólo agrega
-- la manera correcta de CONFIGURAR uno que ya existe.
--
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÉ EL WIZARD NUNCA GUARDÓ NADA — dos causas distintas, medidas
-- ───────────────────────────────────────────────────────────────────────────
-- El wizard hacía seis `supabase.from('businesses').update(...)` sueltos. Todos
-- fallaban, por una de estas dos razones:
--
--   (1) 42501 — `authenticated` NO tiene GRANT de UPDATE sobre `businesses`
--       (sólo SELECT). Existe una policy `businesses_update` correcta
--       —`id = current_user_business_id() AND role IN (owner,admin)`— pero es
--       CÓDIGO MUERTO: GRANT y RLS son capas distintas y PostgreSQL corta en la
--       primera, así que el UPDATE muere antes de que la policy llegue a
--       evaluarse. Afecta a: name, rubro, ciudad, wholesale_whatsapp, logo_url,
--       onboarding_completed y onboarding_completed_at.
--
--   (2) 42703 — columnas que NO EXISTEN. Los pasos fiscal y de métodos de pago
--       escribían `condicion_fiscal`, `cuit` y `payment_methods_enabled` sobre
--       `businesses`, donde nunca existieron. Los datos fiscales viven en
--       `business_settings` (`cuit`, `condicion_iva`, `telefono`, `localidad`).
--
-- Y ninguna de las dos se veía, porque `supabase.from().update()` NO LANZA:
-- devuelve `{ data, error }`. El wizard hacía `await ...update(...)` sin mirar
-- `error`, así que el try/catch no atrapaba nada y el paso avanzaba igual.
--
-- MEDIDO en producción: de 26 negocios, 1 tiene rubro y 2 tienen logo.
--
-- ───────────────────────────────────────────────────────────────────────────
-- LA FORMA DEL ARREGLO
-- ───────────────────────────────────────────────────────────────────────────
-- NO se repone el GRANT de UPDATE sobre `businesses`. Eso reabriría la
-- superficie que P0-P1/P0-P2 cerraron: con UPDATE directo, un cliente podría
-- tocar `owner_user_id`, `subscription_plan` o `subscription_status` — la
-- policy los deja pasar porque sólo filtra POR FILA, no por columna.
--
-- En su lugar, una RPC SECURITY DEFINER con ALLOWLIST EXPLÍCITA de columnas.
-- El negocio se deriva server-side; no se acepta `business_id` como parámetro.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. LECTURA — get_my_business_onboarding()
-- ───────────────────────────────────────────────────────────────────────────
-- Sirve la precarga y la REANUDACIÓN del wizard: si el usuario cierra en el
-- paso 3 y vuelve, los datos salen de la DB y no del estado de React.
--
-- Une `businesses` con `business_settings` en UNA sola llamada. Podría hacerse
-- con dos SELECT desde el cliente (hay RLS y GRANT de SELECT en ambas), pero
-- entonces el frontend tendría que saber qué campo vive en qué tabla — que es
-- justamente el conocimiento que se le escapó al wizard viejo.
CREATE OR REPLACE FUNCTION public.get_my_business_onboarding()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid;
  v_biz uuid;
  v_out jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_biz := public.current_user_business_id();
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  SELECT jsonb_build_object(
           'business_id',             b.id,
           'name',                    b.name,
           'rubro',                   b.rubro,
           'ciudad',                  b.ciudad,
           'whatsapp',                b.wholesale_whatsapp,
           'logo_url',                b.logo_url,
           'onboarding_completed',    COALESCE(b.onboarding_completed, false),
           'onboarding_completed_at', b.onboarding_completed_at,
           'cuit',                    s.cuit,
           'condicion_fiscal',        s.condicion_iva,
           -- El rol se devuelve para que el wizard pueda mostrarse en modo
           -- lectura a quien no puede editar, en vez de dejarlo chocar contra
           -- un 42501 al guardar.
           'role',                    public.current_user_role(),
           'can_edit',                public.current_user_role() IN ('owner','admin')
         )
    INTO v_out
    FROM public.businesses b
    LEFT JOIN public.business_settings s ON s.business_id = b.id
   WHERE b.id = v_biz;

  IF v_out IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  RETURN v_out;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. ESCRITURA — update_my_business_onboarding(...)
-- ───────────────────────────────────────────────────────────────────────────
-- Todos los parámetros son NULL por defecto y NULL significa «no tocar». Eso
-- permite guardar paso por paso con UNA sola API, sin que el paso 3 pise lo que
-- escribió el paso 1.
--
-- Para vaciar un campo a propósito se manda cadena vacía, que se normaliza a
-- NULL en la columna. Es la única forma de distinguir «no lo toques» de
-- «borralo» sin agregar un parámetro booleano por campo.
--
-- NO recibe `business_id`: se deriva de la identidad canónica. Es la razón por
-- la que el cross-tenant es imposible por construcción y no por chequeo.
CREATE OR REPLACE FUNCTION public.update_my_business_onboarding(
  p_name             text    DEFAULT NULL,
  p_rubro            text    DEFAULT NULL,
  p_ciudad           text    DEFAULT NULL,
  p_whatsapp         text    DEFAULT NULL,
  p_condicion_fiscal text    DEFAULT NULL,
  p_cuit             text    DEFAULT NULL,
  p_logo_url         text    DEFAULT NULL,
  p_complete         boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid;
  v_biz    uuid;
  v_rol    text;
  v_name   text;
  v_rubro  text;
  v_wa     text;
  v_cuit   text;
  v_cond   text;
  v_faltan text[];
BEGIN
  -- (a) Identidad y autorización. El rol sale del servidor, no del cliente.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_biz := public.current_user_business_id();
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  v_rol := public.current_user_role();
  IF v_rol IS NULL OR v_rol NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- (b) Serialización por negocio. Dos pestañas del wizard guardando el mismo
  --     paso a la vez se ordenan acá en vez de pisarse.
  PERFORM pg_advisory_xact_lock(
    hashtext('update_my_business_onboarding'), hashtext(v_biz::text)
  );

  -- (c) Validaciones. El nombre es el único campo estructuralmente obligatorio
  --     (`businesses.name` es NOT NULL), así que una cadena vacía se rechaza en
  --     vez de convertirse en un constraint violation crudo.
  IF p_name IS NOT NULL THEN
    v_name := btrim(p_name);
    IF v_name = '' THEN
      RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = 'TRIVN';
    END IF;
    v_name := left(v_name, 120);
  END IF;

  IF p_rubro IS NOT NULL THEN
    v_rubro := NULLIF(btrim(p_rubro), '');
    -- Allowlist cerrada: el rubro alimenta decisiones de producto y no puede
    -- ser texto libre del cliente.
    IF v_rubro IS NOT NULL AND v_rubro NOT IN (
      'celulares','computadoras','electrodomesticos','tecnico_general','redes','otro'
    ) THEN
      RAISE EXCEPTION 'INVALID_RUBRO' USING ERRCODE = 'TRIVU';
    END IF;
  END IF;

  IF p_whatsapp IS NOT NULL THEN
    -- Sólo dígitos, igual que el normalizador del frontend. No se imponen
    -- reglas de longitud agresivas: hay usuarios con números ya cargados y
    -- romperlos sería peor que aceptarlos.
    v_wa := NULLIF(regexp_replace(p_whatsapp, '[^0-9]', '', 'g'), '');
    IF v_wa IS NOT NULL AND length(v_wa) > 20 THEN
      RAISE EXCEPTION 'INVALID_WHATSAPP' USING ERRCODE = 'TRIVW';
    END IF;
  END IF;

  IF p_cuit IS NOT NULL THEN
    v_cuit := NULLIF(regexp_replace(p_cuit, '[^0-9]', '', 'g'), '');
    -- 11 dígitos es el formato del CUIT. NO se valida el dígito verificador ni
    -- se consulta a ARCA: este lote no configura facturación electrónica.
    IF v_cuit IS NOT NULL AND length(v_cuit) <> 11 THEN
      RAISE EXCEPTION 'INVALID_CUIT' USING ERRCODE = 'TRIVC';
    END IF;
  END IF;

  IF p_condicion_fiscal IS NOT NULL THEN
    v_cond := NULLIF(btrim(p_condicion_fiscal), '');
    IF v_cond IS NOT NULL AND v_cond NOT IN (
      'monotributo','responsable_inscripto','exento','consumidor_final'
    ) THEN
      RAISE EXCEPTION 'INVALID_CONDICION_FISCAL' USING ERRCODE = 'TRIVF';
    END IF;
  END IF;

  -- (d) ALLOWLIST sobre `businesses`. Estas 5 columnas y ninguna más.
  --     `owner_user_id`, `subscription_plan`, `subscription_status`,
  --     `trial_ends_at` e `id` NO están y no pueden estar: son justamente los
  --     campos que un UPDATE directo con la policy vieja habría dejado tocar.
  UPDATE public.businesses b
     SET name       = COALESCE(v_name, b.name),
         rubro      = CASE WHEN p_rubro    IS NULL THEN b.rubro  ELSE v_rubro END,
         ciudad     = CASE WHEN p_ciudad   IS NULL THEN b.ciudad ELSE NULLIF(btrim(p_ciudad), '') END,
         wholesale_whatsapp =
                      CASE WHEN p_whatsapp IS NULL THEN b.wholesale_whatsapp ELSE v_wa END,
         logo_url   = CASE WHEN p_logo_url IS NULL THEN b.logo_url ELSE NULLIF(btrim(p_logo_url), '') END
   WHERE b.id = v_biz;

  -- (e) Datos fiscales -> `business_settings`, que es donde viven de verdad.
  --     UPSERT: 18 de 26 negocios NO tienen fila de settings, así que un UPDATE
  --     suelto tocaría 0 filas y volvería a perder el dato en silencio — que es
  --     exactamente lo que hacía el wizard con el logo.
  IF p_cuit IS NOT NULL OR p_condicion_fiscal IS NOT NULL OR p_logo_url IS NOT NULL THEN
    INSERT INTO public.business_settings (business_id, cuit, condicion_iva, logo_url)
    VALUES (
      v_biz,
      CASE WHEN p_cuit             IS NULL THEN NULL ELSE v_cuit END,
      CASE WHEN p_condicion_fiscal IS NULL THEN NULL ELSE v_cond END,
      CASE WHEN p_logo_url         IS NULL THEN NULL ELSE NULLIF(btrim(p_logo_url), '') END
    )
    ON CONFLICT (business_id) DO UPDATE
       SET cuit          = CASE WHEN p_cuit             IS NULL THEN public.business_settings.cuit          ELSE v_cuit END,
           condicion_iva = CASE WHEN p_condicion_fiscal IS NULL THEN public.business_settings.condicion_iva ELSE v_cond END,
           logo_url      = CASE WHEN p_logo_url         IS NULL THEN public.business_settings.logo_url      ELSE NULLIF(btrim(p_logo_url), '') END;
  END IF;

  -- (f) Completado. Sólo se marca si los campos OBLIGATORIOS quedaron cargados,
  --     y se lee el estado YA PERSISTIDO — no los parámetros de esta llamada.
  --     Así, marcar completo en el último paso valida lo que realmente se
  --     guardó en los pasos anteriores: si uno falló, esto no miente.
  IF p_complete THEN
    v_faltan := ARRAY[]::text[];

    -- `array_append` y no `||`: con un `text[]` a la izquierda y un literal sin
    -- tipar a la derecha, PostgreSQL resuelve `||` como concatenación de dos
    -- arrays e intenta parsear 'rubro' como array literal
    -- («malformed array literal»). Lo detectó el test 7.
    IF NOT EXISTS (
      SELECT 1 FROM public.businesses b
       WHERE b.id = v_biz AND NULLIF(btrim(b.name), '') IS NOT NULL
    ) THEN
      v_faltan := array_append(v_faltan, 'name');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.businesses b
       WHERE b.id = v_biz AND b.rubro IS NOT NULL
    ) THEN
      v_faltan := array_append(v_faltan, 'rubro');
    END IF;

    IF array_length(v_faltan, 1) IS NOT NULL THEN
      RAISE EXCEPTION 'ONBOARDING_INCOMPLETE: %', array_to_string(v_faltan, ',')
        USING ERRCODE = 'TRONB';
    END IF;

    -- Idempotente: si ya estaba completo NO se pisa la fecha original. Un retry
    -- no debe reescribir cuándo terminó el onboarding.
    UPDATE public.businesses b
       SET onboarding_completed    = true,
           onboarding_completed_at = COALESCE(b.onboarding_completed_at, now())
     WHERE b.id = v_biz;
  END IF;

  RETURN public.get_my_business_onboarding();
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. ACL
-- ───────────────────────────────────────────────────────────────────────────
-- EXECUTE a PUBLIC es el DEFAULT de PostgreSQL en cada CREATE FUNCTION: hay que
-- revocarlo explícitamente en cada (re)creación o se repone solo.
REVOKE ALL ON FUNCTION public.get_my_business_onboarding()                              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_my_business_onboarding()                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean) TO authenticated;

-- `anon` no recibe nada: las dos exigen auth.uid().

-- ───────────────────────────────────────────────────────────────────────────
-- 4. STORAGE — logo del negocio
-- ───────────────────────────────────────────────────────────────────────────
-- BUG PRODUCTIVO: «new row violates row-level security policy» al subir el logo.
--
-- CAUSA RAÍZ (medida, no supuesta). Las tres policies de escritura sobre
-- `business-assets` usaban:
--
--     auth.uid() IN (
--       SELECT profiles.user_id FROM profiles
--        WHERE COALESCE(profiles.user_id, profiles.id) = auth.uid()
--     )
--
-- Filtran con `COALESCE(user_id, id)` pero PROYECTAN la columna CRUDA
-- `user_id`. `provision_my_business` crea el perfil con `id = auth.uid()` y deja
-- `user_id` en NULL, así que la subconsulta devuelve NULL y
-- `auth.uid() IN (NULL)` es NULL — no true. La policy deniega.
--
-- MEDIDO en producción: 11 de 18 perfiles tienen `user_id IS NULL`, o sea que
-- el 61% de los usuarios NO PODÍA subir su logo. Los 7 que sí podían son
-- perfiles viejos (o reparados por `link_profile_to_auth_user`) que tienen la
-- columna poblada. Por eso "desde Configuración funciona" según quién probara.
--
-- SEGUNDO DEFECTO, independiente: la policy es CIEGA AL TENANT. Sólo pregunta
-- «¿este actor tiene ALGÚN perfil?», nunca a qué negocio pertenece el archivo.
-- Como el path lo arma el cliente, un usuario del negocio A podía sobrescribir
-- el logo del negocio B con sólo cambiar el nombre del archivo.
--
-- EL ARREGLO. El path pasa de `business-logos/<id>_logo.ext` (id en el NOMBRE
-- del archivo, invisible para una policy) a `business-logos/<business_id>/...`
-- (id como CARPETA, que `storage.foldername()` sí puede leer). Con eso la
-- pertenencia se valida server-side contra `current_user_business_id()` y deja
-- de depender de un path que escribe el cliente.
--
-- No se relaja nada: se cierra. Antes alcanzaba con tener un perfil cualquiera;
-- ahora hay que ser owner/admin DEL negocio dueño de la carpeta.
--
-- Los objetos viejos (1 en producción) siguen siendo legibles: la policy de
-- SELECT es pública y no cambia. No se migran archivos ni se borra nada.

DROP POLICY IF EXISTS "Authenticated users can upload business assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update business assets" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete business assets" ON storage.objects;

-- También las nuevas: `CREATE POLICY` no tiene `IF NOT EXISTS`, así que sin
-- esto la migración no se puede reaplicar sobre un stack que ya la corrió
-- (falla con «policy already exists» a mitad de camino y deja el resto sin
-- aplicar). Importa para el ciclo local y para un replay desde cero.
DROP POLICY IF EXISTS "business_assets_insert_own_tenant" ON storage.objects;
DROP POLICY IF EXISTS "business_assets_update_own_tenant" ON storage.objects;
DROP POLICY IF EXISTS "business_assets_delete_own_tenant" ON storage.objects;

-- Predicado único, compartido por las tres operaciones de escritura.
CREATE POLICY "business_assets_insert_own_tenant"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'business-assets'
    AND (storage.foldername(name))[1] = 'business-logos'
    AND (storage.foldername(name))[2] = public.current_user_business_id()::text
    AND public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY "business_assets_update_own_tenant"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'business-assets'
    AND (storage.foldername(name))[1] = 'business-logos'
    AND (storage.foldername(name))[2] = public.current_user_business_id()::text
    AND public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    bucket_id = 'business-assets'
    AND (storage.foldername(name))[1] = 'business-logos'
    AND (storage.foldername(name))[2] = public.current_user_business_id()::text
    AND public.current_user_role() IN ('owner', 'admin')
  );

CREATE POLICY "business_assets_delete_own_tenant"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'business-assets'
    AND (storage.foldername(name))[1] = 'business-logos'
    AND (storage.foldername(name))[2] = public.current_user_business_id()::text
    AND public.current_user_role() IN ('owner', 'admin')
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 5. POSTCONDICIONES
-- ───────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n   int;
  v_def text;
BEGIN
  -- P1. Las dos RPC existen con la firma esperada.
  IF to_regprocedure('public.get_my_business_onboarding()') IS NULL
     OR to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P1: falta alguna RPC de onboarding';
  END IF;

  -- P2. NINGUNA acepta un business_id. Es la barrera cross-tenant del lote: si
  --     alguien agregara el parámetro, el tenant volvería a ser un dato del
  --     cliente.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_my_business_onboarding', 'update_my_business_onboarding')
       AND pg_get_function_identity_arguments(p.oid) ILIKE '%business_id%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P2: una RPC de onboarding acepta business_id';
  END IF;

  -- P3. SECURITY DEFINER + search_path endurecido con pg_temp AL FINAL.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_my_business_onboarding', 'update_my_business_onboarding')
     AND (p.prosecdef = false
          OR p.proconfig IS NULL
          OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P3: % RPC sin SECDEF o sin el search_path esperado', v_n;
  END IF;

  -- P4. ACL: PUBLIC y anon fuera; authenticated dentro.
  IF has_function_privilege('public', 'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_my_business_onboarding()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P4: PUBLIC/anon conservan EXECUTE sobre una RPC de onboarding';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.get_my_business_onboarding()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTCOND P4b: authenticated no puede ejecutar las RPC de onboarding';
  END IF;

  -- P5. LA INVARIANTE DE P0-P1/P0-P2: el cliente sigue SIN DML estructural
  --     directo sobre profiles/businesses. Este lote resuelve la persistencia
  --     por RPC justamente para NO tener que reponer el GRANT.
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('profiles', 'businesses')
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P5: se repusieron % grants de DML sobre profiles/businesses', v_n;
  END IF;

  -- P6. La RPC de escritura NO puede tocar columnas estructurales. Se asevera
  --     sobre el código, sin comentarios: este archivo NOMBRA esas columnas al
  --     explicar por qué están excluidas, y un match sobre el texto crudo
  --     contaría la documentación como si fuera código.
  v_def := regexp_replace(
    pg_get_functiondef(to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)')),
    '--[^\n]*', '', 'g');
  IF v_def ~* 'owner_user_id|subscription_plan|subscription_status|trial_ends_at' THEN
    RAISE EXCEPTION 'POSTCOND P6: la RPC de onboarding menciona una columna estructural';
  END IF;
  IF v_def ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?businesses' THEN
    RAISE EXCEPTION 'POSTCOND P6b: la RPC de onboarding crea businesses';
  END IF;

  -- P7. `provision_my_business` intacta: sigue siendo la única creadora.
  IF to_regprocedure('public.provision_my_business(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P7: desapareció provision_my_business';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.provision_my_business(text)')) NOT LIKE '%INVITATION_PENDING%' THEN
    RAISE EXCEPTION 'POSTCOND P7b: provision_my_business perdió la defensa INVITATION_PENDING';
  END IF;

  -- P8. Storage: exactamente 3 policies de escritura sobre business-assets, y
  --     ninguna puede seguir proyectando la columna cruda `user_id` (la causa
  --     raíz) ni ser ciega al tenant.
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('business_assets_insert_own_tenant',
                        'business_assets_update_own_tenant',
                        'business_assets_delete_own_tenant');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'POSTCOND P8: hay % policies de escritura de business-assets, se esperaban 3', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname IN ('business_assets_insert_own_tenant',
                        'business_assets_update_own_tenant',
                        'business_assets_delete_own_tenant')
     AND coalesce(qual, '') || coalesce(with_check, '') NOT LIKE '%current_user_business_id%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P8b: % policy de business-assets sin scope de tenant', v_n;
  END IF;

  -- P9. Las policies viejas quedaron retiradas.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'Authenticated users can % business assets'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P9: sobrevive una policy vieja de business-assets';
  END IF;

  -- P10. La lectura pública del bucket no se tocó: los logos ya subidos (y los
  --      que muestran los comprobantes impresos) siguen resolviendo.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'Public read business assets' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P10: se perdió la lectura pública de business-assets';
  END IF;

  RAISE NOTICE 'P0-P5: 10 postcondiciones OK';
END;
$post$;

COMMIT;
