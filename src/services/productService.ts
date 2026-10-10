/**
 * productService — fuente única de verdad para crear y editar productos.
 * Todos los módulos (Inventario, Órdenes, Comprobantes, Gastos, Proveedores)
 * deben pasar por aquí en lugar de insertar en inventory directamente.
 */
import { supabase } from '../lib/supabase'
import type { InventoryItem } from '../hooks/useInventory'
import { getVariantParentId } from '../lib/productSellability'
import { INVENTORY_OPERATIONAL_COLUMNS, attachInventoryCosts } from './inventoryCostAccess'
import {
  applyInventoryStockAdjustments,
  assertNoStockFields,
  initialStockKey,
  inventoryStockAdjustmentService,
  isStockInt,
  type StockAdjustmentDeltaItem,
} from './inventoryStockAdjustmentService'

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

  // Stock — sólo parámetros; el SALDO no es un dato del producto (G2-C.3A2).
  min_stock?:      number
  location?:       string
  is_active?:      boolean
  variant_name?:   string
}

/**
 * G2-C.3A2 — el producto SIEMPRE nace con stock 0 (default de la columna).
 *
 * `initialStock` sólo lo pasa el módulo Inventario: después del INSERT se
 * aplica por la autoridad canónica (`initial_stock`, clave
 * `initial-stock:<id>`). Un producto creado desde Proveedores, Gastos, POS u
 * Órdenes NO lo pasa: nace en 0 y el documento posterior mueve el stock.
 */
export interface ProductCreationContext {
  initialStock?:       number
  initialStockReason?: string
  groupingParent?: boolean
}

/**
 * El producto quedó creado (stock 0) pero el stock inicial no se confirmó.
 * NO se borra el producto (la respuesta pudo haberse perdido con el stock ya
 * aplicado): se reintenta con la MISMA clave, que no duplica.
 */
export class InitialStockPendingError extends Error {
  readonly product:  InventoryItem
  readonly quantity: number
  readonly cause:    unknown
  constructor(product: InventoryItem, quantity: number, cause: unknown) {
    super(`El producto se creó, pero el stock inicial no se confirmó: ${(cause as Error)?.message ?? 'error desconocido'}. Reintentá: no se duplica.`)
    this.name = 'InitialStockPendingError'
    this.product = product
    this.quantity = quantity
    this.cause = cause
  }
}

export interface VariantFamilyRecovery {
  product: InventoryItem
  variants: ProductVariant[]
  businessId: string
  items: StockAdjustmentDeltaItem[]
  idempotencyKey: string
  reason: string
}

export class VariantInitialStockPendingError extends InitialStockPendingError {
  constructor(readonly recovery: VariantFamilyRecovery, cause: unknown) {
    super(recovery.product, recovery.items.reduce((sum, item) => sum + item.delta, 0), cause)
    this.name = 'VariantInitialStockPendingError'
    this.message = 'El producto y sus variantes se crearon, pero no pudimos confirmar el stock inicial. Reintentar no duplica el producto.'
  }
}

export const MAX_PRODUCT_VARIANTS = 100

async function cleanupUnstockedDefinition(inventoryId: string, businessId: string): Promise<void> {
  // Existing delete policies may prohibit hard cleanup for an inventory actor.
  // Deactivate any retained rows in that exact attempt instead. Never bypass
  // can_manage, history guards or RLS, and never run this after the stock batch.
  await supabase.from('product_variants').delete().eq('inventory_item_id', inventoryId).eq('business_id', businessId)
  const { error: metadataError } = await supabase.from('product_variants').update({ active: false })
    .eq('inventory_item_id', inventoryId).eq('business_id', businessId)
  if (metadataError) throw new Error(`No pudimos completar la limpieza de metadata: ${metadataError.message}`)
  await supabase.from('inventory').delete().eq('id', inventoryId).eq('business_id', businessId)
  const { error } = await supabase.from('inventory').update({ is_active: false }).eq('id', inventoryId).eq('business_id', businessId)
  if (error) throw new Error(`No pudimos completar la baja del alta fallida: ${error.message}`)
}

