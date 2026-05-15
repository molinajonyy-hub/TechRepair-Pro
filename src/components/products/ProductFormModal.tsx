/**
 * ProductFormModal — formulario unificado de producto.
 *
 * Úsalo desde cualquier módulo (Inventario, Órdenes, Comprobantes,
 * Gastos, Factura de proveedor). Reemplaza todos los formularios
 * reducidos de "crear producto rápido".
 *
 * Props de contexto (pre-relleno):
 *   initialName     — nombre del buscador donde no se encontró el producto
 *   initialCost     — costo unitario de la línea de factura/gasto
 *   initialQuantity — cantidad de la línea (para stock inicial)
 *   initialCurrency — moneda del contexto
 *   supplierId / supplierName — proveedor del contexto
 *   registerStock   — si true, suma stock al crear (con movimiento registrado)
 *   sourceType / sourceId — para trazar el movimiento
 */
import { useState, useEffect, useCallback } from 'react'
import { X, RefreshCw, DollarSign, Package, Check, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { currencyService } from '../../services/currencyService'
import {
  productService,
  calculateMarginPct,
  calculateSaleFromMargin,
  convertToARS,
  convertToUSD,
  type CreateProductInput,
  type ProductCreationContext,
  type CreateVariantInput,
  type ProductVariant,
} from '../../services/productService'
import type { InventoryItem } from '../../hooks/useInventory'

// ─── Categorías ───────────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  'Pantallas', 'Baterías', 'Conectores', 'Cámaras', 'Botones',
  'Altavoces', 'Micrófonos', 'Flex', 'Herramientas', 'Accesorios',
  'Servicios', 'Repuestos', 'Otros',
]

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ProductFormModalProps {
  isOpen:          boolean
  onClose:         () => void
  onCreated:       (product: InventoryItem) => void
  // Callback opcional cuando se crea con variantes: permite seleccionar cuál usar en la operación
  onVariantSelected?: (variantInventory: InventoryItem, variantMeta: ProductVariant) => void

  // Pre-relleno desde contexto (buscador, factura, gasto, etc.)
  initialName?:     string
  initialCost?:     number
  initialQuantity?: number
  initialCurrency?: 'ARS' | 'USD'
  supplierId?:      string
  supplierName?:    string

  // Contexto de movimiento de stock
  registerStock?: boolean
  sourceType?:    ProductCreationContext['sourceType']
  sourceId?:      string
  sourceNote?:    string
}

// ─── Estado del formulario ────────────────────────────────────────────────────

// ─── Variante en el formulario ────────────────────────────────────────────────

interface VariantRow {
  _key:       string
  name:       string
  sku:        string
  barcode:    string
  cost_ars:   string
  cost_usd:   string
  sale_price: string
  wholesale:  string
  stock:      string
  min_stock:  string
  location:   string
  is_active:  boolean
  expanded:   boolean
}

function emptyVariant(n = 1): VariantRow {
  return {
    _key: crypto.randomUUID(), name: `Variante ${n}`, sku: '', barcode: '',
    cost_ars: '', cost_usd: '', sale_price: '', wholesale: '',
    stock: '0', min_stock: '0', location: '', is_active: true, expanded: true,
  }
}

interface FormState {
  tipo:         'product' | 'service' | 'with_variants'
  name:         string
  code:         string
  barcode:      string
  brand:        string
  model:        string
  description:  string
  category:     string
  newCategory:  string
  subcategory:  string
  supplier_id:  string

  base_currency:    'ARS' | 'USD'
  exchange_rate:    string           // cotización USD/ARS
  cost_ars:         string
  cost_usd:         string
  sale_price_ars:   string
  margin_pct:       string

  wholesale_price:  string
  stock_quantity:   string
  min_stock:        string
  location:         string
  is_active:        boolean
  register_stock:   boolean          // registrar movimiento de inventario
  variants:         VariantRow[]     // solo para tipo 'with_variants'
}

const EMPTY: FormState = {
  tipo: 'product', name: '', code: '', barcode: '', brand: '', model: '',
  description: '', category: '', newCategory: '', subcategory: '', supplier_id: '',
  base_currency: 'ARS', exchange_rate: '', cost_ars: '', cost_usd: '',
  sale_price_ars: '', margin_pct: '',
  wholesale_price: '', stock_quantity: '0', min_stock: '0', location: '',
  is_active: true, register_stock: false, variants: [emptyVariant(1)],
}

