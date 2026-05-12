import { supabase } from '../../lib/supabase'
import { requireFeature } from '../../utils/requireFeature'
import type {
  PortalBusiness, WholesaleCustomer, PortalProduct,
  WholesaleOrder, WholesaleOrderItem, CartItem,
} from '../types'

// ─── Business ────────────────────────────────────────────────────────────────

export async function getPortalBusiness(slug: string): Promise<PortalBusiness | null> {
  const { data } = await supabase
    .from('businesses')
    .select('id, name, logo_url, wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp, wholesale_portal_theme')
    .eq('wholesale_portal_slug', slug)
    .maybeSingle()
  if (!data || !data.wholesale_portal_enabled) return null
  return data as PortalBusiness
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

export async function registerCustomer(input: {
  businessId: string
  name: string
  businessName: string
  email: string
  password: string
  whatsapp: string
  province: string
  city: string
  instagram?: string
}): Promise<{ customer: WholesaleCustomer | null; error: string | null }> {
  const { data: authData, error: authErr } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
  })
  if (authErr || !authData.user) {
    const msg = authErr?.message || 'Error al crear cuenta'
    const friendly = msg.toLowerCase().includes('already') ? 'Este email ya está registrado. Intentá iniciar sesión.' : msg
    return { customer: null, error: friendly }
  }

  const { data, error } = await supabase
    .from('wholesale_customers')
    .insert({
      business_id:   input.businessId,
      auth_user_id:  authData.user.id,
      name:          input.name,
      business_name: input.businessName || null,
      email:         input.email,
      whatsapp:      input.whatsapp.replace(/\D/g, '') || null,
      province:      input.province || null,
      city:          input.city || null,
      instagram:     input.instagram?.replace(/^@/, '') || null,
    })
    .select()
    .single()

  if (error) return { customer: null, error: error.message }
  return { customer: data as WholesaleCustomer, error: null }
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
    .select('id, code, name, category, subcategory, stock_quantity, sale_price, precio_mayorista, visible_in_wholesale, cost_price, description')
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

export async function createOrder(input: {
  businessId: string
  customerId: string
  items: CartItem[]
  notes?: string
}): Promise<{ order: WholesaleOrder | null; error: string | null }> {
  try {
    await requireFeature(input.businessId, 'mayorista', 'create_wholesale_order')
  } catch (e: any) {
    return { order: null, error: e.message }
  }
  const total = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)
  const orderNumber = `PW-${Date.now().toString(36).toUpperCase()}`

  const { data: order, error: orderErr } = await supabase
    .from('wholesale_orders')
    .insert({
      business_id:  input.businessId,
      customer_id:  input.customerId,
      order_number: orderNumber,
      subtotal:     total,
      total,
      notes:        input.notes || null,
    })
    .select()
    .single()

  if (orderErr || !order) return { order: null, error: orderErr?.message || 'Error al crear el pedido' }

  const itemsToInsert: Partial<WholesaleOrderItem>[] = input.items.map(i => ({
    order_id:          order.id,
    business_id:       input.businessId,
    inventory_item_id: i.inventoryItemId,
    product_name:      i.productName,
    product_code:      i.productCode || null,
    quantity:          i.quantity,
    unit_price:        i.unitPrice,
    subtotal:          i.unitPrice * i.quantity,
  }))

  await supabase.from('wholesale_order_items').insert(itemsToInsert)

  // Update customer analytics — fire and forget
  supabase
    .from('wholesale_customers')
    .update({ last_order_at: new Date().toISOString() })
    .eq('id', input.customerId)
    .then(() => {})

  // Increment total_orders + total_spent via raw SQL increment
  supabase.rpc('increment_wholesale_customer_stats' as any, {
    p_customer_id: input.customerId,
    p_amount:      total,
  }).then(() => {}) // no-op if RPC not deployed yet

  return { order: order as WholesaleOrder, error: null }
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

export async function updateCustomerStatus(
  customerId: string,
  patch: { approved?: boolean; suspended?: boolean; notes?: string }
): Promise<void> {
  await supabase
    .from('wholesale_customers')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', customerId)
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

export async function updateOrderStatus(
  orderId: string,
  status: WholesaleOrder['status'],
  adminNotes?: string,
  businessId?: string,
): Promise<void> {
  let q = supabase
    .from('wholesale_orders')
    .update({ status, admin_notes: adminNotes || null, updated_at: new Date().toISOString() })
    .eq('id', orderId)
  if (businessId) q = q.eq('business_id', businessId)
  await q

  if (!businessId) return

  const DEDUCT_ON  = ['approved'] as WholesaleOrder['status'][]
  const REVERT_ON  = ['cancelled', 'rejected'] as WholesaleOrder['status'][]

  if (DEDUCT_ON.includes(status)) {
    await _processWholesaleStock(orderId, businessId, 'deduct')
  } else if (REVERT_ON.includes(status)) {
    await _processWholesaleStock(orderId, businessId, 'revert')
  }
}

async function _processWholesaleStock(
  orderId: string,
  businessId: string,
  mode: 'deduct' | 'revert',
): Promise<void> {
  const { data: items } = await supabase
    .from('wholesale_order_items')
    .select('id, inventory_item_id, quantity, stock_processed')
    .eq('order_id', orderId)
    .eq('business_id', businessId)

  if (!items?.length) return

  for (const item of items) {
    if (!item.inventory_item_id || !item.quantity) continue

    if (mode === 'deduct' && item.stock_processed) continue   // idempotencia
    if (mode === 'revert' && !item.stock_processed) continue  // nada que revertir

    const { data: inv } = await supabase
      .from('inventory')
      .select('stock_quantity')
      .eq('id', item.inventory_item_id)
      .eq('business_id', businessId)
      .single()

    if (!inv) continue

    const prevStock = inv.stock_quantity ?? 0
    const delta     = mode === 'deduct' ? -item.quantity : item.quantity
    const newStock  = Math.max(0, prevStock + delta)

    await supabase.from('inventory')
      .update({ stock_quantity: newStock, updated_at: new Date().toISOString() })
      .eq('id', item.inventory_item_id)
      .eq('business_id', businessId)

    const { data: mov } = await supabase.from('inventory_movements').insert({
      business_id:       businessId,
      inventory_item_id: item.inventory_item_id,
      movement_type:     mode === 'deduct' ? 'sale' : 'return',
      quantity:          delta,
      previous_stock:    prevStock,
      new_stock:         newStock,
      reference_type:    'wholesale_order',
      reference_id:      orderId,
      note:              mode === 'deduct'
        ? 'Salida por pedido mayorista aprobado'
        : 'Devolución por pedido mayorista cancelado/rechazado',
    }).select('id').maybeSingle()

    await supabase.from('wholesale_order_items')
      .update({
        stock_processed:    mode === 'deduct',
        stock_processed_at: mode === 'deduct' ? new Date().toISOString() : null,
        stock_movement_id:  mode === 'deduct' ? (mov?.id ?? null) : null,
      })
      .eq('id', item.id)
  }
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
