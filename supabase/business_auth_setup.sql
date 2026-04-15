CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS user_id UUID,
  ADD COLUMN IF NOT EXISTS business_id UUID,
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.profiles
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

DO $$
DECLARE
  v_constraint RECORD;
BEGIN
  FOR v_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END $$;

UPDATE public.profiles p
SET user_id = u.id
FROM auth.users u
WHERE p.user_id IS NULL
  AND p.email IS NOT NULL
  AND lower(trim(p.email)) = lower(u.email);

UPDATE public.profiles
SET user_id = id
WHERE user_id IS NULL
  AND id IS NOT NULL;

UPDATE public.profiles
SET role = CASE lower(coalesce(trim(role), ''))
    WHEN 'owner' THEN 'owner'
    WHEN 'admin' THEN 'admin'
    WHEN 'manager' THEN 'manager'
    WHEN 'tech' THEN 'tech'
    WHEN 'technician' THEN 'tech'
    WHEN 'sales' THEN 'sales'
    WHEN 'cashier' THEN 'cashier'
    WHEN 'receptionist' THEN 'sales'
    WHEN 'viewer' THEN 'viewer'
    ELSE 'viewer'
  END,
  is_active = COALESCE(is_active, TRUE),
  created_at = COALESCE(created_at, NOW()),
  updated_at = COALESCE(updated_at, NOW());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'profiles'
      AND c.conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.business_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier', 'viewer')),
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT 'ARS',
  ADD COLUMN IF NOT EXISTS base_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS cost_price_usd NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exchange_rate_used NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS auto_update_price BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_base_currency_check'
  ) THEN
    ALTER TABLE public.inventory
      ADD CONSTRAINT inventory_base_currency_check
      CHECK (base_currency IN ('USD', 'ARS'));
  END IF;
END
$$;

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_id_unique_idx
  ON public.profiles(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS business_invitations_token_unique_idx
  ON public.business_invitations(token);

CREATE INDEX IF NOT EXISTS profiles_business_id_idx
  ON public.profiles(business_id);

CREATE INDEX IF NOT EXISTS profiles_email_lower_idx
  ON public.profiles(lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_invitations_business_id_idx
  ON public.business_invitations(business_id);

CREATE INDEX IF NOT EXISTS suppliers_business_id_idx
  ON public.suppliers(business_id);

CREATE INDEX IF NOT EXISTS purchases_business_id_idx
  ON public.purchases(business_id);

CREATE INDEX IF NOT EXISTS inventory_business_id_idx
  ON public.inventory(business_id);

CREATE INDEX IF NOT EXISTS inventory_movements_business_id_idx
  ON public.inventory_movements(business_id);

DROP TRIGGER IF EXISTS update_businesses_updated_at ON public.businesses;
CREATE TRIGGER update_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_profiles_updated_at ON public.profiles;
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP VIEW IF EXISTS public.business_users_view;

CREATE VIEW public.business_users_view AS
SELECT
  p.id,
  COALESCE(p.user_id, p.id) AS user_id,
  p.business_id,
  p.role,
  p.is_active,
  p.full_name,
  p.email,
  p.phone,
  p.created_at,
  p.updated_at
FROM public.profiles p;

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_invitations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_user_business_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT p.business_id
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = auth.uid()
    AND COALESCE(p.is_active, TRUE) = TRUE
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = auth.uid()
    AND COALESCE(p.is_active, TRUE) = TRUE
  ORDER BY
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1
$$;

DROP POLICY IF EXISTS businesses_select ON public.businesses;
CREATE POLICY businesses_select
  ON public.businesses
  FOR SELECT
  TO authenticated
  USING (
    id = public.current_user_business_id()
  );

DROP POLICY IF EXISTS businesses_insert ON public.businesses;
CREATE POLICY businesses_insert
  ON public.businesses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid()
  );

DROP POLICY IF EXISTS businesses_update ON public.businesses;
CREATE POLICY businesses_update
  ON public.businesses
  FOR UPDATE
  TO authenticated
  USING (
    id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  )
  WITH CHECK (
    id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    COALESCE(user_id, id) = auth.uid()
    OR business_id = public.current_user_business_id()
  );

DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (
    COALESCE(user_id, id) = auth.uid()
    OR (
      business_id = public.current_user_business_id()
      AND public.current_user_role() IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    COALESCE(user_id, id) = auth.uid()
    OR (
      business_id = public.current_user_business_id()
      AND public.current_user_role() IN ('owner', 'admin')
    )
  );

DROP FUNCTION IF EXISTS public.get_my_profile();

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  business_id UUID,
  role TEXT,
  is_active BOOLEAN,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_user_id UUID;
  v_auth_email TEXT;
BEGIN
  v_auth_user_id := auth.uid();

  IF v_auth_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.user_id, p.id) AS user_id,
    p.business_id,
    p.role,
    COALESCE(p.is_active, TRUE) AS is_active,
    p.full_name,
    p.email,
    p.phone,
    COALESCE(p.created_at, NOW()) AS created_at,
    COALESCE(p.updated_at, NOW()) AS updated_at
  FROM public.profiles p
  WHERE p.user_id = v_auth_user_id
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.user_id, p.id) AS user_id,
    p.business_id,
    p.role,
    COALESCE(p.is_active, TRUE) AS is_active,
    p.full_name,
    p.email,
    p.phone,
    COALESCE(p.created_at, NOW()) AS created_at,
    COALESCE(p.updated_at, NOW()) AS updated_at
  FROM public.profiles p
  WHERE p.id = v_auth_user_id
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  SELECT lower(u.email)
  INTO v_auth_email
  FROM auth.users u
  WHERE u.id = v_auth_user_id;

  IF v_auth_email IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(p.user_id, p.id) AS user_id,
    p.business_id,
    p.role,
    COALESCE(p.is_active, TRUE) AS is_active,
    p.full_name,
    p.email,
    p.phone,
    COALESCE(p.created_at, NOW()) AS created_at,
    COALESCE(p.updated_at, NOW()) AS updated_at
  FROM public.profiles p
  WHERE lower(p.email) = v_auth_email
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.current_user_business_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

