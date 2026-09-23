import { supabase } from '../../lib/supabase'
import { getAuthCallbackUrl } from '../../lib/authRedirect'
import {
  PORTAL_PUBLIC_RPC, PORTAL_PUBLIC_COLUMNS, isMissingObject,
  PORTAL_FEATURES_RPC, portalCanOrder, classifyPortalError,
  type PortalFeatures, type PortalLoadResult,
} from '../portalPublicContract'
import type {
  PortalBusiness, WholesaleCustomer, PortalProduct,
  WholesaleOrder, CartItem,
} from '../types'

// ─── Business ────────────────────────────────────────────────────────────────

/**
 * Lee la configuración pública del portal a partir del slug.
 *
 * Llama a la RPC `get_wholesale_portal_public` y NO lee la tabla `businesses`:
 * la tabla tiene 34 columnas, entre ellas la facturación de Mercado Pago
 * (mp_preapproval_id, mp_payer_email, …), que el portal público nunca debe ver.
 * La RPC devuelve únicamente las 7 columnas de `PortalBusiness`, y sólo del
 * negocio cuyo slug coincide.
 *
 * Corre en cada carga del portal, con sesión y sin ella (PortalContext la llama
 * en el mount), así que el lector puede ser `anon` o `authenticated`.
 *
 * NUNCA lanza y NUNCA devuelve una promesa que quede pendiente: el llamador
 * apaga el spinner con el resultado, así que un throw acá sería exactamente el
 * spinner infinito que la FASE 2 tiene que evitar.
 *
 * Los tres estados son excluyentes y significan cosas distintas:
 *   ok          → renderizar el portal;
 *   unavailable → slug inexistente o portal apagado («Portal no disponible»);
 *   error       → fallo TERMINAL, con pantalla propia y acción de reintento.
 */
export async function getPortalBusiness(slug: string): Promise<PortalLoadResult<PortalBusiness>> {
  try {
    const { data, error, status } = await supabase.rpc(PORTAL_PUBLIC_RPC, { p_slug: slug })

    if (error) {
      // Fallback transitorio: entornos donde la migración 20260803120000 (que
      // crea la RPC) todavía no se aplicó. Hace que cualquier orden de
      // despliegue —frontend primero o base primero— sea seguro.
      //
      // Es el ÚNICO camino que vuelve a tocar la tabla, y está deliberadamente
      // acotado a "el objeto no existe". Un 42501 NO entra acá: con el lockdown
      // aplicado, tratarlo como "todavía no migrado" mandaría al portal a
      // golpear una tabla que acabamos de cerrar, convirtiendo un error claro
      // en un segundo 403 y en una pantalla que miente.
      if (isMissingObject(error)) {
        const { data: legacy, error: legacyError, status: legacyStatus } = await supabase
          .from('businesses')
          .select(PORTAL_PUBLIC_COLUMNS)
          .eq('wholesale_portal_slug', slug)
          .maybeSingle()
        if (legacyError) {
          return { status: 'error', reason: classifyPortalError(legacyError, legacyStatus) }
        }
        if (!legacy || !legacy.wholesale_portal_enabled) return { status: 'unavailable' }
        return { status: 'ok', business: legacy as PortalBusiness }
      }

      return { status: 'error', reason: classifyPortalError(error, status) }
    }

    // La RPC devuelve un set: 0 o 1 fila.
    const row = Array.isArray(data) ? data[0] : data
    if (!row || !row.wholesale_portal_enabled) return { status: 'unavailable' }
    return { status: 'ok', business: row as PortalBusiness }
  } catch {
    // supabase-js normalmente devuelve el fallo de red como `error`, pero un
    // throw (fetch ausente, abort, interceptor de terceros) no puede propagarse:
    // dejaría el spinner colgado para siempre.
    return { status: 'error', reason: 'network' }
  }
}

// ─── Auth / Customer ──────────────────────────────────────────────────────────

