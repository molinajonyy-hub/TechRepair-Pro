-- ============================================================================
-- P0 final pre-M8 — contrato canonico de `public.notifications`
--
-- Cierra el drift de esquema que tenia la feature de notificaciones ROTA DE
-- PUNTA A PUNTA, endurece su RLS/grants y la publica en Realtime.
--
-- ── CAUSA (medida contra produccion, no inferida) ───────────────────────────
-- La tabla real (baseline 20260628190324) tiene 9 columnas:
--   id, user_id, type, title, message, is_read, created_at, created_by,
--   business_id
-- pero el frontend escribia ademas `order_id`, `customer_id` y `metadata`, que
-- vienen de supabase/_archive/loose-scripts/notifications.sql — un script que
-- NUNCA se aplico. PostgREST respondia 400 PGRST204 ("Could not find the column
-- ... in the schema cache") y se perdia el INSERT ENTERO. Ademas StatusChange
-- omitia `business_id`, que es NOT NULL y ademas lo exige la policy
-- notifications_insert. Y supabase-js NO lanza excepcion en errores de
-- PostgREST: devuelve { error }, asi que el try/catch que envolvia el insert no
-- atrapaba nada. Evidencia definitiva: `select count(*) from notifications` en
-- produccion devuelve 0 — la feature nunca escribio una sola fila.
--
-- ── DECISION DE ESQUEMA (caso C: el codigo estaba mitad adelantado, mitad
--    muerto) ────────────────────────────────────────────────────────────────
--   order_id     -> SE AGREGA.  Consumidor real: NotificationsDropdown.tsx:258
--                                renderiza un deep-link <Link to={/orders/id}>.
--   metadata     -> SE AGREGA.  Consumidor real: NotificationsDropdown.tsx:232
--                                renderiza el badge de `metadata.to_status`.
--   customer_id  -> NO se agrega. Se escribia y NO lo lee NADIE en toda la app.
--   read_at      -> NO se agrega. Se escribia y NO lo lee NADIE; `is_read` (que
--                                 ya existe) es lo unico que consume la UI.
-- Las dos ultimas se retiran del frontend en lugar de agregarse al esquema.
--
-- ── SEGURIDAD ──────────────────────────────────────────────────────────────
-- El baseline dejo dos agujeros latentes que esta migracion cierra:
--   [1] `GRANT ALL ON TABLE notifications TO anon` — anon tiene hoy SELECT,
--       INSERT, UPDATE, DELETE y TRUNCATE sobre la tabla.
--   [2] `notifications_select` se creo SIN clausula TO, o sea polroles='{0}' =
--       PUBLIC, anon incluido.
-- Hoy no hay fuga ACTIVA porque current_user_business_id() devuelve NULL para
-- anon (auth.uid() es NULL) y `business_id = NULL` no matchea ninguna fila. Pero
-- es exactamente la misma forma del P0 de `businesses` (20260804130000), y
-- publicar la tabla en Realtime la pondria a evaluar RLS por evento para
-- suscriptores anon. Se cierran las dos capas antes de publicar.
-- TRUNCATE ademas BYPASSEA RLS: se le quita tambien a `authenticated`, que no lo
-- necesita (PostgREST no lo expone) y con el podria vaciar la tabla de TODOS los
-- negocios.
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
-- Toca UNICAMENTE public.notifications. No toca businesses (lockdown 213
-- intacto), ni la allowlist SECDEF (212), ni finance_health_check_v2, ni P0-A/
-- P0-B. No hace backfill ni ningun DML sobre datos historicos. Idempotente.
-- ============================================================================

-- BEGIN/COMMIT EXPLICITOS: el CLI aplica cada archivo en AUTOCOMMIT. Sin este
-- bloque los `SET LOCAL` emiten "SET LOCAL can only be used in transaction
-- blocks" y no tienen efecto, y una postcondicion fallida dejaria la tabla a
-- medio migrar (columnas nuevas + grants viejos) en vez de abortar limpio.
BEGIN;

-- ALTER TABLE toma ACCESS EXCLUSIVE. La tabla tiene 0 filas en prod, asi que el
-- ADD COLUMN es instantaneo; 3s cubre de sobra y evita encolar la app detras de
-- una transaccion larga ajena.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';


-- ============================================================================
-- 0. BASELINE — para poder exigir "este lote solo agrega notifications"
-- ============================================================================
-- Temp de SESION (no ON COMMIT DROP), igual que 20260804120000/130000: asi
-- sobrevive tanto al CLI como a un `psql -f` manual.
DROP TABLE IF EXISTS _notif_pub_baseline;
CREATE TEMP TABLE _notif_pub_baseline AS
SELECT schemaname, tablename
FROM pg_catalog.pg_publication_tables
WHERE pubname = 'supabase_realtime';


-- ============================================================================
-- 1. PRECONDICIONES
-- ============================================================================
DO $precond$
DECLARE
  v_max_applied text;
  v_cols        text[];
BEGIN
  ---------------------------------------------------------------------------
  -- [1] La tabla existe y conserva las columnas del contrato base.
  ---------------------------------------------------------------------------
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 1: no existe public.notifications';
  END IF;

  SELECT array_agg(a.attname ORDER BY a.attname) INTO v_cols
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.notifications'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped;

  IF NOT (v_cols @> ARRAY['id','business_id','type','title','message','is_read','created_at']::text[]) THEN
    RAISE EXCEPTION
      'PRECONDICION 1: public.notifications no tiene el contrato base esperado: %', v_cols;
  END IF;

  ---------------------------------------------------------------------------
  -- [2] `business_id` sigue siendo NOT NULL. Todo el modelo de aislamiento por
  --     negocio (RLS, filtro de Realtime, guard de order_id) descansa en eso.
  ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.notifications'::regclass
      AND attname = 'business_id' AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'PRECONDICION 2: notifications.business_id dejo de ser NOT NULL';
  END IF;

  ---------------------------------------------------------------------------
  -- [3] RLS activo. Sin esto los grants de `authenticated` verian TODA la tabla
  --     cross-tenant, y publicar en Realtime lo convertiria en push.
  ---------------------------------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'public.notifications'::regclass) THEN
    RAISE EXCEPTION 'PRECONDICION 3: RLS deshabilitado sobre notifications';
  END IF;

  ---------------------------------------------------------------------------
  -- [4] `public.orders` existe con (id, business_id): es el destino de la FK
  --     nueva y la base del guard cross-tenant.
  ---------------------------------------------------------------------------
  IF to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICION 4: no existe public.orders (destino de order_id)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.orders'::regclass AND attname = 'business_id' AND attnum > 0
  ) THEN
    RAISE EXCEPTION 'PRECONDICION 4: public.orders no tiene business_id';
  END IF;

  ---------------------------------------------------------------------------
  -- [5] La publicacion de Realtime existe y NO es FOR ALL TABLES. Si fuera
  --     `puballtables`, agregar una tabla seria imposible y ademas significaria
  --     que TODO esta publicado (incluidas businesses y payments).
  ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'PRECONDICION 5: no existe la publicacion supabase_realtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication
             WHERE pubname = 'supabase_realtime' AND puballtables) THEN
    RAISE EXCEPTION
      'PRECONDICION 5: supabase_realtime es FOR ALL TABLES — publica todo, incluidas businesses/payments';
  END IF;

  ---------------------------------------------------------------------------
  -- [6] Sin migracion posterior ya aplicada (aplicacion fuera de orden).
  ---------------------------------------------------------------------------
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT max(version) FROM supabase_migrations.schema_migrations'
      INTO v_max_applied;
    IF v_max_applied IS NOT NULL AND v_max_applied > '20260805120000' THEN
      RAISE EXCEPTION
        'PRECONDICION 6: ya hay una migracion posterior aplicada (%). Esta iria fuera de orden.',
        v_max_applied;
    END IF;
  END IF;

  RAISE NOTICE 'PRECONDICIONES OK.';
