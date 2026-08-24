-- ═══════════════════════════════════════════════════════════════════════════
-- P0-P2 — Ciclo de vida de invitaciones, endurecido.
--
-- Cierra la SEGUNDA autoridad de alta de miembros. Después de P0-S0/P0-P1 la
-- invariante del sistema es:
--
--     provision_my_business()      -> ÚNICA operación que CREA un `businesses`
--     accept_business_invitation() -> ÚNICA operación que INCORPORA un usuario
--                                     a un `businesses` que YA EXISTE
--
-- Aceptar una invitación NUNCA crea un negocio. Esta migración lo vuelve cierto
-- en el código, no sólo en la intención.
--
-- ───────────────────────────────────────────────────────────────────────────
-- ORDEN DE ROLLOUT: FRONTEND PRIMERO, `db push` DESPUÉS
-- ───────────────────────────────────────────────────────────────────────────
-- Esta migración NO es compatible hacia atrás: retira
-- `create_business_invitation(text,text,uuid)`, que es la firma que llama el
-- frontend desplegado hoy. Aplicarla antes del deploy rompería el alta de
-- miembros durante toda la ventana.
--
-- Al revés SÍ es seguro, y por eso es el orden elegido (es además la regla ya
-- medida del proyecto: Vercel deploya solo en el merge, el `db push` es manual y
-- posterior, ventana ~5 min):
--
--   merge -> Vercel publica el frontend nuevo -> `supabase db push`
--
-- Durante esa ventana el frontend nuevo habla con la DB vieja:
--   · create  -> llama a la firma de 2 args, que YA EXISTE en producción. Corre
--                el código viejo y falla con el mismo `gen_random_bytes` de hoy.
--                No es una regresión: es la MISMA falla que ya está abierta.
--   · cancel  -> `cancel_business_invitation(uuid)` ya existe y funciona.
--   · accept  -> ya existe; devuelve uuid en vez de jsonb. El parser del
--                frontend tolera ambas formas a propósito (invitationsService),
--                y de todos modos el accept viejo falla con 23503 (bug 3).
--   · listado -> lectura directa de la tabla, sin cambios.
--
-- O sea: la ventana no introduce ningún estado nuevo ni parcialmente
-- compatible; prolonga por minutos una falla que ya existe, y el `db push` la
-- cierra. A cambio, el lote termina con UNA sola API canónica de creación en vez
-- de arrastrar un shim deprecado.
--
-- ───────────────────────────────────────────────────────────────────────────
-- BUGS CERRADOS (los 5 medidos contra producción el 2026-08-24)
-- ───────────────────────────────────────────────────────────────────────────
-- 1. `gen_random_bytes(integer) does not exist`  <- EL P0 REPORTADO
--    pgcrypto vive en el schema `extensions` (verificado en prod), pero las dos
--    RPC de creación corren con `search_path = public, pg_temp`. `extensions`
--    NO está en ese path, así que la llamada sin calificar no resuelve y la
--    invitación no se puede emitir. `encode()` sí resolvía porque es de
--    `pg_catalog`, que siempre está implícito — por eso el error señalaba sólo a
--    `gen_random_bytes`.
--
--    Se arregla calificando el schema (`extensions.gen_random_bytes`), NO
--    ampliando el search_path: meter `extensions` en el path de una
--    SECURITY DEFINER reabre exactamente la superficie que cerró el lote 7C.1.
--    La aleatoriedad sigue siendo criptográfica; no se degrada a random() ni a
--    un hash de timestamp.
--
-- 2. `accept_business_invitation` NO comparaba el correo.
--    Leía el email del actor desde auth.users y después no lo usaba para nada.
--    CUALQUIER usuario autenticado con el token en la mano entraba al negocio.
--    Ahora es fail-closed contra `invitation.email` normalizado.
--
-- 3. 23503 garantizado en el alta de perfil.
--    La rama de creación hacía INSERT INTO profiles(user_id, ...) omitiendo
--    `id`, que es FK a auth.users(id) con DEFAULT gen_random_uuid(). O sea:
--    tomaba un uuid al azar que jamás está en auth.users y violaba la FK.
--    Es el MISMO defecto que 20260823150000 arregló en el camino de owner.
--    Ningún invitado sin perfil podía aceptar una invitación, nunca.
--
-- 4. La rama "ya tiene perfil" MOVÍA la membresía en silencio.
--    Hacía UPDATE profiles SET business_id = invitation.business_id, role = ...
--    sin comparar nada: un owner del Taller A que abriera una invitación del
--    Taller B perdía su propio negocio y bajaba de rango. Ahora es fail-closed
--    (ALREADY_MEMBER_OF_ANOTHER_BUSINESS) y el rol jamás se toca.
--
-- 5. Sin barrera de concurrencia ni en crear ni en aceptar.
--    Crear usaba un `IF EXISTS` suelto (dos clicks -> dos pending) y aceptar no
--    lockeaba la invitación (dos aceptaciones simultáneas -> dos escrituras).
--    Ahora: índice único parcial + advisory lock en crear, y `FOR UPDATE` sobre
--    la invitación en aceptar.
--
-- ───────────────────────────────────────────────────────────────────────────
-- NOTA SOBRE AUTOCOMMIT
-- ───────────────────────────────────────────────────────────────────────────
-- Las migraciones de Supabase corren en AUTOCOMMIT: sin un BEGIN/COMMIT
-- explícito cada statement se confirma solo y una postcondición que falla al
-- final NO revierte nada. Por eso todo el archivo va dentro de una transacción.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. BARRERA DE DUPLICADOS — índice único parcial
-- ───────────────────────────────────────────────────────────────────────────
-- Invariante: un business + un email normalizado -> como máximo UNA invitación
-- pending. Es una barrera de DB real, no un chequeo del lado del cliente: bajo
-- READ COMMITTED dos transacciones simultáneas pasan las dos por un `IF EXISTS`
-- y insertan las dos.
--
-- Va sobre `lower(btrim(email))` y no sobre `email` a secas porque la
-- comparación canónica del sistema es normalizada; un índice sobre la columna
-- cruda dejaría pasar 'Ana@x.com' y 'ana@x.com' como dos invitaciones distintas.
--
-- Parcial (`WHERE status = 'pending'`) para no bloquear el historial: un mismo
-- email puede tener N invitaciones accepted/cancelled/expired a lo largo del
-- tiempo, y eso es historia legítima que no se borra.
--
-- MEDIDO: producción tiene 0 filas en esta tabla (total/pending/accepted/
-- cancelled/expired = 0) y 0 duplicados pending por (business_id, email), así
-- que la creación del índice no puede fallar ni requiere tocar datos.
CREATE UNIQUE INDEX IF NOT EXISTS business_invitations_one_pending_per_email
  ON public.business_invitations (business_id, lower(btrim(email)))
  WHERE status = 'pending';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. CREACIÓN CANÓNICA — create_business_invitation(email, role)
