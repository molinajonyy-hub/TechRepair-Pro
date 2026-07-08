import { supabase, type Order, type Customer, type Device, type Note,
  type PartUsed, type InventoryItem, type Supplier, type Expense,
  type User, type StatusHistory } from '../lib/supabase'

type CustomerPayload = Omit<Customer, 'id' | 'created_at' | 'updated_at' | 'business_id' | 'created_by'>
type OrderPayload = Omit<Order, 'id' | 'created_at' | 'updated_at' | 'business_id' | 'created_by'>
type DevicePayload = Omit<Device, 'id' | 'created_at' | 'updated_at' | 'business_id' | 'created_by'>

type CustomerContext = {
  businessId: string
  userId: string
}

type CachedProfile = {
  business_id?: string
}

type CatalogItem = {
  id: string
  name: string
}

type DeviceModelCatalogItem = CatalogItem & {
  brand_id: string
}

const CUSTOMER_PROFILE_CACHE_KEY_PREFIX = 'techrepair_profile'
const LOCAL_ID_PREFIX = 'local:'

const FALLBACK_BRANDS: CatalogItem[] = [
  { id: `${LOCAL_ID_PREFIX}apple`, name: 'Apple' },
  { id: `${LOCAL_ID_PREFIX}samsung`, name: 'Samsung' },
  { id: `${LOCAL_ID_PREFIX}xiaomi`, name: 'Xiaomi' },
  { id: `${LOCAL_ID_PREFIX}motorola`, name: 'Motorola' },
  { id: `${LOCAL_ID_PREFIX}huawei`, name: 'Huawei' },
  { id: `${LOCAL_ID_PREFIX}lg`, name: 'LG' },
  { id: `${LOCAL_ID_PREFIX}nokia`, name: 'Nokia' },
  { id: `${LOCAL_ID_PREFIX}sony`, name: 'Sony' },
  { id: `${LOCAL_ID_PREFIX}lenovo`, name: 'Lenovo' },
  { id: `${LOCAL_ID_PREFIX}asus`, name: 'Asus' },
]

const FALLBACK_MODELS_BY_BRAND: Record<string, string[]> = {
  [`${LOCAL_ID_PREFIX}apple`]: ['iPhone 11', 'iPhone 12', 'iPhone 13', 'iPhone 14', 'iPhone 15', 'iPad Air'],
  [`${LOCAL_ID_PREFIX}samsung`]: ['Galaxy A14', 'Galaxy A34', 'Galaxy S21', 'Galaxy S22', 'Galaxy S23', 'Galaxy Tab A8'],
  [`${LOCAL_ID_PREFIX}xiaomi`]: ['Redmi Note 11', 'Redmi Note 12', 'Redmi Note 13', 'Poco X5', 'Poco X6'],
  [`${LOCAL_ID_PREFIX}motorola`]: ['Moto G54', 'Moto G84', 'Edge 40', 'Edge 50 Fusion'],
  [`${LOCAL_ID_PREFIX}huawei`]: ['P30', 'P40 Lite', 'Nova 9'],
  [`${LOCAL_ID_PREFIX}lg`]: ['K52', 'Velvet', 'G8 ThinQ'],
  [`${LOCAL_ID_PREFIX}nokia`]: ['G21', 'G42', 'C32'],
  [`${LOCAL_ID_PREFIX}sony`]: ['Xperia 10', 'Xperia 1'],
  [`${LOCAL_ID_PREFIX}lenovo`]: ['Tab M10', 'IdeaPad 3'],
  [`${LOCAL_ID_PREFIX}asus`]: ['Zenfone 9', 'Zenfone 10', 'ROG Phone 6'],
}

const loadCachedCustomerContext = (userId: string): CustomerContext | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const rawProfile = window.localStorage.getItem(`${CUSTOMER_PROFILE_CACHE_KEY_PREFIX}:${userId}`)

    if (!rawProfile) {
      return null
    }

    const profile = JSON.parse(rawProfile) as CachedProfile

    if (!profile.business_id) {
      return null
    }

    return {
      businessId: profile.business_id,
      userId,
    }
  } catch {
    return null
  }
}

const getCurrentCustomerContext = async (): Promise<CustomerContext> => {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    throw new Error('No hay una sesión activa para operar con clientes.')
  }

  const cachedContext = loadCachedCustomerContext(user.id)

  try {
    const { data, error } = await supabase.rpc('get_my_profile')

    if (error) {
      throw error
    }

    const profileRow = Array.isArray(data) ? data[0] : data
    const businessId = profileRow?.business_id

    if (!businessId) {
      throw new Error('No se encontró un negocio activo para este usuario.')
    }

    return {
      businessId,
      userId: user.id,
    }
  } catch (error) {
    if (cachedContext) {
      return cachedContext
    }

    throw error
  }
}