END
$precond$;


-- ============================================================================
-- 2. ESQUEMA — las dos columnas CON consumidor
-- ============================================================================

-- ── 2.a order_id ────────────────────────────────────────────────────────────
-- ON DELETE SET NULL y no CASCADE: borrar una orden no debe borrar el historial
-- de notificaciones, solo dejarlas sin deep-link. La columna es NULLABLE porque
-- no toda notificacion refiere a una orden (p. ej. `payment_received`).
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS order_id uuid;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.notifications'::regclass
      AND conname  = 'notifications_order_id_fkey'
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_order_id_fkey
      FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;
  END IF;
END
$fk$;

-- ── 2.b metadata ────────────────────────────────────────────────────────────
-- Payload chico y NO sensible: hoy solo lleva {from_status, to_status,
-- changed_by}. El CHECK acota estructura y tamano para que no se vuelva un
-- deposito de datos personales ni infle el WAL de Realtime.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.notifications'::regclass
      AND conname  = 'notifications_metadata_shape'
  ) THEN
    ALTER TABLE public.notifications
      ADD CONSTRAINT notifications_metadata_shape
      CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 2048);
  END IF;
END
$chk$;

-- ── 2.c business_id derivado server-side ────────────────────────────────────
-- §8: ningun insert puede omitirlo y no se confia UNICAMENTE en lo que manda
-- React. Quedan las dos barreras:
--   · DEFAULT  -> si el cliente lo omite, lo deriva el servidor.
--   · WITH CHECK de notifications_insert -> si el cliente lo manda, tiene que
--     coincidir con current_business_id(). Mandar el de otro negocio da 42501.
-- Se usa current_business_id() —y no current_user_business_id()— a proposito:
-- es la MISMA funcion del WITH CHECK, asi que el default nunca puede producir
-- una fila que la propia policy rechace.
-- Un insert de service_role que omita la columna obtiene NULL (auth.uid() es
-- NULL) y falla ruidosamente contra el NOT NULL, que es lo correcto.
ALTER TABLE public.notifications
  ALTER COLUMN business_id SET DEFAULT public.current_business_id();