const F = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

// ─── Componente ───────────────────────────────────────────────────────────────

export function ProductFormModal({
  isOpen, onClose, onCreated, onVariantSelected,
  initialName, initialCost, initialQuantity, initialCurrency,
  supplierId, supplierName,
  registerStock = false, sourceType, sourceId, sourceNote,
}: ProductFormModalProps) {
  const { businessId, user } = useAuth()

  const [form, setForm]               = useState<FormState>(EMPTY)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')
  const [duplicate, setDuplicate]     = useState<InventoryItem | null>(null)
  const [loadingRate, setLoadingRate] = useState(false)
  const [showCatInput, setShowCatInput] = useState(false)
  const [suppliers, setSuppliers]     = useState<{ id: string; name: string }[]>([])
  // Estado post-creación con variantes: permite seleccionar cuál usar en la operación
  const [variantPickerData, setVariantPickerData] = useState<{
    product: InventoryItem
    variants: ProductVariant[]
  } | null>(null)

  // ── Pre-rellenar desde contexto al abrir ────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return
    const rate = form.exchange_rate || ''
    setForm({
      ...EMPTY,
      name:          initialName      ?? '',
      category:      '',
      supplier_id:   supplierId       ?? '',
      base_currency: initialCurrency  ?? 'ARS',
      cost_ars:      initialCurrency === 'ARS' ? String(initialCost ?? '') : '',
      cost_usd:      initialCurrency === 'USD' ? String(initialCost ?? '') : '',
      stock_quantity: String(initialQuantity ?? 0),
      register_stock: registerStock,
      exchange_rate: rate,
    })
    setError(''); setDuplicate(null)
    // Cargar cotización
    if (!form.exchange_rate) fetchRate()
    // Cargar proveedores
    loadSuppliers()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const fetchRate = async () => {
    setLoadingRate(true)
    try {
      const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS')
      setForm(f => ({ ...f, exchange_rate: String(rate.toFixed(2)) }))
    } catch { /* silent */ }
    finally { setLoadingRate(false) }
  }

  const loadSuppliers = async () => {
    if (!businessId) return
    const { data } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .order('name')
      .limit(100)
    setSuppliers((data || []) as { id: string; name: string }[])
  }

  // ── Helpers de precio ───────────────────────────────────────────────────────
  const rate = parseFloat(form.exchange_rate) || 1

  const deriveCostARS = useCallback((f: FormState): number => {
    if (f.base_currency === 'USD') {
      return convertToARS(parseFloat(f.cost_usd) || 0, parseFloat(f.exchange_rate) || 1)
    }
    return parseFloat(f.cost_ars) || 0
  }, [])

  const set = (field: keyof FormState, value: string | boolean) =>
    setForm(f => ({ ...f, [field]: value }))

  // Al cambiar costo → recalcular margen
  const handleCostChange = (val: string, field: 'cost_ars' | 'cost_usd') => {
    setForm(f => {
      const next = { ...f, [field]: val }
      const costARS = deriveCostARS({ ...next })
      const saleARS = parseFloat(f.sale_price_ars) || 0
      const margin  = calculateMarginPct(costARS, saleARS)
      return { ...next, margin_pct: isFinite(margin) ? margin.toFixed(1) : '' }
    })
  }

  // Al cambiar precio venta → recalcular margen
  const handleSalePriceChange = (val: string) => {
    setForm(f => {
      const costARS = deriveCostARS(f)
      const saleARS = parseFloat(val) || 0
      const margin  = calculateMarginPct(costARS, saleARS)
      return { ...f, sale_price_ars: val, margin_pct: isFinite(margin) ? margin.toFixed(1) : '' }
    })
  }

  // Al cambiar margen → recalcular precio venta
  const handleMarginChange = (val: string) => {
    setForm(f => {
      const costARS = deriveCostARS(f)
      const m = parseFloat(val) || 0
      const sale = calculateSaleFromMargin(costARS, m)
      return { ...f, margin_pct: val, sale_price_ars: costARS > 0 ? sale.toFixed(2) : f.sale_price_ars }
    })
  }

  // Al cambiar moneda base → recalcular precios cruzados
  const handleCurrencyChange = (cur: 'ARS' | 'USD') => {
    setForm(f => {
      if (cur === 'USD') {
        const arsVal = parseFloat(f.cost_ars) || 0
        return { ...f, base_currency: 'USD', cost_usd: arsVal > 0 ? convertToUSD(arsVal, rate).toFixed(2) : '' }
      } else {
        const usdVal = parseFloat(f.cost_usd) || 0
        return { ...f, base_currency: 'ARS', cost_ars: usdVal > 0 ? convertToARS(usdVal, rate).toFixed(2) : '' }
      }
    })
  }

  // ── Validación / duplicado ──────────────────────────────────────────────────
  const checkDuplicate = async () => {
    if (!form.name.trim() || !businessId) return
    const dup = await productService.checkDuplicate(form.name, businessId, form.code || undefined)
    setDuplicate(dup)
  }

  // ── Helpers variantes ──────────────────────────────────────────────────────
  const updateVariant = (key: string, updates: Partial<VariantRow>) =>
    setForm(f => ({ ...f, variants: f.variants.map(v => v._key === key ? { ...v, ...updates } : v) }))

  const addVariantRow = () =>
    setForm(f => ({ ...f, variants: [...f.variants, emptyVariant(f.variants.length + 1)] }))

  const removeVariant = (key: string) =>
    setForm(f => ({ ...f, variants: f.variants.filter(v => v._key !== key) }))

  const duplicateVariant = (key: string) =>
    setForm(f => {
      const src = f.variants.find(v => v._key === key)
      if (!src) return f
      const dup: VariantRow = { ...src, _key: crypto.randomUUID(), name: `${src.name} (copia)`, expanded: true }
      const idx = f.variants.findIndex(v => v._key === key)
      const next = [...f.variants]
      next.splice(idx + 1, 0, dup)
      return { ...f, variants: next }
    })

  const applyBaseToVariants = () =>
    setForm(f => ({
      ...f,
      variants: f.variants.map(v => ({
        ...v,
        cost_ars:   f.cost_ars   || v.cost_ars,
        cost_usd:   f.cost_usd   || v.cost_usd,
        sale_price: f.sale_price_ars || v.sale_price,
        wholesale:  f.wholesale_price || v.wholesale,
        location:   f.location   || v.location,
        min_stock:  f.min_stock  || v.min_stock,
      }))
    }))

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!businessId || !user) return
    setError(''); setSaving(true)

    try {
      const costARS = deriveCostARS(form)
      const costUSD = form.base_currency === 'USD' ? (parseFloat(form.cost_usd) || 0) : undefined
      const saleARS = parseFloat(form.sale_price_ars) || 0
      const qty     = parseInt(form.stock_quantity) || 0
      const catName = showCatInput && form.newCategory.trim()
        ? form.newCategory.trim()
        : form.category || 'Otros'

      const baseInput: Omit<CreateProductInput, 'tipo' | 'stock_quantity'> = {
        business_id:    businessId,
        created_by:     user.id,
        name:           form.name.trim(),
        code:           form.code.trim() || undefined,
        barcode:        form.barcode.trim() || undefined,
        brand:          form.brand.trim() || undefined,
        model:          form.model.trim() || undefined,
        description:    form.description.trim() || undefined,
        category:       catName,
        subcategory:    form.subcategory.trim() || undefined,
        supplier_id:    form.supplier_id || undefined,
        base_currency:  form.base_currency,
        base_price:     form.base_currency === 'USD' ? (parseFloat(form.cost_usd) || 0) : costARS,
        cost_price:     costARS,
        cost_price_usd: costUSD,
        sale_price:     saleARS,
        wholesale_price_ars: parseFloat(form.wholesale_price) || undefined,
        exchange_rate_used:  form.base_currency === 'USD' ? rate : undefined,
        min_stock:      parseInt(form.min_stock) || 0,
        location:       form.location.trim() || undefined,
        is_active:      form.is_active,
      }

      // ── Producto con variantes ──────────────────────────────────────────────
      if (form.tipo === 'with_variants') {
        if (!form.variants.length) { setError('Agregá al menos una variante.'); return }
        const variantInputs: CreateVariantInput[] = form.variants.map((v, i) => ({
          business_id:  businessId,
          created_by:   user.id,
          product_name: form.name.trim(),
          name:         v.name.trim() || `Variante ${i + 1}`,
          sku:          v.sku.trim() || undefined,
          barcode:      v.barcode.trim() || undefined,
          category:     catName,
          cost_price_ars:  parseFloat(v.cost_ars) || costARS || 0,
          cost_price_usd:  form.base_currency === 'USD' ? (parseFloat(v.cost_usd) || costUSD) : undefined,
          cost_currency:   form.base_currency,
          sale_price_ars:  parseFloat(v.sale_price) || saleARS || 0,
          wholesale_price_ars: parseFloat(v.wholesale) || undefined,
          exchange_rate_used:  form.base_currency === 'USD' ? rate : undefined,
          stock:      parseInt(v.stock) || 0,
          min_stock:  parseInt(v.min_stock) || 0,
          location:   v.location.trim() || undefined,
          active:     v.is_active,
          sort_order: i,
        }))
        const ctx: ProductCreationContext = registerStock
          ? { registerMovement: true, movementType: 'in', sourceType, sourceId, sourceNote }
          : {}
        const { product, variants: createdVariants } = await productService.createProductWithVariants(
          baseInput, variantInputs, ctx
        )
        if (onVariantSelected && createdVariants.length > 0) {
          setVariantPickerData({ product, variants: createdVariants })
        } else {
          onCreated(product); onClose()
        }
        return
      }

      // ── Producto simple / servicio ──────────────────────────────────────────
      const input: CreateProductInput = {
        ...baseInput,
        tipo:           form.tipo as 'product' | 'service',
        stock_quantity: form.tipo === 'service' ? 0 : qty,
      }

      const ctx: ProductCreationContext = form.register_stock && form.tipo !== 'service' && qty > 0
        ? {
            registerMovement: true, movementType: 'in', sourceType, sourceId,
            sourceNote: sourceNote ?? `Stock inicial desde ${sourceType ?? 'creación'}`,
            unit_cost: costARS, currency: form.base_currency,
            exchange_rate: form.base_currency === 'USD' ? rate : undefined,
          }
        : {}

      const product = await productService.createProduct(input, ctx)
      onCreated(product)
      onClose()
    } catch (err: any) {
      setError(err.message || 'Error al guardar el producto.')
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  // ── Variant picker (post-creación con variantes) ────────────────────────────
  if (variantPickerData) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', fontFamily: F }}>
        <div style={{ background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '1.25rem', width: '100%', maxWidth: '480px', boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }}>
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <h3 style={{ margin: 0, color: '#f1f5f9', fontSize: '1rem', fontWeight: 800 }}>¿Qué variante usás en esta operación?</h3>
            <p style={{ margin: '0.25rem 0 0', color: '#475569', fontSize: '0.8rem' }}>Producto creado: <strong style={{ color: '#94a3b8' }}>{variantPickerData.product.name}</strong></p>
          </div>
          <div style={{ padding: '1rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {variantPickerData.variants.map(variant => (
              <button
                key={variant.id}
                type="button"
                onClick={() => {
                  if (variant.inventory_item_id && onVariantSelected) {
                    // Obtener el inventory item para la variante y llamar el callback
                    onVariantSelected({ id: variant.inventory_item_id, name: `${variantPickerData.product.name} — ${variant.name}`, sale_price: variant.sale_price_ars, cost_price: variant.cost_price_ars, stock_quantity: variant.stock } as any, variant)
                  }
                  setVariantPickerData(null); onClose()
                }}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '0.75rem', cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.14)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(99,102,241,0.06)'}
              >
                <div>
                  <div style={{ color: '#f1f5f9', fontSize: '0.875rem', fontWeight: 700 }}>{variant.name}</div>
                  {variant.sku && <div style={{ color: '#475569', fontSize: '0.72rem' }}>SKU: {variant.sku}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: '#818cf8', fontWeight: 700, fontSize: '0.875rem' }}>${variant.sale_price_ars.toLocaleString('es-AR')}</div>
                  <div style={{ color: '#334155', fontSize: '0.72rem' }}>Stock: {variant.stock}</div>
                </div>
              </button>
            ))}
          </div>
          <div style={{ padding: '0.875rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { onCreated(variantPickerData.product); setVariantPickerData(null); onClose() }}
              style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#475569', fontSize: '0.8rem', cursor: 'pointer', fontFamily: F }}>
              Sin variante específica
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Valores derivados para mostrar ─────────────────────────────────────────
  const costARS_display = deriveCostARS(form)
  const saleARS_display = parseFloat(form.sale_price_ars) || 0
  const margin_display  = calculateMarginPct(costARS_display, saleARS_display)
  const costUSD_display = form.base_currency === 'ARS' && costARS_display > 0 && rate > 1
    ? convertToUSD(costARS_display, rate)
    : parseFloat(form.cost_usd) || 0

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem', fontFamily: F,
      }}
    >
      <div style={{
        background: '#0d1a30', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: '1.25rem', width: '100%', maxWidth: '720px',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1.25rem 1.5rem', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Package size={20} color="#818cf8" />
            <h2 style={{ margin: 0, color: '#f1f5f9', fontSize: '1.1rem', fontWeight: 800, letterSpacing: '-0.03em' }}>
              Nuevo producto
            </h2>
            {supplierName && (
              <span style={{ fontSize: '0.75rem', color: '#475569', background: 'rgba(255,255,255,0.04)', padding: '0.2rem 0.625rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.07)' }}>
                Proveedor: {supplierName}
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem' }}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} style={{ overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Tipo — 3 opciones */}
          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {([
              { v: 'product',       label: 'Producto',        color: '#6366f1' },
              { v: 'service',       label: 'Servicio',         color: '#06b6d4' },
              { v: 'with_variants', label: 'Con variantes',    color: '#f59e0b' },
            ] as const).map(({ v, label, color }) => (
              <button
                key={v} type="button"
                onClick={() => set('tipo', v)}
                style={{
                  padding: '0.4rem 1rem', borderRadius: '999px', cursor: 'pointer',
                  border: `1px solid ${form.tipo === v ? color : 'rgba(255,255,255,0.1)'}`,
                  background: form.tipo === v ? `${color}22` : 'transparent',
                  color: form.tipo === v ? color : '#475569',
                  fontSize: '0.8rem', fontWeight: 600, fontFamily: F,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Duplicado detectado */}
          {duplicate && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '0.75rem' }}>
              <AlertCircle size={16} color="#fbbf24" style={{ flexShrink: 0 }} />
              <div>
                <p style={{ margin: 0, color: '#fbbf24', fontSize: '0.82rem', fontWeight: 700 }}>Producto similar encontrado</p>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '0.75rem' }}>"{duplicate.name}" (stock: {duplicate.stock_quantity}) — ¿Querés usar el existente?</p>
              </div>
              <button
                type="button"
                onClick={() => { onCreated(duplicate); onClose() }}
                style={{ marginLeft: 'auto', flexShrink: 0, padding: '0.3rem 0.75rem', background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: '0.5rem', color: '#fbbf24', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}
              >
                Usar existente
              </button>
            </div>
          )}

          {/* ── Sección: Identificación ── */}
          <Section label="Identificación">
            <Row2>
              <Field label="Nombre *">
                <input
                  value={form.name} required
                  onChange={e => set('name', e.target.value)}
                  onBlur={checkDuplicate}
                  placeholder="Pantalla iPhone 14 Pro"
                  style={inputS}
                />
              </Field>
              <Field label="Código / SKU">
                <input value={form.code} onChange={e => set('code', e.target.value)} placeholder="P001" style={inputS} />
              </Field>
            </Row2>
            <Row2>
              <Field label="Marca">
                <input value={form.brand} onChange={e => set('brand', e.target.value)} placeholder="Samsung, Apple..." style={inputS} />
              </Field>
              <Field label="Modelo compatible">
                <input value={form.model} onChange={e => set('model', e.target.value)} placeholder="iPhone 14 Pro" style={inputS} />
              </Field>
            </Row2>
            <Row2>
              <Field label="Código de barras">
                <input value={form.barcode} onChange={e => set('barcode', e.target.value)} placeholder="7890123456789" style={inputS} />
              </Field>
              <Field label="Proveedor">
                <select value={form.supplier_id} onChange={e => set('supplier_id', e.target.value)} style={inputS}>
                  <option value="">Sin proveedor</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
            </Row2>
            <Field label="Descripción">
              <textarea
                value={form.description} rows={2}
                onChange={e => set('description', e.target.value)}
                placeholder="Descripción opcional del producto"
                style={{ ...inputS, resize: 'vertical', minHeight: '60px' }}
              />
            </Field>
            {/* Categoría */}
            <Row2>
              <Field label="Categoría">
                {!showCatInput ? (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select value={form.category} onChange={e => set('category', e.target.value)} style={{ ...inputS, flex: 1 }}>
                      <option value="">Seleccionar...</option>
                      {DEFAULT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button type="button" onClick={() => setShowCatInput(true)} style={{ padding: '0 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.625rem', color: '#818cf8', fontSize: '0.75rem', cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
                      + Nueva
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      autoFocus value={form.newCategory}
                      onChange={e => set('newCategory', e.target.value)}
                      placeholder="Nueva categoría"
                      style={{ ...inputS, flex: 1 }}
                    />
                    <button type="button" onClick={() => setShowCatInput(false)} style={{ padding: '0 0.625rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.625rem', color: '#64748b', cursor: 'pointer', fontFamily: F }}>
                      Cancelar
                    </button>
                  </div>
                )}
              </Field>
              <Field label="Subcategoría">
                <input value={form.subcategory} onChange={e => set('subcategory', e.target.value)} placeholder="Opcional" style={inputS} />
              </Field>
            </Row2>
          </Section>

          {/* ── Sección: Costos y Precios ── */}
          <Section label="Costos y Precios">
            {/* Cotización */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.625rem' }}>
              <DollarSign size={14} color="#fbbf24" />
              <span style={{ color: '#64748b', fontSize: '0.78rem' }}>Cotización USD/ARS:</span>
              <input
                value={form.exchange_rate}
                onChange={e => setForm(f => ({ ...f, exchange_rate: e.target.value }))}
                style={{ width: '90px', background: 'transparent', border: 'none', outline: 'none', color: '#f1f5f9', fontSize: '0.85rem', fontWeight: 700, textAlign: 'right', fontFamily: F }}
              />
              <button type="button" onClick={fetchRate} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', padding: '0.125rem' }}>
                <RefreshCw size={13} style={{ animation: loadingRate ? 'spin 1s linear infinite' : 'none' }} />
              </button>
            </div>

            {/* Moneda base */}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 600 }}>Moneda del costo:</span>
              {(['ARS', 'USD'] as const).map(cur => (
                <button
                  key={cur} type="button"
                  onClick={() => handleCurrencyChange(cur)}
                  style={{
                    padding: '0.3rem 0.875rem', borderRadius: '999px', cursor: 'pointer',
                    border: `1px solid ${form.base_currency === cur ? '#fbbf24' : 'rgba(255,255,255,0.08)'}`,
                    background: form.base_currency === cur ? 'rgba(251,191,36,0.12)' : 'transparent',
                    color: form.base_currency === cur ? '#fbbf24' : '#475569',
                    fontSize: '0.78rem', fontWeight: 700, fontFamily: F,
                  }}
                >
                  {cur}
                </button>
              ))}
            </div>

            <Row2>
              <Field label={`Costo (${form.base_currency})`}>
                {form.base_currency === 'ARS' ? (
                  <div style={{ position: 'relative' }}>
                    <span style={prefixS}>$</span>
                    <input value={form.cost_ars} onChange={e => handleCostChange(e.target.value, 'cost_ars')} placeholder="0" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                  </div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <span style={prefixS}>U$</span>
                    <input value={form.cost_usd} onChange={e => handleCostChange(e.target.value, 'cost_usd')} placeholder="0" style={{ ...inputS, paddingLeft: '2rem' }} />
                  </div>
                )}
                {form.base_currency === 'USD' && costARS_display > 0 && (
                  <p style={hintS}>≈ ${Math.round(costARS_display).toLocaleString('es-AR')} ARS</p>
                )}
                {form.base_currency === 'ARS' && costUSD_display > 0 && rate > 1 && (
                  <p style={hintS}>≈ U${costUSD_display.toFixed(2)}</p>
                )}
              </Field>
              <Field label="Precio de venta (ARS)">
                <div style={{ position: 'relative' }}>
                  <span style={prefixS}>$</span>
                  <input value={form.sale_price_ars} onChange={e => handleSalePriceChange(e.target.value)} placeholder="0" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                </div>
              </Field>
            </Row2>

            <Row2>
              <Field label="Margen de ganancia %">
                <div style={{ position: 'relative' }}>
                  <input value={form.margin_pct} onChange={e => handleMarginChange(e.target.value)} placeholder="0" style={{ ...inputS, paddingRight: '1.75rem' }} />
                  <span style={{ ...prefixS, left: 'auto', right: '0.75rem' }}>%</span>
                </div>
                {isFinite(margin_display) && saleARS_display > 0 && (
                  <p style={hintS}>
                    Ganancia: ${Math.round((saleARS_display - costARS_display)).toLocaleString('es-AR')} ARS
                    {' '}({margin_display.toFixed(1)}%)
                  </p>
                )}
              </Field>
              <Field label="Precio mayorista (ARS)">
                <div style={{ position: 'relative' }}>
                  <span style={prefixS}>$</span>
                  <input value={form.wholesale_price} onChange={e => set('wholesale_price', e.target.value)} placeholder="Opcional" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                </div>
              </Field>
            </Row2>
          </Section>

          {/* ── Sección: Stock (solo productos) ── */}
          {form.tipo === 'product' && (
            <Section label="Stock">
              <Row2>
                <Field label="Stock inicial">
                  <input value={form.stock_quantity} onChange={e => set('stock_quantity', e.target.value)} placeholder="0" type="number" min="0" style={inputS} />
                </Field>
                <Field label="Stock mínimo">
                  <input value={form.min_stock} onChange={e => set('min_stock', e.target.value)} placeholder="0" type="number" min="0" style={inputS} />
                </Field>
              </Row2>
              <Field label="Ubicación">
                <input value={form.location} onChange={e => set('location', e.target.value)} placeholder="Ej: Estante A3, Caja 2" style={inputS} />
              </Field>

              {/* Registrar movimiento de inventario */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer', userSelect: 'none' }}>
                <div
                  onClick={() => set('register_stock', !form.register_stock)}
                  style={{
                    width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                    background: form.register_stock ? '#6366f1' : 'transparent',
                    border: `2px solid ${form.register_stock ? '#6366f1' : 'rgba(255,255,255,0.2)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  }}
                >
                  {form.register_stock && <Check size={11} color="#fff" strokeWidth={3} />}
                </div>
                <span style={{ color: '#94a3b8', fontSize: '0.82rem' }}>
                  Registrar movimiento de inventario al guardar
                  {sourceType && <span style={{ color: '#475569' }}> ({sourceType})</span>}
                </span>
              </label>
            </Section>
          )}

          {/* ── Sección variantes (solo con_variantes) ── */}
          {form.tipo === 'with_variants' && (
            <Section label="Variantes">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#475569', fontSize: '0.78rem' }}>
                  {form.variants.length} variante{form.variants.length !== 1 ? 's' : ''} agregada{form.variants.length !== 1 ? 's' : ''}
                </span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button type="button" onClick={applyBaseToVariants}
                    style={{ padding: '0.3rem 0.75rem', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: '0.5rem', color: '#818cf8', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                    ↓ Aplicar base a variantes
                  </button>
                  <button type="button" onClick={addVariantRow}
                    style={{ padding: '0.3rem 0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: '0.5rem', color: '#22c55e', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
                    + Agregar variante
                  </button>
                </div>
              </div>

              {form.variants.map((v, idx) => (
                <div key={v._key} style={{ border: `1px solid ${v.is_active ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)'}`, borderRadius: '0.75rem', overflow: 'hidden', opacity: v.is_active ? 1 : 0.5 }}>
                  {/* Cabecera variante */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.02)', cursor: 'pointer' }}
                    onClick={() => updateVariant(v._key, { expanded: !v.expanded })}>
                    <span style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 700, flex: 1 }}>
                      {v.name.trim() || `Variante ${idx + 1}`}
                      {v.sku && <span style={{ color: '#334155', marginLeft: '0.5rem' }}>#{v.sku}</span>}
                    </span>
                    {v.sale_price && <span style={{ color: '#818cf8', fontSize: '0.75rem', fontWeight: 700 }}>${parseFloat(v.sale_price).toLocaleString('es-AR')}</span>}
                    <span style={{ color: '#475569', fontSize: '0.75rem' }}>{parseInt(v.stock) || 0} u</span>
                    <div style={{ display: 'flex', gap: '0.25rem' }} onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => duplicateVariant(v._key)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.2rem', fontSize: '0.7rem' }} title="Duplicar">⊕</button>
                      {form.variants.length > 1 && (
                        <button type="button" onClick={() => removeVariant(v._key)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: '0.2rem', fontSize: '0.7rem' }} title="Eliminar">✕</button>
                      )}
                    </div>
                    <span style={{ color: '#334155', fontSize: '0.7rem' }}>{v.expanded ? '▲' : '▼'}</span>
                  </div>

                  {/* Campos de la variante */}
                  {v.expanded && (
                    <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                      <Row2>
                        <Field label="Nombre *">
                          <input value={v.name} onChange={e => updateVariant(v._key, { name: e.target.value })} placeholder="Rojo 128GB" style={inputS} />
                        </Field>
                        <Field label="SKU variante">
                          <input value={v.sku} onChange={e => updateVariant(v._key, { sku: e.target.value })} placeholder="P001-R128" style={inputS} />
                        </Field>
                      </Row2>
                      <Row2>
                        <Field label={`Costo (${form.base_currency})`}>
                          <div style={{ position: 'relative' }}>
                            <span style={prefixS}>{form.base_currency === 'USD' ? 'U$' : '$'}</span>
                            <input value={form.base_currency === 'USD' ? v.cost_usd : v.cost_ars}
                              onChange={e => updateVariant(v._key, form.base_currency === 'USD' ? { cost_usd: e.target.value } : { cost_ars: e.target.value })}
                              placeholder="0" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                          </div>
                        </Field>
                        <Field label="Precio venta (ARS)">
                          <div style={{ position: 'relative' }}>
                            <span style={prefixS}>$</span>
                            <input value={v.sale_price} onChange={e => updateVariant(v._key, { sale_price: e.target.value })} placeholder="0" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                          </div>
                        </Field>
                      </Row2>
                      <Row2>
                        <Field label="Precio mayorista">
                          <div style={{ position: 'relative' }}>
                            <span style={prefixS}>$</span>
                            <input value={v.wholesale} onChange={e => updateVariant(v._key, { wholesale: e.target.value })} placeholder="Opcional" style={{ ...inputS, paddingLeft: '1.75rem' }} />
                          </div>
                        </Field>
                        <Field label="Código de barras">
                          <input value={v.barcode} onChange={e => updateVariant(v._key, { barcode: e.target.value })} placeholder="Opcional" style={inputS} />
                        </Field>
                      </Row2>
                      <Row2>
                        <Field label="Stock inicial">
                          <input value={v.stock} onChange={e => updateVariant(v._key, { stock: e.target.value })} type="number" min="0" style={inputS} />
                        </Field>
                        <Field label="Stock mínimo">
                          <input value={v.min_stock} onChange={e => updateVariant(v._key, { min_stock: e.target.value })} type="number" min="0" style={inputS} />
                        </Field>
                      </Row2>
                      <Row2>
                        <Field label="Ubicación">
                          <input value={v.location} onChange={e => updateVariant(v._key, { location: e.target.value })} placeholder="Estante A3" style={inputS} />
                        </Field>
                        <Field label="Estado">
                          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', paddingTop: '0.5rem' }}>
                            <div onClick={() => updateVariant(v._key, { is_active: !v.is_active })}
                              style={{ width: 18, height: 18, borderRadius: 4, flexShrink: 0, background: v.is_active ? '#22c55e' : 'transparent', border: `2px solid ${v.is_active ? '#22c55e' : 'rgba(255,255,255,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                              {v.is_active && <Check size={11} color="#fff" strokeWidth={3} />}
                            </div>
                            <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>Activa</span>
                          </label>
                        </Field>
                      </Row2>
                    </div>
                  )}
                </div>
              ))}
            </Section>
          )}

          {/* Error */}
          {error && (
            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.75rem 1rem', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: '0.625rem' }}>
              <AlertCircle size={16} color="#f87171" style={{ flexShrink: 0 }} />
              <span style={{ color: '#f87171', fontSize: '0.82rem' }}>{error}</span>
            </div>
          )}
        </form>

        {/* Footer */}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <button type="button" onClick={onClose} style={{ padding: '0.625rem 1.25rem', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem', color: '#64748b', fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', fontFamily: F }}>
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.5rem', background: 'linear-gradient(135deg, #6366f1, #4f46e5)', border: 'none', borderRadius: '0.75rem', color: '#fff', fontWeight: 700, fontSize: '0.875rem', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1, fontFamily: F }}
          >
            {saving ? <><RefreshCw size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> Guardando...</> : 'Guardar producto'}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ─── Sub-componentes de layout ────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.07em', paddingBottom: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        {label}
      </div>
      {children}
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', color: '#64748b', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.35rem' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ─── Estilos compartidos ──────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '0.625rem 0.875rem',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '0.625rem',
  color: '#f1f5f9', fontSize: '0.875rem',
  fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  outline: 'none', transition: 'border-color 0.15s',
}

const prefixS: React.CSSProperties = {
  position: 'absolute', left: '0.75rem', top: '50%',
  transform: 'translateY(-50%)', color: '#475569', fontSize: '0.82rem',
  pointerEvents: 'none',
}

const hintS: React.CSSProperties = {
  margin: '0.25rem 0 0', color: '#475569', fontSize: '0.72rem',
}
