-- ============================================================
-- Migración: WhatsApp Cloud API + ARCA WSAA token cache
-- Fecha: 2026-04-15
-- ============================================================

-- ──────────────────────────────────────────────
-- 1. whatsapp_settings: agregar campos API mode
-- ──────────────────────────────────────────────

ALTER TABLE whatsapp_settings
  ADD COLUMN IF NOT EXISTS api_mode         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_number_id  TEXT,
  ADD COLUMN IF NOT EXISTS access_token     TEXT;

-- ──────────────────────────────────────────────
-- 2. whatsapp_logs: ampliar send_mode y send_result
-- ──────────────────────────────────────────────

-- send_mode: agregar 'api'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname LIKE '%send_mode%' OR t.typname LIKE '%whatsapp%'
  ) THEN
    -- Si es enum, agregar valor
    ALTER TYPE whatsapp_send_mode ADD VALUE IF NOT EXISTS 'api';
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL; -- Si no es enum o ya existe, ignorar
END $$;

-- send_result: agregar 'sent_api'
DO $$
BEGIN
  ALTER TYPE whatsapp_send_result ADD VALUE IF NOT EXISTS 'sent_api';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Si las columnas son TEXT en lugar de enum, no necesitamos hacer nada extra.
-- La Edge Function ya guarda 'sent_api' y 'api' directamente.

-- ──────────────────────────────────────────────
-- 3. arca_config: agregar columnas de cache WSAA
--    y columnas faltantes
-- ──────────────────────────────────────────────

-- Crear tabla arca_config si no existe (con todas las columnas)
CREATE TABLE IF NOT EXISTS arca_config (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  cuit                   TEXT,
  razon_social           TEXT,
  ambiente               TEXT DEFAULT 'homologacion' CHECK (ambiente IN ('homologacion', 'produccion')),
  punto_venta            INTEGER DEFAULT 1,
  cert_file              TEXT,
  private_key            TEXT,
  pfx_file               TEXT,
  pfx_password           TEXT,
  expires_at             TIMESTAMPTZ,
  estado_conexion        TEXT DEFAULT 'no_configurado',
  ultima_sincronizacion  TIMESTAMPTZ,
  ultimo_error           TEXT,
  -- Cache de token WSAA (válido 12h)
  wsaa_token             TEXT,
  wsaa_sign              TEXT,
  wsaa_token_expires     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- Agregar columnas si ya existe la tabla
ALTER TABLE arca_config
  ADD COLUMN IF NOT EXISTS cuit                  TEXT,
  ADD COLUMN IF NOT EXISTS razon_social          TEXT,
  ADD COLUMN IF NOT EXISTS pfx_password          TEXT,
  ADD COLUMN IF NOT EXISTS wsaa_token            TEXT,
  ADD COLUMN IF NOT EXISTS wsaa_sign             TEXT,
  ADD COLUMN IF NOT EXISTS wsaa_token_expires    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();

-- ──────────────────────────────────────────────
-- 4. arca_parametros: asegurar que existe
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS arca_parametros (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  datos        JSONB,
  actualizado  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, tipo)
);

-- ──────────────────────────────────────────────
-- 5. Permisos
-- ──────────────────────────────────────────────

ALTER TABLE whatsapp_settings OWNER TO postgres;
ALTER TABLE arca_config       OWNER TO postgres;
ALTER TABLE arca_parametros   OWNER TO postgres;

GRANT ALL ON whatsapp_settings TO authenticated, anon, service_role;
GRANT ALL ON arca_config       TO authenticated, anon, service_role;
GRANT ALL ON arca_parametros   TO authenticated, anon, service_role;

ALTER TABLE whatsapp_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE arca_config       DISABLE ROW LEVEL SECURITY;
ALTER TABLE arca_parametros   DISABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────
-- 6. Notificar a PostgREST que recargue el schema
-- ──────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