export function validateVariantInputs(variants: CreateVariantInput[]): void {
  if (!variants.length || variants.length > MAX_PRODUCT_VARIANTS) throw new Error(`Agregá entre 1 y ${MAX_PRODUCT_VARIANTS} variantes.`)
  const names = new Set<string>()
  const skus = new Set<string>()
  const barcodes = new Set<string>()
  if (variants.filter(v => v.is_default).length > 1) throw new Error('Sólo una variante puede ser default.')
  for (const v of variants) {
    const name = v.name?.trim()
    if (!name) throw new Error('El nombre de cada variante es obligatorio.')
    if (names.has(name)) throw new Error('Hay variantes con el mismo nombre.')
    names.add(name)
    for (const [value, seen, label] of [[v.sku, skus, 'SKU'], [v.barcode, barcodes, 'barcode']] as const) {
      const clean = value?.trim()
      if (clean && (seen.has(clean) || /[\u0000-\u001f]/.test(clean))) throw new Error(`${label} repetido o inválido.`)
      if (clean) seen.add(clean)
    }
    if (!isStockInt(v.stock ?? 0) || (v.stock ?? 0) < 0) throw new Error('El stock inicial de cada variante tiene que ser un número entero no negativo.')
    if (!isStockInt(v.min_stock ?? 0) || (v.min_stock ?? 0) < 0) throw new Error('El stock mínimo tiene que ser un entero no negativo.')
    for (const price of [v.cost_price_ars, v.cost_price_usd, v.sale_price_ars, v.sale_price_usd, v.wholesale_price_ars, v.wholesale_price_usd]) {
      if (price != null && (!Number.isFinite(price) || price < 0)) throw new Error('Los precios de variantes deben ser números no negativos.')
    }
    if (v.cost_currency === 'USD' && (!Number.isFinite(v.exchange_rate_used) || (v.exchange_rate_used ?? 0) <= 0)) throw new Error('La cotización USD es inválida.')
  }
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
      .select('id, name, code, category, stock_quantity, sale_price, tipo')
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
    assertNoStockFields(input, 'createProduct')
    const validationError = productService.validate(input)
    if (validationError) throw new Error(validationError)

    const isService = input.tipo === 'service'
    const costPrice = sanitizeNum(input.cost_price)
    const salePrice = sanitizeNum(input.sale_price)
    const basePrice = sanitizeNum(input.base_price ?? costPrice)
    const minStock  = isService ? 0 : sanitizeNum(input.min_stock)
    const initialStock = isService ? 0 : (context.initialStock ?? 0)
    if (initialStock !== 0 && !isStockInt(initialStock)) {
      throw new Error('El stock inicial tiene que ser un número entero.')
    }

    const codeProvided = input.code?.trim() ?? ''

    // Metadata SIN stock: la fila nace en 0 por el default de la columna.
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
      precio_mayorista:    input.wholesale_price_ars != null ? sanitizeNum(input.wholesale_price_ars) : null,
      exchange_rate_used:  input.exchange_rate_used != null ? sanitizeNum(input.exchange_rate_used) : null,
      auto_update_price:   input.auto_update_price ?? false,
      min_stock:           minStock,
      location:            input.location?.trim() || null,
      is_active:           input.is_active ?? true,
      has_variants:        context.groupingParent ?? false,
      parent_id:           null,
    }

    // Insertar con retry automático ante colisión de código autogenerado
    let product: InventoryItem | null = null
    let attempts = 0

    while (attempts < 3) {
      const code = codeProvided || generateCode('P')
      const { data, error } = await supabase
        .from('inventory')
        .insert({ ...baseRow, code })
        .select(INVENTORY_OPERATIONAL_COLUMNS)
        .single()

      if (!error) {
        product = data as InventoryItem
        break
      }

      if (error.code === '23505') {
        if (codeProvided) throw new Error('Ya existe un producto con ese código o nombre.')
        attempts++
        continue
      }

      throw new Error(error.message)
    }

    if (!product) {
      throw new Error('No se pudo generar un código único. Intentá ingresar un SKU manualmente.')
    }

    // Stock inicial por la autoridad canónica. Si falla NO se borra el producto:
    // la respuesta pudo perderse con el stock ya aplicado. El caller reintenta
    // con la misma clave (initial-stock:<id>) y el servidor no duplica.
    if (initialStock !== 0) {
      try {
        const applied = await inventoryStockAdjustmentService.applyInitialStock({
          businessId:  input.business_id,
          inventoryId: product.id,
          quantity:    initialStock,
          reason:      context.initialStockReason ?? null,
        })
        if (applied) product = { ...product, stock_quantity: applied.new_stock }
      } catch (err) {
        throw new InitialStockPendingError(product, initialStock, err)
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
    // Fail-closed: la edición de datos no mueve stock (G2-C.3A2).
    assertNoStockFields(updates, 'updateProduct')
    const { error } = await supabase
      .from('inventory')
      .update({ ...updates, ...(updates.wholesale_price_ars !== undefined ? { precio_mayorista: updates.wholesale_price_ars } : {}), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)

    if (error) throw new Error(error.message)
    const { data: family, error: familyError } = updates.name !== undefined
      ? await supabase.from('inventory').select('has_variants').eq('id', id).eq('business_id', businessId).maybeSingle()
      : { data: null, error: null }
    if (familyError) throw new Error(`Los datos se guardaron, pero no pudimos confirmar la familia: ${familyError.message}`)
    if (family?.has_variants && updates.name !== undefined) {
      const { error: childrenError } = await supabase.from('inventory').update({ name: updates.name })
        .eq('parent_id', id).eq('business_id', businessId)
      if (childrenError) throw new Error(`El nombre se guardó, pero falta confirmar el nombre de la familia en sus variantes: ${childrenError.message}`)
    }

    // Compatibility metadata follows the sellable inventory row. Never stock.
    const variantUpdates = {
      name: updates.variant_name,
      sku: updates.code,
      barcode: updates.barcode,
      cost_price_ars: updates.cost_price,
      cost_price_usd: updates.cost_price_usd,
      cost_currency: updates.base_currency,
      sale_price_ars: updates.sale_price,
      wholesale_price_ars: updates.wholesale_price_ars,
      exchange_rate_used: updates.exchange_rate_used,
      min_stock: updates.min_stock,
      location: updates.location,
      active: updates.is_active,
      updated_at: new Date().toISOString(),
    }
    const { error: variantError } = await supabase.from('product_variants').update(variantUpdates)
      .eq('inventory_item_id', id).eq('business_id', businessId)
    if (variantError) throw new Error(`Los datos de inventario se guardaron, pero falta confirmar la metadata de variante: ${variantError.message}`)
  },

  // ── Crear variante de un producto existente ────────────────────────────────
  // G2-C.3A2: sólo metadata; la fila de inventario nace en 0. El stock inicial
  // de las variantes lo aplica createProductWithVariants por la RPC canónica,
  // DESPUÉS de crear todas las filas (así ningún rollback borra filas con stock).
  async createVariant(
    parentId: string,
    input:    CreateVariantInput,
  ): Promise<ProductVariant> {
    const cleanName = input.name?.trim()
    if (!cleanName)             throw new Error('El nombre de la variante es obligatorio.')
    if (!input.business_id?.trim()) throw new Error('business_id requerido en variante.')
    if (!parentId?.trim())      throw new Error('parentId requerido para crear variante.')
    validateVariantInputs([input])
    const { data: parent, error: parentError } = await supabase.from('inventory')
      .select('id,has_variants,parent_id,stock_quantity,is_active').eq('id', parentId).eq('business_id', input.business_id).single()
    if (parentError || !parent || !parent.has_variants || parent.parent_id || parent.stock_quantity !== 0 || !parent.is_active) {
      throw new Error('La familia debe ser un padre agrupador activo con stock cero.')
    }

    const costArs  = sanitizeNum(input.cost_price_ars)
    const saleArs  = sanitizeNum(input.sale_price_ars)
    const skuProvided = input.sku?.trim() ?? ''

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
                             ? (input.sale_price_usd ?? convertToUSD(saleArs, input.exchange_rate_used ?? 0))
                             : saleArs,
      cost_price:          costArs,
      cost_price_usd:      input.cost_price_usd != null ? sanitizeNum(input.cost_price_usd) : null,
      sale_price:          saleArs,
      wholesale_price_ars: input.wholesale_price_ars != null ? sanitizeNum(input.wholesale_price_ars) : null,
      exchange_rate_used:  input.exchange_rate_used != null ? sanitizeNum(input.exchange_rate_used) : null,
      auto_update_price:   input.auto_update_price ?? false,
      linked_to_dolar:     input.cost_currency === 'USD' && (input.auto_update_price ?? false),
      precio_mayorista:    input.wholesale_price_ars ?? null,
      min_stock:           sanitizeNum(input.min_stock),
      location:            input.location?.trim() || null,
      has_variants:        false,
      parent_id:           parentId,
      is_active:           input.active ?? true,
    }

    // Insertar fila de inventario con retry por colisión de código
    let invData: InventoryItem | null = null
    let attempts = 0

    while (attempts < 3) {
      const code = skuProvided || generateCode('V')
      const { data, error } = await supabase
        .from('inventory')
        .insert({ ...baseInvRow, code })
        .select(INVENTORY_OPERATIONAL_COLUMNS)
        .single()

      if (!error) { invData = data; break }

      if (error.code === '23505') {
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
        sku:                 invData.code,
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
        min_stock:           sanitizeNum(input.min_stock),
        location:            input.location?.trim() || null,
        active:              input.active ?? true,
        is_default:          input.is_default ?? false,
        sort_order:          sanitizeNum(input.sort_order),
      })
      .select('id,business_id,product_id,inventory_item_id,name,sku,barcode,attributes,active,is_default,sort_order,image_url,created_at,updated_at')
      .single()

    if (varErr) {
      // The INSERT response can be lost after metadata committed. Clean that
      // link first; rollback is allowed only before the stock batch is attempted.
      await cleanupUnstockedDefinition(invData.id, input.business_id)
      throw new Error(`Error al crear variante: ${varErr.message}`)
    }

    return { ...varData, stock: 0, cost_price_ars: costArs,
      cost_price_usd: input.cost_price_usd ?? null, cost_currency: input.cost_currency ?? 'ARS',
      sale_price_ars: saleArs, sale_price_usd: input.sale_price_usd ?? null,
      wholesale_price_ars: input.wholesale_price_ars ?? null, wholesale_price_usd: input.wholesale_price_usd ?? null,
      margin_percent: input.margin_percent ?? null, exchange_rate_used: input.exchange_rate_used ?? null,
      min_stock: input.min_stock ?? 0, location: input.location ?? null,
    } as ProductVariant
  },

  // ── Crear producto padre + variantes ───────────────────────────────────────
  // Variants V2: independent sellable inventory children.
  // Fase 1: metadata (padre + variantes en 0). Si falla, rollback de filas que
  // TODAVÍA no tienen stock ni movimientos. Fase 2: UN lote initial_stock
  // (clave initial-stock:<padre>) — desde acá no hay rollback destructivo.
  async createProductWithVariants(
    baseInput: Omit<CreateProductInput, 'tipo'>,
    variants:  CreateVariantInput[],
  ): Promise<{ product: InventoryItem; variants: ProductVariant[] }> {
    validateVariantInputs(variants)
    const codes = [baseInput.code, ...variants.map(v => v.sku)].map(code => code?.trim()).filter(Boolean)
    if (new Set(codes).size !== codes.length) throw new Error('SKU repetido en la familia.')

    const product = await productService.createProduct({
      ...baseInput,
      tipo: 'product',
      auto_update_price: false,
    }, { groupingParent: true })

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
        })
        createdVariants.push(v)
      }
    } catch (err) {
      // Rollback de metadata: ninguna de estas filas tiene stock ni movimientos.
      for (const v of createdVariants) {
        if (v.inventory_item_id) {
          await cleanupUnstockedDefinition(v.inventory_item_id, baseInput.business_id)
        }
      }
      await cleanupUnstockedDefinition(product.id, baseInput.business_id)
      throw err
    }

    const items = createdVariants
      .map((v, i) => ({ inventory_id: v.inventory_item_id, delta: sanitizeNum(variants[i].stock) }))
      .filter((it): it is { inventory_id: string; delta: number } => !!it.inventory_id && it.delta !== 0)
    if (items.length) {
      try {
        await applyInventoryStockAdjustments({
          businessId:     baseInput.business_id,
          source:         'initial_stock',
          items,
          idempotencyKey: initialStockKey(product.id),
          reason:         'Alta de variantes',
        })
      } catch (err) {
        throw new VariantInitialStockPendingError({ product, variants: createdVariants, businessId: baseInput.business_id, items, idempotencyKey: initialStockKey(product.id), reason: 'Alta de variantes' }, err)
      }
    }

    return { product, variants: createdVariants }
  },

  async retryVariantInitialStock(recovery: VariantFamilyRecovery): Promise<{ product: InventoryItem; variants: ProductVariant[] }> {
    await applyInventoryStockAdjustments({ businessId: recovery.businessId, source: 'initial_stock', items: recovery.items, idempotencyKey: recovery.idempotencyKey, reason: recovery.reason })
    return { product: recovery.product, variants: recovery.variants }
  },

  async addVariantWithInitialStock(parent: InventoryItem, input: CreateVariantInput): Promise<ProductVariant> {
    const variant = await productService.createVariant(parent.id, input)
    if (input.stock) {
      const recovery: VariantFamilyRecovery = { product: parent, variants: [variant], businessId: input.business_id,
        items: [{ inventory_id: variant.inventory_item_id!, delta: input.stock }],
        idempotencyKey: initialStockKey(variant.inventory_item_id!), reason: 'Alta de variantes' }
      try { await productService.retryVariantInitialStock(recovery) }
      catch (error) { throw new VariantInitialStockPendingError(recovery, error) }
    }
    return variant
  },

  // ── Obtener variantes de un producto ───────────────────────────────────────
  async getVariants(productId: string, businessId: string): Promise<ProductVariant[]> {
    const { data, error } = await supabase
      .from('product_variants')
      .select('id,business_id,product_id,inventory_item_id,name,sku,barcode,attributes,active,is_default,sort_order,image_url,created_at,updated_at')
      .eq('product_id', productId)
      .eq('business_id', businessId)
      .eq('active', true)
      .order('sort_order')
    if (error) throw new Error(error.message)
    if (!data?.length) return []
    const ids = data.map(v => v.inventory_item_id).filter((id): id is string => !!id)
    if (!ids.length) return []
    const { data: rows, error: inventoryError } = await supabase.from('inventory')
      .select(INVENTORY_OPERATIONAL_COLUMNS).eq('business_id', businessId).eq('is_active', true).in('id', ids)
    if (inventoryError) throw new Error(inventoryError.message)
    const inventory = await attachInventoryCosts(rows ?? [])
    return data.flatMap(meta => {
      const item = inventory.find(row => row.id === meta.inventory_item_id && row.has_variants !== true && getVariantParentId(row) === productId)
      if (!item) return [] // Orphaned / inactive links are never selectable.
      return [{ ...meta, stock: 0, stock_quantity: item.stock_quantity, inventory: item,
        name: item.variant_name || meta.name, sku: item.code, barcode: item.barcode,
        cost_price_ars: item.cost_price, cost_price_usd: item.cost_price_usd,
        cost_currency: item.base_currency, sale_price_ars: item.sale_price,
        wholesale_price_ars: item.wholesale_price_ars, min_stock: item.min_stock,
        location: item.location, exchange_rate_used: item.exchange_rate_used,
        sale_price_usd: item.base_currency === 'USD' ? item.base_price : null,
        wholesale_price_usd: item.wholesale_price_usd, margin_percent: null,
      } as ProductVariant]
    })
  },

  // ── Desactivar variante ────────────────────────────────────────────────────
  async deactivateVariant(variantId: string, businessId: string): Promise<void> {
    const { data, error } = await supabase.from('product_variants').select('inventory_item_id')
      .eq('id', variantId).eq('business_id', businessId).single()
    if (error || !data?.inventory_item_id) throw new Error(error?.message || 'Variante sin inventario vinculado.')
    await productService.updateProduct(data.inventory_item_id, { is_active: false }, businessId)
  },

  async setVariantActive(inventoryId: string, active: boolean, businessId: string): Promise<void> {
    await productService.updateProduct(inventoryId, { is_active: active }, businessId)
  },

  async deactivateFamily(productId: string, businessId: string): Promise<void> {
    const { error: inventoryError } = await supabase.from('inventory').update({ is_active: false })
      .eq('business_id', businessId).or(`id.eq.${productId},parent_id.eq.${productId}`)
    if (inventoryError) throw new Error(inventoryError.message)
    const { error } = await supabase
      .from('product_variants')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('product_id', productId)
      .eq('business_id', businessId)
    if (error) throw new Error(error.message)
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
  auto_update_price?:   boolean
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
  /** Deprecated metadata. Never use as a balance. */
  stock:                number
  stock_quantity?:      number
  inventory?:           InventoryItem
  min_stock:            number
  location:             string | null
  active:               boolean
  is_default:           boolean
  sort_order:           number
  image_url:            string | null
  created_at:           string
  updated_at:           string
}
