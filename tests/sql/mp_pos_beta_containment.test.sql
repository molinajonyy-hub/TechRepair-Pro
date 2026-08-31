-- Run in a rollback-only transaction AFTER the migration, against LOCAL Postgres.
DO $test$
DECLARE actor text; privilege text; command text;
BEGIN
  FOREACH actor IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(actor, 'public.mp_accounts', privilege) THEN
        RAISE EXCEPTION 'mp_accounts privilege still reachable: % %', actor, privilege;
      END IF;
    END LOOP;
    FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
      IF has_any_column_privilege(actor, 'public.mp_accounts', privilege) THEN
        RAISE EXCEPTION 'mp_accounts column grant still reachable: % %', actor, privilege;
      END IF;
    END LOOP;
    EXECUTE format('SET LOCAL ROLE %I', actor);
    FOREACH command IN ARRAY ARRAY[
      'SELECT access_token_encrypted, refresh_token_encrypted FROM public.mp_accounts',
      'INSERT INTO public.mp_accounts(business_id) VALUES (''00000000-0000-4000-8000-000000000001'')',
      'UPDATE public.mp_accounts SET is_active=false',
      'INSERT INTO public.mp_accounts(business_id) VALUES (''00000000-0000-4000-8000-000000000001'') ON CONFLICT(business_id) DO UPDATE SET is_active=false',
      'DELETE FROM public.mp_accounts'
    ] LOOP
      BEGIN
        EXECUTE command;
        RAISE EXCEPTION 'Unexpected success: %', command;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    RESET ROLE;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.mp_accounts', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Historical service access changed';
  END IF;
END;
$test$;

-- Deliberately restore a grant within this rollback-only test to prove the RLS brake.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mp_accounts TO authenticated;
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF EXISTS (SELECT 1 FROM public.mp_accounts) THEN RAISE EXCEPTION 'Restrictive RLS leaked rows'; END IF;
  BEGIN
    INSERT INTO public.mp_accounts(business_id) VALUES ('00000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'Restrictive RLS allowed insertion';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
RESET ROLE;
