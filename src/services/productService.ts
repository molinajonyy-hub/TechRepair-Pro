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
  business_id:  string
  created_by:   string
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
  base_currency:        'ARS' | 'USD'
  base_price:           number
  cost_price:           number
  cost_price_usd?:      number
  sale_price:           number
  wholesale_price_ars?: number
  exchange_rate_used?:  number
  auto_update_price?:   boolean

  // Stock
  stock_quantity?: number
  min_stock?:      number
  location?:       string
  is_active?:      boolean
}

export interface ProductCreationContext {
  registerMovement?: boolean
  movementType?:     'purchase' | 'in' | 'manual'
  sourceType?:       'supplier_invoice' | 'expense' | 'purchase' | 'manual'
  sourceId?:         string
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

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Convierte cualquier valor en un número finito seguro.
 * NaN / Infinity / null / undefined → 0.
 * Por defecto clampea a ≥ 0; pasar allowNegative=true para márgenes o ajustes.
 */
function sanitizeNum(v: unknown, allowNegative = false): number {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  if (!isFinite(n)) return 0
  return allowNegative ? n : Math.max(0, n)
}

/**
 * Genera un código único usando crypto.randomUUID() como fuente de entropía.
 * El resultado tiene ~40 bits de aleatoriedad → colisión extremadamente improbable.
 * Formato: P-ABCD12-EF34  /  V-ABCD12-EF34
 */
function generateCode(prefix: 'P' | 'V'): string {
  const u = crypto.randomUUID().replace(/-/g, '').toUpperCase()
  return `${prefix}-${u.slice(0, 6)}-${u.slice(6, 10)}`
}

// ─── Helpers públicos ─────────────────────────────────────────────────────────

export function calculateMarginPct(cost: number, sale: number): number {
  if (!cost || cost <= 0) return 0
  return ((sale - cost) / cost) * 100
}

export function calculateSaleFromMargin(cost: number, marginPct: number): number {
  if (!cost || cost <= 0) return 0
  return cost * (1 + marginPct / 100)
}

export function convertToARS(usd: number, rate: number): number {
  if (!isFinite(usd) || !isFinite(rate) || rate <= 0) return 0
  return Math.round(usd * rate * 100) / 100
}

export function convertToUSD(ars: number, rate: number): number {
  if (!isFinite(ars) || !isFinite(rate) || rate <= 0) return 0
  return Math.round((ars / rate) * 100) / 100
}

// ─── Servicio ─────────────────────────────────────────────────────────────────

export const productService = {

  // ── Validación ──────────────────────────────────────────────────────────────
  validate(input: Partial<CreateProductInput>): string | null {
    if (!input.name?.trim())        return 'El nombre del producto es obligatorio.'
    if (!input.business_id?.trim()) return 'business_id requerido.'
    if (!input.created_by?.trim())  return 'created_by requerido.'

    const sale = Number(input.sale_price)
    const cost = Number(input.cost_price)
    if (!isFinite(sale))  return 'El precio de venta es inválido.'
    if (!isFinite(cost))  return 'El costo es inválido.'
    if (sale < 0)         return 'El precio de venta no puede ser negativo.'
    if (cost < 0)         return 'El costo no puede ser negativo.'

    if (input.base_currency === 'USD') {
      const rate = Number(input.exchange_rate_used)
      if (!isFinite(rate) || rate <= 0)
        return 'La cotización USD es inválida (se requiere para productos en USD).'
    }

    if (input.stock_quantity !== undefined) {
      const stock = Number(input.stock_quantity)
      if (!isFinite(stock) || stock < 0) return 'El stock no puede ser negativo.'
    }

    return null
  },

  // ── Detectar producto similar ───────────────────────────────────────────────
  async checkDuplicate(
    name:       string,
    businessId: string,
    code?:      string,
    barcode?:   string
  ): Promise<InventoryItem | null> {
    const cleanName = name.trim()
    if (!cleanName) return null

    let q = supabase
      .from('inventory')
      .select('id, name, code, category, stock_quantity, sale_price, cost_price, tipo')
      .eq('business_id', businessId)
      .eq('is_active', true)

    if (code?.trim()) {
      q = q.or(`name.ilike.${cleanName},code.eq.${code.trim()}`)
    } else if (barcode?.trim()) {
      q = q.or(`name.ilike.${cleanName},barcode.eq.${barcode.trim()}`)
    } else {
      q = q.ilike('name', cleanName)
    }

    const { data } = await q.limit(1).maybeSingle()
    return data as InventoryItem | null
  },

  // ── Crear producto ──────────────────────────────────────────────────────────
  async createProduct(
    input:   CreateProductInput,
    context: ProductCreationContext = {}
  ): Promise<InventoryItem> {
    const validationError = productService.validate(input)
    if (validationError) throw new Error(validationError)

    const isService = input.tipo === 'service'
    const costPrice = sanitizeNum(input.cost_price)
    const salePrice = sanitizeNum(input.sale_price)
    const basePrice = sanitizeNum(input.base_price ?? costPrice)
    const stockQty  = isService ? 0 : sanitizeNum(input.stock_quantity)
    const minStock  = isService ? 0 : sanitizeNum(input.min_stock)

    // Cuando registerMovement está activo el movimiento sube el stock desde 0.
    // Insertar con 0 evita el double-stock: si insertamos qty Y después registerMovement
    // suma qty más, el stock quedaría duplicado.
    const insertStock = context.registerMovement && !isService ? 0 : stockQty

    const codeProvided = input.code?.trim() ?? ''

    const baseRow = {
      business_id:         input.business_id,
      created_by:          input.created_by,
      name:                input.name.trim(),
      barcode:             input.barcode?.trim() || null,
      description:         input.description?.trim() || null,
      category:            input.category?.trim() || 'Otros',
      subcategory:         input.subcategory?.trim() || null,
      brand:               input.brand?.trim() || null,
      model:               input.model?.trim() || null,
      supplier_id:         input.supplier_id || null,
      tipo:                input.tipo,
      base_currency:       input.base_currency ?? 'ARS',
      currency:            'ARS' as const,
      base_price:          basePrice,
      cost_price:          costPrice,
      cost_price_usd:      input.cost_price_usd != null ? sanitizeNum(input.cost_price_usd) : null,
      sale_price:          salePrice,
      wholesale_price_ars: input.wholesale_price_ars != null ? sanitizeNum(input.wholesale_price_ars) : null,
      exchange_rate_used:  input.exchange_rate_used != null ? sanitizeNum(input.exchange_rate_used) : null,
      auto_update_price:   input.auto_update_price ?? false,
      stock_quantity:      insertStock,
      min_stock:           minStock,
      location:            input.location?.trim() || null,
      is_active:           input.is_active ?? true,
    }

    if (import.meta.env.DEV) {
      console.log('[CREATE_PRODUCT]', {
        name: baseRow.name, tipo: baseRow.tipo,
        cost: baseRow.cost_price, sale: baseRow.sale_price,
        stock: stockQty, insertStock,
        registerMovement: context.registerMovement,
      })
    }

    // Insertar con retry automático ante colisión de código autogenerado
    let product: InventoryItem | null = null
    let attempts = 0

    while (attempts < 3) {
      const code = codeProvided || generateCode('P')
      const { data, error } = await supabase
        .from('inventory')
        .insert({ ...baseRow, code })
        .select()
        .single()

      if (!error) {
        product = data as InventoryItem
        break
      }

      if ((error as any).code === '23505') {
        if (codeProvided) throw new Error('Ya existe un producto con ese código o nombre.')
        attempts++
        continue
      }

      throw new Error(error.message)
    }

    if (!product) {
      throw new Error('No se pudo generar un código único. Intentá ingresar un SKU manualmente.')
    }

    // Registrar movimiento de stock inicial (el movimiento actualiza stock desde 0 → stockQty)
    if (context.registerMovement && !isService && stockQty > 0) {
      try {
        await inventoryMovementsService.registerMovement(
          product.id,
          (context.movementType ?? 'in') as any,
          stockQty,
          (context.sourceType as any) ?? 'manual',
          context.sourceId,
          context.sourceNote ?? 'Stock inicial al crear producto',
          input.business_id,
          input.created_by,
          {
            unit_cost:    context.unit_cost ?? costPrice,
            currency:     context.currency  ?? (input.base_currency ?? 'ARS'),
            exchange_rate: context.exchange_rate ?? input.exchange_rate_used ?? null,
            supplier_id:  input.supplier_id ?? null,
          }
        )
        // El movimiento actualizó stock_quantity en DB; corregir el objeto devuelto
        product = { ...product, stock_quantity: stockQty }
      } catch (movErr) {
        // Rollback: eliminar producto para evitar inventario huérfano sin stock correcto
        await supabase.from('inventory').delete().eq('id', product.id)
        throw new Error(`Error al registrar stock inicial: ${(movErr as Error).message}`)
      }
    }

    return product
  },

  // ── Actualizar producto ────────────────────────────────────────────────────
  async updateProduct(
    id:         string,
    updates:    Partial<CreateProductInput>,
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
    parentId: string,
    input:    CreateVariantInput,
    context:  ProductCreationContext = {}
  ): Promise<ProductVariant> {
    const cleanName = input.name?.trim()
    if (!cleanName)             throw new Error('El nombre de la variante es obligatorio.')
    if (!input.business_id?.trim()) throw new Error('business_id requerido en variante.')
    if (!parentId?.trim())      throw new Error('parentId requerido para crear variante.')

    const costArs  = sanitizeNum(input.cost_price_ars)
    const saleArs  = sanitizeNum(input.sale_price_ars)
    const stock    = sanitizeNum(input.stock)
    const skuProvided = input.sku?.trim() ?? ''

    const insertStock = context.registerMovement ? 0 : stock

    const baseInvRow = {
      business_id:         input.business_id,
      created_by:          input.created_by,
      name:                (input.product_name?.trim() || cleanName),
      variant_name:        cleanName,
      barcode:             input.barcode?.trim() || null,
      category:            input.category?.trim() || 'Otros',
      currency:            'ARS' as const,
      tipo:                'product' as const,
      base_currency:       input.cost_currency ?? 'ARS',
      base_price:          input.cost_currency === 'USD'
                             ? sanitizeNum(input.cost_price_usd)
                             : costArs,
      cost_price:          costArs,
      cost_price_usd:      input.cost_price_usd != null ? sanitizeNum(input.cost_price_usd) : null,
      sale_price:          saleArs,
      wholesale_price_ars: input.wholesale_price_ars != null ? sanitizeNum(input.wholesale_price_ars) : null,
      exchange_rate_used:  input.exchange_rate_used != null ? sanitizeNum(input.exchange_rate_used) : null,
      stock_quantity:      insertStock,
      min_stock:           sanitizeNum(input.min_stock),
      location:            input.location?.trim() || null,
      has_variants:        false,
      parent_id:           parentId,
      is_active:           input.active ?? true,
    }

    if (import.meta.env.DEV) {
      console.log('[CREATE_VARIANT]', {
        parent: parentId, variant: cleanName,
        cost: costArs, sale: saleArs, stock, insertStock,
      })
    }

    // Insertar fila de inventario con retry por colisión de código
    let invData: any = null
    let attempts = 0

    while (attempts < 3) {
      const code = skuProvided || generateCode('V')
      const { data, error } = await supabase
        .from('inventory')
        .insert({ ...baseInvRow, code })
        .select()
        .single()

      if (!error) { invData = data; break }

      if ((error as any).code === '23505') {
        if (skuProvided) throw new Error('Ya existe un producto con ese SKU.')
        attempts++
        continue
      }

      throw new Error(error.message)
    }

    if (!invData) {
      throw new Error('No se pudo generar un código único para la variante.')
    }

    // Crear registro en product_variants; si falla, limpiar la fila de inventario
    const { data: varData, error: varErr } = await supabase
      .from('product_variants')
      .insert({
        business_id:         input.business_id,
        product_id:          parentId,
        inventory_item_id:   invData.id,
        name:                cleanName,
        sku:                 skuProvided || null,
        barcode:             input.barcode?.trim() || null,
        attributes:          input.attributes ?? {},
        cost_price_ars:      costArs,
        cost_price_usd:      input.cost_price_usd != null ? sanitizeNum(input.cost_price_usd) : null,
        cost_currency:       input.cost_currency ?? 'ARS',
        sale_price_ars:      saleArs,
        sale_price_usd:      input.sale_price_usd != null ? sanitizeNum(input.sale_price_usd) : null,
        wholesale_price_ars: input.wholesale_price_ars != null ? sanitizeNum(input.wholesale_price_ars) : null,
        wholesale_price_usd: input.wholesale_price_usd != null ? sanitizeNum(input.wholesale_price_usd) : null,
        margin_percent:      input.margin_percent != null ? sanitizeNum(input.margin_percent, true) : null,
        exchange_rate_used:  input.exchange_rate_used != null ? sanitizeNum(input.exchange_rate_used) : null,
        stock:               stock,
        min_stock:           sanitizeNum(input.min_stock),
        location:            input.location?.trim() || null,
        active:              input.active ?? true,
        sort_order:          sanitizeNum(input.sort_order),
      })
      .select()
      .single()

    if (varErr) {
      // Rollback: eliminar la fila de inventario para evitar registros huérfanos
      await supabase.from('inventory').delete().eq('id', invData.id)
      throw new Error(`Error al crear variante: ${varErr.message}`)
    }

    // Movimiento de stock inicial
    if (context.registerMovement && stock > 0) {
      try {
        await inventoryMovementsService.registerMovement(
          invData.id,
          (context.movementType ?? 'in') as any,
          stock,
          (context.sourceType as any) ?? 'manual',
          context.sourceId,
          context.sourceNote ?? 'Stock inicial de variante',
          input.business_id,
          input.created_by,
          {
            unit_cost:    context.unit_cost ?? costArs,
            currency:     context.currency  ?? input.cost_currency ?? 'ARS',
            exchange_rate: context.exchange_rate ?? input.exchange_rate_used ?? null,
          }
        )
      } catch (movErr) {
        // El stock ya está en inventory.stock_quantity (correcto).
        // El movimiento es auditoría; no hacemos rollback del producto por esto.
        if (import.meta.env.DEV) {
          console.warn('[CREATE_VARIANT] Fallo al registrar movimiento de stock (no crítico):', movErr)
        }
      }
    }

    return varData as ProductVariant
  },

  // ── Crear producto padre + variantes (operación atómica) ───────────────────
  async createProductWithVariants(
    baseInput: Omit<CreateProductInput, 'stock_quantity' | 'tipo'>,
    variants:  CreateVariantInput[],
    context:   ProductCreationContext = {}
  ): Promise<{ product: InventoryItem; variants: ProductVariant[] }> {
    if (!variants.length) throw new Error('Debés agregar al menos una variante.')

    const product = await productService.createProduct({
      ...baseInput,
      tipo:           'product',
      stock_quantity: 0,
    })

    await supabase
      .from('inventory')
      .update({ has_variants: true })
      .eq('id', product.id)

    const createdVariants: ProductVariant[] = []

    try {
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
    } catch (err) {
      // Rollback completo: eliminar variantes creadas + sus filas de inventario + producto padre
      for (const v of createdVariants) {
        if (v.inventory_item_id) {
          await supabase.from('inventory').delete().eq('id', v.inventory_item_id)
        }
        await supabase.from('product_variants').delete().eq('id', v.id)
      }
      await supabase.from('inventory').delete().eq('id', product.id)
      throw err
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
    base:     Partial<CreateVariantInput>
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
  business_id:          string
  created_by:           string
  product_name?:        string
  name:                 string
  sku?:                 string
  barcode?:             string
  category?:            string
  attributes?:          Record<string, string>
  cost_price_ars?:      number
  cost_price_usd?:      number
  cost_currency?:       'ARS' | 'USD'
  sale_price_ars?:      number
  sale_price_usd?:      number
  wholesale_price_ars?: number
  wholesale_price_usd?: number
  margin_percent?:      number
  exchange_rate_used?:  number
  stock?:               number
  min_stock?:           number
  location?:            string
  active?:              boolean
  is_default?:          boolean
  sort_order?:          number
}

export interface ProductVariant {
  id:                   string
  business_id:          string
  product_id:           string
  inventory_item_id:    string | null
  name:                 string
  sku:                  string | null
  barcode:              string | null
  attributes:           Record<string, string>
  cost_price_ars:       number
  cost_price_usd:       number | null
  cost_currency:        'ARS' | 'USD'
  sale_price_ars:       number
  sale_price_usd:       number | null
  wholesale_price_ars:  number | null
  wholesale_price_usd:  number | null
  margin_percent:       number | null
  exchange_rate_used:   number | null
  stock:                number
  min_stock:            number
  location:             string | null
  active:               boolean
  is_default:           boolean
  sort_order:           number
  image_url:            string | null
  created_at:           string
  updated_at:           string
}