export async function getCustomerByAuthId(businessId: string): Promise<WholesaleCustomer | null> {
  // Usar getSession() en lugar de getUser() — no hace roundtrip a la red
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return null

  const { data, error } = await supabase
    .from('wholesale_customers')
    .select('*')
    .eq('auth_user_id', session.user.id)
    .eq('business_id', businessId)
    .maybeSingle()

  if (error) {
    // 403 = sin permiso (grant faltante) — silencioso para no romper el flujo
    if (error.code === '42501' || error.message.includes('permission denied')) return null
    console.warn('[portalService] getCustomerByAuthId error:', error.message)
    return null
  }
  return (data as WholesaleCustomer | null)
}

// ─── Alta mayorista con confirmación de correo ───────────────────────────────
//
// El portal mayorista es PRIVADO de Clic/el owner. Nada de lo que sigue lo
// convierte en un módulo multi-tenant ni agrega permisos: es la adaptación
// MÍNIMA para que el alta sobreviva a «Confirm Email» global.
//
// EL PROBLEMA
//   Antes: signUp() y acto seguido INSERT en wholesale_customers. Con Confirm
//   Email ON, signUp devuelve `session: null`, así que ese INSERT sale como
//   `anon` y la policy `wc_own_insert` (WITH CHECK auth_user_id = auth.uid())
//   lo rechaza con 42501. El registro quedaba a medias: auth user sí, cliente
//   mayorista no.
//
// LA FORMA MÍNIMA DE CONSERVAR EL CONTEXTO
//   Los datos del formulario viajan en `raw_user_meta_data` bajo una sola
//   clave namespaced, y el alta se completa DESPUÉS, ya con sesión, contra
//   `auth.uid()` real.
//
//   Lo que se guarda es el SLUG del portal, NUNCA un business_id. Al completar,
//   el business_id sale de `business.id` del PortalContext, que se resolvió
//   server-side con `get_wholesale_portal_public(p_slug)`. Un cliente que
//   manipule su metadata sólo puede nombrar un slug; si ese slug no es el del
//   portal que está mirando, no se completa nada. No hay forma de inyectar un
//   business_id arbitrario, ni antes ni ahora.
//
//   Y NO se agrega una RPC SECURITY DEFINER para `anon`: eso abriría una
//   superficie de escritura sin sesión, que es exactamente lo que la P0 de
//   SECDEF vino cerrando.
//
// El namespace importa: `handle_new_user()` lee `full_name`, `role` y
// `business_name` del NIVEL SUPERIOR de raw_user_meta_data. Todo va adentro de
// `wholesale_registration` para no alterar ese comportamiento.

/** Clave namespaced dentro de raw_user_meta_data. */
const WHOLESALE_META_KEY = 'wholesale_registration'

interface WholesaleRegistrationMeta {
  portal_slug: string
  name: string
  business_name: string | null
  whatsapp: string | null
  province: string | null
  city: string | null
  instagram: string | null
}

export type RegisterCustomerResult =
  | { status: 'created'; customer: WholesaleCustomer }
  | { status: 'pending_confirmation' }
  | { status: 'error'; error: string }

/** Normaliza los campos del formulario una sola vez. */
function buildRegistrationMeta(input: {
  portalSlug: string
  name: string
  businessName: string
  whatsapp: string
  province: string
  city: string
  instagram?: string
}): WholesaleRegistrationMeta {
  return {
    portal_slug:   input.portalSlug,
    name:          input.name,
    business_name: input.businessName || null,
    whatsapp:      input.whatsapp.replace(/\D/g, '') || null,
    province:      input.province || null,
    city:          input.city || null,
    instagram:     input.instagram?.replace(/^@/, '') || null,
  }
}

async function insertWholesaleCustomer(
  businessId: string,
  authUserId: string,
  email: string,
  meta: WholesaleRegistrationMeta,
): Promise<{ customer: WholesaleCustomer | null; error: string | null }> {
  const { data, error } = await supabase
    .from('wholesale_customers')
    .insert({
      business_id:   businessId,
      auth_user_id:  authUserId,
      name:          meta.name,
      business_name: meta.business_name,
      email,
      whatsapp:      meta.whatsapp,
      province:      meta.province,
      city:          meta.city,
      instagram:     meta.instagram,
    })
    .select()
    .single()

  if (error) return { customer: null, error: error.message }
  return { customer: data as WholesaleCustomer, error: null }
}

