import { useState, useEffect, useRef, useCallback } from 'react'
import { ProductFormModal } from '../products/ProductFormModal'
import type { InventoryItem as InventoryItemHook } from '../../hooks/useInventory'
import { productService } from '../../services/productService'
import { inventoryMovementsService } from '../../services/inventoryMovementsService'
import {
  DollarSign, Calendar, Tag, Building2, Loader2, Plus, Trash2,
  Search, Package, ChevronDown, AlertCircle, CheckCircle2, ShoppingCart,
  Boxes, TrendingDown
} from 'lucide-react'
import { CloseButton } from '../ui/CloseButton'
import { supabase } from '../../lib/supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Supplier {
  id: string
  name: string
}

interface InventoryItem {
  id: string
  code: string
  name: string
  category: string
  stock_quantity: number
  cost_price: number
  sale_price: number
}

interface CompraItem {
  _key: string
  // Producto seleccionado o nuevo
  inventoryId: string | null
  nombre: string
  codigo: string
  categoriaInventario: string
  precioVenta: number
  esNuevo: boolean
  // Detalles de compra
  cantidad: number
  costoUnitario: number
}

const emptyItem = (): CompraItem => ({
  _key: Math.random().toString(36).slice(2),
  inventoryId: null,
  nombre: '',
  codigo: '',
  categoriaInventario: 'Repuestos',
  precioVenta: 0,
  esNuevo: false,
  cantidad: 1,
  costoUnitario: 0,
})

// ─── Props ────────────────────────────────────────────────────────────────────

interface ModalCrearGastoProps {
  isOpen: boolean
  onClose: () => void
  onCrear: (data: {
    descripcion: string
    categoria: string
    monto: number
    fecha: string
    proveedor: string
    metodoPago?: string
  }) => void
  onSuccess?: () => void
  loading?: boolean
  businessId?: string | null
  userId?: string
}

// ─── Categorías ───────────────────────────────────────────────────────────────

const categoriasConfig = {
  inventario: {
    label: 'Compra a proveedor',
    description: 'Productos, repuestos y mercadería con impacto en stock',
    icon: ShoppingCart,
    color: '#6366f1',
    bgColor: 'rgba(99,102,241,0.1)',
    borderColor: 'rgba(99,102,241,0.3)',
  },
  operativos: {
    label: 'Operativos',
    description: 'Alquiler, servicios, luz, internet, etc.',
    icon: Building2,
    color: '#10b981',
    bgColor: 'rgba(16,185,129,0.1)',
    borderColor: 'rgba(16,185,129,0.3)',
  },
  equipamiento: {
    label: 'Equipamiento',
    description: 'Herramientas, maquinaria y activos fijos',
    icon: Boxes,
    color: '#f59e0b',
    bgColor: 'rgba(245,158,11,0.1)',
    borderColor: 'rgba(245,158,11,0.3)',
  },
  marketing: {
    label: 'Marketing',
    description: 'Publicidad, redes y promoción',
    icon: TrendingDown,
    color: '#ef4444',
    bgColor: 'rgba(239,68,68,0.1)',
    borderColor: 'rgba(239,68,68,0.3)',
  },
  otros: {
    label: 'Otros',
    description: 'Gastos varios sin categoría específica',
    icon: Tag,
    color: '#8b5cf6',
    bgColor: 'rgba(139,92,246,0.1)',
    borderColor: 'rgba(139,92,246,0.3)',
  },
}

const INVENTORY_CATEGORIES = [
  'Repuestos', 'Accesorios', 'Pantallas', 'Baterías',
  'Herramientas', 'Insumos', 'Equipos', 'Cables', 'Otro'
]

// ─── Sub-component: ProductSearchInput ────────────────────────────────────────

