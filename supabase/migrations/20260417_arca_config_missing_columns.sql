-- ──────────────────────────────────────────────────────────────────────────────
-- Migración: agregar columnas faltantes en arca_config
-- Fecha: 2026-04-17
--
-- La tabla arca_config fue creada con columnas básicas. Este archivo agrega:
--   - alias       : nombre amigable del certificado (ej: "Cert Producción 2025")
--   - web_service : servicio AFIP por defecto (wsfev1, wsbfe, etc.)
--
-- IMPORTANTE: el campo correcto para el CUIT es `cuit` (no `cuit_emisor`).
-- Si hay alguna aplicación que usa `cuit_emisor`, debe actualizarse.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE arca_config
  ADD COLUMN IF NOT EXISTS alias       TEXT,
  ADD COLUMN IF NOT EXISTS web_service TEXT DEFAULT 'wsfev1';