-- ───────────────────────────────────────────────────────────────────────────
-- Firma canónica: NO recibe business_id. El negocio destino se deriva del actor
-- server-side, con la misma identidad canónica que usan current_business_id(),
-- current_user_role() y las 96+ policies: COALESCE(profiles.user_id, profiles.id).
--
-- El único dato del cliente que sobrevive es el email y el rol, y el rol pasa
-- por una allowlist cerrada antes de tocar la tabla.
CREATE OR REPLACE FUNCTION public.create_business_invitation(
  p_email text,
  p_role  text DEFAULT 'tech'
)
RETURNS public.business_invitations
LANGUAGE plpgsql
SECURITY DEFINER
-- `pg_temp` va ÚLTIMO y explícito. Omitirlo no lo saca del path: lo pone
-- PRIMERO, que es justo el bypass que cerró el lote 7C.1.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      uuid;
  v_biz      uuid;
  v_role     text;
  v_email    text;
  v_actor    record;
  v_existing public.business_invitations;
  v_token    text;
BEGIN
  -- (a) Identidad: SIEMPRE del JWT.
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- (b) Normalización del correo invitado. `lower(btrim(...))` es la forma
  --     canónica que usan tanto provision_my_business como el accept de abajo:
  --     si acá se guardara sin normalizar, la comparación del accept fallaría
  --     contra un correo que el owner escribió con mayúsculas.
  v_email := lower(btrim(coalesce(p_email, '')));
  IF v_email = '' OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'INVALID_EMAIL' USING ERRCODE = 'TRIVE';
  END IF;

  -- (c) Rol contra allowlist CERRADA.
  --     El CHECK de la tabla admite 'owner' (y el de profiles también), así que
  --     la tabla NO alcanza como gate: sin esto, una invitación podría fabricar
  --     un segundo owner del negocio. 'owner' se otorga en un solo lugar del
  --     sistema —provision_my_business— y por invitación jamás.
  v_role := lower(btrim(coalesce(p_role, '')));
  IF v_role NOT IN ('admin', 'manager', 'tech', 'sales', 'cashier', 'viewer') THEN
    RAISE EXCEPTION 'INVALID_ROLE' USING ERRCODE = 'TRIVR';
  END IF;

  -- (d) Autorización: el actor tiene que ser miembro ACTIVO y owner/admin del
  --     negocio. El business sale de ACÁ, de su propio perfil — no de un
  --     argumento. Un business_id del cliente sería un oráculo y, sin este
  --     chequeo, permitiría sembrar invitaciones en negocios ajenos.
  SELECT p.business_id, p.role
    INTO v_actor
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid
     AND p.is_active = true
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  IF v_actor.business_id IS NULL THEN
    RAISE EXCEPTION 'NO_BUSINESS' USING ERRCODE = 'TRNOB';
  END IF;

  IF v_actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_biz := v_actor.business_id;

  -- (e) BARRERA DE CONCURRENCIA.
  --     El índice único de arriba es la garantía dura, pero por sí solo
  --     convierte un doble click en un 23505 crudo en la cara del usuario. El
  --     advisory lock serializa a los dos actores ANTES, así el segundo ve el
  --     trabajo del primero y devuelve la MISMA invitación en vez de fallar.
  --     El índice queda como red de último recurso, no como barrera principal.
  --
  --     Es xact: se libera solo al terminar la transacción. La forma de dos
  --     int4 namespacea el lock contra otros usos de advisory locks del esquema.
  PERFORM pg_advisory_xact_lock(
    hashtext('create_business_invitation:' || v_biz::text),
    hashtext(v_email)
  );

  -- (f) Higiene de vencidas ANTES de mirar si hay una viva.
  --     Sin esto, una pending ya vencida ocuparía para siempre el slot único
  --     del índice parcial y el owner no podría volver a invitar a ese correo.
  --     No borra historial: transiciona pending -> expired, que es exactamente
  --     lo que ya significaba `expires_at <= now()`.
  UPDATE public.business_invitations
     SET status = 'expired',
         updated_at = now()
   WHERE business_id = v_biz
     AND lower(btrim(email)) = v_email
     AND status = 'pending'
     AND expires_at <= now();

  -- (g) Idempotencia: si ya hay una pending viva, se devuelve ESA.
  --     Doble click / retry / reenvío no crean N filas ni rotan el token de una
  --     invitación que el usuario quizá ya recibió.
  SELECT *
    INTO v_existing
    FROM public.business_invitations
   WHERE business_id = v_biz
     AND lower(btrim(email)) = v_email
     AND status = 'pending'
     AND expires_at > now()
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- (h) Token criptográfico.
  --     `extensions.gen_random_bytes` CALIFICADO: pgcrypto está instalado en el
  --     schema `extensions` y esta función corre con un search_path endurecido
  --     que no lo incluye. Ésta es la línea que arregla el P0 productivo
  --     `function gen_random_bytes(integer) does not exist`.
  --
  --     32 bytes -> 64 caracteres hex. No se degrada a random(), timestamp, uuid
  --     ni hash previsible: el token ES la capacidad que abre el negocio.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO public.business_invitations (
    business_id, email, role, invited_by, token, status
  )
  VALUES (
    v_biz, v_email, v_role, v_uid, v_token, 'pending'
  )
  RETURNING * INTO v_existing;

  RETURN v_existing;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. RETIRO DE LA API LEGACY — create_business_invitation(email, role, business_id)
