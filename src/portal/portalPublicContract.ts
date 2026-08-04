// ─── Contrato de la superficie pública del portal mayorista ──────────────────
//
// Módulo PURO a propósito: no importa el cliente de Supabase ni nada de Vite,
// así se puede testear con `node --test` (tests/unit/portalPublicContract.test.ts).
//
// La barrera real vive en la DB: la RPC `get_wholesale_portal_public`
// (SECURITY DEFINER, 7 columnas, filtro por slug exacto) más el lockdown de
// grants sobre `public.businesses`. Acá sólo se fija el lado del cliente.

/** RPC que expone la proyección pública del portal. */
export const PORTAL_PUBLIC_RPC = 'get_wholesale_portal_public'

/**
 * RPC de features del portal — superficie SEPARADA del paywall del comercio.
 *
 * El portal NO puede usar `get_business_subscription_features(p_business_id)`:
 * un cliente del portal es `authenticated` (se registra con supabase.auth) pero
 * NO es miembro del negocio, así que esa RPC —que ahora exige pertenencia— le
 * daría 42501. Y dejarla sin pertenencia tampoco servía: cualquier usuario
 * registrado de cualquier tenant podría consultar el plan de otro negocio
 * pasando un business_id arbitrario.
 *
 * Esta RPC resuelve por SLUG exacto, sólo responde por portales encendidos y
 * devuelve exactamente dos booleanos. Nada de plan, estado crudo, fechas ni
 * access_source.
 */
export const PORTAL_FEATURES_RPC = 'get_wholesale_portal_features'

/** Forma del payload de PORTAL_FEATURES_RPC. */
export interface PortalFeatures {
  /** El negocio tiene el plan que habilita el portal mayorista. */
  mayorista: boolean
  /** La suscripción no está suspendida ni cancelada. */
  active: boolean
}

/**
 * ¿El portal puede tomar un pedido?
 *
 * Fail-closed a propósito: sin payload (RPC caída, slug inexistente, portal
 * apagado) la respuesta es NO. Mismo criterio que `requireFeature`, que nunca
 * ejecuta una acción premium sin confirmación del plan.
 */
export function portalCanOrder(features: PortalFeatures | null | undefined): boolean {
  if (!features) return false
  return features.mayorista === true && features.active === true
}

/**
 * Allowlist de columnas públicas: exactamente las de `PortalBusiness`, las
 * mismas que declara el `RETURNS TABLE` de la RPC. Sólo la usa el fallback
 * transitorio que lee la tabla; nunca pedir más que éstas, y nunca `*` — la
 * tabla `businesses` tiene 34 columnas, incluida la facturación de Mercado Pago.
 */
export const PORTAL_PUBLIC_COLUMNS =
  'id, name, logo_url, wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp, wholesale_portal_theme'

/**
 * ¿El error indica que la función/relación todavía no existe en este entorno?
 *
 * Decide el fallback transitorio, así que tiene que ser ESTRECHO: un 403
 * (42501), un 5xx o un JWT vencido NO son "objeto ausente". Si el fallback se
 * disparara con esos, un lockdown correctamente aplicado se leería como
 * "todavía no migrado" y el portal volvería a golpear la tabla.
 *
 * Se decide por CÓDIGO, nunca por el texto del mensaje: los mensajes cambian
 * entre versiones de PostgREST y "does not exist" aparece en errores que no
 * son ausencia de objeto.
 */
export function isMissingObject(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  // PGRST202 = función ausente del schema cache · 42883 = undefined_function
  // PGRST205 / 42P01 = relación ausente (por si se vuelve a apuntar a una vista)
  return ['PGRST202', '42883', 'PGRST205', '42P01'].includes(error.code ?? '')
}
