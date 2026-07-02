-- ============================================================================
-- ARCA — estado fiscal "pendiente de conciliación" (auditoría de emisión ARCA)
--
-- CONTEXTO:
--   Incidente ARCA (ver supabase/functions/afip-cae/logic.ts::reconciliarComprobante):
--   ante un timeout / connection reset / 502 / 503 / 504 DESPUÉS de haber enviado
--   FECAESolicitar, no sabemos si ARCA autorizó el comprobante o no. El sistema
--   ahora reconcilia contra FECompConsultar en vez de pedir un número nuevo a
--   ciegas, pero cuando ni siquiera esa consulta puede confirmar el resultado,
--   el comprobante debe quedar en un estado explícito distinto de
--   'error_emision' (rechazo confirmado) y de 'pendiente_emision' (aún no
--   intentado): 'pendiente_conciliacion' — no se debe reintentar automáticamente
--   ni marcarlo como rechazado hasta que se resuelva.
--
-- NO se agregan columnas nuevas: `request_data` y `response_data` (jsonb, ya
-- existentes y sin uso hasta ahora) pasan a guardar el intento fiscal
-- (punto_venta / tipo_comprobante / número intentado / correlation_id / etapa)
-- y el resultado de conciliación respectivamente. `resultado_fiscal`,
-- `error_codigo`, `error_mensaje`, `tipo_comprobante_fiscal`,
-- `numero_comprobante` y `fecha_emision_fiscal` (todas ya existentes) pasan a
-- poblarse por primera vez. Esto evita duplicar columnas equivalentes.
--
-- Idempotente. No reescribe filas existentes (estado_fiscal actual sigue
-- siendo válido). Solo amplía el CHECK y agrega un índice parcial para poder
-- encontrar comprobantes pendientes de conciliación sin escanear toda la tabla.
-- ============================================================================

ALTER TABLE "public"."comprobantes"
  DROP CONSTRAINT IF EXISTS "comprobantes_estado_fiscal_check";

ALTER TABLE "public"."comprobantes"
  ADD CONSTRAINT "comprobantes_estado_fiscal_check"
  CHECK (("estado_fiscal" = ANY (ARRAY[
    'no_fiscal'::text,
    'pendiente_emision'::text,
    'pendiente_conciliacion'::text,
    'emitido'::text,
    'error_emision'::text,
    'anulado_fiscal'::text
  ])));

COMMENT ON COLUMN "public"."comprobantes"."estado_fiscal" IS
  'no_fiscal=remito/no aplica. pendiente_emision=aún no se intentó o se va a reintentar. '
  'pendiente_conciliacion=se envió FECAESolicitar y el resultado es ambiguo (timeout/502/503/504); '
  'requiere FECompConsultar antes de reintentar, NUNCA se debe re-emitir a ciegas. '
  'emitido=CAE confirmado (directo o por conciliación). error_emision=ARCA rechazó el comprobante '
  '(definitivo, no reintentable automáticamente). anulado_fiscal=reemplazado por nota de crédito.';

COMMENT ON COLUMN "public"."comprobantes"."request_data" IS
  'Intento de emisión ARCA en curso (jsonb): { intentado: { punto_venta, tipo_comprobante, '
  'numero, ambiente, correlation_id, ts } }. Lo escribe afip-cae ANTES de llamar a '
  'FECAESolicitar, para poder conciliar con FECompConsultar si la respuesta se pierde. '
  'Nunca contiene certificados, tokens, sign ni CMS.';

COMMENT ON COLUMN "public"."comprobantes"."response_data" IS
  'Resultado de la última conciliación/consulta ARCA (jsonb), para auditoría. '
  'Nunca contiene certificados, tokens, sign ni CMS — solo campos fiscales devueltos por AFIP '
  '(CAE, vencimiento, resultado, observaciones) y metadata de la reconciliación (correlation_id, etapa).';

-- Índice parcial: encontrar rápido los comprobantes que necesitan conciliación
-- manual/automática sin escanear toda la tabla (la mayoría de las filas no
-- están en este estado).
CREATE INDEX IF NOT EXISTS "idx_comprobantes_pendiente_conciliacion"
  ON "public"."comprobantes" ("business_id", "updated_at")
  WHERE ("estado_fiscal" = 'pendiente_conciliacion');

-- ============================================================================
-- ROLLBACK (documentado, no ejecutado por esta migración)
--   Solo es seguro si NINGUNA fila quedó con estado_fiscal='pendiente_conciliacion'
--   (si existe alguna, el ADD CONSTRAINT de abajo falla por diseño — no bajar
--   la migración con filas en ese estado sin resolverlas primero):
--
--   DROP INDEX IF EXISTS "idx_comprobantes_pendiente_conciliacion";
--   ALTER TABLE "public"."comprobantes" DROP CONSTRAINT IF EXISTS "comprobantes_estado_fiscal_check";
--   ALTER TABLE "public"."comprobantes" ADD CONSTRAINT "comprobantes_estado_fiscal_check"
--     CHECK (("estado_fiscal" = ANY (ARRAY[
--       'no_fiscal'::text, 'pendiente_emision'::text, 'emitido'::text,
--       'error_emision'::text, 'anulado_fiscal'::text
--     ])));
--
-- COMPATIBILIDAD CON FILAS EXISTENTES: el ADD CONSTRAINT de este archivo agrega
-- un valor nuevo al conjunto permitido — nunca quita ni reinterpreta uno viejo,
-- así que valida contra CUALQUIER fila existente sin fallar (los 5 valores
-- previos siguen siendo válidos). No requiere backfill.
-- ============================================================================