export async function registerCustomer(input: {
  businessId: string
  portalSlug: string
  name: string
  businessName: string
  email: string
  password: string
  whatsapp: string
  province: string
  city: string
  instagram?: string
}): Promise<RegisterCustomerResult> {
  const meta = buildRegistrationMeta(input)

  const { data: authData, error: authErr } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: getAuthCallbackUrl(),
      data: { [WHOLESALE_META_KEY]: meta },
    },
  })

  if (authErr || !authData.user) {
    const msg = authErr?.message || 'Error al crear cuenta'
    const friendly = msg.toLowerCase().includes('already')
      ? 'Este email ya está registrado. Intentá iniciar sesión.'
      : msg
    return { status: 'error', error: friendly }
  }

  // Sin sesión = Confirm Email está ON. El alta se completa al confirmar.
  // NO se intenta el INSERT: como `anon` sería un 42501 garantizado y le
  // mostraría al cliente un error de permisos por un flujo que funcionó.
  if (!authData.session) {
    return { status: 'pending_confirmation' }
  }

  const { customer, error } = await insertWholesaleCustomer(
    input.businessId, authData.user.id, input.email, meta,
  )
  if (error || !customer) return { status: 'error', error: error || 'Error al crear la cuenta' }
  return { status: 'created', customer }
}

/**
 * Completa el alta mayorista de un usuario que YA confirmó su correo.
 *
 * Idempotente por dos vías: sólo corre si no existe ya la fila del cliente, y
 * el `businessId` viene del portal resuelto server-side. Devuelve `null`
 * cuando no hay nada que completar (que es el caso normal).
 */
export async function completePendingWholesaleRegistration(
  businessId: string,
  portalSlug: string,
): Promise<WholesaleCustomer | null> {
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return null

  // Sin correo confirmado no se completa: la RLS lo permitiría (hay sesión),
  // pero el contrato de producto es que el alta ocurre POST confirmación.
  if (!user.email_confirmed_at) return null

  const raw = (user.user_metadata as Record<string, unknown> | undefined)?.[WHOLESALE_META_KEY]
  if (!raw || typeof raw !== 'object') return null

  const meta = raw as Partial<WholesaleRegistrationMeta>

  // El slug de la metadata TIENE que ser el del portal que se está mirando.
  // Es lo que impide que una metadata manipulada dé de alta al usuario en otro
  // portal: el business_id nunca sale de acá, y sin coincidencia no se escribe.
  if (!meta.portal_slug || meta.portal_slug !== portalSlug) return null
  if (!meta.name) return null

  const { customer, error } = await insertWholesaleCustomer(
    businessId,
    user.id,
    user.email ?? '',
    {
      portal_slug:   portalSlug,
      name:          meta.name,
      business_name: meta.business_name ?? null,
      whatsapp:      meta.whatsapp ?? null,
      province:      meta.province ?? null,
      city:          meta.city ?? null,
      instagram:     meta.instagram ?? null,
    },
  )

  if (error) {
    // 23505 = ya existía (carrera entre dos pestañas). No es un fallo.
    if (!error.includes('duplicate') && !error.includes('23505')) {
      console.warn('[portalService] no se pudo completar el alta mayorista:', error)
    }
    return null
  }

  return customer
}