-- ── 2.d Indice de la consulta real ──────────────────────────────────────────
-- useNotifications: WHERE business_id = ? ORDER BY created_at DESC LIMIT 50.
CREATE INDEX IF NOT EXISTS idx_notifications_business_created
  ON public.notifications (business_id, created_at DESC);


-- ============================================================================
-- 3. GUARD CROSS-TENANT DE order_id
-- ============================================================================
-- Una FK garantiza que la orden EXISTE, no que sea del MISMO negocio. Sin este
-- trigger, un miembro del negocio A podria crear una notificacion propia
-- apuntando a una orden del negocio B y el deep-link filtraria el UUID ajeno.
-- SECURITY DEFINER porque tiene que ver la fila de `orders` aunque la RLS del
-- invocante se la oculte: si no, una orden ajena daria "no existe" (correcto por
-- accidente) pero una orden propia oculta por RLS daria un falso rechazo.
CREATE OR REPLACE FUNCTION public.notifications_guard_order_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
-- pg_temp AL FINAL y explicito: omitirlo lo pone PRIMERO en el search_path
-- efectivo y habilita el shadowing de objetos via pg_temp.
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = NEW.order_id
        AND o.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION
        'notifications.order_id no pertenece al negocio de la notificacion'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

-- EXECUTE a PUBLIC es el DEFAULT de PostgreSQL: la funcion nace abierta. Un
-- trigger no necesita el privilegio para dispararse, asi que revocarlo no le
-- quita nada y la saca de la superficie ejecutable.
REVOKE ALL ON FUNCTION public.notifications_guard_order_tenant() FROM PUBLIC;

DROP TRIGGER IF EXISTS trig_notifications_guard_order_tenant ON public.notifications;
CREATE TRIGGER trig_notifications_guard_order_tenant
  BEFORE INSERT OR UPDATE OF order_id, business_id ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_guard_order_tenant();


-- ============================================================================
-- 4. RLS — cerrar la lectura PUBLIC
-- ============================================================================
-- `notifications_select` se creo sin clausula TO (polroles = '{0}' = PUBLIC).
-- Se recrea identica pero TO authenticated. La expresion NO cambia: sigue siendo
-- business_id = current_user_business_id(), que es el scope de membresia.
DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT TO authenticated
  USING (business_id = public.current_user_business_id());

-- insert/update/delete ya son TO authenticated con guard de negocio + rol
-- (is_staff / can_manage) desde el baseline: no se tocan.


-- ============================================================================
-- 5. GRANTS — anon a cero, authenticated a lo minimo
-- ============================================================================
-- `FROM PUBLIC` ademas de `FROM anon`: mientras exista el grant a PUBLIC,
-- revocarle a anon no cierra nada porque lo hereda igual.
REVOKE ALL ON TABLE public.notifications FROM anon;
REVOKE ALL ON TABLE public.notifications FROM PUBLIC;

-- TRUNCATE bypassea RLS: con el, cualquier sesion `authenticated` podria vaciar
-- las notificaciones de TODOS los negocios. REFERENCES y TRIGGER tampoco los
-- necesita un cliente PostgREST.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.notifications FROM authenticated;

-- Lo que la app SI necesita (y que RLS acota fila por fila).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO authenticated;


