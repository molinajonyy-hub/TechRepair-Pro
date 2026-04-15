import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Faltan variables de entorno de Supabase. Asegurate de configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en tu archivo .env'
  )
}

export const supabase = createClient(supabaseUrl as string, supabaseAnonKey as string, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  }
})

// Types
export type Order = {
  id: string
  customer_id: string
  device_id: string
  technician_id: string | null
  status: 'new' | 'diagnosis' | 'waiting_approval' | 'repair' | 'waiting_parts' | 'ready_delivery' | 'waiting_payment' | 'completed' | 'cancelled'
  priority: 'urgent' | 'high' | 'medium' | 'low'
  estimated_total: number
  labor_cost: number
  total_cost: number
  notes?: string
  business_id?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export type Customer = {
  id: string
  name: string
  phone: string
  email?: string
  address?: string
  notes?: string
  business_id?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export type Device = {
  id: string
  customer_id: string
  type: 'smartphone' | 'tablet' | 'laptop' | 'smartwatch' | 'other'
  brand: string
  model: string
  serial?: string
  imei?: string
  issue: string
  diagnosis?: string
  business_id?: string
  created_by?: string
  created_at: string
  updated_at: string
}

export type Note = {
  id: string
  order_id: string
  author: string
  text: string
  is_internal: boolean
  created_at: string
}

export type PartUsed = {
  id: string
  order_id: string
  code: string
  description: string
  quantity: number
  unit_price: number
  subtotal: number
  created_at: string
}

export type InventoryItem = {
  id: string
  code: string
  name: string
  category: string
  description?: string
  stock: number
  min_stock: number
  cost_price: number
  sale_price: number
  supplier_id?: string
  created_at: string
  updated_at: string
}

export type Supplier = {
  id: string
  name: string
  contact_name?: string
  phone?: string
  email?: string
  address?: string
  created_at: string
  updated_at: string
}

export type Expense = {
  id: string
  description: string
  category: string
  amount: number
  supplier_id?: string
  date: string
  notes?: string
  created_at: string
}

export type Document = {
  id: string
  order_id: string
  file_name: string
  file_url: string
  file_type: string
  file_size?: number
  uploaded_by?: string
  created_at: string
}

export type User = {
  id: string
  name: string
  email: string
  role: 'admin' | 'technician' | 'receptionist'
  phone?: string
  active: boolean
  created_at: string
}

export type StatusHistory = {
  id: string
  order_id: string
  status: string
  note?: string
  created_at: string
}