export async function loginCustomer(
  email: string, password: string, businessId: string
): Promise<{ customer: WholesaleCustomer | null; error: string | null }> {
  console.log('[loginCustomer] signInWithPassword', { email, businessId })
  const { data: signInData, error: authErr } = await supabase.auth.signInWithPassword({ email, password })
  if (authErr || !signInData.user) {
    console.error('[loginCustomer] signInWithPassword error:', authErr?.message)
    return { customer: null, error: 'Email o contraseña incorrectos' }
  }
  const authUserId = signInData.user.id
  console.log('[loginCustomer] signInWithPassword OK — authUserId:', authUserId)

  // Buscar directamente por auth_user_id sin llamar getUser() de nuevo
  const { data, error: queryErr } = await supabase
    .from('wholesale_customers')
    .select('*')
    .eq('auth_user_id', authUserId)
    .eq('business_id', businessId)
    .maybeSingle()

  if (queryErr) {
    console.error('[loginCustomer] wholesale_customers query error:', queryErr.message)
    await supabase.auth.signOut()
    return { customer: null, error: 'Error al verificar la cuenta. Intentá de nuevo.' }
  }

  const customer = data as WholesaleCustomer | null
  console.log('[loginCustomer] wholesale_customer:', customer ? `found (approved=${customer.approved})` : 'not found')

  if (!customer) {
    await supabase.auth.signOut()
    return { customer: null, error: 'Esta cuenta no pertenece a este portal. Verificá que estés en el portal correcto.' }
  }
  if (customer.suspended) {
    await supabase.auth.signOut()
    return { customer: null, error: 'Tu cuenta fue suspendida. Contactá al negocio para más información.' }
  }
  console.log('[loginCustomer] customer encontrado:', { approved: customer.approved, suspended: customer.suspended })

  await supabase
    .from('wholesale_customers')
    .update({ last_login: new Date().toISOString() })
    .eq('id', customer.id)

  return { customer, error: null }
}