const getErrorMessageText = (error: unknown) => {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }

  return ''
}

const getCustomerErrorMessage = (error: unknown, action: string) => {
  const fallbackMessage = `Error al ${action} cliente`
  const rawMessage = getErrorMessageText(error)

  if (!rawMessage) {
    return fallbackMessage
  }

  const message = rawMessage.toLowerCase()

  if (message.includes('business_id') && message.includes('does not exist')) {
    return 'La tabla customers no tiene la columna business_id. Ejecutá el script supabase/fix_customers_business_context.sql.'
  }

  if (message.includes('created_by') && message.includes('does not exist')) {
    return 'La tabla customers no tiene la columna created_by. Ejecutá el script supabase/fix_customers_business_context.sql.'
  }

  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'No tenés permisos para operar con clientes en este negocio. Revisá las políticas de customers.'
  }

  if (message.includes('no hay una sesión activa') || message.includes('negocio activo')) {
    return rawMessage
  }

  return rawMessage || fallbackMessage
}

const isMissingColumnError = (error: unknown, columnName: string) => {
  const rawMessage = getErrorMessageText(error)

  if (!rawMessage) {
    return false
  }

  const message = rawMessage.toLowerCase()
  const normalizedColumn = columnName.toLowerCase()

  return (
    message.includes(normalizedColumn) &&
    (message.includes('does not exist') ||
      message.includes('could not find the') ||
      message.includes('schema cache') ||
      message.includes('column'))
  )
}

const insertWithOptionalColumns = async (
  table: string,
  payload: Record<string, unknown>,
  optionalColumns: string[] = []
) => {
  const insertPayload = { ...payload }
  const remainingColumns = new Set(optionalColumns)

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .insert(insertPayload)
      .select()
      .single()

    if (!error) {
      return data
    }

    const missingColumn = Array.from(remainingColumns).find((columnName) =>
      isMissingColumnError(error, columnName)
    )

    if (!missingColumn) {
      throw error
    }

    delete insertPayload[missingColumn]
    remainingColumns.delete(missingColumn)
  }
}

const getOrderErrorMessage = (error: unknown, action: string) => {
  const fallbackMessage = `Error al ${action} orden`
  const rawMessage = getErrorMessageText(error)

  if (!rawMessage) {
    return fallbackMessage
  }

  const message = rawMessage.toLowerCase()

  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'No tenés permisos para crear órdenes en este negocio. Revisá que tu usuario tenga rol owner, admin o technician.'
  }

  if (message.includes('no hay una sesión activa') || message.includes('no se encontró un negocio activo')) {
    return rawMessage
  }

  return rawMessage || fallbackMessage
}

const getDeviceErrorMessage = (error: unknown, action: string) => {
  const fallbackMessage = `Error al ${action} dispositivo`
  const rawMessage = getErrorMessageText(error)

  if (!rawMessage) {
    return fallbackMessage
  }

  const message = rawMessage.toLowerCase()

  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'No tenés permisos para crear dispositivos para este cliente. Revisá que el cliente pertenezca a tu negocio y que tu usuario tenga rol owner, admin o technician.'
  }

  if (message.includes('no hay una sesión activa') || message.includes('no se encontró un negocio activo')) {
    return rawMessage
  }

  return rawMessage || fallbackMessage
}

const assertCustomerBelongsToBusiness = async (customerId: string, businessId: string) => {
  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('business_id', businessId)
    .maybeSingle()

  if (error) {
    throw new Error(getCustomerErrorMessage(error, 'validar'))
  }

  if (!data) {
    throw new Error('El cliente seleccionado no pertenece al negocio activo o ya no está disponible.')
  }
}

const createLocalCatalogId = (value: string) =>
  `${LOCAL_ID_PREFIX}${value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item'}`

const buildFallbackModelCatalog = (brandId?: string) => {
  const entries = Object.entries(FALLBACK_MODELS_BY_BRAND)
  const filteredEntries = brandId ? entries.filter(([currentBrandId]) => currentBrandId === brandId) : entries

  return filteredEntries.flatMap(([currentBrandId, names]) =>
    names.map((name) => ({
      id: createLocalCatalogId(`${currentBrandId}-${name}`),
      name,
      brand_id: currentBrandId,
    }))
  )
}

