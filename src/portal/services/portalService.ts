import { supabase } from '../../lib/supabase'
import type {
  PortalBusiness, WholesaleCustomer, PortalProduct,
  WholesaleOrder, WholesaleOrderItem, CartItem,
} from '../types'

// ─── Business ────────────────────────────────────────────────────────────────

export async function getPortalBusiness(slug: string): Promise<PortalBusiness | null> {
  const { data } = await supabase
    .from('businesses')
    .select('id, name, wholesale_portal_enabled, wholesale_portal_slug, wholesale_whatsapp, wholesale_portal_theme')
    .eq('wholesale_portal_slug', slug)
    .maybeSingle()
  if (!data || !data.wholesale_portal_enabled) return null
  return data as PortalBusiness
}

// ─── Auth / Customer ──────────────────────────────────────────────────────────

export async function getCustomerByAuthId(businessId: string): Promise<WholesaleCustomer | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data } = await supabase
    .from('wholesale_customers')
    .select('*')
    .eq('auth_user_id', user.id)
    .eq('business_id', businessId)
    .maybeSingle()
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
  if (authErr || !authData.user) return { customer: null, error: authErr?.message || 'Error al crear cuenta' }

  const { data, error } = await supabase
    .from('wholesale_customers')
    .insert({
      business_id:   input.businessId,
      auth_user_id:  authData.user.id,
      name:          input.name,
      business_name: input.businessName || null,
      email:         input.email,
      whatsapp:      input.whatsapp || null,
      province:      input.province || null,
      city:          input.city || null,
      instagram:     input.instagram || null,
    })
    .select()
    .single()

  if (error) return { customer: null, error: error.message }
  return { customer: data as WholesaleCustomer, error: null }
}

export async function loginCustomer(
  email: string, password: string, businessId: string
): Promise<{ customer: WholesaleCustomer | null; error: string | null }> {
  const { error: authErr } = await supabase.auth.signInWithPassword({ email, password })
  if (authErr) return { customer: null, error: 'Email o contraseña incorrectos' }

  const customer = await getCustomerByAuthId(businessId)
  if (!customer) {
    await supabase.auth.signOut()
    return { customer: null, error: 'Esta cuenta no pertenece a este portal' }
  }

  // Update last_login
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
  const { data } = await supabase
    .from('inventory')
    .select('id, code, name, category, subcategory, stock_quantity, sale_price, precio_mayorista, visible_in_wholesale, cost_price, description')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .eq('visible_in_wholesale', true)
    .gt('stock_quantity', 0)
    .order('category')
    .order('name')
  return (data || []) as PortalProduct[]
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function createOrder(input: {
  businessId: string
  customerId: string
  items: CartItem[]
  notes?: string
}): Promise<{ order: WholesaleOrder | null; error: string | null }> {
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
    product_code:      i.productCode,
    quantity:          i.quantity,
    unit_price:        i.unitPrice,
    subtotal:          i.unitPrice * i.quantity,
  }))

  await supabase.from('wholesale_order_items').insert(itemsToInsert)

  return { order: order as WholesaleOrder, error: null }
}

export async function getCustomerOrders(customerId: string): Promise<WholesaleOrder[]> {
  const { data } = await supabase
    .from('wholesale_orders')
    .select('*, items:wholesale_order_items(*)')
    .eq('customer_id', customerId)
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
    .select('*, customer:wholesale_customers(id,name,business_name,whatsapp), items:wholesale_order_items(*)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(100)
  return (data || []) as WholesaleOrder[]
}

export async function updateOrderStatus(
  orderId: string,
  status: WholesaleOrder['status'],
  adminNotes?: string
): Promise<void> {
  await supabase
    .from('wholesale_orders')
    .update({ status, admin_notes: adminNotes || null, updated_at: new Date().toISOString() })
    .eq('id', orderId)
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
