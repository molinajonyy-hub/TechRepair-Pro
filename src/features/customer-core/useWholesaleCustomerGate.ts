/**
 * PRE-BETA-3A-2 — ¿Puede este actor ofrecer «Mayorista» en un cliente?
 *
 * Es EXACTAMENTE el acceso a Mayorista: la misma decisión que el menú, el guard
 * de `/mayorista` y la página (`useWholesaleAccess`). No se recalcula acá:
 *
 *  - el NEGOCIO tiene la feature `mayorista` (Pro+; el trial hereda Pro), y
 *  - el ACTOR es owner/admin (automático) o tiene la capacidad `wholesale`.
 *
 * Los roles viven en la autoridad central, no en el core de clientes.
 * `business_settings.mayorista_enabled` NO participa: hoy sólo decide si el
 * menú muestra Mayorista.
 *
 * Mientras sesión o suscripción cargan (o si la suscripción no se pudo leer) el
 * gate está cerrado: sólo se abre con datos confirmados.
 *
 * Es un gate de UX. Hoy ni RLS ni un trigger impiden escribir
 * `customer_type = 'mayorista'` en `customers`; por eso el payload también lo
 * garantiza (`toCreatePayload` / `toUpdatePayload`), pero eso sigue siendo
 * cliente, no servidor (ver PRE-BETA-3A-2S).
 */

import { useWholesaleAccess } from '../../hooks/useWholesaleAccess'

export function useWholesaleCustomerGate(): boolean {
  return useWholesaleAccess().canAccess
}