const isMissingRelationError = (error: unknown, relationName: string) => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const maybeError = error as { code?: string; message?: string; details?: string | null; hint?: string | null }
  const text = `${maybeError.message || ''} ${maybeError.details || ''} ${maybeError.hint || ''}`.toLowerCase()

  return (
    maybeError.code === 'PGRST205' ||
    text.includes(`table 'public.${relationName.toLowerCase()}'`) ||
    text.includes(`relation "${relationName.toLowerCase()}" does not exist`)
  )
}

// ============================================
// Orders Service
// ============================================
export const ordersService = {
  async getAll(options?: { 
    status?: string
    priority?: string
    limit?: number
  }) {
    const { businessId } = await getCurrentCustomerContext()
    
    let query = supabase
      .from('orders')
      .select(`
        *,
        customer:customers(id, name, phone, email),
        device:devices(id, brand, model, type),
        technician:users(id, name)
      `)
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
    
    if (options?.status) {
      query = query.eq('status', options.status)
    }
    if (options?.priority) {
      query = query.eq('priority', options.priority)
    }
    if (options?.limit) {
      query = query.limit(options.limit)
    }
    
    const { data, error } = await query
    
    if (error) throw error
    return data as (Order & {
      customer: Customer
      device: Device
      technician: User | null
    })[]
  },

  async getById(id: string) {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        customer:customers(*),
        device:devices(*),
        technician:users(id, name),
        notes(*),
        parts_used(*),
        status_history(*)
      `)
      .eq('id', id)
      .single()
    
    if (error) throw error
    return data as Order & {
      customer: Customer
      device: Device
      technician: User | null
      notes: Note[]
      parts_used: PartUsed[]
      status_history: StatusHistory[]
    }
  },

  async create(order: OrderPayload) {
    try {
      const { businessId, userId } = await getCurrentCustomerContext()

      await assertCustomerBelongsToBusiness(order.customer_id, businessId)

      const data = await insertWithOptionalColumns(
        'orders',
        {
          ...order,
          business_id: businessId,
          created_by: userId,
          updated_at: new Date().toISOString(),
        },
        ['business_id', 'created_by']
      )

      return data as Order
    } catch (error) {
      throw new Error(getOrderErrorMessage(error, 'crear'))
    }
  },

  async update(id: string, order: Partial<Order>) {
    const { data, error } = await supabase
      .from('orders')
      .update({ ...order, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as Order
  },

  async updateStatus(id: string, status: Order['status'], note?: string) {
    const { error: updateError } = await supabase
      .from('orders')
      .update({ 
        status, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', id)
    
    if (updateError) throw updateError

    const { error: historyError } = await supabase
      .from('status_history')
      .insert({
        order_id: id,
        status,
        note: note || `Cambio de estado a ${status}`,
        created_at: new Date().toISOString()
      })
    
    if (historyError) throw historyError
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  }
}

// ============================================
// Customers Service
// ============================================
export const customersService = {
  async getAll() {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .order('name', { ascending: true })
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'obtener'))
    return data as Customer[]
  },

  async getById(id: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('customers')
      .select(`
        *,
        orders:orders(
          id,
          status,
          total_cost,
          estimated_total,
          created_at,
          device:devices(brand, model)
        ),
        devices:devices(*)
      `)
      .eq('id', id)
      .eq('business_id', businessId)
      .single()
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'obtener'))
    return data as Customer & {
      orders: (Order & {
        device?: Pick<Device, 'brand' | 'model'> | null
      })[]
      devices: Device[]
    }
  },

  async create(customer: CustomerPayload) {
    const { businessId, userId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('customers')
      .insert({
        ...customer,
        business_id: businessId,
        created_by: userId,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'crear'))
    return data as Customer
  },

  async update(id: string, customer: Partial<Customer>) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('customers')
      .update({ ...customer, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single()
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'actualizar'))
    return data as Customer
  },

  async search(query: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', businessId)
      .or(`name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      .limit(10)
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'buscar'))
    return data as Customer[]
  },

  async delete(id: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { error } = await supabase
      .from('customers')
      .delete()
      .eq('id', id)
      .eq('business_id', businessId)
    
    if (error) throw new Error(getCustomerErrorMessage(error, 'eliminar'))
  }
}

