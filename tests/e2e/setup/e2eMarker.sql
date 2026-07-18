-- ============================================================================
-- M7 7D.2 — MARKER DE ENTORNO E2E LOCAL.
--
-- ⚠️  ESTE ARCHIVO **NO** ES UNA MIGRACIÓN. Vive fuera de supabase/migrations/
--     a propósito: jamás debe aplicarse a producción. Lo ejecuta únicamente el
--     setup de E2E contra el Supabase local.
--
-- POR QUÉ: un hostname local no alcanza como prueba de destino seguro. Alguien
-- podría tunelizar producción a 127.0.0.1, o `supabase start` podría estar
-- enlazado a un proyecto remoto. El marker es evidencia POSITIVA de que este
-- backend es el entorno E2E descartable: si falta, la suite aborta.
--
-- En producción esta tabla NO existe → el guard aborta → imposible sembrar o
-- escribir contra ella.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.e2e_environment_marker (
  id                        integer PRIMARY KEY DEFAULT 1,
  environment               text NOT NULL,
  project                   text NOT NULL,
  destructive_tests_allowed boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT e2e_marker_singleton CHECK (id = 1)
);

COMMENT ON TABLE public.e2e_environment_marker IS
  'M7 7D.2 — Marker de entorno E2E LOCAL. NO es parte de ninguna migración: lo '
  'crea tests/e2e/setup/e2eMarker.sql sólo contra el stack local. Su ausencia '
  'hace abortar la suite E2E (fail-closed). Si aparece en producción, alguien '
  'ejecutó el setup de E2E contra un destino equivocado.';

INSERT INTO public.e2e_environment_marker (id, environment, project, destructive_tests_allowed)
VALUES (1, 'e2e_local', 'techrepair-pro', true)
ON CONFLICT (id) DO UPDATE
  SET environment = EXCLUDED.environment,
      project = EXCLUDED.project,
      destructive_tests_allowed = EXCLUDED.destructive_tests_allowed;

-- El marker sólo se lee desde Node con service_role: el browser no lo necesita,
-- y exponerlo a anon/authenticated sería filtrar la topología del entorno.
--
-- El REVOKE va PRIMERO y arrastra a service_role (heredaba su acceso vía PUBLIC),
-- así que el GRANT posterior es obligatorio: sin él, el guard recibe 403 y aborta
-- la suite entera contra un backend que en realidad era el correcto.
REVOKE ALL ON public.e2e_environment_marker FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.e2e_environment_marker TO service_role;
