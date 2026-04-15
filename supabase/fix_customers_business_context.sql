-- Fix customers schema and RLS for business-scoped access.
-- Safe to run multiple times.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'customers'
  ) THEN
    RAISE EXCEPTION 'La tabla public.customers no existe. Ejecuta primero el schema base.';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'business_id'
  ) THEN
    ALTER TABLE public.customers
      ADD COLUMN business_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.customers
      ADD COLUMN created_by UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'notes'
  ) THEN
    ALTER TABLE public.customers
      ADD COLUMN notes TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE public.customers
      ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'businesses'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_business_id_fkey'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_business_id_fkey
      FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.customers'::regclass
      AND conname = 'customers_created_by_fkey'
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN
    NULL;
END
$$;

UPDATE public.customers
SET updated_at = COALESCE(updated_at, created_at, NOW())
WHERE updated_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'business_id'
  ) THEN
    EXECUTE $sql$
      UPDATE public.customers AS c
      SET business_id = p.business_id
      FROM public.profiles AS p
      WHERE c.business_id IS NULL
        AND c.created_by IS NOT NULL
        AND COALESCE(p.user_id, p.id) = c.created_by
        AND p.business_id IS NOT NULL
    $sql$;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS customers_business_id_idx
  ON public.customers (business_id);

CREATE INDEX IF NOT EXISTS customers_created_by_idx
  ON public.customers (created_by);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_select ON public.customers;
DROP POLICY IF EXISTS customers_insert ON public.customers;
DROP POLICY IF EXISTS customers_update ON public.customers;
DROP POLICY IF EXISTS customers_delete ON public.customers;

DROP POLICY IF EXISTS "Allow authenticated users to view customers" ON public.customers;
DROP POLICY IF EXISTS "Allow authenticated users to insert customers" ON public.customers;
DROP POLICY IF EXISTS "Allow authenticated users to update customers" ON public.customers;
DROP POLICY IF EXISTS "Allow authenticated users to delete customers" ON public.customers;

DO $$
BEGIN
  IF to_regprocedure('public.current_user_business_id()') IS NULL THEN
    RAISE EXCEPTION 'Falta la funcion public.current_user_business_id(). Ejecuta antes supabase/business_auth_setup.sql.';
  END IF;

  IF to_regprocedure('public.current_user_role()') IS NULL THEN
    RAISE EXCEPTION 'Falta la funcion public.current_user_role(). Ejecuta antes supabase/business_auth_setup.sql.';
  END IF;
END
$$;

CREATE POLICY customers_select
  ON public.customers
  FOR SELECT
  TO authenticated
  USING (business_id = public.current_user_business_id());

CREATE POLICY customers_insert
  ON public.customers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier')
  );

CREATE POLICY customers_update
  ON public.customers
  FOR UPDATE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier')
  )
  WITH CHECK (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'manager', 'tech', 'sales', 'cashier')
  );

CREATE POLICY customers_delete
  ON public.customers
  FOR DELETE
  TO authenticated
  USING (
    business_id = public.current_user_business_id()
    AND public.current_user_role() IN ('owner', 'admin', 'manager')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