-- ============================================================================
-- 6. REALTIME — publicar SOLO notifications
-- ============================================================================
-- Criterio (§11) satisfecho: hay consumidor real (NotificationsDropdown via
-- useNotifications), el UX se beneficia del push, la RLS quedo probada arriba,
-- el payload es chico y acotado por el CHECK de metadata, los inserts ahora
-- funcionan y el lifecycle del canal esta corregido en src/lib/realtimeChannel.ts.
--
-- REPLICA IDENTITY: se deja en DEFAULT (la PK) A PROPOSITO. El unico binding de
-- la app es INSERT, y para INSERT el WAL lleva la tupla NEW completa sin
-- importar la replica identity — FULL solo agrega la tupla OLD de UPDATE/DELETE,
-- que ningun consumidor usa. Ponerla en FULL duplicaria el WAL de cada cambio y
-- empujaria el `old_record` completo a los suscriptores sin ninguna necesidad
-- funcional.
DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
    RAISE NOTICE 'notifications agregada a supabase_realtime';
  ELSE
    RAISE NOTICE 'notifications ya estaba en supabase_realtime (idempotente)';
  END IF;
END
$pub$;


-- ============================================================================
-- 7. POSTCONDICIONES
-- ============================================================================
DO $post$
DECLARE
  v_bad   text;
  v_priv  text;
  v_cnt   int;
