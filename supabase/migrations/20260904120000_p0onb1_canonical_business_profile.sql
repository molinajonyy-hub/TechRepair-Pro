-- ═════════════════════════════════════════════════════════════════════════════
-- P0-ONBOARDING-1 — Perfil del negocio canónico + reparación histórica.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EL DEFECTO — medido, no supuesto
-- ─────────────────────────────────────────────────────────────────────────────
-- P0-P5 arregló que el wizard GUARDARA. No arregló DÓNDE guarda.
--
-- El wizard escribe en `businesses` (name, ciudad, wholesale_whatsapp) mientras
-- que Configuración y TODOS los documentos impresos leen de `business_settings`
-- (nombre_comercial, localidad, telefono). Son columnas distintas de tablas
-- distintas, así que el dato se guarda bien y no lo ve nadie.
--
-- Medido en producción antes de esta migración:
--   · 30 negocios, 18 SIN fila en `business_settings`;
--   · 20 con `onboarding_completed = true`, de los cuales 18 tienen
--     `business_settings.nombre_comercial` VACÍO;
--   · `nombre_comercial` es lo que imprimen ComprobanteDocumento,
--     ComprobantePrintLayout, ServiceOrderPrint y WarrantyPrintLayout, con
--     fallback literal a 'Mi Negocio'.
--
-- O sea: comprobantes, órdenes de servicio y garantías salen a la calle
-- diciendo «Mi Negocio» aunque el usuario haya completado el onboarding.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DECISIÓN DE PRODUCTO (cerrada antes de este lote)
-- ─────────────────────────────────────────────────────────────────────────────
-- `business_settings.nombre_comercial` es la AUTORIDAD comercial.
-- `businesses.name` queda como ESPEJO técnico: lo necesitan
-- `provision_my_business` (la columna es NOT NULL) y el shell de la app.
-- Ningún writer normal puede volver a dejarlos divergentes.
--
-- Lo mismo para `ciudad`→`localidad`. Para el teléfono es asimétrico y está
-- explicado abajo, en la sección 3.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ UN HELPER PRIVADO Y NO UN OVERLOAD
-- ─────────────────────────────────────────────────────────────────────────────
-- `update_my_business_onboarding` está DESPLEGADA con la firma
-- (text,text,text,text,text,text,text,boolean) y el frontend productivo la
-- llama con esos 8 nombres. Hay tres formas de extenderla y dos son trampas:
--
--   ✗ Agregar parámetros con DEFAULT. `CREATE OR REPLACE` no puede cambiar la
--     lista de parámetros: crea un OVERLOAD. Con dos candidatas que aceptan los
--     mismos 8 nombres, PostgREST no puede desambiguar y responde PGRST203
--     durante toda la ventana de rollout.
--   ✗ Cambiar la firma con DROP + CREATE. El frontend viejo pasa a recibir
--     PGRST202 (función no encontrada) hasta que Vercel termine de desplegar.
--   ✓ Helper privado canónico + wrapper legacy con la firma INTACTA + RPC nueva
--     con NOMBRE distinto. Cero ambigüedad, cero ventana rota.
--
-- El wrapper legacy no queda congelado: ahora delega en el writer canónico, así
-- que **el frontend viejo, sin redesplegarse, empieza a escribir bien**. Es la
-- razón por la que el rollout de este lote puede ser DB-first.
--
-- `private` no está expuesto por PostgREST (verificado: `authenticated` y `anon`
-- no tienen USAGE sobre el esquema), así que el helper es inalcanzable desde el
-- navegador aunque alguien adivine su nombre.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- QUÉ NO HACE ESTE LOTE
-- ─────────────────────────────────────────────────────────────────────────────
-- · NO rediseña el wizard (eso es ONBOARDING-2).
-- · NO agrega pasos fiscales nuevos (ONBOARDING-3).
-- · NO toca ARCA, POS, caja, finanzas, cuenta corriente ni órdenes.
-- · NO toca `comprobantes.condicion_fiscal` ni `sales_points.condicion_fiscal`:
--   son la condición del RECEPTOR y del punto de venta, no la del emisor. Ver
--   la sección 1.
-- · NO borra `businesses.ciudad` ni `businesses.wholesale_whatsapp`.
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. VOCABULARIO DE CONDICIÓN FISCAL DEL EMISOR
-- ─────────────────────────────────────────────────────────────────────────────
-- ATENCIÓN AL ALCANCE. En el repo conviven TRES «condición fiscal» distintas y
-- sólo UNA es de este lote:
--
--   (a) `business_settings.condicion_iva`     → la del EMISOR (el negocio).
--                                               ← ESTA, y sólo esta.
--   (b) `comprobantes.condicion_fiscal`       → la del RECEPTOR del comprobante.
--       Se mapea a `CondicionIVAReceptorId` de ARCA en comprobanteService.ts.
--       Tocarla cambiaría lo que se le declara a ARCA. NO SE TOCA.
--   (c) `sales_points.condicion_fiscal`       → la del punto de venta. NO SE TOCA.
--
-- Vocabularios encontrados en `business_settings.condicion_iva` (producción):
--   'monotributo'             × 5   ← los escribió el wizard (slug)
--   'Responsable Inscripto'   × 5   ← Settings, o el DEFAULT de la columna
--   'Responsable Monotributo' × 2   ← Settings
--
-- Tres vocabularios en una columna `text` sin CHECK. El `<select>` de Settings
-- no tiene ninguna `<option>` que matchee lo que escribe el wizard, así que a
-- los 5 negocios con 'monotributo' el campo se les renderiza EN BLANCO.
--
-- ALLOWLIST CANÓNICA — slugs estables, la UI traduce a etiqueta humana:
--
--   slug                     etiqueta UI                CondicionIVAReceptorId
--   ───────────────────────  ─────────────────────────  ──────────────────────
--   responsable_inscripto    Responsable Inscripto       1
--   monotributo              Responsable Monotributo     6
--   monotributista_social    Monotributista Social      13
--   exento                   Exento                      4
--   consumidor_final         Consumidor Final            5
--
-- `monotributista_social` NO se colapsa contra `monotributo`: en la taxonomía
-- de ARCA son códigos distintos (13 vs 6) y fusionarlos perdería semántica
-- fiscal. Hoy no hay ninguna fila con ese valor en producción, pero el
-- `<select>` de Settings lo ofrece, así que la allowlist tiene que admitirlo o
-- el CHECK rompería la próxima vez que alguien lo elija.
CREATE OR REPLACE FUNCTION private.normalize_condicion_iva(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE lower(btrim(regexp_replace(coalesce(p_value, ''), '[\s_]+', ' ', 'g')))
    WHEN ''                          THEN NULL
    WHEN 'responsable inscripto'     THEN 'responsable_inscripto'
    WHEN 'iva responsable inscripto' THEN 'responsable_inscripto'
    WHEN 'monotributo'               THEN 'monotributo'
    WHEN 'monotributista'            THEN 'monotributo'
    WHEN 'responsable monotributo'   THEN 'monotributo'
    WHEN 'monotributista social'     THEN 'monotributista_social'
    WHEN 'exento'                    THEN 'exento'
    WHEN 'iva exento'                THEN 'exento'
    WHEN 'iva sujeto exento'         THEN 'exento'
    WHEN 'consumidor final'          THEN 'consumidor_final'
    ELSE NULL                       -- desconocido -> NULL. No se inventa una
                                    -- condición fiscal a partir de basura.
  END;
$$;

COMMENT ON FUNCTION private.normalize_condicion_iva(text) IS
  'P0-ONB1: legacy -> slug canónico de la condición fiscal del EMISOR. '
  'NO aplica a comprobantes.condicion_fiscal (receptor) ni a sales_points.';

-- El DEFAULT de la columna era 'Responsable Inscripto', o sea una etiqueta de
-- UI y además una AFIRMACIÓN FISCAL que nadie hizo: cualquier fila creada por
-- un writer que no mande la columna quedaba declarada Responsable Inscripto.
-- Pasa a no tener default: ausencia de dato se representa como ausencia.
ALTER TABLE public.business_settings ALTER COLUMN condicion_iva DROP DEFAULT;

-- Normalización de la historia ANTES del CHECK, o el ADD CONSTRAINT falla.
UPDATE public.business_settings s
   SET condicion_iva = private.normalize_condicion_iva(s.condicion_iva)
 WHERE s.condicion_iva IS DISTINCT FROM private.normalize_condicion_iva(s.condicion_iva);

ALTER TABLE public.business_settings
  DROP CONSTRAINT IF EXISTS business_settings_condicion_iva_check;

ALTER TABLE public.business_settings
  ADD CONSTRAINT business_settings_condicion_iva_check
  CHECK (condicion_iva IS NULL OR condicion_iva IN (
    'responsable_inscripto', 'monotributo', 'monotributista_social',
    'exento', 'consumidor_final'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. WRITER CANÓNICO — private.write_business_profile(uuid, jsonb)
-- ─────────────────────────────────────────────────────────────────────────────
-- ÚNICO lugar del sistema que decide qué campo va a qué tabla. Onboarding,
-- Configuración y cualquier writer futuro pasan por acá.
--
-- CONTRATO DEL PATCH — por qué jsonb y no 15 parámetros `text`:
--
--   · clave AUSENTE            -> no se toca la columna;
--   · clave presente con texto -> se escribe (normalizado);
--   · clave presente con ''    -> se BORRA (queda NULL);
--   · clave presente con null  -> se BORRA (queda NULL).
--
-- Es un contrato de tres estados. Con parámetros `text DEFAULT NULL` sólo hay
-- dos (NULL = «no tocar»), y por eso la RPC vieja tuvo que usar '' para borrar
-- — una convención que funciona pero que no se puede extender sin agregar un
-- booleano por campo. Y agregar una clave al jsonb NUNCA cambia la firma, así
-- que ONBOARDING-2/3 no van a tener que repetir esta danza de compatibilidad.
--
-- El business_id llega YA RESUELTO por el caller público, que es quien valida
-- identidad y rol. Esta función es privada justamente para poder confiar en eso
-- sin volver a mirar `auth.uid()` (que en un contexto service_role sería NULL).
CREATE OR REPLACE FUNCTION private.write_business_profile(
  p_business_id uuid,
  p_patch       jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
-- `pg_temp` explícito y AL FINAL: omitirlo no lo saca del path, lo pone PRIMERO.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- «la clave vino en el patch» — distinto de «vino con valor»
  h_nombre   boolean := p_patch ? 'nombre_comercial';
  h_razon    boolean := p_patch ? 'razon_social';
  h_cuit     boolean := p_patch ? 'cuit';
  h_cond     boolean := p_patch ? 'condicion_iva';
  h_domic    boolean := p_patch ? 'domicilio_fiscal';
  h_local    boolean := p_patch ? 'localidad';
  h_prov     boolean := p_patch ? 'provincia';
  h_cp       boolean := p_patch ? 'codigo_postal';
  h_tel      boolean := p_patch ? 'telefono';
  h_email    boolean := p_patch ? 'email';
  h_obs      boolean := p_patch ? 'observaciones_comprobantes';
  h_logo     boolean := p_patch ? 'logo_url';
  h_rubro    boolean := p_patch ? 'rubro';

  v_nombre   text;
  v_razon    text;
  v_cuit     text;
  v_cond     text;
  v_domic    text;
  v_local    text;
  v_prov     text;
  v_cp       text;
  v_tel      text;
  v_email    text;
  v_obs      text;
  v_logo     text;
  v_rubro    text;
BEGIN
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  -- Serialización por negocio. Dos pestañas guardando a la vez se ordenan acá
  -- en vez de pisarse. Mismo hash que usaba la RPC vieja para no cambiar el
  -- comportamiento de concurrencia que ya está en producción.
  PERFORM pg_advisory_xact_lock(
    hashtext('update_my_business_onboarding'), hashtext(p_business_id::text)
  );

  -- ── Normalización y validación ────────────────────────────────────────────
  v_nombre := left(nullif(btrim(coalesce(p_patch ->> 'nombre_comercial', '')), ''), 120);
  v_razon  := left(nullif(btrim(coalesce(p_patch ->> 'razon_social',     '')), ''), 160);
  v_domic  := left(nullif(btrim(coalesce(p_patch ->> 'domicilio_fiscal', '')), ''), 200);
  v_local  := left(nullif(btrim(coalesce(p_patch ->> 'localidad',        '')), ''), 120);
  v_prov   := left(nullif(btrim(coalesce(p_patch ->> 'provincia',        '')), ''), 120);
  v_cp     := left(nullif(btrim(coalesce(p_patch ->> 'codigo_postal',    '')), ''),  20);
  v_email  := left(nullif(btrim(coalesce(p_patch ->> 'email',            '')), ''), 160);
  v_obs    := left(nullif(btrim(coalesce(p_patch ->> 'observaciones_comprobantes', '')), ''), 2000);
  v_logo   := nullif(btrim(coalesce(p_patch ->> 'logo_url', '')), '');

  -- El nombre comercial es la autoridad y `businesses.name` es NOT NULL: si la
  -- clave vino, no puede quedar vacía. Se rechaza explícitamente en vez de
  -- dejar que reviente como constraint violation cruda.
  IF h_nombre AND v_nombre IS NULL THEN
    RAISE EXCEPTION 'INVALID_NAME' USING ERRCODE = 'TRIVN';
  END IF;

  -- Sólo dígitos, igual que el normalizador del frontend. No se imponen reglas
  -- de longitud agresivas: hay números ya cargados y romperlos sería peor.
  v_tel := nullif(regexp_replace(coalesce(p_patch ->> 'telefono', ''), '[^0-9]', '', 'g'), '');
  IF h_tel AND v_tel IS NOT NULL AND length(v_tel) > 20 THEN
    RAISE EXCEPTION 'INVALID_WHATSAPP' USING ERRCODE = 'TRIVW';
  END IF;

  v_cuit := nullif(regexp_replace(coalesce(p_patch ->> 'cuit', ''), '[^0-9]', '', 'g'), '');
  -- 11 dígitos es el formato del CUIT. NO se valida el dígito verificador ni se
  -- consulta a ARCA: este lote no configura facturación electrónica.
  IF h_cuit AND v_cuit IS NOT NULL AND length(v_cuit) <> 11 THEN
    RAISE EXCEPTION 'INVALID_CUIT' USING ERRCODE = 'TRIVC';
  END IF;

  -- El normalizador acepta slug y etiqueta legacy y devuelve NULL ante lo
  -- desconocido, así que hay que distinguir «vino vacío» (borrar) de «vino algo
  -- que no reconozco» (rechazar). Sin esto, mandar basura borraría el dato.
  v_cond := private.normalize_condicion_iva(p_patch ->> 'condicion_iva');
  IF h_cond
     AND v_cond IS NULL
     AND nullif(btrim(coalesce(p_patch ->> 'condicion_iva', '')), '') IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_CONDICION_FISCAL' USING ERRCODE = 'TRIVF';
  END IF;

  -- Allowlist cerrada: el rubro alimenta decisiones de producto y no puede ser
  -- texto libre del cliente.
  v_rubro := nullif(btrim(coalesce(p_patch ->> 'rubro', '')), '');
  IF h_rubro AND v_rubro IS NOT NULL AND v_rubro NOT IN (
    'celulares','computadoras','electrodomesticos','tecnico_general','redes','otro'
  ) THEN
    RAISE EXCEPTION 'INVALID_RUBRO' USING ERRCODE = 'TRIVU';
  END IF;

  -- ── (a) business_settings — la AUTORIDAD ──────────────────────────────────
  -- UPSERT y no UPDATE: 18 de 30 negocios NO tienen fila de settings, así que
  -- un UPDATE suelto tocaría 0 filas y volvería a perder el dato EN SILENCIO —
  -- que es exactamente el defecto que este lote cierra.
  --
  -- ⚠️ `logo_url` EN LA RAMA DEL INSERT NO PUEDE QUEDAR NULL POR OMISIÓN.
  -- Existe `trigger_sync_business_logo_url` (AFTER INSERT OR UPDATE OF logo_url)
  -- que replica `business_settings.logo_url` -> `businesses.logo_url`. En un
  -- INSERT el trigger dispara SIEMPRE, así que crear la fila de settings sin
  -- logo_url le escribiría NULL a `businesses` y BORRARÍA el logo de un negocio
  -- que sí lo tenía. Por eso, cuando la clave no viene en el patch, se siembra
  -- con el valor actual de `businesses` y el trigger queda en no-op.
  --
  -- El defecto ya existe en la RPC vieja (su INSERT lista `logo_url` y le pasa
  -- NULL cuando sólo se guarda CUIT o condición fiscal). Hoy no muerde a nadie
  -- en producción —los 8 negocios sin fila de settings tienen logo_url NULL—
  -- pero es una mina: bastaba con que uno subiera el logo antes de guardar un
  -- dato fiscal. Se cierra acá.
  INSERT INTO public.business_settings AS s (
    business_id, nombre_comercial, razon_social, cuit, condicion_iva,
    domicilio_fiscal, localidad, provincia, codigo_postal,
    telefono, email, observaciones_comprobantes, logo_url
  )
  VALUES (
    p_business_id,
    CASE WHEN h_nombre THEN v_nombre END,
    CASE WHEN h_razon  THEN v_razon  END,
    CASE WHEN h_cuit   THEN v_cuit   END,
    CASE WHEN h_cond   THEN v_cond   END,
    CASE WHEN h_domic  THEN v_domic  END,
    CASE WHEN h_local  THEN v_local  END,
    CASE WHEN h_prov   THEN v_prov   END,
    CASE WHEN h_cp     THEN v_cp     END,
    CASE WHEN h_tel    THEN v_tel    END,
    CASE WHEN h_email  THEN v_email  END,
    CASE WHEN h_obs    THEN v_obs    END,
    CASE WHEN h_logo THEN v_logo
         ELSE (SELECT nullif(btrim(coalesce(b0.logo_url, '')), '')
                 FROM public.businesses b0 WHERE b0.id = p_business_id) END
  )
  ON CONFLICT (business_id) DO UPDATE SET
    nombre_comercial           = CASE WHEN h_nombre THEN v_nombre ELSE s.nombre_comercial           END,
    razon_social               = CASE WHEN h_razon  THEN v_razon  ELSE s.razon_social               END,
    cuit                       = CASE WHEN h_cuit   THEN v_cuit   ELSE s.cuit                       END,
    condicion_iva              = CASE WHEN h_cond   THEN v_cond   ELSE s.condicion_iva              END,
    domicilio_fiscal           = CASE WHEN h_domic  THEN v_domic  ELSE s.domicilio_fiscal           END,
    localidad                  = CASE WHEN h_local  THEN v_local  ELSE s.localidad                  END,
    provincia                  = CASE WHEN h_prov   THEN v_prov   ELSE s.provincia                  END,
    codigo_postal              = CASE WHEN h_cp     THEN v_cp     ELSE s.codigo_postal              END,
    telefono                   = CASE WHEN h_tel    THEN v_tel    ELSE s.telefono                   END,
    email                      = CASE WHEN h_email  THEN v_email  ELSE s.email                      END,
    observaciones_comprobantes = CASE WHEN h_obs    THEN v_obs    ELSE s.observaciones_comprobantes END,
    logo_url                   = CASE WHEN h_logo   THEN v_logo   ELSE s.logo_url                   END,
    updated_at                 = now();

  -- ── (b) businesses — ESPEJOS técnicos ─────────────────────────────────────
  -- ALLOWLIST de 5 columnas y ninguna más. `owner_user_id`, `subscription_plan`,
  -- `subscription_status`, `trial_ends_at` e `id` NO están y no pueden estar.
  --
  -- `name` es NOT NULL: si el nombre comercial se borra a propósito, la columna
  -- espejo no puede quedar vacía y conserva su valor anterior. La autoridad
  -- sigue siendo `nombre_comercial`; `name` es sólo el respaldo estructural.
  --
  -- `wholesale_whatsapp` es asimétrico A PROPÓSITO: es el número del PORTAL
  -- MAYORISTA, no el teléfono general del negocio. Se SIEMBRA cuando está vacío
  -- (para no regresionar a los negocios que hoy sólo tienen ese valor) pero
  -- NUNCA se pisa: un número puesto deliberadamente para el portal gana sobre
  -- el teléfono general. Retirar el espejo es trabajo de ONBOARDING-2.
  --
  -- `logo_url` NO está en este SET: ya lo replica
  -- `trigger_sync_business_logo_url` desde `business_settings`. Escribirlo acá
  -- también daría DOS mecanismos para el mismo espejo — justo la clase de
  -- duplicación que este lote viene a eliminar. La postcondición P13 asevera
  -- que el trigger sigue existiendo, así que el espejo no puede desaparecer en
  -- silencio si alguien lo borra.
  UPDATE public.businesses b
     SET name   = CASE WHEN h_nombre THEN COALESCE(v_nombre, b.name) ELSE b.name   END,
         ciudad = CASE WHEN h_local  THEN v_local                    ELSE b.ciudad END,
         rubro  = CASE WHEN h_rubro  THEN v_rubro                    ELSE b.rubro  END,
         wholesale_whatsapp = CASE
           WHEN h_tel AND v_tel IS NOT NULL
                AND nullif(btrim(coalesce(b.wholesale_whatsapp, '')), '') IS NULL
             THEN v_tel
           ELSE b.wholesale_whatsapp
         END
   WHERE b.id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;
END;
$$;

COMMENT ON FUNCTION private.write_business_profile(uuid, jsonb) IS
  'P0-ONB1: writer canónico del perfil del negocio. Privado: el business_id '
  'llega ya resuelto y validado por el caller público. Clave ausente = no tocar.';

-- No es alcanzable por PostgREST (el esquema `private` no tiene USAGE para
-- anon/authenticated), pero el EXECUTE a PUBLIC se repone en cada CREATE y se
-- revoca igual: defensa en profundidad, no confianza en la configuración.
REVOKE ALL ON FUNCTION private.normalize_condicion_iva(text)          FROM PUBLIC;
REVOKE ALL ON FUNCTION private.write_business_profile(uuid, jsonb)    FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. LECTURA CANÓNICA — get_my_business_profile()
-- ─────────────────────────────────────────────────────────────────────────────
-- Devuelve TODO el perfil en una llamada. El frontend no tiene que saber qué
-- campo vive en qué tabla — que es justamente el conocimiento que se le escapó
-- al wizard viejo y produjo este defecto.
CREATE OR REPLACE FUNCTION public.get_my_business_profile()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_biz uuid;
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_biz := public.current_user_business_id();
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  SELECT jsonb_build_object(
           'business_id',                b.id,
           -- La autoridad primero; `businesses.name` sólo como respaldo para
           -- los negocios que todavía no pasaron por la reparación.
           'nombre_comercial',           COALESCE(nullif(btrim(s.nombre_comercial), ''),
                                                  nullif(btrim(b.name), '')),
           'razon_social',               nullif(btrim(s.razon_social), ''),
           'cuit',                       nullif(btrim(s.cuit), ''),
           'condicion_iva',              s.condicion_iva,
           'domicilio_fiscal',           nullif(btrim(s.domicilio_fiscal), ''),
           'localidad',                  COALESCE(nullif(btrim(s.localidad), ''),
                                                  nullif(btrim(b.ciudad), '')),
           'provincia',                  nullif(btrim(s.provincia), ''),
           'codigo_postal',              nullif(btrim(s.codigo_postal), ''),
           'telefono',                   COALESCE(nullif(btrim(s.telefono), ''),
                                                  nullif(btrim(b.wholesale_whatsapp), '')),
           'email',                      nullif(btrim(s.email), ''),
           'observaciones_comprobantes', nullif(btrim(s.observaciones_comprobantes), ''),
           'logo_url',                   COALESCE(nullif(btrim(s.logo_url), ''),
                                                  nullif(btrim(b.logo_url), '')),
           'rubro',                      b.rubro,
           'business_name_mirror',       b.name,
           'onboarding_completed',       COALESCE(b.onboarding_completed, false),
           'onboarding_completed_at',    b.onboarding_completed_at,
           'role',                       public.current_user_role(),
           'can_edit',                   public.current_user_role() IN ('owner','admin')
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ESCRITURA CANÓNICA — update_my_business_profile(jsonb, boolean)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOMBRE NUEVO, no un overload de `update_my_business_onboarding`. Dos
-- funciones homónimas que aceptan los mismos nombres de parámetro hacen que
-- PostgREST no pueda desambiguar (PGRST203) durante todo el rollout.
--
-- NO recibe `business_id`: se deriva de la identidad canónica. Es la razón por
-- la que el cross-tenant es imposible por construcción y no por chequeo.
CREATE OR REPLACE FUNCTION public.update_my_business_profile(
  p_patch    jsonb   DEFAULT '{}'::jsonb,
  p_complete boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_biz    uuid;
  v_rol    text;
  v_faltan text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_biz := public.current_user_business_id();
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  -- El rol sale del servidor, nunca del cliente.
  v_rol := public.current_user_role();
  IF v_rol IS NULL OR v_rol NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Un patch que no es un objeto JSON es un contrato roto, no un caso de uso.
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH' USING ERRCODE = 'TRIVP';
  END IF;

  -- Aunque el patch llegara con `business_id`, el writer lo ignora: el tenant
  -- es el parámetro que le pasa ESTA función, no un dato del cliente.
  PERFORM private.write_business_profile(v_biz, p_patch - 'business_id');

  -- Completado. Se lee el estado YA PERSISTIDO, no los parámetros de esta
  -- llamada: si un paso anterior falló, esto no miente.
  IF p_complete THEN
    v_faltan := ARRAY[]::text[];

    IF NOT EXISTS (
      SELECT 1 FROM public.businesses b
        LEFT JOIN public.business_settings s ON s.business_id = b.id
       WHERE b.id = v_biz
         AND COALESCE(nullif(btrim(s.nombre_comercial), ''),
                      nullif(btrim(b.name), '')) IS NOT NULL
    ) THEN
      v_faltan := array_append(v_faltan, 'nombre_comercial');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.businesses b WHERE b.id = v_biz AND b.rubro IS NOT NULL
    ) THEN
      v_faltan := array_append(v_faltan, 'rubro');
    END IF;

    IF array_length(v_faltan, 1) IS NOT NULL THEN
      RAISE EXCEPTION 'ONBOARDING_INCOMPLETE: %', array_to_string(v_faltan, ',')
        USING ERRCODE = 'TRONB';
    END IF;

    -- Idempotente: un retry no reescribe cuándo terminó el onboarding.
    UPDATE public.businesses b
       SET onboarding_completed    = true,
           onboarding_completed_at = COALESCE(b.onboarding_completed_at, now())
     WHERE b.id = v_biz;
  END IF;

  RETURN public.get_my_business_profile();
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. WRAPPERS LEGACY — firma INTACTA
-- ─────────────────────────────────────────────────────────────────────────────
-- El frontend productivo llama a estas dos con exactamente estos nombres de
-- parámetro. La firma NO cambia — sólo el cuerpo, que ahora delega en el writer
-- canónico.
--
-- CONSECUENCIA BUSCADA: el frontend viejo, sin redesplegarse, deja de escribir
-- sólo en `businesses` y pasa a escribir donde leen los documentos. Por eso
-- este lote puede salir DB-first sin ventana rota.
--
-- Traducción de los 8 parámetros viejos al patch canónico:
--   p_name             -> nombre_comercial (+ espejo businesses.name)
--   p_rubro            -> rubro
--   p_ciudad           -> localidad        (+ espejo businesses.ciudad)
--   p_whatsapp         -> telefono         (+ siembra de wholesale_whatsapp)
--   p_condicion_fiscal -> condicion_iva    (normalizado a slug)
--   p_cuit             -> cuit
--   p_logo_url         -> logo_url         (ambas tablas, como ya hacía)
--
-- La convención vieja se respeta: NULL = «no tocar», '' = «borrar». Se traduce
-- a «clave ausente» / «clave presente vacía» del contrato nuevo.
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
  v_patch jsonb := '{}'::jsonb;
BEGIN
  IF p_name             IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('nombre_comercial', p_name);             END IF;
  IF p_rubro            IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('rubro',            p_rubro);            END IF;
  IF p_ciudad           IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('localidad',        p_ciudad);           END IF;
  IF p_whatsapp         IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('telefono',         p_whatsapp);         END IF;
  IF p_condicion_fiscal IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('condicion_iva',    p_condicion_fiscal); END IF;
  IF p_cuit             IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('cuit',             p_cuit);             END IF;
  IF p_logo_url         IS NOT NULL THEN v_patch := v_patch || jsonb_build_object('logo_url',         p_logo_url);         END IF;

  PERFORM public.update_my_business_profile(v_patch, p_complete);
  RETURN public.get_my_business_onboarding();
END;
$$;

-- Lectura legacy: MISMA firma, MISMAS claves que antes (el frontend viejo las
-- mapea por nombre en businessSetupService.mapear). El contrato es ADITIVO —
-- se agregan claves, no se quita ninguna — así que un cliente viejo las ignora.
--
-- `name` pasa a resolver por la autoridad comercial. Para un negocio ya
-- reparado ambas coinciden; para uno sin reparar sigue devolviendo
-- `businesses.name`, que es lo que devolvía antes.
CREATE OR REPLACE FUNCTION public.get_my_business_onboarding()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_p jsonb;
BEGIN
  v_p := public.get_my_business_profile();

  RETURN jsonb_build_object(
    'business_id',             v_p -> 'business_id',
    'name',                    v_p -> 'nombre_comercial',
    'rubro',                   v_p -> 'rubro',
    'ciudad',                  v_p -> 'localidad',
    'whatsapp',                v_p -> 'telefono',
    'logo_url',                v_p -> 'logo_url',
    'onboarding_completed',    v_p -> 'onboarding_completed',
    'onboarding_completed_at', v_p -> 'onboarding_completed_at',
    'cuit',                    v_p -> 'cuit',
    'condicion_fiscal',        v_p -> 'condicion_iva',
    'role',                    v_p -> 'role',
    'can_edit',                v_p -> 'can_edit'
  ) || v_p;   -- claves nuevas al final: aditivo, nunca destructivo
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ACL
-- ─────────────────────────────────────────────────────────────────────────────
-- EXECUTE a PUBLIC es el DEFAULT de PostgreSQL en cada CREATE FUNCTION: hay que
-- revocarlo explícitamente en cada (re)creación o se repone solo.
REVOKE ALL ON FUNCTION public.get_my_business_profile()                                                FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_my_business_profile(jsonb, boolean)                               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_business_onboarding()                                             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_my_business_profile()                                                TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_business_profile(jsonb, boolean)                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_business_onboarding()                                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean) TO authenticated;

-- `anon` no recibe nada: las cuatro exigen auth.uid().

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. REPARACIÓN HISTÓRICA
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotente y SEMÁNTICA: selecciona por condición, no por lista de ids ni por
-- un contador. El «18 de 20» del discovery es EVIDENCIA de que el defecto
-- existe, no la lógica de la reparación — si entre la medición y el deploy
-- entran negocios nuevos, la migración los repara también.
--
-- REGLA MAESTRA: NUNCA se pisa un dato canónico que ya existe. La condición de
-- cada rama exige que el destino esté vacío.
--
-- EXCLUSIÓN CRÍTICA — 'Mi Negocio'. Es el default de `provision_my_business`,
-- o sea un PLACEHOLDER TÉCNICO, no un nombre que alguien eligió. Copiarlo a
-- `nombre_comercial` lo convertiría en un nombre «real» y lo imprimiría en
-- comprobantes — exactamente el daño que este lote viene a cerrar. Los negocios
-- que nunca se renombraron quedan con `nombre_comercial` NULL, que es la verdad.
--
-- Medido en producción con SELECT read-only antes de escribir esto:
--   · 30 negocios, 18 sin fila de settings;
--   · 14 recibirían nombre_comercial;
--   · 14 quedan excluidos por el placeholder;
--   ·  2 ya tienen nombre_comercial real y NO se tocan;
--   ·  5 recibirían localidad;
--   ·  6 recibirían telefono;
--   ·  8 necesitan INSERT (no tienen fila de settings pero sí datos que copiar).
DO $repair$
DECLARE
  v_esperado_nombre int;
  v_esperado_local  int;
  v_esperado_tel    int;
  v_esperado_logo   int;
  v_real_nombre     int;
  v_real_local      int;
  v_real_tel        int;
  v_real_logo       int;
  v_antes           jsonb;
  v_despues         jsonb;
  v_n               int;
BEGIN
  -- ── PRE: cuántas filas CUMPLEN la condición ───────────────────────────────
  SELECT
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.nombre_comercial,'')),'') IS NULL
                       AND nullif(btrim(b.name),'') IS NOT NULL
                       AND btrim(b.name) <> 'Mi Negocio'),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.localidad,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.ciudad,'')),'') IS NOT NULL),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.telefono,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.wholesale_whatsapp,'')),'') IS NOT NULL),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.logo_url,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.logo_url,'')),'') IS NOT NULL)
    INTO v_esperado_nombre, v_esperado_local, v_esperado_tel, v_esperado_logo
    FROM public.businesses b
    LEFT JOIN public.business_settings s ON s.business_id = b.id;

  -- Huella de TODO `businesses` MENOS `updated_at`. El resto de la fila NO debe
  -- cambiar: la comparación es sobre la fila entera, así que detecta cualquier
  -- columna tocada por accidente, incluidas las que no nombramos.
  --
  -- `updated_at` se excluye porque SÍ se mueve, y por un camino legítimo: el
  -- INSERT en `business_settings` dispara `trigger_sync_business_logo_url`, que
  -- hace un UPDATE sobre `businesses`, y eso activa `update_businesses_updated_at`
  -- (`NEW.updated_at = now()`, incondicional). Es comportamiento explícito del
  -- esquema, no un efecto de esta reparación. Que `logo_url` no cambie se
  -- asevera aparte, en R2b, que es donde estaba el riesgo real.
  SELECT jsonb_agg((to_jsonb(b.*) - 'updated_at') ORDER BY b.id) INTO v_antes
    FROM public.businesses b;

  -- ── REPARACIÓN ────────────────────────────────────────────────────────────
  -- Un solo UPSERT con las tres ramas. `business_settings` es la única tabla
  -- que se escribe.
  --
  -- ⚠️ `logo_url` VIAJA EN EL INSERT aunque no sea uno de los campos reparados.
  -- `trigger_sync_business_logo_url` dispara en TODO INSERT y replica
  -- `business_settings.logo_url` hacia `businesses`. Omitir la columna la
  -- dejaría NULL y le BORRARÍA el logo al negocio. Se copia el valor actual
  -- para que el trigger quede en no-op. Medido: hoy 0 de los 8 negocios que
  -- reciben INSERT tienen logo, así que en producción no cambia nada — pero la
  -- migración no puede depender de un snapshot de los datos para ser correcta.
  INSERT INTO public.business_settings AS s (business_id, nombre_comercial, localidad, telefono, logo_url)
  SELECT b.id,
         CASE WHEN btrim(b.name) <> 'Mi Negocio' THEN nullif(btrim(b.name), '') END,
         nullif(btrim(coalesce(b.ciudad, '')), ''),
         nullif(regexp_replace(coalesce(b.wholesale_whatsapp, ''), '[^0-9]', '', 'g'), ''),
         nullif(btrim(coalesce(b.logo_url, '')), '')
    FROM public.businesses b
   WHERE NOT EXISTS (SELECT 1 FROM public.business_settings x WHERE x.business_id = b.id)
     AND (
          (nullif(btrim(b.name), '') IS NOT NULL AND btrim(b.name) <> 'Mi Negocio')
       OR nullif(btrim(coalesce(b.ciudad, '')), '') IS NOT NULL
       OR nullif(btrim(coalesce(b.wholesale_whatsapp, '')), '') IS NOT NULL
     )
  ON CONFLICT (business_id) DO NOTHING;   -- carrera: si otra sesión la creó, el UPDATE de abajo la cubre

  -- CUARTA RAMA — `logo_url`. NO estaba en las tres del brief, y se agrega
  -- porque es EXACTAMENTE el mismo defecto: el dato vive en `businesses` y el
  -- consumidor canónico lee `business_settings`. Medido: 1 negocio en
  -- producción tiene logo en `businesses` y `business_settings.logo_url` vacío,
  -- así que su comprobante y su orden de servicio se imprimen SIN LOGO aunque
  -- la app se lo muestre en pantalla.
  --
  -- Es también lo que permite que R2b sea una aserción absoluta («cero
  -- divergencias») en vez de un delta, que es un guard más débil.
  --
  -- OJO: esta rama SÍ menciona `logo_url` en el SET, así que dispara
  -- `trigger_sync_business_logo_url`. Es inocuo por construcción: el trigger
  -- escribe en `businesses.logo_url` el valor que se acaba de copiar DESDE
  -- `businesses.logo_url`. Idempotente por definición.
  UPDATE public.business_settings s
     SET nombre_comercial = CASE
           WHEN nullif(btrim(coalesce(s.nombre_comercial, '')), '') IS NULL
                AND nullif(btrim(b.name), '') IS NOT NULL
                AND btrim(b.name) <> 'Mi Negocio'
             THEN btrim(b.name)
           ELSE s.nombre_comercial
         END,
         localidad = CASE
           WHEN nullif(btrim(coalesce(s.localidad, '')), '') IS NULL
                AND nullif(btrim(coalesce(b.ciudad, '')), '') IS NOT NULL
             THEN btrim(b.ciudad)
           ELSE s.localidad
         END,
         telefono = CASE
           WHEN nullif(btrim(coalesce(s.telefono, '')), '') IS NULL
                AND nullif(btrim(coalesce(b.wholesale_whatsapp, '')), '') IS NOT NULL
             THEN regexp_replace(b.wholesale_whatsapp, '[^0-9]', '', 'g')
           ELSE s.telefono
         END,
         logo_url = CASE
           WHEN nullif(btrim(coalesce(s.logo_url, '')), '') IS NULL
                AND nullif(btrim(coalesce(b.logo_url, '')), '') IS NOT NULL
             THEN btrim(b.logo_url)
           ELSE s.logo_url
         END
    FROM public.businesses b
   WHERE b.id = s.business_id
     AND (
          (nullif(btrim(coalesce(s.nombre_comercial, '')), '') IS NULL
             AND nullif(btrim(b.name), '') IS NOT NULL
             AND btrim(b.name) <> 'Mi Negocio')
       OR (nullif(btrim(coalesce(s.localidad, '')), '') IS NULL
             AND nullif(btrim(coalesce(b.ciudad, '')), '') IS NOT NULL)
       OR (nullif(btrim(coalesce(s.telefono, '')), '') IS NULL
             AND nullif(btrim(coalesce(b.wholesale_whatsapp, '')), '') IS NOT NULL)
       OR (nullif(btrim(coalesce(s.logo_url, '')), '') IS NULL
             AND nullif(btrim(coalesce(b.logo_url, '')), '') IS NOT NULL)
     );

  -- ── POST ──────────────────────────────────────────────────────────────────
  SELECT
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.nombre_comercial,'')),'') IS NULL
                       AND nullif(btrim(b.name),'') IS NOT NULL
                       AND btrim(b.name) <> 'Mi Negocio'),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.localidad,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.ciudad,'')),'') IS NOT NULL),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.telefono,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.wholesale_whatsapp,'')),'') IS NOT NULL),
    count(*) FILTER (WHERE nullif(btrim(coalesce(s.logo_url,'')),'') IS NULL
                       AND nullif(btrim(coalesce(b.logo_url,'')),'') IS NOT NULL)
    INTO v_real_nombre, v_real_local, v_real_tel, v_real_logo
    FROM public.businesses b
    LEFT JOIN public.business_settings s ON s.business_id = b.id;

  -- R1. La condición quedó agotada: cero pendientes en las cuatro ramas.
  IF v_real_nombre <> 0 OR v_real_local <> 0 OR v_real_tel <> 0 OR v_real_logo <> 0 THEN
    RAISE EXCEPTION 'REPAIR R1: quedaron pendientes (nombre=%, localidad=%, telefono=%, logo=%)',
      v_real_nombre, v_real_local, v_real_tel, v_real_logo;
  END IF;

  -- R2. `businesses` NO cambió NINGUNA columna de datos. La reparación es
  --     unidireccional: copia hacia `business_settings` y no borra el origen.
  SELECT jsonb_agg((to_jsonb(b.*) - 'updated_at') ORDER BY b.id) INTO v_despues
    FROM public.businesses b;
  IF v_antes IS DISTINCT FROM v_despues THEN
    RAISE EXCEPTION 'REPAIR R2: la reparación modificó una columna de public.businesses';
  END IF;

  -- R2b. Ningún logo se perdió. Es el riesgo concreto del trigger de sincro:
  --      un INSERT en `business_settings` sin `logo_url` habría escrito NULL
  --      sobre `businesses.logo_url`. R2 ya lo cubre, pero esto lo nombra para
  --      que un futuro relajamiento de R2 no se lo lleve puesto en silencio.
  SELECT count(*) INTO v_n
    FROM public.businesses b
    JOIN public.business_settings s ON s.business_id = b.id
   WHERE nullif(btrim(coalesce(b.logo_url, '')), '')
         IS DISTINCT FROM nullif(btrim(coalesce(s.logo_url, '')), '');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'REPAIR R2b: % negocios quedaron con el logo divergente entre las dos tablas', v_n;
  END IF;

  -- R3. Ningún negocio con nombre real puede haber quedado con el placeholder
  --     como nombre comercial. Es la invariante que protege los documentos.
  SELECT count(*) INTO v_n
    FROM public.business_settings s
   WHERE btrim(coalesce(s.nombre_comercial, '')) = 'Mi Negocio';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'REPAIR R3: % filas quedaron con el placeholder como nombre comercial', v_n;
  END IF;

  -- R4. Segunda pasada: 0 filas. Si esto cambiara algo, la reparación no sería
  --     idempotente y un replay corrompería datos.
  WITH segunda AS (
    UPDATE public.business_settings s
       SET nombre_comercial = btrim(b.name)
      FROM public.businesses b
     WHERE b.id = s.business_id
       AND nullif(btrim(coalesce(s.nombre_comercial, '')), '') IS NULL
       AND nullif(btrim(b.name), '') IS NOT NULL
       AND btrim(b.name) <> 'Mi Negocio'
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM segunda;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'REPAIR R4: la reparación NO es idempotente (% filas en la 2da pasada)', v_n;
  END IF;

  RAISE NOTICE 'P0-ONB1 reparación: nombre=%, localidad=%, telefono=%, logo=% (esperados por condición)',
    v_esperado_nombre, v_esperado_local, v_esperado_tel, v_esperado_logo;
END;
$repair$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. POSTCONDICIONES
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n   int;
  v_def text;
BEGIN
  -- P1. Las cuatro RPC públicas existen con la firma esperada, y la LEGACY
  --     conserva EXACTAMENTE la suya: es lo que evita el PGRST202 del frontend
  --     productivo durante el rollout.
  IF to_regprocedure('public.get_my_business_onboarding()') IS NULL
     OR to_regprocedure('public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)') IS NULL
     OR to_regprocedure('public.get_my_business_profile()') IS NULL
     OR to_regprocedure('public.update_my_business_profile(jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P1: falta alguna RPC de perfil de negocio';
  END IF;

  -- P2. NINGUNA acepta business_id. Es la barrera cross-tenant del lote.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_my_business_onboarding', 'update_my_business_onboarding',
                         'get_my_business_profile',    'update_my_business_profile')
       AND pg_get_function_identity_arguments(p.oid) ILIKE '%business_id%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P2: una RPC pública de perfil acepta business_id';
  END IF;

  -- P3. NO hay overload de las RPC de perfil. Dos funciones homónimas que
  --     aceptan los mismos nombres hacen que PostgREST responda PGRST203.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_my_business_onboarding', 'update_my_business_onboarding',
                       'get_my_business_profile',    'update_my_business_profile');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'POSTCOND P3: hay % funciones de perfil, se esperaban 4 (overload?)', v_n;
  END IF;

  -- P4. SECDEF + search_path endurecido con pg_temp AL FINAL, en públicas y
  --     privadas.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE ((n.nspname = 'public'
           AND p.proname IN ('get_my_business_onboarding', 'update_my_business_onboarding',
                             'get_my_business_profile',    'update_my_business_profile'))
          OR (n.nspname = 'private' AND p.proname = 'write_business_profile'))
     AND (p.prosecdef = false
          OR p.proconfig IS NULL
          OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P4: % función sin SECDEF o sin el search_path esperado', v_n;
  END IF;

  -- P5. ACL: PUBLIC y anon fuera; authenticated dentro.
  IF has_function_privilege('public', 'public.update_my_business_profile(jsonb,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.update_my_business_profile(jsonb,boolean)', 'EXECUTE')
     OR has_function_privilege('public', 'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.get_my_business_profile()', 'EXECUTE')
     OR has_function_privilege('anon',   'public.get_my_business_onboarding()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P5: PUBLIC/anon conservan EXECUTE sobre una RPC de perfil';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.update_my_business_profile(jsonb,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.get_my_business_profile()', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.update_my_business_onboarding(text,text,text,text,text,text,text,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.get_my_business_onboarding()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTCOND P5b: authenticated no puede ejecutar alguna RPC de perfil';
  END IF;

  -- P6. El writer canónico NO es alcanzable desde el navegador: PostgREST sólo
  --     expone esquemas con USAGE para los roles del cliente.
  IF has_schema_privilege('authenticated', 'private', 'USAGE')
     OR has_schema_privilege('anon', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'POSTCOND P6: el esquema private quedó expuesto a un rol del cliente';
  END IF;

  -- P7. La invariante de P0-P1/P0-P2: el cliente sigue SIN DML estructural
  --     directo sobre profiles/businesses.
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('profiles', 'businesses')
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P7: se repusieron % grants de DML sobre profiles/businesses', v_n;
  END IF;

  -- P8. El writer canónico NO toca columnas estructurales. Se asevera sobre el
  --     código SIN comentarios: este archivo NOMBRA esas columnas al explicar
  --     por qué están excluidas, y un match sobre el texto crudo contaría la
  --     documentación como si fuera código.
  v_def := regexp_replace(
    pg_get_functiondef(to_regprocedure('private.write_business_profile(uuid,jsonb)')),
    '--[^\n]*', '', 'g');
  IF v_def ~* 'owner_user_id|subscription_plan|subscription_status|trial_ends_at' THEN
    RAISE EXCEPTION 'POSTCOND P8: el writer canónico menciona una columna estructural';
  END IF;
  IF v_def ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?businesses' THEN
    RAISE EXCEPTION 'POSTCOND P8b: el writer canónico crea businesses';
  END IF;

  -- P9. `provision_my_business` intacta: sigue siendo la única creadora.
  IF to_regprocedure('public.provision_my_business(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P9: desapareció provision_my_business';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.provision_my_business(text)')) NOT LIKE '%INVITATION_PENDING%' THEN
    RAISE EXCEPTION 'POSTCOND P9b: provision_my_business perdió la defensa INVITATION_PENDING';
  END IF;

  -- P10. El CHECK de condicion_iva existe y la historia lo respeta.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.business_settings'::regclass
       AND conname  = 'business_settings_condicion_iva_check'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P10: falta el CHECK de condicion_iva';
  END IF;

  SELECT count(*) INTO v_n
    FROM public.business_settings s
   WHERE s.condicion_iva IS NOT NULL
     AND s.condicion_iva NOT IN ('responsable_inscripto','monotributo',
                                 'monotributista_social','exento','consumidor_final');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P10b: % filas con condicion_iva fuera de la allowlist', v_n;
  END IF;

  -- P11. El DEFAULT que declaraba a todo el mundo Responsable Inscripto se fue.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'business_settings'
       AND column_name = 'condicion_iva' AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'POSTCOND P11: condicion_iva conserva un DEFAULT';
  END IF;

  -- P12. NO se tocaron las otras dos «condición fiscal». Son de ARCA y del
  --      punto de venta, y este lote no las gobierna.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.sales_points'::regclass
       AND conname LIKE '%condicion%'
       AND conname LIKE '%p0onb1%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P12: este lote agregó un constraint sobre sales_points';
  END IF;

  -- P13. El espejo del logo sigue existiendo. El writer canónico NO escribe
  --      `businesses.logo_url` a propósito: delega en este trigger para que
  --      haya UN solo mecanismo de espejo. Si alguien lo borra, el logo dejaría
  --      de replicarse EN SILENCIO — que es la forma exacta en que se rompió el
  --      nombre comercial.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.business_settings'::regclass
       AND tgname  = 'trigger_sync_business_logo_url'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'POSTCOND P13: desapareció trigger_sync_business_logo_url (el espejo del logo)';
  END IF;

  RAISE NOTICE 'P0-ONB1: 13 postcondiciones OK';
END;
$post$;

COMMIT;