DROP POLICY IF EXISTS business_invitations_select ON public.business_invitations;
CREATE POLICY business_invitations_select
  ON public.business_invitations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE COALESCE(p.user_id, p.id) = auth.uid()
        AND p.business_id = business_invitations.business_id
        AND p.is_active = TRUE
        AND p.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS business_invitations_insert ON public.business_invitations;
CREATE POLICY business_invitations_insert
  ON public.business_invitations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE COALESCE(p.user_id, p.id) = auth.uid()
        AND p.business_id = business_invitations.business_id
        AND p.is_active = TRUE
        AND p.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS business_invitations_update ON public.business_invitations;
CREATE POLICY business_invitations_update
  ON public.business_invitations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE COALESCE(p.user_id, p.id) = auth.uid()
        AND p.business_id = business_invitations.business_id
        AND p.is_active = TRUE
        AND p.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE COALESCE(p.user_id, p.id) = auth.uid()
        AND p.business_id = business_invitations.business_id
        AND p.is_active = TRUE
        AND p.role IN ('owner', 'admin')
    )
  );

DROP FUNCTION IF EXISTS public.create_business_invitation(TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.create_business_invitation(
  p_email TEXT,
  p_role TEXT,
  p_business_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF lower(trim(p_role)) = 'owner' THEN
    RAISE EXCEPTION 'No se pueden enviar invitaciones con rol owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE COALESCE(p.user_id, p.id) = auth.uid()
      AND p.business_id = p_business_id
      AND p.is_active = TRUE
      AND p.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'No tenés permisos para invitar usuarios a este negocio';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO public.business_invitations (
    business_id,
    email,
    role,
    token,
    invited_by
  )
  VALUES (
    p_business_id,
    lower(trim(p_email)),
    lower(trim(p_role)),
    v_token,
    auth.uid()
  );

  RETURN v_token;
END;
$$;

DROP FUNCTION IF EXISTS public.accept_business_invitation(TEXT);

CREATE OR REPLACE FUNCTION public.accept_business_invitation(
  p_token TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invitation public.business_invitations%ROWTYPE;
  v_user_id UUID;
  v_email TEXT;
  v_full_name TEXT;
  v_profile_id UUID;
BEGIN
  v_user_id := auth.uid();

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Tenés que iniciar sesión antes de aceptar la invitación';
  END IF;

  SELECT *
  INTO v_invitation
  FROM public.business_invitations
  WHERE token = trim(p_token)
    AND status = 'pending'
    AND expires_at > NOW()
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_invitation.id IS NULL THEN
    RAISE EXCEPTION 'Invitación inválida o expirada';
  END IF;

  SELECT
    lower(u.email),
    COALESCE(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
  INTO v_email, v_full_name
  FROM auth.users u
  WHERE u.id = v_user_id;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE COALESCE(user_id, id) = v_user_id) THEN
    UPDATE public.profiles
    SET business_id = v_invitation.business_id,
        user_id = COALESCE(user_id, v_user_id),
        role = v_invitation.role,
        is_active = TRUE,
        email = COALESCE(public.profiles.email, v_email),
        full_name = COALESCE(public.profiles.full_name, v_full_name),
        updated_at = NOW()
    WHERE COALESCE(user_id, id) = v_user_id
    RETURNING id INTO v_profile_id;
  ELSE
    INSERT INTO public.profiles (
      user_id,
      business_id,
      role,
      is_active,
      full_name,
      email
    )
    VALUES (
      v_user_id,
      v_invitation.business_id,
      v_invitation.role,
      TRUE,
      v_full_name,
      v_email
    )
    RETURNING id INTO v_profile_id;
  END IF;

  UPDATE public.business_invitations
  SET status = 'accepted',
      accepted_at = NOW()
  WHERE id = v_invitation.id;

  RETURN v_profile_id;
END;
$$;

DROP FUNCTION IF EXISTS public.change_user_role(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.change_user_role(
  p_profile_id UUID,
  p_new_role TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_current_role TEXT;
  v_target_user_id UUID;
BEGIN
  SELECT
    business_id,
    role,
    COALESCE(user_id, id)
  INTO v_business_id, v_current_role, v_target_user_id
  FROM public.profiles
  WHERE id = p_profile_id;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Perfil no encontrado';
  END IF;

  IF lower(trim(p_new_role)) = 'owner' THEN
    RAISE EXCEPTION 'El rol owner solo se asigna al crear el negocio';
  END IF;

  IF v_current_role = 'owner' THEN
    RAISE EXCEPTION 'No se puede cambiar el rol del owner';
  END IF;

  IF v_target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'No podes cambiar tu propio rol';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE COALESCE(p.user_id, p.id) = auth.uid()
      AND p.business_id = v_business_id
      AND p.is_active = TRUE
      AND p.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'No tenés permisos para cambiar roles';
  END IF;

  UPDATE public.profiles
  SET role = lower(trim(p_new_role)),
      updated_at = NOW()
  WHERE id = p_profile_id;
END;
$$;

DROP FUNCTION IF EXISTS public.set_user_active_status(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION public.set_user_active_status(
  p_profile_id UUID,
  p_is_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_current_role TEXT;
  v_target_user_id UUID;
BEGIN
  SELECT
    business_id,
    role,
    COALESCE(user_id, id)
  INTO v_business_id, v_current_role, v_target_user_id
  FROM public.profiles
  WHERE id = p_profile_id;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Perfil no encontrado';
  END IF;

  IF v_current_role = 'owner' THEN
    RAISE EXCEPTION 'No se puede desactivar al owner';
  END IF;

  IF v_target_user_id = auth.uid() AND p_is_active = FALSE THEN
    RAISE EXCEPTION 'No podes desactivarte a vos mismo';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE COALESCE(p.user_id, p.id) = auth.uid()
      AND p.business_id = v_business_id
      AND p.is_active = TRUE
      AND p.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'No tenés permisos para cambiar el estado del usuario';
  END IF;

  UPDATE public.profiles
  SET is_active = p_is_active,
      updated_at = NOW()
  WHERE id = p_profile_id;
END;
$$;

DROP FUNCTION IF EXISTS public.bootstrap_owner_profile(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.bootstrap_owner_profile(
  p_user_email TEXT,
  p_business_name TEXT,
  p_full_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_profile_id UUID;
  v_business_id UUID;
BEGIN
  SELECT id
  INTO v_user_id
  FROM auth.users u
  WHERE lower(u.email) = lower(trim(p_user_email))
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No existe un usuario autenticado con ese email: %', p_user_email;
  END IF;

  SELECT
    p.id,
    p.business_id
  INTO v_profile_id, v_business_id
  FROM public.profiles p
  WHERE COALESCE(p.user_id, p.id) = v_user_id
     OR lower(COALESCE(p.email, '')) = lower(trim(p_user_email))
  ORDER BY
    (p.business_id IS NOT NULL) DESC,
    COALESCE(p.updated_at, p.created_at, NOW()) DESC
  LIMIT 1;

  IF v_business_id IS NULL THEN
    INSERT INTO public.businesses (name, owner_user_id)
    VALUES (trim(p_business_name), v_user_id)
    RETURNING id INTO v_business_id;
  END IF;

  IF v_profile_id IS NULL THEN
    INSERT INTO public.profiles (
      user_id,
      business_id,
      role,
      is_active,
      full_name,
      email
    )
    VALUES (
      v_user_id,
      v_business_id,
      'owner',
      TRUE,
      NULLIF(trim(p_full_name), ''),
      lower(trim(p_user_email))
    );
  ELSE
    UPDATE public.profiles
    SET user_id = COALESCE(user_id, v_user_id),
        business_id = v_business_id,
        role = 'owner',
        is_active = TRUE,
        full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name),
        email = lower(trim(p_user_email)),
        updated_at = NOW()
    WHERE id = v_profile_id;
  END IF;

  DELETE FROM public.profiles
  WHERE id <> v_profile_id
    AND (
      COALESCE(user_id, id) = v_user_id
      OR lower(COALESCE(email, '')) = lower(trim(p_user_email))
    );

  UPDATE public.businesses
  SET owner_user_id = COALESCE(owner_user_id, v_user_id),
      updated_at = NOW()
  WHERE id = v_business_id;

  RETURN v_business_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_business_invitation(TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_business_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_user_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_active_status(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_owner_profile(TEXT, TEXT, TEXT) TO authenticated;
