-- Agregar campo logo_url a tabla business_settings
ALTER TABLE business_settings 
  ADD COLUMN IF NOT EXISTS logo_url TEXT;