function ProductSearchInput({
  item,
  onChange,
  onRemove,
  onOpenProductForm,
  businessId,
  idx,
}: {
  item: CompraItem
  onChange: (updates: Partial<CompraItem>) => void
  onRemove: () => void
  onOpenProductForm?: (initialName: string, itemKey: string) => void
  businessId: string | null | undefined
  idx: number
}) {
  const [query, setQuery] = useState(item.esNuevo ? '' : item.nombre)
  const [results, setResults] = useState<InventoryItem[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = useCallback(async (q: string) => {
    if (!q.trim() || !businessId) { setResults([]); return }
    setSearching(true)
    try {
      const { data } = await supabase
        .from('inventory')
        .select('id, code, name, category, stock_quantity, cost_price, sale_price')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .or(`name.ilike.%${q}%,code.ilike.%${q}%`)
        .order('name')
        .limit(8)
      setResults(data || [])
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [businessId])

  const handleInputChange = (val: string) => {
    setQuery(val)
    setOpen(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => search(val), 280)
  }

  const selectProduct = (prod: InventoryItem) => {
    setQuery(prod.name)
    setOpen(false)
    setShowNewForm(false)
    onChange({
      inventoryId: prod.id,
      nombre: prod.name,
      codigo: prod.code,
      categoriaInventario: prod.category,
      precioVenta: prod.sale_price,
      costoUnitario: prod.cost_price || item.costoUnitario,
      esNuevo: false,
    })
  }

  const handleCreateNew = () => {
    setOpen(false)
    onOpenProductForm?.(query.trim(), item._key)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.75rem',
    backgroundColor: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.375rem',
    color: '#f1f5f9',
    fontSize: '0.875rem',
    outline: 'none',
    boxSizing: 'border-box',
  }

  const rowBg = '#0f1829'
  const total = item.cantidad * item.costoUnitario

  return (
    <div style={{
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '0.75rem',
      backgroundColor: rowBg,
      overflow: 'visible',
      marginBottom: '0.75rem',
    }}>
      {/* Row header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        padding: '0.75rem 0.875rem 0.5rem',
        gap: '0.5rem',
      }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Ítem #{idx + 1}
        </span>
        <button
          onClick={onRemove}
          style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: '0.25rem', borderRadius: '0.25rem', display: 'flex' }}
          title="Eliminar ítem"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div style={{ padding: '0 0.875rem 0.875rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
        {/* Product search */}
        {!showNewForm ? (
          <div ref={wrapperRef} style={{ position: 'relative' }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
              <input
                type="text"
                value={query}
                onChange={e => handleInputChange(e.target.value)}
                onFocus={() => { setOpen(true); if (!results.length && query) search(query) }}
                placeholder="Buscar producto o código..."
                style={{ ...inputStyle, paddingLeft: '2rem', paddingRight: item.inventoryId ? '2rem' : undefined }}
              />
              {item.inventoryId && (
                <CheckCircle2 size={13} style={{ position: 'absolute', right: '0.625rem', top: '50%', transform: 'translateY(-50%)', color: '#10b981' }} />
              )}
            </div>

            {/* Dropdown */}
            {open && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                backgroundColor: '#0b1120',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '0.5rem',
                zIndex: 999,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                overflow: 'hidden',
                maxHeight: '220px',
                overflowY: 'auto',
              }}>
                {searching ? (
                  <div style={{ padding: '0.75rem 1rem', color: '#64748b', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Loader2 size={12} className="animate-spin" /> Buscando...
                  </div>
                ) : results.length === 0 && query.trim() ? (
                  <>
                    <div style={{ padding: '0.75rem 1rem', color: '#64748b', fontSize: '0.8rem' }}>
                      Sin resultados para "{query}"
                    </div>
                    <button
                      onClick={handleCreateNew}
                      style={{
                        width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                        background: 'rgba(99,102,241,0.1)', border: 'none',
                        borderTop: '1px solid rgba(255,255,255,0.06)',
                        color: '#818cf8', fontSize: '0.8rem', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: '0.5rem'
                      }}
                    >
                      <Plus size={12} /> Crear "{query}" como nuevo producto
                    </button>
                  </>
                ) : results.length > 0 ? (
                  <>
                    {results.map(r => (
                      <button
                        key={r.id}
                        onClick={() => selectProduct(r)}
                        style={{
                          width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                          background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)',
                          color: '#f1f5f9', fontSize: '0.8rem', cursor: 'pointer',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <span>
                          <span style={{ color: '#f1f5f9', fontWeight: 500 }}>{r.name}</span>
                          {r.code && <span style={{ color: '#475569', marginLeft: '0.5rem' }}>#{r.code}</span>}
                        </span>
                        <span style={{ color: '#475569', fontSize: '0.75rem', whiteSpace: 'nowrap', marginLeft: '0.5rem' }}>
                          Stock: {r.stock_quantity}
                        </span>
                      </button>
                    ))}
                    <button
                      onClick={handleCreateNew}
                      style={{
                        width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                        background: 'rgba(99,102,241,0.06)', border: 'none',
                        borderTop: '1px solid rgba(255,255,255,0.06)',
                        color: '#818cf8', fontSize: '0.8rem', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: '0.5rem'
                      }}
                    >
                      <Plus size={12} /> Crear nuevo producto{query ? ` "${query}"` : ''}
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>
        ) : (
          /* Inline new product form — reemplazado por ProductFormModal */
          <div style={{
            border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
            backgroundColor: 'rgba(99,102,241,0.06)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#818cf8' }}>✦ Creando producto...</span>
              <button
                onClick={() => { setShowNewForm(false); onChange({ esNuevo: false, inventoryId: null, nombre: '' }); setQuery('') }}
                style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '0.7rem' }}
              >
                Buscar existente
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Nombre *</label>
                <input
                  type="text"
                  value={item.nombre}
                  onChange={e => onChange({ nombre: e.target.value })}
                  placeholder="Nombre del producto"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Código</label>
                <input
                  type="text"
                  value={item.codigo}
                  onChange={e => onChange({ codigo: e.target.value })}
                  placeholder="SKU / Código"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Categoría</label>
                <select
                  value={item.categoriaInventario}
                  onChange={e => onChange({ categoriaInventario: e.target.value })}
                  style={{ ...inputStyle }}
                >
                  {INVENTORY_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Precio de venta sugerido</label>
                <input
                  type="number"
                  value={item.precioVenta || ''}
                  onChange={e => onChange({ precioVenta: parseFloat(e.target.value) || 0 })}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
        )}

        {/* Qty + Cost + Total */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', alignItems: 'end' }}>
          <div>
            <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Cantidad *</label>
            <input
              type="number"
              value={item.cantidad}
              onChange={e => onChange({ cantidad: parseFloat(e.target.value) || 0 })}
              min="0.01"
              step="0.01"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ fontSize: '0.7rem', color: '#64748b', display: 'block', marginBottom: '0.25rem' }}>Costo unit. *</label>
            <input
              type="number"
              value={item.costoUnitario || ''}
              onChange={e => onChange({ costoUnitario: parseFloat(e.target.value) || 0 })}
              placeholder="0.00"
              min="0"
              step="0.01"
              style={inputStyle}
            />
          </div>
          <div style={{
            padding: '0.5rem 0.75rem',
            backgroundColor: 'rgba(99,102,241,0.08)',
            border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: '0.375rem',
            textAlign: 'right',
          }}>
            <div style={{ fontSize: '0.65rem', color: '#475569', marginBottom: '0.125rem' }}>Subtotal</div>
            <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#818cf8', fontFamily: 'monospace' }}>
              ${total.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function ModalCrearGasto({
  isOpen,
  onClose,
  onCrear,
  onSuccess,
  loading = false,
  businessId,
  userId,
}: ModalCrearGastoProps) {
  const [step, setStep] = useState(1)
  const [categoria, setCategoria] = useState('operativos')

  // Simple form state
  const [descripcion, setDescripcion] = useState('')
  const [monto, setMonto] = useState('')
  const [fecha, setFecha] = useState(new Date().toISOString().split('T')[0])
  const [proveedor, setProveedor] = useState('')
  const [metodoPago, setMetodoPago] = useState('efectivo')

  // Inventory purchase state
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierQuery, setSupplierQuery] = useState('')
  const [supplierOpen, setSupplierOpen] = useState(false)
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [currency, setCurrency] = useState<'ARS' | 'USD'>('ARS')
  const [exchangeRate, setExchangeRate] = useState('')
  const [purchaseNote, setPurchaseNote] = useState('')
  const [items, setItems] = useState<CompraItem[]>([emptyItem()])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState(false)

  const supplierWrapperRef = useRef<HTMLDivElement>(null)

  // Load suppliers
  useEffect(() => {
    if (!isOpen || !businessId) return
    supabase
      .from('suppliers')
      .select('id, name')
      .eq('business_id', businessId)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setSuppliers(data || []))
      .catch(() => setSuppliers([]))
  }, [isOpen, businessId])

  // Load current exchange rate
  useEffect(() => {
    if (!isOpen || currency !== 'USD') return
    supabase
      .from('exchange_rates')
      .select('rate')
      .eq('base_currency', 'USD')
      .eq('target_currency', 'ARS')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()
      .then(({ data }) => { if (data?.rate) setExchangeRate(String(data.rate)) })
      .catch(() => {})
  }, [isOpen, currency])

  // Supplier dropdown outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (supplierWrapperRef.current && !supplierWrapperRef.current.contains(e.target as Node)) {
        setSupplierOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const resetAll = () => {
    setStep(1)
    setCategoria('operativos')
    setDescripcion('')
    setMonto('')
    setFecha(new Date().toISOString().split('T')[0])
    setProveedor('')
    setMetodoPago('efectivo')
    setSupplierQuery('')
    setSelectedSupplierId(null)
    setInvoiceNumber('')
    setCurrency('ARS')
    setExchangeRate('')
    setPurchaseNote('')
    setItems([emptyItem()])
    setSubmitError(null)
    setSubmitSuccess(false)
  }

  const handleClose = () => {
    resetAll()
    onClose()
  }

  if (!isOpen) return null

  const handleCategoriaSelect = (cat: string) => {
    setCategoria(cat)
    setStep(2)
  }

  // ─── Simple submit ──────────────────────────────────────────────────────────
  const handleSimpleSubmit = () => {
    if (!descripcion.trim()) { alert('Ingresá una descripción'); return }
    if (!monto || parseFloat(monto) <= 0) { alert('Ingresá un monto válido'); return }
    onCrear({ descripcion, categoria, monto: parseFloat(monto), fecha, proveedor, metodoPago })
  }

  // ─── Inventory purchase submit ──────────────────────────────────────────────
  const handlePurchaseSubmit = async () => {
    setSubmitError(null)

    // Validate
    const validItems = items.filter(it => it.nombre.trim() && it.cantidad > 0 && it.costoUnitario >= 0)
    if (validItems.length === 0) {
      setSubmitError('Agregá al menos un producto con cantidad y costo válidos')
      return
    }
    for (const it of validItems) {
      if (!it.inventoryId && !it.nombre.trim()) {
        setSubmitError('Todos los ítems deben tener un producto seleccionado o nombre ingresado')
        return
      }
    }

    const rate = currency === 'USD' ? parseFloat(exchangeRate) || 1 : 1
    const totalARS = validItems.reduce((s, it) => s + it.cantidad * it.costoUnitario * rate, 0)

    setSubmitting(true)
    try {
      // 1. Ensure each new inventory item exists
      const resolvedItems: (CompraItem & { resolvedId: string })[] = []

      for (const it of validItems) {
        if (it.inventoryId) {
          resolvedItems.push({ ...it, resolvedId: it.inventoryId })
        } else if (it.nombre.trim() && businessId && userId) {
          // Fallback: crear producto completo via productService (no debería llegar aquí
          // si ProductFormModal está correctamente integrado, pero lo mantenemos como red de seguridad)
          const product = await productService.createProduct({
            business_id:  businessId,
            created_by:   userId,
            name:         it.nombre.trim(),
            code:         it.codigo.trim() || undefined,
            category:     it.categoriaInventario || 'Otros',
            tipo:         'product',
            base_currency: currency as 'ARS' | 'USD',
            base_price:   it.costoUnitario,
            cost_price:   it.costoUnitario * rate,
            sale_price:   it.precioVenta || 0,
            stock_quantity: 0,  // stock sube en el paso siguiente
            is_active:    true,
          })
          resolvedItems.push({ ...it, resolvedId: product.id, inventoryId: product.id })
        }
      }

      // 2. Sumar stock via inventoryMovementsService (maneja previous_stock, new_stock, audit)
      for (const it of resolvedItems) {
        await inventoryMovementsService.registerMovement(
          it.resolvedId,
          'purchase',
          it.cantidad,
          'purchase',
          undefined,   // referenceId se asigna en paso 3 cuando tengamos el purchaseId
          `Compra: ${supplierQuery || 'Proveedor'}${invoiceNumber ? ` - Factura ${invoiceNumber}` : ''}`,
          businessId ?? undefined,
          userId ?? undefined
        )
        // Actualizar también el costo unitario
        if (it.costoUnitario > 0) {
          await supabase
            .from('inventory')
            .update({ cost_price: it.costoUnitario * rate, updated_at: new Date().toISOString() })
            .eq('id', it.resolvedId)
        }
      }

      // 3. Create purchase record
      const { data: purchaseRecord, error: purchaseErr } = await supabase
        .from('purchases')
        .insert({
          business_id: businessId,
          supplier_id: selectedSupplierId || null,
          invoice_number: invoiceNumber.trim() || null,
          purchase_date: fecha,
          subtotal: totalARS,
          taxes: 0,
          total: totalARS,
          notes: purchaseNote.trim() || null,
          status: 'confirmed',
          created_by: userId || null,
        })
        .select('id')
        .single()

      if (purchaseErr) throw new Error(`Error creando compra: ${purchaseErr.message}`)

      // 4. Create purchase items
      await supabase
        .from('purchase_items')
        .insert(
          resolvedItems.map(it => ({
            purchase_id: purchaseRecord.id,
            inventory_item_id: it.resolvedId,
            description: it.nombre,
            quantity: it.cantidad,
            unit_cost: it.costoUnitario * rate,
            subtotal: it.cantidad * it.costoUnitario * rate,
          }))
        )

      // 5. Record in business_finance_entries
      await supabase
        .from('business_finance_entries')
        .insert({
          business_id: businessId,
          date: fecha,
          type: 'variable_cost',
          category: 'repuestos',
          subcategory: 'compra_proveedor',
          description: `Compra a ${supplierQuery || 'Proveedor'}${invoiceNumber ? ` - ${invoiceNumber}` : ''} (${validItems.length} ítem${validItems.length > 1 ? 's' : ''})`,
          amount: totalARS,
          currency: 'ARS',
          amount_ars: totalARS,
          exchange_rate: rate,
          payment_method: 'transferencia',
          notes: purchaseNote.trim() || null,
          reference_order_id: null,
          created_by: userId || null,
        })

      // 6. Record in expenses (for existing expenses view)
      await supabase
        .from('expenses')
        .insert({
          description: `Compra a ${supplierQuery || 'Proveedor'}${invoiceNumber ? ` (${invoiceNumber})` : ''}`,
          category: 'Inventario',
          amount: totalARS,
          date: fecha,
          business_id: businessId,
        })

      setSubmitSuccess(true)
      setTimeout(() => {
        onSuccess?.()
        handleClose()
      }, 1500)
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Error al guardar la compra')
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Item helpers ───────────────────────────────────────────────────────────
  const updateItem = (key: string, updates: Partial<CompraItem>) => {
    setItems(prev => prev.map(it => it._key === key ? { ...it, ...updates } : it))
  }
  const removeItem = (key: string) => {
    setItems(prev => prev.length > 1 ? prev.filter(it => it._key !== key) : prev)
  }
  const addItem = () => setItems(prev => [...prev, emptyItem()])

  // ProductFormModal state — manejado aquí para evitar problemas de JSX en sub-componentes
  const [showProductFormModal, setShowProductFormModal] = useState(false)
  const [productFormItemKey, setProductFormItemKey] = useState<string | null>(null)
  const [productFormInitialName, setProductFormInitialName] = useState('')

  const handleOpenProductForm = (initialName: string, itemKey: string) => {
    setProductFormInitialName(initialName)
    setProductFormItemKey(itemKey)
    setShowProductFormModal(true)
  }

  const handleProductCreated = (product: InventoryItemHook) => {
    if (productFormItemKey) {
      updateItem(productFormItemKey, {
        inventoryId:         product.id,
        nombre:              product.name,
        codigo:              product.code || '',
        categoriaInventario: product.category || 'Repuestos',
        precioVenta:         product.sale_price || 0,
        costoUnitario:       product.cost_price || 0,
        esNuevo:             false,
      })
    }
    setShowProductFormModal(false)
    setProductFormItemKey(null)
  }

  const totalItems = items.reduce((s, it) => s + it.cantidad * it.costoUnitario, 0)
  const rate = currency === 'USD' ? parseFloat(exchangeRate) || 1 : 1
  const totalARS = totalItems * rate

  const filteredSuppliers = suppliers.filter(s =>
    s.name.toLowerCase().includes(supplierQuery.toLowerCase())
  )

  // ─── Styles ────────────────────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.75rem 1rem',
    backgroundColor: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.5rem',
    color: '#f1f5f9',
    outline: 'none',
    fontSize: '0.875rem',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '0.5rem',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 50, padding: '1rem',
    }}>
      <div style={{
        backgroundColor: '#0b1120',
        borderRadius: '1rem',
        border: '1px solid rgba(255,255,255,0.08)',
        width: '100%',
        maxWidth: categoria === 'inventario' && step === 2 ? '780px' : '640px',
        maxHeight: '92vh',
        overflowY: 'auto',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        transition: 'max-width 0.2s ease',
      }}>
        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)',
          position: 'sticky', top: 0, backgroundColor: '#0b1120', zIndex: 10,
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
              <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', backgroundColor: '#f59e0b' }} />
              <span style={{ fontSize: '0.7rem', color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                {step === 1 ? 'Paso 1 de 2' : 'Paso 2 de 2'}
              </span>
            </div>
            <h2 style={{ fontSize: '1.375rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
              {step === 1
                ? 'Registrar gasto'
                : categoria === 'inventario'
                  ? 'Compra a proveedor'
                  : 'Detalles del gasto'}
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.25rem' }}>
              {step === 1
                ? 'Seleccioná el tipo de gasto'
                : categoria === 'inventario'
                  ? 'Buscá o creá productos · actualiza stock y finanzas automáticamente'
                  : `Configurando gasto operativo`}
            </p>
          </div>
          <CloseButton onClick={handleClose} />
        </div>

        {/* ── Step 1: Category ── */}
        {step === 1 && (
          <div style={{ padding: '1.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.875rem' }}>
              {(Object.keys(categoriasConfig) as (keyof typeof categoriasConfig)[]).map(catKey => {
                const cfg = categoriasConfig[catKey]
                const Icon = cfg.icon
                const isSelected = categoria === catKey
                return (
                  <button
                    key={catKey}
                    onClick={() => handleCategoriaSelect(catKey)}
                    style={{
                      position: 'relative', padding: '1.125rem',
                      borderRadius: '0.875rem', border: '2px solid',
                      backgroundColor: isSelected ? cfg.bgColor : 'rgba(11,17,32,0.6)',
                      borderColor: isSelected ? cfg.borderColor : 'rgba(255,255,255,0.06)',
                      textAlign: 'left', cursor: 'pointer', transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
                        e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)'
                      }
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
                        e.currentTarget.style.backgroundColor = 'rgba(11,17,32,0.6)'
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
                      <div style={{
                        width: '2.5rem', height: '2.5rem', borderRadius: '0.625rem',
                        backgroundColor: cfg.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                        marginTop: '0.125rem',
                      }}>
                        <Icon size={18} color="#fff" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
                          <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>{cfg.label}</h3>
                          {catKey === 'inventario' && (
                            <span style={{
                              fontSize: '0.6rem', fontWeight: 700, color: '#818cf8',
                              backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: '0.25rem',
                              padding: '0.15rem 0.4rem', border: '1px solid rgba(99,102,241,0.3)',
                              textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
                            }}>
                              Stock + Finanzas
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0, lineHeight: 1.4 }}>{cfg.description}</p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Step 2a: Inventory Purchase ── */}
        {step === 2 && categoria === 'inventario' && (
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {submitSuccess && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '1rem 1.25rem', borderRadius: '0.625rem',
                backgroundColor: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
              }}>
                <CheckCircle2 size={20} style={{ color: '#10b981', flexShrink: 0 }} />
                <div>
                  <div style={{ color: '#10b981', fontWeight: 600, fontSize: '0.875rem' }}>¡Compra registrada!</div>
                  <div style={{ color: '#6ee7b7', fontSize: '0.8rem' }}>Stock, finanzas y gastos actualizados correctamente.</div>
                </div>
              </div>
            )}

            {submitError && (
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                padding: '1rem 1.25rem', borderRadius: '0.625rem',
                backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
              }}>
                <AlertCircle size={16} style={{ color: '#ef4444', flexShrink: 0, marginTop: '0.125rem' }} />
                <span style={{ color: '#fca5a5', fontSize: '0.8rem' }}>{submitError}</span>
              </div>
            )}

            {/* Proveedor + Fecha + Factura */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              {/* Supplier */}
              <div style={{ gridColumn: '1 / -1' }} ref={supplierWrapperRef}>
                <label style={labelStyle}>Proveedor</label>
                <div style={{ position: 'relative' }}>
                  <Building2 size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    value={supplierQuery}
                    onChange={e => { setSupplierQuery(e.target.value); setSelectedSupplierId(null); setSupplierOpen(true) }}
                    onFocus={() => setSupplierOpen(true)}
                    placeholder="Nombre del proveedor..."
                    style={{ ...inputStyle, paddingLeft: '2.25rem', paddingRight: '2rem' }}
                  />
                  <ChevronDown size={14} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                  {supplierOpen && (filteredSuppliers.length > 0 || supplierQuery.trim()) && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                      backgroundColor: '#0b1120', border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '0.5rem', zIndex: 999, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                      overflow: 'hidden', maxHeight: '180px', overflowY: 'auto',
                    }}>
                      {filteredSuppliers.map(s => (
                        <button
                          key={s.id}
                          onClick={() => { setSupplierQuery(s.name); setSelectedSupplierId(s.id); setSupplierOpen(false) }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                            background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.04)',
                            color: '#f1f5f9', fontSize: '0.8rem', cursor: 'pointer',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)')}
                          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                        >
                          {s.name}
                        </button>
                      ))}
                      {supplierQuery.trim() && !filteredSuppliers.some(s => s.name.toLowerCase() === supplierQuery.toLowerCase()) && (
                        <button
                          onClick={() => { setSupplierOpen(false) }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '0.625rem 1rem',
                            background: 'rgba(99,102,241,0.06)', border: 'none',
                            color: '#818cf8', fontSize: '0.8rem', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '0.5rem'
                          }}
                        >
                          <Plus size={12} /> Usar "{supplierQuery}" como proveedor nuevo
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Date */}
              <div>
                <label style={labelStyle}>Fecha de compra</label>
                <div style={{ position: 'relative' }}>
                  <Calendar size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                  <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} style={{ ...inputStyle, paddingLeft: '2.25rem' }} />
                </div>
              </div>

              {/* Invoice */}
              <div>
                <label style={labelStyle}>N° Factura / Remito <span style={{ color: '#475569', fontWeight: 400 }}>(opcional)</span></label>
                <input
                  type="text"
                  value={invoiceNumber}
                  onChange={e => setInvoiceNumber(e.target.value)}
                  placeholder="0001-00000001"
                  style={inputStyle}
                />
              </div>

              {/* Currency */}
              <div>
                <label style={labelStyle}>Moneda</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(['ARS', 'USD'] as const).map(cur => (
                    <button
                      key={cur}
                      onClick={() => setCurrency(cur)}
                      style={{
                        flex: 1, padding: '0.625rem',
                        background: currency === cur ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : 'rgba(255,255,255,0.04)',
                        border: currency === cur ? 'none' : '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '0.375rem', color: currency === cur ? '#fff' : '#94a3b8',
                        cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
                      }}
                    >
                      {cur}
                    </button>
                  ))}
                </div>
              </div>

              {/* Exchange rate */}
              {currency === 'USD' && (
                <div>
                  <label style={labelStyle}>Tipo de cambio (USD → ARS)</label>
                  <div style={{ position: 'relative' }}>
                    <DollarSign size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }} />
                    <input
                      type="number"
                      value={exchangeRate}
                      onChange={e => setExchangeRate(e.target.value)}
                      placeholder="1200.00"
                      min="1"
                      step="0.01"
                      style={{ ...inputStyle, paddingLeft: '2.25rem' }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Items section */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Package size={15} style={{ color: '#818cf8' }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Productos comprados
                  </span>
                  <span style={{
                    fontSize: '0.7rem', color: '#818cf8', fontWeight: 600,
                    backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: '0.25rem',
                    padding: '0.125rem 0.375rem', border: '1px solid rgba(99,102,241,0.3)',
                  }}>
                    {items.length}
                  </span>
                </div>
                <button
                  onClick={addItem}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.375rem',
                    padding: '0.375rem 0.75rem',
                    background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)',
                    borderRadius: '0.375rem', color: '#818cf8', cursor: 'pointer',
                    fontSize: '0.75rem', fontWeight: 600,
                  }}
                >
                  <Plus size={12} /> Agregar ítem
                </button>
              </div>

              {items.map((item, idx) => (
                <ProductSearchInput
                  key={item._key}
                  item={item}
                  idx={idx}
                  onChange={updates => updateItem(item._key, updates)}
                  onRemove={() => removeItem(item._key)}
                  onOpenProductForm={handleOpenProductForm}
                  businessId={businessId}
                />
              ))}
            </div>

            {/* Note */}
            <div>
              <label style={labelStyle}>Nota interna <span style={{ color: '#475569', fontWeight: 400 }}>(opcional)</span></label>
              <textarea
                value={purchaseNote}
                onChange={e => setPurchaseNote(e.target.value)}
                placeholder="Observaciones sobre la compra..."
                rows={2}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            {/* Summary */}
            <div style={{
              padding: '1rem 1.25rem',
              backgroundColor: '#0f1829',
              border: '1px solid rgba(99,102,241,0.2)',
              borderRadius: '0.75rem',
            }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                Resumen de compra
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: '#64748b' }}>{items.length} ítem{items.length !== 1 ? 's' : ''}</span>
                  <span style={{ color: '#94a3b8' }}>
                    {currency === 'USD'
                      ? `USD ${totalItems.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                      : `$${totalItems.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`}
                  </span>
                </div>
                {currency === 'USD' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                    <span style={{ color: '#64748b' }}>Tipo de cambio</span>
                    <span style={{ color: '#94a3b8' }}>× {exchangeRate || '1'}</span>
                  </div>
                )}
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.5rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#f1f5f9', fontWeight: 700 }}>Total ARS</span>
                  <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#818cf8', fontFamily: 'monospace' }}>
                    ${totalARS.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {['📦 Stock actualizado', '💰 Registrado en Finanzas', '📋 Guardado en Gastos'].map(tag => (
                  <span key={tag} style={{
                    fontSize: '0.7rem', color: '#475569',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '0.25rem', padding: '0.125rem 0.5rem',
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setStep(1)}
                disabled={submitting}
                style={{
                  padding: '0.75rem 1.25rem', color: '#94a3b8',
                  backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.625rem', cursor: 'pointer', fontSize: '0.875rem',
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                Volver
              </button>
              <button
                onClick={handlePurchaseSubmit}
                disabled={submitting || submitSuccess}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  padding: '0.75rem 1.5rem',
                  background: submitSuccess
                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                    : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none', color: '#fff',
                  borderRadius: '0.625rem', cursor: submitting || submitSuccess ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem', fontWeight: 600,
                  boxShadow: `0 4px 12px ${submitSuccess ? 'rgba(16,185,129,0.35)' : 'rgba(99,102,241,0.35)'}`,
                  opacity: submitting ? 0.8 : 1,
                  transition: 'all 0.2s ease',
                }}
              >
                {submitting ? (
                  <><Loader2 size={16} className="animate-spin" /> Procesando...</>
                ) : submitSuccess ? (
                  <><CheckCircle2 size={16} /> ¡Compra registrada!</>
                ) : (
                  <><ShoppingCart size={16} /> Registrar compra</>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2b: Simple form ── */}
        {step === 2 && categoria !== 'inventario' && (
          <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <label style={labelStyle}>Descripción <span style={{ color: '#fbbf24' }}>*</span></label>
              <input
                type="text"
                value={descripcion}
                onChange={e => setDescripcion(e.target.value)}
                placeholder="Ej: Alquiler del local junio"
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Monto <span style={{ color: '#fbbf24' }}>*</span></label>
              <div style={{ position: 'relative' }}>
                <DollarSign size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                <input
                  type="number"
                  value={monto}
                  onChange={e => setMonto(e.target.value)}
                  placeholder="0.00"
                  min="0" step="0.01"
                  style={{ ...inputStyle, paddingLeft: '2.5rem', fontFamily: 'monospace', fontSize: '1.125rem' }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label style={labelStyle}>Fecha</label>
                <div style={{ position: 'relative' }}>
                  <Calendar size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                  <input type="date" value={fecha} onChange={e => setFecha(e.target.value)} style={{ ...inputStyle, paddingLeft: '2.25rem' }} />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Proveedor</label>
                <input
                  type="text"
                  value={proveedor}
                  onChange={e => setProveedor(e.target.value)}
                  placeholder="Nombre del proveedor"
                  style={inputStyle}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Método de pago</label>
              <select
                value={metodoPago}
                onChange={e => setMetodoPago(e.target.value)}
                style={inputStyle}
              >
                <option value="efectivo">Efectivo</option>
                <option value="transferencia">Transferencia</option>
                <option value="tarjeta_debito">Tarjeta de débito</option>
                <option value="tarjeta_credito">Tarjeta de crédito</option>
                <option value="cheque">Cheque</option>
                <option value="otro">Otro</option>
              </select>
            </div>

            {/* Mini summary */}
            <div style={{
              padding: '1rem', backgroundColor: '#0f1829',
              border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.625rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                    {categoriasConfig[categoria as keyof typeof categoriasConfig]?.label} · {fecha}
                  </div>
                  <div style={{ fontSize: '0.875rem', color: '#94a3b8', marginTop: '0.25rem' }}>{descripcion || '—'}</div>
                </div>
                <span style={{ fontSize: '1.375rem', fontWeight: 700, color: '#f87171', fontFamily: 'monospace' }}>
                  ${monto ? parseFloat(monto).toLocaleString('es-AR', { minimumFractionDigits: 2 }) : '0.00'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setStep(1)}
                disabled={loading}
                style={{
                  padding: '0.75rem 1.25rem', color: '#94a3b8',
                  backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '0.625rem', cursor: 'pointer', fontSize: '0.875rem',
                  opacity: loading ? 0.5 : 1,
                }}
              >
                Volver
              </button>
              <button
                onClick={handleSimpleSubmit}
                disabled={loading}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  padding: '0.75rem 1.5rem',
                  background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                  border: 'none', color: '#fff', borderRadius: '0.625rem',
                  cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.875rem', fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(245,158,11,0.35)', opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? <><Loader2 size={16} className="animate-spin" /> Guardando...</> : <><DollarSign size={16} /> Registrar gasto</>}
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin { animation: spin 1s linear infinite; }
      `}</style>

      {/* ProductFormModal — creación de producto desde ítem de compra
          registerStock=false: el stock se suma en handleSaveCompra al registrar la factura */}
      <ProductFormModal
        isOpen={showProductFormModal}
        onClose={() => { setShowProductFormModal(false); setProductFormItemKey(null) }}
        onCreated={handleProductCreated}
        initialName={productFormInitialName}
        initialCost={productFormItemKey ? (items.find(it => it._key === productFormItemKey)?.costoUnitario || undefined) : undefined}
        initialQuantity={productFormItemKey ? (items.find(it => it._key === productFormItemKey)?.cantidad ?? 1) : 1}
        registerStock={false}
        sourceType="expense"
      />
    </div>
  )
}
