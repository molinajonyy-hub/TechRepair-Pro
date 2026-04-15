// Datos mock centralizados para desarrollo
// Reemplazar con llamadas a Supabase en producción

export interface Order {
  id: string
  customer_id: string
  device_id: string
  technician_id: string
  status: 'new' | 'diagnosis' | 'repair' | 'ready' | 'completed' | 'cancelled'
  priority: 'urgent' | 'high' | 'medium' | 'low'
  created_at: string
  updated_at: string
  estimated_total: number
  labor_cost: number
  total_cost: number
}

export interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
  created_at: string
}

export interface Device {
  id: string
  customer_id: string
  type: string
  brand: string
  model: string
  serial: string
  issue: string
  diagnosis?: string
}

export interface Note {
  id: string
  order_id: string
  author: string
  text: string
  created_at: string
}

export interface PartUsed {
  id: string
  order_id: string
  code: string
  description: string
  quantity: number
  unit_price: number
  subtotal: number
}

export interface InventoryItem {
  id: string
  code: string
  name: string
  category: string
  stock: number
  min_stock: number
  price: number
}

export interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'technician' | 'receptionist'
  active: boolean
}

// Mock data
export const mockOrders: Order[] = [
  {
    id: '001',
    customer_id: '1',
    device_id: '1',
    technician_id: '2',
    status: 'repair',
    priority: 'high',
    created_at: '2024-01-15T10:30:00',
    updated_at: '2024-01-15T14:30:00',
    estimated_total: 450,
    labor_cost: 150,
    total_cost: 0
  },
  {
    id: '002',
    customer_id: '2',
    device_id: '2',
    technician_id: '3',
    status: 'diagnosis',
    priority: 'medium',
    created_at: '2024-01-15T11:00:00',
    updated_at: '2024-01-15T11:00:00',
    estimated_total: 0,
    labor_cost: 50,
    total_cost: 0
  },
  {
    id: '003',
    customer_id: '3',
    device_id: '3',
    technician_id: '2',
    status: 'ready',
    priority: 'low',
    created_at: '2024-01-14T09:00:00',
    updated_at: '2024-01-15T16:00:00',
    estimated_total: 320,
    labor_cost: 100,
    total_cost: 320
  }
]

export const mockCustomers: Customer[] = [
  {
    id: '1',
    name: 'Juan Pérez',
    phone: '+54 9 11 1234-5678',
    email: 'juan@email.com',
    address: 'Av. Corrientes 1234, CABA',
    created_at: '2024-01-01'
  },
  {
    id: '2',
    name: 'María García',
    phone: '+54 9 11 8765-4321',
    email: 'maria@email.com',
    address: 'Av. Santa Fe 5678, CABA',
    created_at: '2024-01-02'
  },
  {
    id: '3',
    name: 'Carlos López',
    phone: '+54 9 11 2468-1357',
    email: 'carlos@email.com',
    address: 'Av. Libertador 9876, CABA',
    created_at: '2024-01-03'
  }
]

export const mockDevices: Device[] = [
  {
    id: '1',
    customer_id: '1',
    type: 'smartphone',
    brand: 'Apple',
    model: 'iPhone 13 Pro',
    serial: 'ABC123456789',
    issue: 'Pantalla rota, no enciende'
  },
  {
    id: '2',
    customer_id: '2',
    type: 'smartphone',
    brand: 'Samsung',
    model: 'Galaxy S21',
    serial: 'DEF987654321',
    issue: 'No carga, problema de batería'
  },
  {
    id: '3',
    customer_id: '3',
    type: 'tablet',
    brand: 'Apple',
    model: 'iPad Pro 12"',
    serial: 'GHI456789123',
    issue: 'Pantalla con líneas, touch no responde'
  }
]

export const mockInventory: InventoryItem[] = [
  {
    id: '1',
    code: 'SCR-IPH13P',
    name: 'Pantalla iPhone 13 Pro OLED',
    category: 'Pantallas',
    stock: 5,
    min_stock: 1,
    price: 280
  },
  {
    id: '2',
    code: 'BAT-IPH13P',
    name: 'Batería iPhone 13 Pro',
    category: 'Baterías',
    stock: 12,
    min_stock: 1,
    price: 45
  },
  {
    id: '3',
    code: 'SCR-SAM21',
    name: 'Pantalla Samsung S21',
    category: 'Pantallas',
    stock: 2,
    min_stock: 1,
    price: 220
  },
  {
    id: '4',
    code: 'CHG-USB-C',
    name: 'Conector de Carga USB-C',
    category: 'Conectores',
    stock: 25,
    min_stock: 1,
    price: 15
  }
]

export const mockUsers: User[] = [
  {
    id: '1',
    name: 'Admin Principal',
    email: 'admin@techrepair.com',
    role: 'admin',
    active: true
  },
  {
    id: '2',
    name: 'Técnico A',
    email: 'tecnicoa@techrepair.com',
    role: 'technician',
    active: true
  },
  {
    id: '3',
    name: 'Técnico B',
    email: 'tecnicob@techrepair.com',
    role: 'technician',
    active: true
  }
]

// Helper functions
export const getStatusLabel = (status: string): string => {
  const labels: Record<string, string> = {
    new: 'Nueva',
    diagnosis: 'Diagnóstico',
    repair: 'En Reparación',
    ready: 'Listo',
    completed: 'Completada',
    cancelled: 'Cancelada'
  }
  return labels[status] || status
}

export const getPriorityLabel = (priority: string): string => {
  const labels: Record<string, string> = {
    urgent: 'Urgente',
    high: 'Alta',
    medium: 'Media',
    low: 'Baja'
  }
  return labels[priority] || priority
}

export const getStatusColor = (status: string): string => {
  const colors: Record<string, string> = {
    new: '#64748b',
    diagnosis: '#06b6d4',
    repair: '#6366f1',
    ready: '#10b981',
    completed: '#10b981',
    cancelled: '#dc2626'
  }
  return colors[status] || '#64748b'
}

export const getPriorityColor = (priority: string): string => {
  const colors: Record<string, string> = {
    urgent: '#dc2626',
    high: '#f59e0b',
    medium: '#6366f1',
    low: '#64748b'
  }
  return colors[priority] || '#64748b'
}
