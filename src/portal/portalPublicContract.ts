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

// ─── Clasificación de fallos de carga del portal ─────────────────────────────
//
// La FASE 2 cierra el SELECT directo de `anon` sobre `businesses`. A partir de
// ahí un 42501 deja de ser una anomalía teórica: es la respuesta esperada de
// cualquier bundle viejo que todavía consulte la tabla. El portal tiene que
// distinguirlo de "el portal no existe" y de "la RPC todavía no está desplegada",
// porque cada uno pide una pantalla distinta y sólo UNO de los tres habilita el
// fallback a la tabla.

/** Motivo de un fallo TERMINAL de carga (no es "portal inexistente"). */
export type PortalLoadErrorReason =
  /** 42501 — el rol no tiene permiso. Casi siempre: bundle viejo post-lockdown. */
  | 'permission-denied'
  /** El navegador no llegó a hablar con el servidor (offline, DNS, CORS, timeout). */
  | 'network'
  /** El servidor respondió, pero con 5xx. */
  | 'server'
  /** Cualquier otra cosa. Fail-closed: no se asume que sea recuperable sola. */
  | 'unknown'

/**
 * Resultado de resolver el portal público a partir del slug.
 *
 * Tres estados EXCLUYENTES, en vez del `PortalBusiness | null` anterior, que
 * colapsaba "no existe" con "no tengo permiso" y con "se cayó la red": los tres
 * terminaban mostrando «Portal no disponible», que para un 42501 es una mentira
 * (el portal existe y funciona; lo que está viejo es el cliente).
 *
 * Genérico en `T` para que este módulo siga siendo PURO: no importa
 * `PortalBusiness` ni nada de Vite, así se puede testear con `node --test`.
 */
export type PortalLoadResult<T> =
  | { status: 'ok'; business: T }
  | { status: 'unavailable' }
  | { status: 'error'; reason: PortalLoadErrorReason }

/** 42501 = insufficient_privilege. El único código que significa "sin permiso". */
export function isPermissionDenied(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42501'
}

/**
 * Clasifica un fallo de carga en un motivo terminal.
 *
 * Se decide por CÓDIGO y por STATUS HTTP, nunca por el texto: el mensaje de
 * PostgREST cambia entre versiones y además puede traer fragmentos de SQL, que
 * no queremos ni leer ni mostrar.
 *
 * `status === 0` es la marca de supabase-js para un fetch que nunca completó.
 */
export function classifyPortalError(
  error: { code?: string; message?: string } | null | undefined,
  status?: number,
): PortalLoadErrorReason {
  if (isPermissionDenied(error)) return 'permission-denied'
  if (typeof status === 'number' && status >= 500) return 'server'
  if (/^5\d\d$/.test(error?.code ?? '')) return 'server'
  // supabase-js devuelve status 0 y code vacío cuando el fetch falla de raíz.
  if (status === 0) return 'network'
  if (!error?.code) return 'network'
  return 'unknown'
}

/**
 * Texto que ve el usuario. Mapa CERRADO a propósito: es la garantía estructural
 * de que un mensaje del servidor —con nombres de tabla, columnas o SQL— nunca
 * llegue a la pantalla. Para mostrar algo distinto hay que agregar una entrada
 * acá, no interpolar `error.message`.
 */
export const PORTAL_ERROR_MESSAGE: Record<PortalLoadErrorReason, string> = {
  'permission-denied': 'No pudimos cargar este portal. Actualizá la página o intentá nuevamente.',
  network:             'No pudimos cargar este portal. Revisá tu conexión e intentá nuevamente.',
  server:              'No pudimos cargar este portal. Actualizá la página o intentá nuevamente.',
  unknown:             'No pudimos cargar este portal. Actualizá la página o intentá nuevamente.',
}

/**
 * ¿Conviene ofrecer «Actualizar» (recarga dura) como acción principal?
 *
 * Sólo ante un 42501: el caso típico es un bundle cacheado anterior al lockdown.
 * Para red y 5xx la acción útil es reintentar, no recargar —recargar con la red
 * caída sólo produce una pantalla en blanco—.
 */
export function suggestsHardReload(reason: PortalLoadErrorReason): boolean {
  return reason === 'permission-denied'
}
