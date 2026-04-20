-- ============================================================
-- Migración: Tablas de integración WhatsApp Cloud API
-- Fecha: 2026-04-18
-- Descripción: Crea las tablas necesarias para la integración con
--   WhatsApp Business Cloud API via Meta Embedded Signup.
--   Incluye conexiones, logs de mensajes y configuración de automatizaciones.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- Función auxiliar: actualizar updated_at automáticamente
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- TABLA 1: whatsapp_connections
-- Almacena las credenciales y datos de cada cuenta WABA conectada.
-- Un negocio (business_id) puede tener una sola conexión activa.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificación del negocio y el usuario que realizó la conexión
  business_id            UUID NOT NULL,
  user_id                UUID NOT NULL,

  -- Identificadores de Meta / WhatsApp Business API
  waba_id                TEXT,                        -- WhatsApp Business Account ID
  phone_number_id        TEXT,                        -- Phone Number ID en la WABA
  business_phone_number  TEXT,                        -- Número de teléfono con formato +549...
  system_user_id         TEXT,                        -- System User ID de Meta (opcional)

  -- Token de acceso a la API de Meta
  access_token           TEXT,                        -- Token de larga duración
  token_expires_at       TIMESTAMPTZ,                 -- Fecha de vencimiento del token (null = permanente)

  -- Información descriptiva de la cuenta
  connected_account_name TEXT,                        -- Nombre de la WABA / negocio en Meta

  -- Estado de la conexión
  -- Valores posibles: 'connected', 'disconnected', 'error', 'pending'
  status                 TEXT NOT NULL DEFAULT 'connected',

  -- Metadatos adicionales (por ejemplo, permisos otorgados, scopes, etc.)
  metadata               JSONB NOT NULL DEFAULT '{}',

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para búsquedas frecuentes por negocio
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_business_id
  ON whatsapp_connections (business_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status
  ON whatsapp_connections (business_id, status);

-- Trigger: mantener updated_at actualizado automáticamente
CREATE TRIGGER trg_whatsapp_connections_updated_at
  BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Comentarios de columna
COMMENT ON TABLE  whatsapp_connections                  IS 'Credenciales y datos de cuentas WABA conectadas por negocio';
COMMENT ON COLUMN whatsapp_connections.waba_id          IS 'WhatsApp Business Account ID asignado por Meta';
COMMENT ON COLUMN whatsapp_connections.phone_number_id  IS 'ID del número de teléfono registrado en la WABA';
COMMENT ON COLUMN whatsapp_connections.access_token     IS 'Token de acceso de larga duración para llamar a la Graph API';
COMMENT ON COLUMN whatsapp_connections.status           IS 'Estado: connected | disconnected | error | pending';


-- ============================================================
-- TABLA 2: whatsapp_message_logs
-- Registra cada mensaje enviado o recibido a través de la integración.
-- Vinculada a whatsapp_connections; si la conexión se elimina, los
-- logs se eliminan en cascada.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_message_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Contexto del mensaje
  business_id       UUID NOT NULL,
  connection_id     UUID REFERENCES whatsapp_connections (id) ON DELETE CASCADE,

  -- Destinatario / remitente
  customer_phone    TEXT NOT NULL,                    -- Número del cliente (formato E.164)

  -- Datos del template utilizado
  template_name     TEXT,                             -- Nombre del template en Meta Business Manager
  template_language TEXT NOT NULL DEFAULT 'es_AR',   -- Código de idioma del template

  -- Payload completo enviado a la Graph API (para depuración)
  payload           JSONB,

  -- Referencia y estado en Meta
  meta_message_id   TEXT,                             -- ID de mensaje devuelto por Meta
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | delivered | read | failed
  direction         TEXT NOT NULL DEFAULT 'outbound', -- outbound | inbound

  -- Detalles de error en caso de fallo
  error_message     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_logs_business_id
  ON whatsapp_message_logs (business_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_logs_connection_id
  ON whatsapp_message_logs (connection_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_logs_status
  ON whatsapp_message_logs (business_id, status);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_logs_customer_phone
  ON whatsapp_message_logs (business_id, customer_phone);

COMMENT ON TABLE  whatsapp_message_logs               IS 'Log de todos los mensajes enviados y recibidos vía WhatsApp Cloud API';
COMMENT ON COLUMN whatsapp_message_logs.status        IS 'Estado del mensaje: pending | sent | delivered | read | failed';
COMMENT ON COLUMN whatsapp_message_logs.direction     IS 'Dirección: outbound (enviado por el sistema) | inbound (recibido del cliente)';
COMMENT ON COLUMN whatsapp_message_logs.meta_message_id IS 'wamid devuelto por la Graph API de Meta al enviar el mensaje';


-- ============================================================
-- TABLA 3: whatsapp_automation_settings
-- Configuración de automatizaciones por negocio: qué eventos
-- disparan el envío automático de mensajes de WhatsApp.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_automation_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Un único registro por negocio (constraint UNIQUE)
  business_id         UUID NOT NULL UNIQUE,

  -- Estado global de las automatizaciones
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,

  -- Disparadores por estado de la orden de trabajo
  send_on_received    BOOLEAN NOT NULL DEFAULT TRUE,   -- Al recibir el equipo
  send_on_diagnosis   BOOLEAN NOT NULL DEFAULT FALSE,  -- Al completar el diagnóstico
  send_on_repair      BOOLEAN NOT NULL DEFAULT FALSE,  -- Durante la reparación
  send_on_ready       BOOLEAN NOT NULL DEFAULT TRUE,   -- Cuando el equipo está listo para retirar
  send_on_delivered   BOOLEAN NOT NULL DEFAULT FALSE,  -- Al entregar el equipo al cliente

  -- Mapa de templates: { "received": "nombre_template", "ready": "nombre_template", ... }
  -- Permite que cada negocio use sus propios templates de Meta Business Manager
  template_map        JSONB NOT NULL DEFAULT '{}',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice (UNIQUE ya crea un índice, pero lo dejamos explícito para claridad)
CREATE INDEX IF NOT EXISTS idx_whatsapp_automation_settings_business_id
  ON whatsapp_automation_settings (business_id);

-- Trigger: mantener updated_at actualizado
CREATE TRIGGER trg_whatsapp_automation_settings_updated_at
  BEFORE UPDATE ON whatsapp_automation_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE  whatsapp_automation_settings              IS 'Configuración de mensajes automáticos de WhatsApp por negocio';
COMMENT ON COLUMN whatsapp_automation_settings.template_map IS 'JSON: mapeo de evento -> nombre de template en Meta Business Manager';
COMMENT ON COLUMN whatsapp_automation_settings.enabled      IS 'Si es false, no se envía ningún mensaje automático, independientemente de los otros flags';


-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Política: el usuario autenticado debe tener un perfil activo
-- con el mismo business_id que el registro al que intenta acceder.
-- Se usa JOIN a la tabla `profiles` que relaciona auth.uid() con business_id.
-- ============================================================

-- ── whatsapp_connections ─────────────────────────────────────

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- SELECT: el usuario puede ver las conexiones de su propio negocio
CREATE POLICY "whatsapp_connections_select"
  ON whatsapp_connections
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_connections.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- INSERT: el usuario puede crear conexiones para su propio negocio
CREATE POLICY "whatsapp_connections_insert"
  ON whatsapp_connections
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_connections.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- UPDATE: el usuario puede actualizar conexiones de su propio negocio
CREATE POLICY "whatsapp_connections_update"
  ON whatsapp_connections
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_connections.business_id
        AND profiles.is_active   = TRUE
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_connections.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- DELETE: el usuario puede eliminar conexiones de su propio negocio
CREATE POLICY "whatsapp_connections_delete"
  ON whatsapp_connections
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_connections.business_id
        AND profiles.is_active   = TRUE
    )
  );


-- ── whatsapp_message_logs ─────────────────────────────────────

ALTER TABLE whatsapp_message_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: el usuario puede leer logs de mensajes de su negocio
CREATE POLICY "whatsapp_message_logs_select"
  ON whatsapp_message_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_message_logs.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- INSERT: el usuario puede registrar logs para su negocio
-- (normalmente lo hace la Edge Function con service_role, pero
--  se define para completitud)
CREATE POLICY "whatsapp_message_logs_insert"
  ON whatsapp_message_logs
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_message_logs.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- No se permiten UPDATE ni DELETE de logs desde el cliente
-- para mantener integridad del historial de comunicaciones.


-- ── whatsapp_automation_settings ─────────────────────────────

ALTER TABLE whatsapp_automation_settings ENABLE ROW LEVEL SECURITY;

-- SELECT
CREATE POLICY "whatsapp_automation_settings_select"
  ON whatsapp_automation_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_automation_settings.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- INSERT
CREATE POLICY "whatsapp_automation_settings_insert"
  ON whatsapp_automation_settings
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_automation_settings.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- UPDATE
CREATE POLICY "whatsapp_automation_settings_update"
  ON whatsapp_automation_settings
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_automation_settings.business_id
        AND profiles.is_active   = TRUE
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_automation_settings.business_id
        AND profiles.is_active   = TRUE
    )
  );

-- DELETE
CREATE POLICY "whatsapp_automation_settings_delete"
  ON whatsapp_automation_settings
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM profiles
      WHERE profiles.user_id    = auth.uid()
        AND profiles.business_id = whatsapp_automation_settings.business_id
        AND profiles.is_active   = TRUE
    )
  );