-- ───────────────────────────────────────────────────────────────────────────
-- Se retira la firma de 3 argumentos. Objetivo del lote: UNA sola API canónica
-- de creación.
--
-- Por qué esta y no la otra: era la peor de las dos. Aceptaba un `business_id`
-- del cliente (lo validaba contra la membresía, pero igual lo recibía como
-- entrada), NO tenía allowlist de roles —sólo bloqueaba 'owner' por comparación
-- de texto, así que cualquier string fuera del CHECK llegaba a la tabla— y NO
-- tenía ninguna deduplicación: cada click creaba una pending nueva.
--
-- Dependencias verificadas contra producción y contra el repo antes de retirarla:
--   · funciones/triggers/policies que la mencionen ... 0
--   · vistas sobre business_invitations ............. 0
--   · cron jobs ..................................... 0 (los 3 activos son
--     expire_trials, enforce_grace_period, apply_whatsapp_logs_retention)
--   · callers en el repo ............................ 1, `usersService.ts`, que
--     este mismo lote migra a la firma canónica.
-- El único caller vivo es el frontend, y por eso el frontend sale PRIMERO.
DROP FUNCTION IF EXISTS public.create_business_invitation(text, text, uuid);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. ACEPTACIÓN CANÓNICA — accept_business_invitation(token)
-- ───────────────────────────────────────────────────────────────────────────
-- Cambia el tipo de retorno (uuid -> jsonb), así que hace falta DROP: PostgreSQL
-- no permite cambiar el tipo de retorno con CREATE OR REPLACE.
--
-- El cambio es COMPATIBLE con el frontend viejo: `usersService.acceptInvitation`
-- descarta el valor devuelto y sólo mira `error`. El jsonb (mismo estilo que
-- provision_my_business) le da al frontend nuevo el business y el rol sin una
-- segunda consulta.
DROP FUNCTION IF EXISTS public.accept_business_invitation(text);