export async function logoutCustomer(): Promise<void> {
  await supabase.auth.signOut()
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export async function getCatalog(businessId: string): Promise<PortalProduct[]> {
  const { data, error } = await supabase
    .from('inventory')
    .select('id, code, name, category, subcategory, stock_quantity, sale_price, precio_mayorista, visible_in_wholesale, description')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .eq('visible_in_wholesale', true)
    .gt('stock_quantity', 0)
    .order('category')
    .order('name')
  if (error) throw error
  return (data || []) as PortalProduct[]
}

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Valida contra la DB que el portal de `slug` puede tomar pedidos.
 *
 * Usa la superficie del portal, NO el paywall del comercio: el cliente del
 * portal es `authenticated` pero no es miembro del negocio (ver
 * PORTAL_FEATURES_RPC). Fail-closed ante cualquier error.
 */
export async function portalFeatureAllowsOrders(slug: string): Promise<boolean> {
  if (!slug) return false
  const { data, error } = await supabase.rpc(PORTAL_FEATURES_RPC, { p_slug: slug })
  if (error) return false
  return portalCanOrder(data as PortalFeatures | null)
}

/** RPC canónica de alta de pedidos mayoristas (G2-C.1). */
export const WHOLESALE_CREATE_ORDER_RPC = 'create_wholesale_order_atomic'

/** Una línea tal como la guardó la base: nombre, código y precio canónicos. */
export interface CreatedWholesaleOrderItem {
  inventory_item_id: string
  product_name: string
  product_code: string | null
  quantity: number
  unit_price: number
  subtotal: number
}

/** Lo que devuelve la RPC de alta. Totales y líneas son los de la base. */
export interface CreatedWholesaleOrder {
  ok: true
  order_id: string
  order_number: string
  business_id: string
  customer_id: string
  status: WholesaleOrder['status']
  subtotal: number
  total: number
  notes: string | null
  created_at: string
  items: CreatedWholesaleOrderItem[]
}

/**
 * Mensajes del alta. Mapa CERRADO, como PORTAL_ERROR_MESSAGE: el texto del
 * servidor nunca llega a la pantalla, sólo el motivo que la RPC nombra.
 */
const CREATE_ORDER_ERROR: Array<[RegExp, string]> = [
  [/PORTAL_NOT_ACCEPTING_ORDERS/, 'Este portal mayorista no está disponible en este momento.'],
  [/CUSTOMER_NOT_APPROVED/,       'Tu cuenta todavía no fue aprobada. Te avisamos cuando puedas hacer pedidos.'],
  [/CUSTOMER_SUSPENDED/,          'Tu cuenta está suspendida. Contactá al negocio para más información.'],
  [/PRODUCT_NOT_AVAILABLE/,       'Uno de los productos ya no está disponible. Revisá tu pedido.'],
  [/EMPTY_ORDER/,                 'Tu pedido está vacío.'],
]

/**
 * G2-C.1 — alta de un pedido mayorista.
 *
 * El navegador sólo manda QUÉ se pide: el portal (slug), y por línea el
 * producto y la cantidad. La RPC decide todo lo demás en una transacción:
 * el negocio (por slug), el cliente del actor (aprobado y no suspendido), que
 * cada producto sea de ese negocio y esté visible, el precio
 * (precio_mayorista > 0 ? precio_mayorista : sale_price), nombre, código,
 * subtotales, total y número de pedido. Pedido e items se crean juntos o no
 * se crea nada. El total que muestra el carrito es sólo orientativo: el que
 * vale es el que devuelve la base.
 *
 * `portalFeatureAllowsOrders` queda como pre-chequeo de UX (mensaje claro sin
 * ida y vuelta); la autoridad es la RPC, que aplica la misma regla.
 */
export async function createOrder(input: {
  portalSlug: string
  items: CartItem[]
  notes?: string
}): Promise<{ order: CreatedWholesaleOrder | null; error: string | null }> {
  if (!(await portalFeatureAllowsOrders(input.portalSlug))) {
    return {
      order: null,
      error: 'Este portal mayorista no está disponible en este momento.',
    }
  }

  const { data, error } = await supabase.rpc(WHOLESALE_CREATE_ORDER_RPC, {
    p_portal_slug: input.portalSlug,
    p_items:       input.items.map(i => ({ inventory_item_id: i.inventoryItemId, quantity: i.quantity })),
    p_notes:       input.notes?.trim() || null,
  })

  if (error) {
    const motivo = CREATE_ORDER_ERROR.find(([re]) => re.test(error.message))
    return { order: null, error: motivo ? motivo[1] : 'No se pudo crear el pedido. Intentá de nuevo.' }
  }
  return { order: data as CreatedWholesaleOrder, error: null }
}

export async function getCustomerOrders(
  customerId: string,
  businessId: string,
): Promise<WholesaleOrder[]> {
  const { data } = await supabase
    .from('wholesale_orders')
    .select('*, items:wholesale_order_items(*)')
    .eq('customer_id', customerId)
    .eq('business_id', businessId)   // ← security: only orders of this business
    .order('created_at', { ascending: false })
    .limit(30)
  return (data || []) as WholesaleOrder[]
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export async function getWholesaleCustomers(
  businessId: string
): Promise<WholesaleCustomer[]> {
  const { data } = await supabase
    .from('wholesale_customers')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
  return (data || []) as WholesaleCustomer[]
}

/** RPC canónica de administración de clientes mayoristas (G2-C.1). */
export const WHOLESALE_CUSTOMER_STATUS_RPC = 'update_wholesale_customer_status_atomic'

/** Lo que devuelve la RPC de clientes. */
export interface WholesaleCustomerStatusChange {
  ok: true
  customer_id: string
  business_id: string
  approved: boolean
  suspended: boolean
  notes: string | null
  changed: boolean
  updated_at: string
}

/**
 * G2-C.1 — el staff aprueba, suspende o reactiva un cliente mayorista.
 *
 * La base es la autoridad: la RPC exige la capability `wholesale` y el plan
 * del MISMO negocio y sólo toca approved/suspended/notes. El navegador ya no
 * puede escribir esas columnas (tampoco el propio cliente: así no se puede
 * autoaprobar). Un campo ausente del patch se conserva. Los errores se
 * propagan.
 */
export async function updateCustomerStatus(
  businessId: string,
  customerId: string,
  patch: { approved?: boolean; suspended?: boolean; notes?: string },
): Promise<WholesaleCustomerStatusChange> {
  if (!businessId) throw new Error('No hay negocio activo para administrar el cliente.')

  const { data, error } = await supabase.rpc(WHOLESALE_CUSTOMER_STATUS_RPC, {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_approved:    patch.approved ?? null,
    p_suspended:   patch.suspended ?? null,
    p_notes:       patch.notes ?? null,
  })
  if (error) throw new Error(error.message)
  return data as WholesaleCustomerStatusChange
}

export async function getWholesaleOrders(
  businessId: string
): Promise<WholesaleOrder[]> {
  const { data } = await supabase
    .from('wholesale_orders')
    .select('*, customer:wholesale_customers(id,name,business_name,whatsapp,email,province,city), items:wholesale_order_items(*)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(100)
  return (data || []) as WholesaleOrder[]
}

/** RPC canónica de cambio de estado de un pedido mayorista (G2-C.1). */
export const WHOLESALE_ORDER_STATUS_RPC = 'update_wholesale_order_status_atomic'

/** Lo que devuelve la RPC. `changed` es false cuando se repitió el mismo estado. */
export interface WholesaleOrderStatusChange {
  ok: true
  order_id: string
  business_id: string
  status: WholesaleOrder['status']
  previous_status: WholesaleOrder['status']
  admin_notes: string | null
  changed: boolean
  updated_at: string
}

/**
 * G2-C.1 — cambia el estado administrativo de un pedido mayorista.
 *
 * PEDIDO MAYORISTA = ESTADO COMERCIAL. COMPROBANTE = MOVIMIENTO DE STOCK.
 * Ningún estado mueve inventario: la salida real ocurre sólo al convertir el
 * pedido en comprobante por el checkout canónico. Este servicio no lee ni
 * escribe `inventory`, `inventory_movements` ni los marcadores `stock_*`.
 *
 * La base es la única autoridad: la RPC valida identidad (auth.uid()),
 * capability `wholesale` y plan del MISMO negocio, bloquea el pedido y
 * actualiza status/admin_notes en una transacción. El UPDATE directo sobre
 * `wholesale_orders` está cerrado para el navegador.
 *
 * `businessId` es obligatorio: sin él no hay tenant que autorizar. Los errores
 * se propagan (42501 sin autoridad, 22023 estado inválido, P0002 pedido
 * inexistente en ese negocio). `adminNotes` undefined conserva las notas.
 */
export async function updateOrderStatus(
  businessId: string,
  orderId: string,
  status: WholesaleOrder['status'],
  adminNotes?: string,
): Promise<WholesaleOrderStatusChange> {
  if (!businessId) throw new Error('No hay negocio activo para cambiar el estado del pedido.')

  const { data, error } = await supabase.rpc(WHOLESALE_ORDER_STATUS_RPC, {
    p_business_id: businessId,
    p_order_id:    orderId,
    p_status:      status,
    p_admin_notes: adminNotes ?? null,
  })
  if (error) throw new Error(error.message)
  return data as WholesaleOrderStatusChange
}

/**
 * Busca o crea un cliente en la tabla `customers` (TechRepair Pro) a partir
 * de un cliente del portal. Necesario para "Convertir en comprobante".
 */
export async function getOrCreateCustomerFromPortal(
  businessId: string,
  email: string,
  name: string,
  phone?: string | null,
  customerType: 'mayorista' | 'minorista' = 'mayorista',
): Promise<{ customerId: string | null; error: string | null }> {
  // 1. Buscar cliente existente por email
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('business_id', businessId)
    .eq('email', email)
    .maybeSingle()

  if (existing?.id) return { customerId: existing.id, error: null }

  // 2. Buscar por nombre exacto como fallback
  const { data: byName } = await supabase
    .from('customers')
    .select('id')
    .eq('business_id', businessId)
    .ilike('name', name)
    .maybeSingle()

  if (byName?.id) return { customerId: byName.id, error: null }

  // 3. Crear nuevo cliente
  const { data: created, error } = await supabase
    .from('customers')
    .insert({
      business_id:   businessId,
      name,
      email:         email || null,
      phone:         phone  || null,
      customer_type: customerType,
    })
    .select('id')
    .single()

  if (error) return { customerId: null, error: error.message }
  return { customerId: created.id, error: null }
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function trackEvent(
  businessId: string,
  eventType: string,
  customerId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await supabase.from('customer_events').insert({
    business_id: businessId,
    event_type:  eventType,
    customer_id: customerId || null,
    metadata:    metadata || null,
  }).then(() => {}) // fire-and-forget
}
