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

  // ── Crear variante de un producto existente ────────────────────────────────
  async createVariant(
    parentId:   string,
    input:      CreateVariantInput,
    context:    ProductCreationContext = {}
  ): Promise<ProductVariant> {
    if (!input.name.trim()) throw new Error('El nombre de la variante es obligatorio.')

    // 1. Crear fila en inventory (necesaria para que el resto del sistema funcione)
    const invRow = {
      business_id:         input.business_id,
      created_by:          input.created_by,
      name:                input.product_name || input.name,
      variant_name:        input.name.trim(),
      code:                input.sku?.trim() || null,
      barcode:             input.barcode?.trim() || null,
      category:            input.category || 'Otros',
      tipo:                'product',
      base_currency:       input.cost_currency ?? 'ARS',
      base_price:          input.cost_currency === 'USD' ? (input.cost_price_usd ?? 0) : (input.cost_price_ars ?? 0),
      cost_price:          input.cost_price_ars ?? 0,
      cost_price_usd:      input.cost_price_usd ?? null,
      sale_price:          input.sale_price_ars ?? 0,
      wholesale_price_ars: input.wholesale_price_ars ?? null,
      exchange_rate_used:  input.exchange_rate_used ?? null,
      stock_quantity:      input.stock ?? 0,
      min_stock:           input.min_stock ?? 0,
      location:            input.location?.trim() || null,
      has_variants:        false,
      parent_id:           parentId,
      is_active:           input.active ?? true,
    }

    const { data: invData, error: invErr } = await supabase
      .from('inventory')
      .insert(invRow)
      .select()
      .single()

    if (invErr) throw new Error(invErr.message)

    // 2. Crear en product_variants (fuente de verdad con metadatos)
    const { data: varData, error: varErr } = await supabase
      .from('product_variants')
      .insert({
        business_id:         input.business_id,
        product_id:          parentId,
        inventory_item_id:   invData.id,
        name:                input.name.trim(),
        sku:                 input.sku?.trim() || null,
        barcode:             input.barcode?.trim() || null,
        attributes:          input.attributes ?? {},
        cost_price_ars:      input.cost_price_ars ?? 0,
        cost_price_usd:      input.cost_price_usd ?? null,
        cost_currency:       input.cost_currency ?? 'ARS',
        sale_price_ars:      input.sale_price_ars ?? 0,
        sale_price_usd:      input.sale_price_usd ?? null,
        wholesale_price_ars: input.wholesale_price_ars ?? null,
        wholesale_price_usd: input.wholesale_price_usd ?? null,
        margin_percent:      input.margin_percent ?? null,
        exchange_rate_used:  input.exchange_rate_used ?? null,
        stock:               input.stock ?? 0,
        min_stock:           input.min_stock ?? 0,
        location:            input.location?.trim() || null,
        active:              input.active ?? true,
        sort_order:          input.sort_order ?? 0,
      })
      .select()
      .single()

    if (varErr) throw new Error(varErr.message)

    // 3. Movimiento de stock inicial (solo si corresponde)
    if (context.registerMovement && (input.stock ?? 0) > 0) {
      await inventoryMovementsService.registerMovement(
        invData.id,
        (context.movementType ?? 'in') as any,
        input.stock!,
        (context.sourceType as any) ?? 'manual',
        context.sourceId,
        context.sourceNote ?? 'Stock inicial de variante',
        input.business_id,
        input.created_by
      )
    }

    return varData as ProductVariant
  },

  // ── Crear producto padre + variantes en una sola operación ─────────────────
  async createProductWithVariants(
    baseInput:  Omit<CreateProductInput, 'stock_quantity' | 'tipo'>,
    variants:   CreateVariantInput[],
    context:    ProductCreationContext = {}
  ): Promise<{ product: InventoryItem; variants: ProductVariant[] }> {
    if (!variants.length) throw new Error('Debés agregar al menos una variante.')

    // Crear producto padre (sin stock, sin tipo service)
    const product = await productService.createProduct({
      ...baseInput,
      tipo:           'product',
      stock_quantity: 0,
    })

    // Actualizar parent para marcar has_variants = true
    await supabase
      .from('inventory')
      .update({ has_variants: true })
      .eq('id', product.id)

    // Crear cada variante
    const createdVariants: ProductVariant[] = []
    for (let i = 0; i < variants.length; i++) {
      const v = await productService.createVariant(product.id, {
        ...variants[i],
        business_id:  baseInput.business_id,
        created_by:   baseInput.created_by,
        product_name: baseInput.name,
        category:     variants[i].category || baseInput.category,
        sort_order:   i,
      }, context)
      createdVariants.push(v)
    }

    return { product, variants: createdVariants }
  },

  // ── Obtener variantes de un producto ───────────────────────────────────────
  async getVariants(productId: string, businessId: string): Promise<ProductVariant[]> {
    const { data } = await supabase
      .from('product_variants')
      .select('*')
      .eq('product_id', productId)
      .eq('business_id', businessId)
      .eq('active', true)
      .order('sort_order')
    return (data || []) as ProductVariant[]
  },

  // ── Desactivar variante ────────────────────────────────────────────────────
  async deactivateVariant(variantId: string, businessId: string): Promise<void> {
    await supabase
      .from('product_variants')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', variantId)
      .eq('business_id', businessId)
  },

  // ── Aplicar valores base a todas las variantes ─────────────────────────────
  applyBaseToVariants<T extends Partial<CreateVariantInput>>(
    variants: T[],
    base: Partial<CreateVariantInput>
  ): T[] {
    return variants.map(v => ({
      ...v,
      cost_price_ars:      base.cost_price_ars      ?? v.cost_price_ars,
      cost_price_usd:      base.cost_price_usd      ?? v.cost_price_usd,
      cost_currency:       base.cost_currency       ?? v.cost_currency,
      sale_price_ars:      base.sale_price_ars      ?? v.sale_price_ars,
      wholesale_price_ars: base.wholesale_price_ars ?? v.wholesale_price_ars,
      exchange_rate_used:  base.exchange_rate_used  ?? v.exchange_rate_used,
      location:            base.location            ?? v.location,
      min_stock:           base.min_stock           ?? v.min_stock,
    }))
  },
}

// ─── Tipos de variantes ───────────────────────────────────────────────────────

export interface CreateVariantInput {
  business_id:         string
  created_by:          string
  product_name?:       string  // nombre del producto padre
  name:                string
  sku?:                string
  barcode?:            string
  category?:           string
  attributes?:         Record<string, string>
  cost_price_ars?:     number
  cost_price_usd?:     number
  cost_currency?:      'ARS' | 'USD'
  sale_price_ars?:     number
  sale_price_usd?:     number
  wholesale_price_ars?: number
  wholesale_price_usd?: number
  margin_percent?:     number
  exchange_rate_used?: number
  stock?:              number
  min_stock?:          number
  location?:           string
  active?:             boolean
  sort_order?:         number
}

export interface ProductVariant {
  id:                  string
  business_id:         string
  product_id:          string
  inventory_item_id:   string | null
  name:                string
  sku:                 string | null
  barcode:             string | null
  attributes:          Record<string, string>
  cost_price_ars:      number
  cost_price_usd:      number | null
  cost_currency:       'ARS' | 'USD'
  sale_price_ars:      number
  sale_price_usd:      number | null
  wholesale_price_ars: number | null
  wholesale_price_usd: number | null
  margin_percent:      number | null
  exchange_rate_used:  number | null
  stock:               number
  min_stock:           number
  location:            string | null
  active:              boolean
  sort_order:          number
  created_at:          string
  updated_at:          string
}