CREATE FUNCTION public.accept_business_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_email      text;
  v_confirmado timestamptz;
  v_full_name  text;
  v_inv        public.business_invitations;
  v_profile    record;
  v_profile_id uuid;
BEGIN
  -- (a) Identidad. El ÚNICO dato de capacidad que aporta el cliente es el token.
  --     No se recibe user_id (sería suplantación), ni email (sería un oráculo y
  --     anularía la validación del punto (d)), ni business_id (lo dicta la
  --     invitación, no quien la acepta), ni role (ver punto (h)).
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT lower(btrim(u.email)),
         u.email_confirmed_at,
         NULLIF(btrim(u.raw_user_meta_data ->> 'full_name'), '')
    INTO v_email, v_confirmado, v_full_name
    FROM auth.users u
   WHERE u.id = v_uid;

  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  -- (b) Misma señal canónica y provider-agnostic que provision_my_business.
  --     Con Confirm Email ON un usuario sin confirmar no llega a tener sesión,
  --     así que en la práctica esto es defensa en profundidad; Google llega con
  --     el timestamp ya poblado y pasa sin ninguna rama especial.
  IF v_confirmado IS NULL THEN
    RAISE EXCEPTION 'EMAIL_NOT_CONFIRMED' USING ERRCODE = '42501';
  END IF;

  -- (c) LOCK sobre la invitación. Se busca por token SIN filtrar por estado,
  --     para poder distinguir "no existe" de "cancelada" de "vencida" — un
  --     filtro por status colapsaba los tres en el mismo mensaje.
  --
  --     `FOR UPDATE` es la barrera de concurrencia: dos aceptaciones simultáneas
  --     del mismo token se serializan acá, y la segunda ve el status ya escrito
  --     por la primera. Sin esto, las dos pasaban el chequeo de 'pending'.
  --     `token` es UNIQUE, así que hay a lo sumo una fila.
  SELECT *
    INTO v_inv
    FROM public.business_invitations
   WHERE token = btrim(p_token)
   FOR UPDATE;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE = 'TRINF';
  END IF;

  -- (d) EL BUG PRINCIPAL DE P0-P2: comparar el correo.
  --     La versión anterior leía el email del actor y NUNCA lo comparaba, así
  --     que cualquier usuario autenticado que consiguiera el token entraba al
  --     negocio. Ambos lados normalizados; el del actor sale de auth.users
  --     server-side, jamás del cliente.
  --
  --     Va ANTES de revelar el estado de la invitación: si no, un tercero con
  --     un token ajeno podría usar los distintos errores como oráculo.
  IF v_email IS DISTINCT FROM lower(btrim(v_inv.email)) THEN
    RAISE EXCEPTION 'INVITATION_EMAIL_MISMATCH' USING ERRCODE = 'TRIEM';
  END IF;

  -- (e) Perfil actual del actor, lockeado. Se lee ANTES de ramificar por estado
  --     porque la idempotencia del punto (f) depende de la membresía.
  SELECT p.id, p.business_id, p.role
    INTO v_profile
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1
   FOR UPDATE;

  -- (f) Estado y vigencia. Sólo se acepta pending y no vencida.
  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'INVITATION_CANCELLED' USING ERRCODE = 'TRICA';

  ELSIF v_inv.status = 'expired' OR (v_inv.status = 'pending' AND v_inv.expires_at <= now()) THEN
    -- No se persiste la transición a 'expired' acá: RAISE aborta la transacción
    -- y el UPDATE se iría con ella. El expirador canónico es
    -- expire_old_invitations() (cron), y la creación también limpia las vencidas
    -- de ese (business,email) antes de emitir una nueva.
    RAISE EXCEPTION 'INVITATION_EXPIRED' USING ERRCODE = 'TRIEX';

  ELSIF v_inv.status = 'accepted' THEN
    -- IDEMPOTENCIA (decisión de producto 8.A): si el actor YA es miembro del
    -- negocio correcto, reaceptar es un no-op exitoso, no un error técnico.
    IF v_profile.business_id IS NOT NULL AND v_profile.business_id = v_inv.business_id THEN
      RETURN jsonb_build_object(
        'business_id', v_inv.business_id,
        'profile_id',  v_profile.id,
        'role',        v_profile.role,
        'created',     false,
        'status',      'ALREADY_MEMBER'
      );
    END IF;
    RAISE EXCEPTION 'INVITATION_ALREADY_USED' USING ERRCODE = 'TRIAU';
  END IF;

  -- A partir de acá la invitación es pending y vigente.

  -- (g) Membresía previa.
  IF v_profile.id IS NOT NULL THEN
    IF v_profile.business_id IS DISTINCT FROM v_inv.business_id THEN
      -- FAIL CLOSED (decisión de producto 8.B). Este lote NO implementa
      -- transferencias entre tenants. La versión anterior hacía justo lo
      -- contrario: movía `business_id` y pisaba `role`, así que un owner del
      -- Taller A que abriera una invitación del Taller B perdía su negocio.
      -- No se toca el profile, no se toca owner_user_id, no se crea nada.
      RAISE EXCEPTION 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS' USING ERRCODE = 'TRIAM';
    END IF;

    -- Ya es miembro del negocio correcto: no-op idempotente. NO se toca `role`
    -- —subirlo o bajarlo acá sería una escalada/degradación silenciosa— y
    -- tampoco `business_id`, que ya es el correcto.
    UPDATE public.business_invitations
       SET status = 'accepted',
           accepted_at = now(),
           updated_at = now()
     WHERE id = v_inv.id;

    RETURN jsonb_build_object(
      'business_id', v_inv.business_id,
      'profile_id',  v_profile.id,
      'role',        v_profile.role,
      'created',     false,
      'status',      'ALREADY_MEMBER'
    );
  END IF;

  -- (h) Alta del miembro. NO se crea ningún `businesses`: el negocio es el de la
  --     invitación y tiene que preexistir. NO se inicia trial. NO se toca
  --     owner_user_id.
  --
  --     El rol sale de la invitación —que ya pasó por la allowlist al crearse— y
  --     se REVALIDA acá: una fila histórica podría tener 'owner' (el CHECK de la
  --     tabla lo admite), y aceptar eso fabricaría un segundo owner.
  IF v_inv.role NOT IN ('admin', 'manager', 'tech', 'sales', 'cashier', 'viewer') THEN
    RAISE EXCEPTION 'INVALID_ROLE' USING ERRCODE = 'TRIVR';
  END IF;

  -- `id = v_uid` EXPLÍCITO. `profiles.id` es FK a auth.users(id) con DEFAULT
  -- gen_random_uuid(): dejar que tome el default produce un uuid que no está en
  -- auth.users y falla con 23503. Ése es el bug que hacía IMPOSIBLE aceptar una
  -- invitación para cualquier usuario sin perfil previo.
  INSERT INTO public.profiles (id, business_id, role, is_active, full_name, email)
  VALUES (
    v_uid,
    v_inv.business_id,
    v_inv.role,
    TRUE,
    COALESCE(v_full_name, split_part(v_email, '@', 1)),
    v_email
  )
  RETURNING id INTO v_profile_id;

  -- Misma transacción que el INSERT: si el alta del perfil falla, la invitación
  -- NO queda accepted. Nunca hay una invitación consumida sin miembro creado.
  UPDATE public.business_invitations
     SET status = 'accepted',
         accepted_at = now(),
         updated_at = now()
   WHERE id = v_inv.id;

  RETURN jsonb_build_object(
    'business_id', v_inv.business_id,
    'profile_id',  v_profile_id,
    'role',        v_inv.role,
    'created',     true,
    'status',      'ACCEPTED'
  );
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. CANCELACIÓN — cancel_business_invitation(id)
-- ───────────────────────────────────────────────────────────────────────────
-- El estado válido es 'cancelled' (así lo dice el CHECK de la tabla). El
-- frontend escribía 'revoked', que no existe en el contrato; se corrige el
-- caller, NO el CHECK.
--
-- Sólo se cancelan invitaciones 'pending'. Un retry sobre una ya cancelada
-- devuelve la fila en vez de reventar: doble click no es un error.
CREATE OR REPLACE FUNCTION public.cancel_business_invitation(p_invitation_id uuid)
RETURNS public.business_invitations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid   uuid;
  v_biz   uuid;
  v_role  text;
  v_inv   public.business_invitations;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT p.business_id, p.role
    INTO v_biz, v_role
    FROM public.profiles p
   WHERE COALESCE(p.user_id, p.id) = v_uid
     AND p.is_active = true
   ORDER BY (p.business_id IS NOT NULL) DESC,
            COALESCE(p.updated_at, p.created_at, now()) DESC
   LIMIT 1;

  IF v_biz IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Scope de tenant en el WHERE: una invitación de otro negocio simplemente no
  -- existe para este actor.
  SELECT *
    INTO v_inv
    FROM public.business_invitations
   WHERE id = p_invitation_id
     AND business_id = v_biz
   FOR UPDATE;

  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE = 'TRINF';
  END IF;

  -- Idempotente: ya cancelada -> se devuelve tal cual.
  IF v_inv.status = 'cancelled' THEN
    RETURN v_inv;
  END IF;

  -- Una invitación ya aceptada no se "descancela": sacar al miembro es otra
  -- operación (set_user_active_status), no ésta.
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'INVITATION_NOT_PENDING' USING ERRCODE = 'TRINP';
  END IF;

  UPDATE public.business_invitations
     SET status = 'cancelled',
         updated_at = now()
   WHERE id = v_inv.id
  RETURNING * INTO v_inv;

  RETURN v_inv;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. ACL — PUBLIC revocado, mínimo imprescindible otorgado
