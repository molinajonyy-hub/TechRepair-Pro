/**
 * productService — fuente única de verdad para crear y editar productos.
 * Todos los módulos (Inventario, Órdenes, Comprobantes, Gastos, Proveedores)
 * deben pasar por aquí en lugar de insertar en inventory directamente.
 */
import { supabase } from '../lib/supabase'
import { inventoryMovementsService } from './inventoryMovementsService'
import type { InventoryItem } from '../hooks/useInventory'

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface CreateProductInput {
  business_id: string
  created_by:  string
  name:         string
  code?:        string
  barcode?:     string
  description?: string
  category?:    string
  subcategory?: string
  brand?:       string
  model?:       string
  supplier_id?: string
  tipo:         'product' | 'service'

  // Precios
  base_currency:      'ARS' | 'USD'
  base_price:         number        // precio en moneda base
  cost_price:         number        // costo en ARS (siempre)
  cost_price_usd?:    number        // costo en USD si base es USD
  sale_price:         number        // precio venta en ARS
  wholesale_price_ars?: number
  exchange_rate_used?: number
  auto_update_price?: boolean

  // Stock
  stock_quantity?: number
  min_stock?:      number
  location?:       string
  is_active?:      boolean
}

export interface ProductCreationContext {
  registerMovement?: boolean         // sumar stock con auditoría
  movementType?:     'purchase' | 'in' | 'manual'
  sourceType?:       'supplier_invoice' | 'expense' | 'purchase' | 'manual'
  sourceId?:         string          // ID de la factura/gasto origen
  sourceNote?:       string
  unit_cost?:        number
  currency?:         'ARS' | 'USD'
  exchange_rate?:    number
}

export interface PriceResult {
  salePrice:    number
  marginAmount: number
  marginPct:    number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function calculateMarginPct(cost: number, sale: number): number {
  if (!cost || cost <= 0) return 0
  return ((sale - cost) / cost) * 100
}

export function calculateSaleFromMargin(cost: number, marginPct: number): number {
  if (!cost || cost <= 0) return 0
  return cost * (1 + marginPct / 100)
}

export function convertToARS(usd: number, rate: number): number {
  return Math.round(usd * rate * 100) / 100
}

export function convertToUSD(ars: number, rate: number): number {
  if (!rate || rate <= 0) return 0
  return Math.round((ars / rate) * 100) / 100
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

export const productService = {

  // ── Validación ──────────────────────────────────────────────────────────────
  validate(input: Partial<CreateProductInput>): string | null {
    if (!input.name?.trim())         return 'El nombre del producto es obligatorio.'
    if (!input.business_id)          return 'business_id requerido.'
    if (!input.created_by)           return 'created_by requerido.'
    if ((input.sale_price ?? 0) < 0) return 'El precio de venta no puede ser negativo.'
    if ((input.cost_price ?? 0) < 0) return 'El costo no puede ser negativo.'
    return null
  },

  // ── Detectar producto similar (por nombre o código/barcode) ─────────────────
  async checkDuplicate(
    name: string,
    businessId: string,
    code?: string,
    barcode?: string
  ): Promise<InventoryItem | null> {
    let q = supabase
      .from('inventory')
      .select('id, name, code, category, stock_quantity, sale_price, cost_price, tipo')
      .eq('business_id', businessId)
      .eq('is_active', true)

    if (code?.trim()) {
      q = q.or(`name.ilike.${name.trim()},code.eq.${code.trim()}`)
    } else if (barcode?.trim()) {
      q = q.or(`name.ilike.${name.trim()},barcode.eq.${barcode.trim()}`)
    } else {
      q = q.ilike('name', name.trim())
    }

    const { data } = await q.limit(1).maybeSingle()
    return data as InventoryItem | null
  },

  // ── Crear producto (con movimiento de inventario opcional) ──────────────────
  async createProduct(
    input: CreateProductInput,
    context: ProductCreationContext = {}
  ): Promise<InventoryItem> {
    const validationError = productService.validate(input)
    if (validationError) throw new Error(validationError)

    const row = {
      business_id:       input.business_id,
      created_by:        input.created_by,
      name:              input.name.trim(),
      code:              input.code?.trim() || null,
      barcode:           input.barcode?.trim() || null,
      description:       input.description?.trim() || null,
      category:          input.category || 'Otros',
      subcategory:       input.subcategory || null,
      brand:             input.brand?.trim() || null,
      model:             input.model?.trim() || null,
      supplier_id:       input.supplier_id || null,
      tipo:              input.tipo ?? 'product',
      base_currency:     input.base_currency ?? 'ARS',
      base_price:        input.base_price ?? input.cost_price ?? 0,
      cost_price:        input.cost_price ?? 0,
      cost_price_usd:    input.cost_price_usd ?? null,
      sale_price:        input.sale_price ?? 0,
      wholesale_price_ars: input.wholesale_price_ars ?? null,
      exchange_rate_used:  input.exchange_rate_used ?? null,
      auto_update_price:   input.auto_update_price ?? false,
      // Stock — servicios siempre 0
      stock_quantity:    input.tipo === 'service' ? 0 : (input.stock_quantity ?? 0),
      min_stock:         input.tipo === 'service' ? 0 : (input.min_stock ?? 0),
      location:          input.location?.trim() || null,
      is_active:         input.is_active ?? true,
    }

    const { data, error } = await supabase
      .from('inventory')
      .insert(row)
      .select()
      .single()

    if (error) {
      if ((error as any).code === '23505') {
        throw new Error('Ya existe un producto con ese nombre o código.')
      }
      throw new Error(error.message)
    }

    const product = data as InventoryItem

    // Registrar movimiento de inventario si viene de un contexto con stock inicial
    if (
      context.registerMovement &&
      input.tipo !== 'service' &&
      (input.stock_quantity ?? 0) > 0
    ) {
      await inventoryMovementsService.registerMovement(
        product.id,
        (context.movementType ?? 'in') as any,
        input.stock_quantity!,
        (context.sourceType as any) ?? 'manual',
        context.sourceId,
        context.sourceNote ?? 'Stock inicial al crear producto',
        input.business_id,
        input.created_by
      )
    }

    return product
  },

  // ── Actualizar producto ────────────────────────────────────────────────────
  async updateProduct(
    id: string,
    updates: Partial<CreateProductInput>,
    businessId: string
  ): Promise<void> {
    const { error } = await supabase
      .from('inventory')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)

    if (error) throw new Error(error.message)
  },
}
