-- ============================================================================
-- M7 7E.2 §7 — Identificar QUE nota de crédito quedó sin reversa financiera.
--
-- ┌── QUE FALTABA ───────────────────────────────────────────────────────────┐
-- │ La emisión de una NC en ARCA no se puede deshacer, así que si la reversa  │
-- │ financiera posterior falla, la NC queda emitida y el ingreso original     │
-- │ sigue contado. Eso ya se detecta de forma durable: el check               │
-- │ `credit_note_cash_not_compensated` del Health Check v2 lo marca en        │
-- │ severidad `high`, con cantidad e importe, del lado del servidor (o sea,   │
-- │ sobrevive a un refresh y a cerrar el navegador).                          │
-- │                                                                          │
-- │ Lo que ese check NO dice es CUAL. Devuelve `rows: []`: el operador ve     │
-- │ "1 NC sin compensar por $10.000" y tiene que salir a buscarla a mano.     │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- POR QUE UNA VISTA Y NO TOCAR EL HEALTH CHECK:
-- `finance_health_check_v2` tiene ~900 líneas y 44 checks. Reescribirla entera
-- por un `p_rows` de un solo check es mucho riesgo para poca ganancia: cualquier
-- error de transcripción se lleva puestos los otros 43. La vista es aditiva, no
-- toca nada existente, y responde exactamente la pregunta que falta.
--
-- `security_invoker = true` es deliberado: la vista NO debe ver más que quien la
-- consulta. Con esto hereda las RLS de `comprobantes`, así que el aislamiento
-- entre negocios lo sigue garantizando la misma regla de siempre y no una copia
-- que podría quedar desincronizada.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_credit_notes_pending_reversal
WITH (security_invoker = true) AS
SELECT
  nc.business_id,
  nc.id                                              AS comprobante_id,
  COALESCE(nc.numero_fiscal, nc.numero)              AS numero,
  COALESCE(nc.fecha, nc.date)                        AS fecha,
  COALESCE(nc.total_bruto, nc.total_ars, nc.total, 0) AS importe_pendiente,
  nc.comprobante_original_id,
  (SELECT COALESCE(o.numero_fiscal, o.numero)
     FROM public.comprobantes o
    WHERE o.id = nc.comprobante_original_id)         AS numero_original,
  nc.created_at
FROM public.comprobantes nc
WHERE COALESCE(nc.tipo, nc.type) = 'nota_credito'
  AND nc.estado = 'emitido'
  -- Mismo predicado que usa el check del Health Check v2: si uno cambia, el
  -- otro tiene que cambiar con él, y por eso queda escrito igual y a la vista.
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_movements f
     WHERE f.comprobante_id = nc.id AND f.type = 'expense');

COMMENT ON VIEW public.v_credit_notes_pending_reversal IS
  'M7 7E.2: NC emitidas cuya reversa financiera no quedo registrada. '
  'Complementa el check credit_note_cash_not_compensated, que dice CUANTAS y por '
  'CUANTO pero no cuales. La recuperacion es reintentar '
  'create_credit_note_finance_reversal(comprobante_id), que es idempotente por '
  'identidad natural: si otra sesion ya la resolvio, devuelve replay.';

GRANT SELECT ON public.v_credit_notes_pending_reversal TO authenticated;

DO $$
BEGIN
  IF has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION '7E.2: se reintrodujo CREATE sobre public';
  END IF;
  RAISE NOTICE '7E.2 OK: vista de NC pendientes de reversa disponible';
END $$;
