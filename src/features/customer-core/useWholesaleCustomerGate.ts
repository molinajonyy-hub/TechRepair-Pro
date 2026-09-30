/**
 * PRE-BETA-3A-2 — ¿Puede este actor ofrecer «Mayorista» en un cliente?
 *
 * Hacen falta las DOS cosas, igual que para ver el módulo Mayorista (P0-P6):
 *
 *  - el NEGOCIO tiene la feature `mayorista` (Full-only: el trial da features
 *    Pro, así que un trial no la tiene), y
 *  - el ACTOR tiene la capacidad `wholesale` (defaults del rol + overrides).
 *
 * No hay roles hardcodeados: las dos respuestas salen de las autoridades que
 * ya existen. `business_settings.mayorista_enabled` NO participa: hoy sólo
 * decide si el menú muestra Mayorista.
 *
 * Mientras la suscripción carga, `hasFeature` resuelve como trial → `false`:
 * el gate arranca cerrado y sólo se abre con datos confirmados.
 *
 * Es un gate de UX. Hoy ni RLS ni un trigger impiden escribir
 * `customer_type = 'mayorista'` en `customers`; por eso el payload también lo
 * garantiza (`toCreatePayload` / `toUpdatePayload`), pero eso sigue siendo
 * cliente, no servidor.
 */

import { usePermissions } from '../../hooks/usePermissions'
import { useSubscription } from '../../hooks/useSubscription'

export function useWholesaleCustomerGate(): boolean {
  const { hasFeature } = useSubscription()
  const { can } = usePermissions()
  return hasFeature('mayorista') && can('wholesale')
}
