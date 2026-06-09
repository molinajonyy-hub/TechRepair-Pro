import type { SearchAdapter } from './searchTypes'

// ─── Inventory / Products ─────────────────────────────────────────────────────

export interface ProductSearchItem {
  id: string
  name: string
  code?: string | null
  description?: string | null
  category?: string | null
  subcategory?: string | null
  location?: string | null
  supplier_code?: string | null
  variant_name?: string | null
  [key: string]: unknown
}

export const productSearchAdapter: SearchAdapter<ProductSearchItem> = {
  fields: [
    { getValue: (p) => p.code,         weight: 5  }, // SKU/barcode: máxima prioridad
    { getValue: (p) => p.name,         weight: 3  },
    { getValue: (p) => p.variant_name, weight: 2  },
    { getValue: (p) => p.category,     weight: 1.5 },
    { getValue: (p) => p.subcategory,  weight: 1.5 },
    { getValue: (p) => p.description,  weight: 1  },
    { getValue: (p) => p.location,     weight: 0.8 },
    { getValue: (p) => p.supplier_code, weight: 0.8 },
  ],
  getLabel: (p) => p.name,
}

// ─── Customers ────────────────────────────────────────────────────────────────

export interface CustomerSearchItem {
  id: string
  name: string
  phone?: string | null
  email?: string | null
  cuit?: string | null
  documento?: string | null
  customer_type?: string | null
  notes?: string | null
  [key: string]: unknown
}

export const customerSearchAdapter: SearchAdapter<CustomerSearchItem> = {
  fields: [
    { getValue: (c) => c.documento,  weight: 10 }, // DNI/CUIT: identificador único
    { getValue: (c) => c.cuit,       weight: 10 },
    { getValue: (c) => c.phone,      weight: 5  },
    { getValue: (c) => c.email,      weight: 4  },
    { getValue: (c) => c.name,       weight: 3  },
    { getValue: (c) => c.notes,      weight: 0.5 },
  ],
  getLabel: (c) => c.name,
}

// ─── Repair Orders ────────────────────────────────────────────────────────────

export interface OrderSearchItem {
  id: string
  order_number?: string | null
  customer_name?: string | null
  brand?: string | null
  model?: string | null
  imei?: string | null
  problem?: string | null
  [key: string]: unknown
}

export const orderSearchAdapter: SearchAdapter<OrderSearchItem> = {
  fields: [
    { getValue: (o) => o.imei,          weight: 10 }, // IMEI: identificador único
    { getValue: (o) => o.order_number,  weight: 7  },
    { getValue: (o) => o.customer_name, weight: 3  },
    { getValue: (o) => o.brand,         weight: 2  },
    { getValue: (o) => o.model,         weight: 2  },
    { getValue: (o) => o.problem,       weight: 1  },
  ],
  getLabel: (o) => o.order_number ?? o.id,
}

// ─── Comprobantes ─────────────────────────────────────────────────────────────

export interface ComprobanteSearchItem {
  numero?: string | null
  tipo?: string | null
  cliente_nombre?: string | null
  [key: string]: unknown
}

export const comprobanteSearchAdapter: SearchAdapter<ComprobanteSearchItem> = {
  fields: [
    { getValue: (c) => c.numero,         weight: 5 },
    { getValue: (c) => c.cliente_nombre, weight: 3 },
    { getValue: (c) => c.tipo,           weight: 2 },
  ],
  getLabel: (c) => c.numero ?? '',
}

// ─── Suppliers ────────────────────────────────────────────────────────────────

export interface SupplierSearchItem {
  id: string
  name: string
  cuit?: string | null
  email?: string | null
  phone?: string | null
  [key: string]: unknown
}

export const supplierSearchAdapter: SearchAdapter<SupplierSearchItem> = {
  fields: [
    { getValue: (s) => s.cuit,  weight: 8 },
    { getValue: (s) => s.phone, weight: 4 },
    { getValue: (s) => s.email, weight: 3 },
    { getValue: (s) => s.name,  weight: 3 },
  ],
  getLabel: (s) => s.name,
}
