// ─── Portal Mayorista — tipos compartidos ────────────────────────────────────

export interface PortalBusiness {
  id: string
  name: string
  logo_url: string | null
  wholesale_portal_enabled: boolean
  wholesale_portal_slug: string
  wholesale_whatsapp: string | null
  wholesale_portal_theme: Record<string, string> | null
}

export interface WholesaleCustomer {
  id: string
  business_id: string
  auth_user_id: string | null
  name: string
  business_name: string | null
  email: string
  whatsapp: string | null
  whatsapp_verified: boolean
  province: string | null
  city: string | null
  instagram: string | null
  approved: boolean
  suspended: boolean
  notes: string | null
  tags: string[] | null
  last_login: string | null
  last_order_at: string | null
  total_orders: number
  total_spent: number
  created_at: string
  updated_at: string
}

export interface PortalProduct {
  id: string
  code: string
  name: string
  category: string
  subcategory?: string | null
  stock_quantity: number
  sale_price: number
  precio_mayorista: number | null
  visible_in_wholesale: boolean
  cost_price: number
  description?: string | null
}

export interface CartItem {
  inventoryItemId: string
  productName: string
  productCode: string
  unitPrice: number
  quantity: number
  stock: number
}

export interface WholesaleOrder {
  id: string
  business_id: string
  customer_id: string
  order_number: string
  status: 'pending_whatsapp' | 'pending_review' | 'approved' | 'rejected' | 'invoiced' | 'delivered' | 'cancelled'
  subtotal: number
  total: number
  notes: string | null
  admin_notes: string | null
  whatsapp_sent_at: string | null
  created_at: string
  updated_at: string
  customer?: WholesaleCustomer
  items?: WholesaleOrderItem[]
}

export interface WholesaleOrderItem {
  id: string
  order_id: string
  inventory_item_id: string | null
  product_name: string
  product_code: string | null
  quantity: number
  unit_price: number
  subtotal: number
}

export const ORDER_STATUS_LABEL: Record<WholesaleOrder['status'], string> = {
  pending_whatsapp: 'Enviado por WA',
  pending_review:   'En revisión',
  approved:         'Aprobado',
  rejected:         'Rechazado',
  invoiced:         'Facturado',
  delivered:        'Entregado',
  cancelled:        'Cancelado',
}

export const ORDER_STATUS_COLOR: Record<WholesaleOrder['status'], string> = {
  pending_whatsapp: '#f59e0b',
  pending_review:   '#6366f1',
  approved:         '#10b981',
  rejected:         '#ef4444',
  invoiced:         '#3b82f6',
  delivered:        '#34d399',
  cancelled:        '#6b7280',
}