// ============================================
// Devices Service
// ============================================
export const devicesService = {
  async getByCustomer(customerId: string) {
    const { data, error } = await supabase
      .from('devices')
      .select('*')
      .eq('customer_id', customerId)
    
    if (error) throw error
    return data as Device[]
  },

  async create(device: DevicePayload) {
    try {
      const { businessId, userId } = await getCurrentCustomerContext()

      await assertCustomerBelongsToBusiness(device.customer_id, businessId)

      const data = await insertWithOptionalColumns(
        'devices',
        {
          ...device,
          business_id: businessId,
          created_by: userId,
        },
        ['business_id', 'created_by']
      )

      return data as Device
    } catch (error) {
      throw new Error(getDeviceErrorMessage(error, 'crear'))
    }
  },

  async update(id: string, device: Partial<Device>) {
    const { data, error } = await supabase
      .from('devices')
      .update({ ...device, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as Device
  }
}

// ============================================
// Notes Service
// ============================================
export const notesService = {
  async getByOrder(orderId: string) {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
    
    if (error) throw error
    return data as Note[]
  },

  async create(note: Omit<Note, 'id' | 'created_at'>) {
    const { data, error } = await supabase
      .from('notes')
      .insert(note)
      .select()
      .single()
    
    if (error) throw error
    return data as Note
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('notes')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  }
}

// ============================================
// Parts Service
// ============================================
export const partsService = {
  async getByOrder(orderId: string) {
    const { data, error } = await supabase
      .from('parts_used')
      .select('*')
      .eq('order_id', orderId)
    
    if (error) throw error
    return data as PartUsed[]
  },

  async create(part: Omit<PartUsed, 'id' | 'created_at' | 'subtotal'>) {
    const { data, error } = await supabase
      .from('parts_used')
      .insert({
        ...part,
        subtotal: part.quantity * part.unit_price
      })
      .select()
      .single()
    
    if (error) throw error
    return data as PartUsed
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('parts_used')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  },

  async calculateTotal(orderId: string) {
    const { data, error } = await supabase
      .from('parts_used')
      .select('subtotal')
      .eq('order_id', orderId)
    
    if (error) throw error
    return data?.reduce((sum, part) => sum + (part.subtotal || 0), 0) || 0
  }
}

// ============================================
// Inventory Service
// ============================================
export const inventoryService = {
  async getAll() {
    const { businessId } = await getCurrentCustomerContext()
    
    const { data, error } = await supabase
      .from('inventory')
      .select(`
        *,
        supplier:suppliers(id, name)
      `)
      .eq('business_id', businessId)
      .order('name', { ascending: true })
    
    if (error) throw error
    return data as (InventoryItem & { supplier: Supplier | null })[]
  },

  async getLowStock() {
    const { businessId } = await getCurrentCustomerContext()
    
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('business_id', businessId)
      .lte('stock', 5)
    
    if (error) throw error
    return data as InventoryItem[]
  },

  async create(item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>) {
    const { data, error } = await supabase
      .from('inventory')
      .insert(item)
      .select()
      .single()
    
    if (error) throw error
    return data as InventoryItem
  },

  async update(id: string, item: Partial<InventoryItem>) {
    const { data, error } = await supabase
      .from('inventory')
      .update({ ...item, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as InventoryItem
  },

  async updateStock(id: string, quantity: number) {
    const { data, error } = await supabase
      .from('inventory')
      .update({ stock: quantity, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as InventoryItem
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('inventory')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  }
}

// ============================================
// Suppliers Service
// ============================================
export const suppliersService = {
  async getAll() {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('name', { ascending: true })
    
    if (error) throw error
    return data as Supplier[]
  },

  async create(supplier: Omit<Supplier, 'id' | 'created_at' | 'updated_at'>) {
    const { data, error } = await supabase
      .from('suppliers')
      .insert(supplier)
      .select()
      .single()
    
    if (error) throw error
    return data as Supplier
  },

  async update(id: string, supplier: Partial<Supplier>) {
    const { data, error } = await supabase
      .from('suppliers')
      .update({ ...supplier, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as Supplier
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  }
}

// ============================================
// Expenses Service
// ============================================
export const expensesService = {
  async getAll() {
    const { data, error } = await supabase
      .from('expenses')
      .select(`
        *,
        supplier:suppliers(id, name)
      `)
      .order('date', { ascending: false })
    
    if (error) throw error
    return data as (Expense & { supplier: Supplier | null })[]
  },

  // create()/update()/delete() eliminados (M6 Fase 9): eran writes directos
  // client-side sin callers vivos. Alta por RPC create_expense_with_finance o
  // factura documental (Expenses.tsx); UPDATE/DELETE en lockdown (sin policy).
  // El reverso económico va por reverse_operating_expense_atomic (append-only).
}

// ============================================
// Users Service
// ============================================
export const usersService = {
  async getAll() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('name', { ascending: true })
    
    if (error) throw error
    return data as User[]
  },

  async getActiveTechnicians() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'technician')
      .eq('active', true)
      .order('name', { ascending: true })
    
    if (error) throw error
    return data as User[]
  },

  async create(user: Omit<User, 'id' | 'created_at'>) {
    const { data, error } = await supabase
      .from('users')
      .insert(user)
      .select()
      .single()
    
    if (error) throw error
    return data as User
  },

  async update(id: string, user: Partial<User>) {
    const { data, error } = await supabase
      .from('users')
      .update(user)
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as User
  },

  async toggleActive(id: string, active: boolean) {
    const { data, error } = await supabase
      .from('users')
      .update({ active })
      .eq('id', id)
      .select()
      .single()
    
    if (error) throw error
    return data as User
  },

  async delete(id: string) {
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id)
    
    if (error) throw error
  }
}

// ============================================
// Brands Service
// ============================================
export const brandsService = {
  async getAll() {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .eq('business_id', businessId)
      .order('name', { ascending: true })
    
    if (error) {
      if (isMissingRelationError(error, 'brands')) {
        return FALLBACK_BRANDS
      }

      throw error
    }

    return (data as CatalogItem[]) || []
  },

  async getOrCreate(name: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .rpc('get_or_create_brand', { 
        p_name: name, 
        p_business_id: businessId 
      })
    
    if (error) {
      if (isMissingRelationError(error, 'brands')) {
        return createLocalCatalogId(name)
      }

      throw error
    }

    return data
  },

  async create(name: string) {
    const { businessId, userId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('brands')
      .insert({
        name: name.trim(),
        business_id: businessId,
        created_by: userId,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()
    
    if (error) {
      if (isMissingRelationError(error, 'brands')) {
        return {
          id: createLocalCatalogId(name),
          name: name.trim(),
          business_id: businessId,
          created_by: userId,
        }
      }

      throw error
    }

    return data
  },

  async update(id: string, name: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('brands')
      .update({ 
        name: name.trim(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single()
    
    if (error) throw error
    return data
  },

  async delete(id: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { error } = await supabase
      .from('brands')
      .delete()
      .eq('id', id)
      .eq('business_id', businessId)
    
    if (error) throw error
  }
}

// ============================================
// Device Models Service
// ============================================
export const deviceModelsService = {
  async getAll(brandId?: string) {
    const { businessId } = await getCurrentCustomerContext()

    let query = supabase
      .from('device_models')
      .select('*')
      .eq('business_id', businessId)
    
    if (brandId) {
      query = query.eq('brand_id', brandId)
    }
    
    query = query.order('name', { ascending: true })
    
    const { data, error } = await query
    
    if (error) {
      if (isMissingRelationError(error, 'device_models')) {
        return buildFallbackModelCatalog(brandId)
      }

      throw error
    }

    return (data as DeviceModelCatalogItem[]) || []
  },

  async getOrCreate(name: string, brandId: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .rpc('get_or_create_model', { 
        p_name: name, 
        p_brand_id: brandId,
        p_business_id: businessId
      })
    
    if (error) {
      if (isMissingRelationError(error, 'device_models')) {
        return createLocalCatalogId(`${brandId}-${name}`)
      }

      throw error
    }

    return data
  },

  async create(name: string, brandId: string) {
    const { businessId, userId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('device_models')
      .insert({
        name: name.trim(),
        brand_id: brandId,
        business_id: businessId,
        created_by: userId,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()
    
    if (error) {
      if (isMissingRelationError(error, 'device_models')) {
        return {
          id: createLocalCatalogId(`${brandId}-${name}`),
          name: name.trim(),
          brand_id: brandId,
          business_id: businessId,
          created_by: userId,
        }
      }

      throw error
    }

    return data
  },

  async update(id: string, name: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { data, error } = await supabase
      .from('device_models')
      .update({ 
        name: name.trim(),
        updated_at: new Date().toISOString() 
      })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single()
    
    if (error) throw error
    return data
  },

  async delete(id: string) {
    const { businessId } = await getCurrentCustomerContext()

    const { error } = await supabase
      .from('device_models')
      .delete()
      .eq('id', id)
      .eq('business_id', businessId)
    
    if (error) throw error
  }
}
