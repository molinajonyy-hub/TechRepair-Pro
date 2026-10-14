-- BETA-MP-EMAIL: revisión previa, sólo lectura. NO ejecutar cancelaciones/limpieza automáticamente.
-- 1. Debe devolver cero filas antes de aplicar uq_scs_pending_business.
SELECT business_id, count(*) AS pending_checkouts
FROM public.subscription_checkout_sessions
WHERE status = 'pending'
GROUP BY business_id
HAVING count(*) > 1;

-- 2. Reservas cuyo resultado remoto es incierto: requieren revisión, no expiración automática.
SELECT id, business_id, status, created_at
FROM public.subscription_checkout_sessions
WHERE status = 'pending' AND mp_preapproval_id IS NULL
  AND created_at < now() - interval '1 minute';

-- 3. Historial retirado localmente por versiones anteriores. El estado local no prueba
-- que el proveedor lo haya cancelado. Revisar por ID con autorización antes de habilitar cobros.
SELECT id, business_id, status, mp_preapproval_id, created_at
FROM public.subscription_checkout_sessions
WHERE status IN ('expired', 'failed') AND mp_preapproval_id IS NOT NULL
ORDER BY created_at DESC;
