-- =========================================================
-- AUTH PROFILE TIMEOUT PATCH
-- Ejecutar en Supabase SQL Editor si aparece:
-- "Tiempo agotado al cargar el perfil del negocio"
-- =========================================================

CREATE INDEX IF NOT EXISTS profiles_email_lower_idx
  ON public.profiles(lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_user_id_lookup_idx
  ON public.profiles(user_id)
  WHERE user_id IS NOT NULL;

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

GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;