-- ───────────────────────────────────────────────────────────────────────────
-- EXECUTE a PUBLIC es el DEFAULT de PostgreSQL en cada CREATE FUNCTION: hay que
-- revocarlo explícitamente en cada (re)creación o se repone solo.
REVOKE ALL ON FUNCTION public.create_business_invitation(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_business_invitation(text)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_business_invitation(uuid)       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_business_invitation(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_business_invitation(text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_business_invitation(uuid)       TO authenticated;

-- `anon` NO recibe nada: las tres exigen auth.uid().

-- ───────────────────────────────────────────────────────────────────────────
-- 7. POSTCONDICIONES
-- ───────────────────────────────────────────────────────────────────────────
-- Corren DENTRO de la misma transacción, así que un fallo revierte la migración
-- entera en vez de dejar el esquema a medias.
DO $post$
DECLARE
  v_def text;
  v_n   int;
BEGIN
  -- P1. Las tres RPC canónicas existen con la firma esperada.
  IF to_regprocedure('public.create_business_invitation(text,text)') IS NULL
     OR to_regprocedure('public.accept_business_invitation(text)') IS NULL
     OR to_regprocedure('public.cancel_business_invitation(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P1: falta alguna RPC de invitaciones';
  END IF;

  -- P1b. La API legacy quedó retirada: UNA sola forma de crear invitaciones.
  IF to_regprocedure('public.create_business_invitation(text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCOND P1b: sigue viva la firma legacy de 3 argumentos';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_business_invitation';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSTCOND P1c: hay % overloads de create_business_invitation, se esperaba 1', v_n;
  END IF;

  -- P2. accept devuelve jsonb (el contrato nuevo, no el uuid viejo).
  IF pg_get_function_result(to_regprocedure('public.accept_business_invitation(text)')) <> 'jsonb' THEN
    RAISE EXCEPTION 'POSTCOND P2: accept_business_invitation no devuelve jsonb';
  END IF;

  -- P3 + P12. Chequeos sobre el CÓDIGO de las tres RPC.
  --
  --   P3  — EL P0: nadie puede llamar a gen_random_bytes sin calificar el
  --         schema. Es la regresión exacta que cierra este lote.
  --   P12 — INVARIANTE CENTRAL: ninguna RPC de invitaciones inserta en
  --         `businesses`. Aceptar una invitación nunca crea un negocio.
  --
  -- Se le sacan los comentarios de línea ANTES de buscar. Sin eso el chequeo se
  -- dispara con su propia documentación: este archivo cita el mensaje de error
  -- productivo ("function gen_random_bytes(integer) does not exist") dentro de un
  -- comentario, y un match sobre el texto crudo lo cuenta como si fuera una
  -- llamada real. Ya pasó al validar esta migración contra el stack local.
  FOR v_def IN
    SELECT regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('create_business_invitation', 'accept_business_invitation',
                         'cancel_business_invitation')
  LOOP
    IF v_def ~* '(^|[^.[:alnum:]_])gen_random_bytes[[:space:]]*\(' THEN
      RAISE EXCEPTION 'POSTCOND P3: gen_random_bytes sin calificar (pgcrypto vive en extensions)';
    END IF;
    IF v_def ~* 'insert[[:space:]]+into[[:space:]]+(public\.)?businesses' THEN
      RAISE EXCEPTION 'POSTCOND P12: una RPC de invitaciones crea businesses';
    END IF;
  END LOOP;

  -- P4. `extensions.gen_random_bytes(integer)` sigue existiendo y es ejecutable
  --     por el owner de las SECURITY DEFINER. Si alguien moviera pgcrypto de
  --     schema, esto grita acá en vez de en la cara del usuario.
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P4: extensions.gen_random_bytes(integer) no existe';
  END IF;

  -- P5. search_path endurecido y con pg_temp AL FINAL en las cuatro.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_business_invitation', 'accept_business_invitation',
                       'cancel_business_invitation')
     AND (p.proconfig IS NULL
          OR NOT (p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P5: % RPC sin el search_path endurecido esperado', v_n;
  END IF;

  -- P6. Las cuatro son SECURITY DEFINER.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('create_business_invitation', 'accept_business_invitation',
                       'cancel_business_invitation')
     AND p.prosecdef = false;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P6: % RPC no son SECURITY DEFINER', v_n;
  END IF;

  -- P7. PUBLIC y anon sin EXECUTE; authenticated con EXECUTE.
  --     `has_function_privilege` y no aclexplode: sobre una ACL nula aclexplode
  --     devuelve 0 filas y da un falso negativo (gotcha del lote P0 mayorista).
  IF has_function_privilege('public',    'public.accept_business_invitation(text)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.accept_business_invitation(text)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.create_business_invitation(text,text)', 'EXECUTE')
     OR has_function_privilege('anon',   'public.cancel_business_invitation(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND P7: PUBLIC/anon conservan EXECUTE sobre una RPC de invitaciones';
  END IF;

  IF NOT (has_function_privilege('authenticated', 'public.accept_business_invitation(text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.create_business_invitation(text,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.cancel_business_invitation(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTCOND P7b: authenticated perdió EXECUTE sobre una RPC de invitaciones';
  END IF;

  -- P8. El índice único parcial existe.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'business_invitations'
       AND indexname  = 'business_invitations_one_pending_per_email'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P8: falta el índice único parcial de pending';
  END IF;

  -- P9. El CHECK de status sigue siendo el contrato de 4 estados. Si alguien lo
  --     ampliara para acomodar el 'revoked' roto del frontend, esto lo frena.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.business_invitations'::regclass
       AND conname  = 'business_invitations_status_check'
       AND pg_get_constraintdef(oid) LIKE '%pending%'
       AND pg_get_constraintdef(oid) LIKE '%accepted%'
       AND pg_get_constraintdef(oid) LIKE '%cancelled%'
       AND pg_get_constraintdef(oid) LIKE '%expired%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND P9: cambió el CHECK de status de business_invitations';
  END IF;

  -- P10. Los grants estructurales siguen cerrados: `authenticated` y `anon` NO
  --      pueden escribir directo sobre profiles/businesses/business_invitations.
  --      Toda escritura sensible pasa por las RPC. (P0-P1 dejó esto así; acá se
  --      verifica que este lote no lo haya repuesto.)
  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('profiles', 'businesses', 'business_invitations')
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'DELETE', 'TRUNCATE');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POSTCOND P10: se repusieron % grants de DML estructural sobre profiles/businesses/business_invitations', v_n;
  END IF;

  -- P11. provision_my_business intacta y con su defensa INVITATION_PENDING.
  --      P0-P2 completa ese camino; no puede romperlo.
  IF to_regprocedure('public.provision_my_business(text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCOND P11: desapareció provision_my_business';
  END IF;
  IF pg_get_functiondef(to_regprocedure('public.provision_my_business(text)')) NOT LIKE '%INVITATION_PENDING%' THEN
    RAISE EXCEPTION 'POSTCOND P11b: provision_my_business perdió la defensa INVITATION_PENDING';
  END IF;

  RAISE NOTICE 'P0-P2: postcondiciones OK';
END;
$post$;

COMMIT;