BEGIN
  ---------------------------------------------------------------------------
  -- E1/E2. Esquema: las dos columnas con su forma esperada.
  ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.notifications'::regclass
      AND attname = 'order_id' AND atttypid = 'uuid'::regtype AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION E1: order_id no quedo como uuid NULLABLE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.notifications'::regclass
      AND attname = 'metadata' AND atttypid = 'jsonb'::regtype AND attnotnull
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION E2: metadata no quedo como jsonb NOT NULL';
  END IF;

  -- Las columnas SIN consumidor no se agregaron: el contrato es minimo.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.notifications'::regclass
      AND attname IN ('customer_id','read_at') AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'POSTCONDICION E3: aparecieron customer_id/read_at — no tienen consumidor y quedan fuera del contrato';
  END IF;

  -- El guard cross-tenant esta armado.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.notifications'::regclass
      AND tgname  = 'trig_notifications_guard_order_tenant'
      AND NOT tgisinternal
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION E4: falta (o esta deshabilitado) el guard cross-tenant de order_id';
  END IF;

  ---------------------------------------------------------------------------
  -- G1. `anon` y PUBLIC a CERO en las cinco formas de acceso.
  --     has_table_privilege resuelve tambien la herencia de roles.
  ---------------------------------------------------------------------------
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION 'POSTCONDICION G1: `anon` conserva % sobre notifications', v_priv;
    END IF;
    IF has_table_privilege('public', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION 'POSTCONDICION G1: PUBLIC conserva % sobre notifications', v_priv;
    END IF;
  END LOOP;

  -- Ni por columna: un GRANT SELECT(col) sobrevive al REVOKE de tabla.
  SELECT count(*) INTO v_cnt
  FROM pg_catalog.pg_attribute a, aclexplode(a.attacl) x
  WHERE a.attrelid = 'public.notifications'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    AND (x.grantee = 0 OR x.grantee = 'anon'::regrole::oid);
  IF v_cnt > 0 THEN
    RAISE EXCEPTION 'POSTCONDICION G2: quedan % ACL de columna para anon/PUBLIC', v_cnt;
  END IF;

  ---------------------------------------------------------------------------
  -- G3. `authenticated` conserva el DML que la app necesita y perdio TRUNCATE.
  ---------------------------------------------------------------------------
  FOREACH v_priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.notifications', v_priv) THEN
      RAISE EXCEPTION 'POSTCONDICION G3: `authenticated` perdio % (rompe la app)', v_priv;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.notifications', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDICION G4: `authenticated` conserva TRUNCATE (bypassea RLS)';
  END IF;

  ---------------------------------------------------------------------------
  -- P1. Ninguna policy PERMISIVA alcanzable por PUBLIC o por anon.
  --     Se mira polroles por OID 0 (asi almacena PG a PUBLIC) y ademas
  --     pg_has_role, que cubre el caso indirecto de una policy `TO algun_rol`
  --     donde anon sea miembro. polpermissive: una RESTRICTIVE no concede.
  ---------------------------------------------------------------------------
  SELECT string_agg(format('%s(cmd=%s)', p.polname, p.polcmd), ', ' ORDER BY p.polname)
    INTO v_bad
  FROM pg_catalog.pg_policy p
  WHERE p.polrelid = 'public.notifications'::regclass
    AND p.polpermissive
    AND (
      0 = ANY (p.polroles)
      OR EXISTS (
        SELECT 1 FROM unnest(p.polroles) AS pr(oid)
        WHERE pg_has_role('anon', pr.oid, 'USAGE')
      )
    );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDICION P1: quedan policies alcanzables por PUBLIC/anon sobre notifications: %', v_bad;
  END IF;

  -- P2. La policy de lectura sigue existiendo, TO authenticated y con scope.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = 'public.notifications'::regclass
      AND p.polname  = 'notifications_select'
      AND p.polcmd   = 'r'
      AND p.polpermissive
      AND p.polroles = ARRAY['authenticated'::regrole::oid]
      AND pg_get_expr(p.polqual, p.polrelid) ILIKE '%current_user_business_id%'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION P2: `notifications_select` no quedo TO authenticated con scope de negocio';
  END IF;

  -- P3. RLS sigue activo.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'public.notifications'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICION P3: RLS quedo deshabilitado sobre notifications';
  END IF;

  ---------------------------------------------------------------------------
  -- R1. La publicacion contiene EXACTAMENTE lo que tenia + notifications.
  --     No se exige que quede una sola tabla para siempre; se exige que ESTE
  --     lote no haya agregado ninguna otra.
  ---------------------------------------------------------------------------
  SELECT string_agg(format('%s.%s', n.schemaname, n.tablename), ', ' ORDER BY n.tablename)
    INTO v_bad
  FROM pg_catalog.pg_publication_tables n
  LEFT JOIN _notif_pub_baseline b
    ON b.schemaname = n.schemaname AND b.tablename = n.tablename
  WHERE n.pubname = 'supabase_realtime'
    AND b.tablename IS NULL
    AND NOT (n.schemaname = 'public' AND n.tablename = 'notifications');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'POSTCONDICION R1: este lote publico tablas ademas de notifications: %', v_bad;
  END IF;

  -- R2. notifications SI quedo publicada.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    RAISE EXCEPTION 'POSTCONDICION R2: notifications no quedo en supabase_realtime';
  END IF;

  -- R3. Las tablas explicitamente vetadas NO estan publicadas.
  SELECT string_agg(tablename, ', ' ORDER BY tablename) INTO v_bad
  FROM pg_catalog.pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename IN ('businesses','payments','comprobante_payments','financial_movements');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICION R3: hay tablas vetadas publicadas en supabase_realtime: %', v_bad;
  END IF;

  -- R4. REPLICA IDENTITY sigue en DEFAULT: FULL exige justificacion funcional
  --     y no la hay (ver seccion 6).
  IF (SELECT relreplident FROM pg_catalog.pg_class
      WHERE oid = 'public.notifications'::regclass) <> 'd' THEN
    RAISE EXCEPTION
      'POSTCONDICION R4: notifications no quedo en REPLICA IDENTITY DEFAULT';
  END IF;

  RAISE NOTICE 'POSTCONDICIONES OK — contrato cerrado, anon a cero, solo notifications publicada.';
END
$post$;

DROP TABLE IF EXISTS _notif_pub_baseline;

COMMIT;

-- Fuera de la transaccion: un NOTIFY no debe viajar en un rollback. Ademas es
-- IMPRESCINDIBLE aca — PostgREST cachea el esquema, y sin recargarlo las
-- columnas nuevas siguen dando 400 PGRST204 exactamente igual que antes.
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- RECUPERACION — FORWARD-ONLY
-- ============================================================================
-- No hay rollback. Devolverle privilegios a `anon` o recrear
-- `notifications_select` sin clausula TO reabre la superficie que este archivo
-- cierra, asi que ninguna de las dos cosas es un procedimiento valido de
-- recuperacion.
--
-- Si hubiera que despublicar la tabla de Realtime (p. ej. por costo de WAL), el
-- camino es una migracion NUEVA con
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.notifications;
-- La app degrada sola: useNotifications ya carga por HTTP y solo pierde el push.
--
-- ── FUERA DE ALCANCE (deliberado) ───────────────────────────────────────────
--   · Ningun backfill. Las filas historicas (0 en prod) quedan con order_id NULL
--     y metadata '{}'; no se infiere la orden ni el cliente desde el texto.
--   · No se agrega businesses ni payments a la publicacion.
--   · No se toca el lockdown de businesses (20260804130000) ni la allowlist
--     SECDEF (20260804120000).
-- ============================================================================
