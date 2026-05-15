import { useState, useEffect, useRef } from 'react'
import { X, Search, Package, Wrench, AlertCircle, Loader2, ChevronDown, ChevronUp, DollarSign, Plus } from 'lucide-react'
import { CloseButton } from '../ui/CloseButton'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { currencyService } from '../../services/currencyService'
import { ProductFormModal } from '../products/ProductFormModal'
import type { InventoryItem } from '../../hooks/useInventory'

interface InventoryProduct {
  id: string
  name: string
  code?: string
  category?: string
  stock_quantity: number
  sale_price: number
  cost_price?: number
}

interface ModalAgregarItemProps {
  isOpen: boolean
  orderId: string
  onClose: () => void
  onItemAdded: () => void
}

export function ModalAgregarItem({ isOpen, orderId, onClose, onItemAdded }: ModalAgregarItemProps) {
  const { businessId } = useAuth()
  const [tipo, setTipo] = useState<'repuesto' | 'servicio'>('repuesto')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Repuesto fields
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<InventoryProduct[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<InventoryProduct | null>(null)
  const PREF_KEY = 'techrepair_pref_cliente_paga_repuesto'
  const [clientePagaRepuesto, setClientePagaRepuesto] = useState(() => {
    try { return localStorage.getItem(PREF_KEY) === 'true' } catch { return false }
  })
  const [showInventorySearch, setShowInventorySearch] = useState(false)

  // Shared fields
  const [descripcion, setDescripcion] = useState('')
  const [cantidad, setCantidad] = useState('1')
  const [precioUnitario, setPrecioUnitario] = useState('')
  const [costoUnitario, setCostoUnitario] = useState('')

  // Currency
  const [baseCurrency, setBaseCurrency] = useState<'ARS' | 'USD'>('ARS')
  const [exchangeRate, setExchangeRate] = useState(0)
  const [exchangeRateInput, setExchangeRateInput] = useState('')
  const [loadingRate, setLoadingRate] = useState(false)

  const [showProductForm, setShowProductForm] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset form when modal opens or tipo changes
  useEffect(() => {
    if (isOpen) {
      resetForm()
    }
  }, [isOpen])

  useEffect(() => {
    resetForm()
  }, [tipo])

  // Load exchange rate on first open
  useEffect(() => {
    if (isOpen && exchangeRate === 0) {
      setLoadingRate(true)
      currencyService.getCurrentExchangeRate('USD', 'ARS')
        .then(rate => {
          setExchangeRate(rate)
          setExchangeRateInput(rate.toFixed(2))
        })
        .finally(() => setLoadingRate(false))
    }
  }, [isOpen])

  function resetForm() {
    setDescripcion('')
    setCantidad('1')
    setPrecioUnitario('')
    setCostoUnitario('')
    setSelectedProduct(null)
    setSearchQuery('')
    setSearchResults([])
    setShowDropdown(false)
    setError('')
    // restore saved preference (default OFF)
    try { setClientePagaRepuesto(localStorage.getItem(PREF_KEY) === 'true') } catch { setClientePagaRepuesto(false) }
    setShowInventorySearch(false)
    setBaseCurrency('ARS')
  }

  function toggleClientePaga(val: boolean) {
    setClientePagaRepuesto(val)
    try { localStorage.setItem(PREF_KEY, val ? 'true' : 'false') } catch {}
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Debounced inventory search
  useEffect(() => {
    if (!searchQuery.trim() || selectedProduct) {
      setSearchResults([])
      setShowDropdown(false)
      return
    }

    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      if (!businessId || searchQuery.trim().length < 2) return
      setIsSearching(true)
      try {
        let query = supabase
          .from('inventory')
          .select('id, name, code, category, stock_quantity, sale_price, cost_price, tipo')
          .eq('business_id', businessId)
          .eq('is_active', true)
          .or(`name.ilike.%${searchQuery}%,code.ilike.%${searchQuery}%`)
          .order('name')
          .limit(8)

        // Filter by tipo: repuesto → products, servicio → services
        if (tipo === 'repuesto') {
          query = query.eq('tipo', 'product')
        } else {
          query = query.eq('tipo', 'service')
        }

        const { data, error } = await query

        if (!error && data) {
          setSearchResults(data)
          setShowDropdown(data.length > 0)
        }
      } catch {
        // silent
      } finally {
        setIsSearching(false)
      }
    }, 300)
  }, [searchQuery, businessId, selectedProduct, tipo])

  function selectProduct(product: InventoryProduct) {
    setSelectedProduct(product)
    setSearchQuery(product.name)
    setShowDropdown(false)
    setDescripcion(product.name)
    setPrecioUnitario(product.sale_price?.toString() || '')
    setCostoUnitario(product.cost_price?.toString() || '')
    setBaseCurrency('ARS') // inventory prices are always in ARS
  }

  function clearProduct() {
    setSelectedProduct(null)
    setSearchQuery('')
    setDescripcion('')
    setPrecioUnitario('')
    setCostoUnitario('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!descripcion.trim()) {
      setError('La descripción es obligatoria.')
      return
    }
    const rawPrecio = parseFloat(precioUnitario) || 0
    const rawCosto = parseFloat(costoUnitario) || 0
    const qty = parseInt(cantidad) || 1
    const rate = parseFloat(exchangeRateInput) || exchangeRate || 1

    // Convert to ARS if USD
    const precio = baseCurrency === 'USD' ? Math.round(rawPrecio * rate * 100) / 100 : rawPrecio
    const costo = baseCurrency === 'USD' ? Math.round(rawCosto * rate * 100) / 100 : rawCosto

    if (tipo === 'repuesto' && clientePagaRepuesto && precio <= 0) {
      setError('Ingresá el precio de venta del repuesto.')
      return
    }

    // Stock check (only for products, not services)
    if (tipo === 'repuesto' && selectedProduct && (selectedProduct as any).tipo !== 'service') {
      if (selectedProduct.stock_quantity < qty) {
        setError(`Stock insuficiente. Disponible: ${selectedProduct.stock_quantity} unidades.`)
        return
      }
    }

    setIsSubmitting(true)
    try {
      // Si no hay producto del inventario seleccionado → crear en inventario
      let inventoryProductId: string | null = selectedProduct?.id || null
      if (!selectedProduct && descripcion.trim() && businessId) {
        const isService = tipo === 'servicio'
        const { data: newInvItem, error: invError } = await supabase
          .from('inventory')
          .insert({
            business_id: businessId,
            name: descripcion.trim(),
            sale_price: precio,              // siempre en ARS
            cost_price: costo || null,       // siempre en ARS
            base_currency: baseCurrency,
            base_price: baseCurrency === 'USD' ? rawPrecio : precio,
            exchange_rate_used: baseCurrency === 'USD' ? rate : null,
            cost_price_usd: baseCurrency === 'USD' ? rawCosto : null,
            stock_quantity: isService ? 0 : qty,
            min_stock: 0,
            tipo: isService ? 'service' : 'product',
            is_active: true,
          })
          .select('id')
          .single()
        if (!invError && newInvItem) {
          inventoryProductId = newInvItem.id
        }
      }

      const { error: insertError } = await supabase
        .from('order_items')
        .insert({
          order_id: orderId,
          product_id: inventoryProductId,
          business_id: businessId,
          tipo,
          descripcion: descripcion.trim(),
          cantidad: qty,
          precio_unitario: precio,   // ARS
          costo_unitario: costo,     // ARS
          cliente_paga_repuesto: tipo === 'repuesto' ? clientePagaRepuesto : false,
        })

      if (insertError) throw insertError

      // Sincronizar repuestos a order_parts para que aparezcan en el comprobante
      // y en las métricas de ganancia. deduct_from_inventory = false porque el
      // trigger de order_items ya descontó el stock.
      if (tipo === 'repuesto') {
        const margenAmt = (precio - costo) * qty
        await supabase.from('order_parts').insert({
          order_id:              orderId,
          business_id:           businessId,
          name:                  descripcion.trim(),
          internal_cost:         costo,
          sale_price:            precio,
          quantity:              qty,
          margin_amount:         margenAmt,
          margin_percentage:     costo > 0 ? ((precio - costo) / costo) * 100 : 0,
          status:                'used',
          deduct_from_inventory: false,
        })
      }

      onItemAdded()
      onClose()
    } catch (err: any) {
      setError(err.message || 'Error al guardar el ítem.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Cuando el ProductFormModal crea un producto → lo selecciona automáticamente
  function handleProductCreated(product: InventoryItem) {
    selectProduct({
      id:             product.id,
      name:           product.name,
      code:           product.code,
      category:       product.category,
      stock_quantity: product.stock_quantity,
      sale_price:     product.sale_price,
      cost_price:     product.cost_price,
    })
    setShowProductForm(false)
  }

  if (!isOpen) return null

  const rate = parseFloat(exchangeRateInput) || exchangeRate || 1
  const rawPrecio = parseFloat(precioUnitario) || 0
  const rawCosto = parseFloat(costoUnitario) || 0
  const precioARS = baseCurrency === 'USD' ? rawPrecio * rate : rawPrecio
  const costoARS = baseCurrency === 'USD' ? rawCosto * rate : rawCosto
  const subtotal = precioARS * (parseInt(cantidad) || 1)
  const margen = subtotal - costoARS * (parseInt(cantidad) || 1)

  return (
    <>
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem'
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        backgroundColor: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: '1rem',
        width: '100%',
        maxWidth: '520px',
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 25px 50px rgba(0,0,0,0.5)'
      }}>
        {/* Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid #1e293b',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between'
        }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
            Agregar ítem
          </h2>
          <CloseButton onClick={onClose} />
        </div>

        {/* Tipo toggle */}
        <div style={{ padding: '1.25rem 1.5rem 0' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: '0.5rem',
            backgroundColor: '#1e293b',
            borderRadius: '0.625rem',
            padding: '0.25rem'
          }}>
            {([
              { value: 'repuesto', label: 'Repuesto', icon: Package },
              { value: 'servicio', label: 'Servicio', icon: Wrench },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTipo(value)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  padding: '0.625rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: tipo === value ? '#6366f1' : 'transparent',
                  color: tipo === value ? '#fff' : '#64748b',
                  fontWeight: 600, fontSize: '0.875rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s'
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>

          {/* Inventory search toggle */}
          <div ref={searchRef}>
            <button
              type="button"
              onClick={() => {
                setShowInventorySearch(!showInventorySearch)
                if (showInventorySearch) clearProduct()
              }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0.5rem 0.75rem',
                backgroundColor: showInventorySearch ? 'rgba(99,102,241,0.08)' : '#1e293b',
                border: `1px solid ${showInventorySearch ? 'rgba(99,102,241,0.4)' : '#334155'}`,
                borderRadius: '0.5rem',
                color: showInventorySearch ? '#a5b4fc' : '#64748b',
                fontSize: '0.8125rem', fontWeight: 600,
                cursor: 'pointer', transition: 'all 0.15s'
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Search size={14} />
                Buscar en inventario <span style={{ fontWeight: 400, color: '#475569' }}>(opcional)</span>
              </span>
              {showInventorySearch ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>

            {showInventorySearch && (
              <div style={{ marginTop: '0.625rem', position: 'relative' }}>
                <div style={{ position: 'relative' }}>
                  <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      if (selectedProduct) clearProduct()
                      setSearchQuery(e.target.value)
                    }}
                    placeholder={tipo === 'servicio' ? 'Buscar servicio del inventario...' : 'Nombre o código del repuesto...'}
                    autoFocus
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '0.625rem 2.25rem 0.625rem 2.25rem',
                      backgroundColor: '#1e293b',
                      border: `1px solid ${selectedProduct ? '#6366f1' : '#334155'}`,
                      borderRadius: '0.5rem',
                      color: '#f8fafc', fontSize: '0.875rem',
                      outline: 'none'
                    }}
                  />
                  {isSearching && (
                    <Loader2 size={15} style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b', animation: 'spin 1s linear infinite' }} />
                  )}
                  {selectedProduct && (
                    <button
                      type="button"
                      onClick={clearProduct}
                      style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 0 }}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>

                {/* Dropdown results */}
                {(showDropdown || (searchQuery.trim().length >= 2 && !isSearching && !selectedProduct)) && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '0.5rem',
                    marginTop: '0.25rem',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.4)',
                    overflow: 'hidden'
                  }}>
                    {searchResults.length === 0 && searchQuery.trim().length >= 2 && !isSearching && (
                      <p style={{ margin: 0, padding: '0.625rem 1rem', color: '#475569', fontSize: '0.82rem' }}>
                        No se encontró "{searchQuery.trim()}"
                      </p>
                    )}
                    {searchResults.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => selectProduct(product)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0.75rem 1rem',
                          backgroundColor: 'transparent',
                          border: 'none',
                          borderBottom: '1px solid #0f172a',
                          color: '#f8fafc',
                          cursor: 'pointer',
                          textAlign: 'left',
                          transition: 'background 0.1s'
                        }}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#0f172a')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, fontSize: '0.875rem' }}>{product.name}</p>
                          <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>
                            {product.code && `${product.code} · `}
                            {product.category}
                          </p>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <p style={{ margin: 0, fontWeight: 700, color: '#6366f1', fontSize: '0.875rem' }}>
                            ${product.sale_price?.toLocaleString()}
                          </p>
                          <p style={{
                            margin: 0, fontSize: '0.75rem',
                            color: (product as any).tipo === 'service' ? '#818cf8' : product.stock_quantity > 0 ? '#10b981' : '#dc2626'
                          }}>
                            {(product as any).tipo === 'service'
                              ? 'Servicio'
                              : product.stock_quantity > 0
                                ? `${product.stock_quantity} en stock`
                                : 'Sin stock'
                            }
                          </p>
                        </div>
                      </button>
                    ))}
                    {/* Botón crear producto completo (siempre disponible cuando hay búsqueda) */}
                    {searchQuery.trim().length >= 2 && (
                      <button
                        type="button"
                        onClick={() => { setShowDropdown(false); setShowProductForm(true) }}
                        style={{
                          width: '100%', padding: '0.625rem 1rem',
                          background: 'rgba(99,102,241,0.08)',
                          border: 'none', borderTop: '1px solid rgba(255,255,255,0.06)',
                          color: '#818cf8', fontSize: '0.8rem', fontWeight: 700,
                          cursor: 'pointer', textAlign: 'left',
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                        }}
                      >
                        <Plus size={14} />
                        Crear producto completo: "{searchQuery.trim()}"
                      </button>
                    )}
                  </div>
                )}

                {/* Selected product info badge */}
                {selectedProduct && (
                  <div style={{
                    marginTop: '0.5rem', padding: '0.5rem 0.75rem',
                    backgroundColor: 'rgba(99,102,241,0.1)',
                    border: '1px solid rgba(99,102,241,0.3)',
                    borderRadius: '0.375rem',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                  }}>
                    {(selectedProduct as any).tipo === 'service' ? (
                      <span style={{ fontSize: '0.8125rem', color: '#a5b4fc' }}>
                        🔧 Servicio del inventario seleccionado
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.8125rem', color: '#a5b4fc' }}>
                        📦 Stock actual: <strong>{selectedProduct.stock_quantity}</strong> unidades
                      </span>
                    )}
                    <span style={{ fontSize: '0.8125rem', color: '#a5b4fc' }}>
                      Costo: <strong>${selectedProduct.cost_price?.toLocaleString() || '—'}</strong>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Descripción */}
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>
              {tipo === 'repuesto' ? 'Descripción (o ingresá manual)' : 'Descripción del servicio'} *
            </label>
            <input
              type="text"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder={tipo === 'repuesto' ? 'Ej: Pantalla iPhone 14 Pro' : 'Ej: Cambio de pantalla, diagnóstico...'}
              required
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '0.625rem 0.875rem',
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '0.5rem',
                color: '#f8fafc', fontSize: '0.875rem', outline: 'none'
              }}
            />
          </div>

          {/* Currency selector — only visible when no inventory product selected */}
          {!selectedProduct && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: baseCurrency === 'USD' ? '0.625rem' : 0 }}>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <DollarSign size={13} />
                  Moneda de los precios
                </label>
                <div style={{
                  display: 'flex', backgroundColor: '#1e293b',
                  borderRadius: '0.375rem', padding: '0.125rem', gap: '0.125rem'
                }}>
                  {(['ARS', 'USD'] as const).map(cur => (
                    <button
                      key={cur}
                      type="button"
                      onClick={() => setBaseCurrency(cur)}
                      style={{
                        padding: '0.25rem 0.75rem',
                        borderRadius: '0.25rem', border: 'none',
                        backgroundColor: baseCurrency === cur ? (cur === 'USD' ? '#10b981' : '#6366f1') : 'transparent',
                        color: baseCurrency === cur ? '#fff' : '#64748b',
                        fontSize: '0.8125rem', fontWeight: 700,
                        cursor: 'pointer', transition: 'all 0.15s'
                      }}
                    >
                      {cur === 'ARS' ? '$ ARS' : 'USD $'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Exchange rate row when USD */}
              {baseCurrency === 'USD' && (
                <div style={{
                  padding: '0.625rem 0.875rem',
                  backgroundColor: 'rgba(16,185,129,0.07)',
                  border: '1px solid rgba(16,185,129,0.2)',
                  borderRadius: '0.5rem',
                  display: 'flex', alignItems: 'center', gap: '0.75rem'
                }}>
                  <DollarSign size={14} color="#10b981" style={{ flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8125rem', color: '#10b981', fontWeight: 600, flexShrink: 0 }}>
                    Cotización USD/ARS
                  </span>
                  {loadingRate ? (
                    <Loader2 size={14} color="#10b981" style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <input
                      type="number"
                      value={exchangeRateInput}
                      onChange={e => setExchangeRateInput(e.target.value)}
                      step="0.01"
                      style={{
                        flex: 1, minWidth: 0,
                        padding: '0.25rem 0.5rem',
                        backgroundColor: 'rgba(16,185,129,0.1)',
                        border: '1px solid rgba(16,185,129,0.3)',
                        borderRadius: '0.375rem',
                        color: '#f8fafc', fontSize: '0.875rem', outline: 'none',
                        textAlign: 'right'
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Cantidad + Precio */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>
                Cantidad
              </label>
              <input
                type="number"
                min="1"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '0.5rem',
                  color: '#f8fafc', fontSize: '0.875rem', outline: 'none'
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>
                Precio unitario {baseCurrency === 'USD' ? '(USD)' : '(ARS)'}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={precioUnitario}
                onChange={(e) => setPrecioUnitario(e.target.value)}
                placeholder="0.00"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.625rem 0.875rem',
                  backgroundColor: '#1e293b',
                  border: `1px solid ${baseCurrency === 'USD' ? 'rgba(16,185,129,0.4)' : '#334155'}`,
                  borderRadius: '0.5rem',
                  color: '#f8fafc', fontSize: '0.875rem', outline: 'none'
                }}
              />
              {baseCurrency === 'USD' && rawPrecio > 0 && rate > 0 && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#10b981' }}>
                  = ${precioARS.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS
                </p>
              )}
            </div>
          </div>

          {/* Costo interno */}
          <div>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: '0.375rem' }}>
              Costo interno {baseCurrency === 'USD' ? '(USD)' : '(no visible al cliente)'}
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={costoUnitario}
              onChange={(e) => setCostoUnitario(e.target.value)}
              placeholder="0.00"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '0.625rem 0.875rem',
                backgroundColor: '#1e293b',
                border: `1px solid ${baseCurrency === 'USD' ? 'rgba(16,185,129,0.4)' : '#334155'}`,
                borderRadius: '0.5rem',
                color: '#f8fafc', fontSize: '0.875rem', outline: 'none'
              }}
            />
            {baseCurrency === 'USD' && rawCosto > 0 && rate > 0 && (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.7rem', color: '#10b981' }}>
                = ${costoARS.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ARS
              </p>
            )}
          </div>

          {/* Cliente paga repuesto (solo para repuestos) */}
          {tipo === 'repuesto' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: 'pointer' }}>
              <div
                onClick={() => toggleClientePaga(!clientePagaRepuesto)}
                style={{
                  width: '40px', height: '22px', borderRadius: '11px',
                  backgroundColor: clientePagaRepuesto ? '#6366f1' : '#334155',
                  position: 'relative', transition: 'background 0.2s', cursor: 'pointer', flexShrink: 0
                }}
              >
                <div style={{
                  position: 'absolute', top: '3px',
                  left: clientePagaRepuesto ? '21px' : '3px',
                  width: '16px', height: '16px', borderRadius: '50%',
                  backgroundColor: '#fff', transition: 'left 0.2s'
                }} />
              </div>
              <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                El cliente paga este repuesto (se incluye en el total)
              </span>
            </label>
          )}

          {/* Subtotal preview (always in ARS) */}
          {(precioARS > 0 || costoARS > 0) && (
            <div style={{
              padding: '0.875rem',
              backgroundColor: '#1e293b',
              borderRadius: '0.5rem',
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem'
            }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>Subtotal (ARS)</p>
                <p style={{ margin: 0, fontWeight: 700, color: '#f8fafc' }}>${subtotal.toLocaleString('es-AR', { maximumFractionDigits: 0 })}</p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>Costo (ARS)</p>
                <p style={{ margin: 0, fontWeight: 700, color: '#f59e0b' }}>
                  ${(costoARS * (parseInt(cantidad) || 1)).toLocaleString('es-AR', { maximumFractionDigits: 0 })}
                </p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: '0.75rem', color: '#64748b' }}>Margen</p>
                <p style={{ margin: 0, fontWeight: 700, color: margen >= 0 ? '#10b981' : '#dc2626' }}>
                  ${margen.toLocaleString('es-AR', { maximumFractionDigits: 0 })}
                </p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.75rem', backgroundColor: 'rgba(220,38,38,0.1)',
              borderRadius: '0.5rem', color: '#dc2626', fontSize: '0.875rem'
            }}>
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.25rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: 1, padding: '0.75rem',
                backgroundColor: 'transparent',
                border: '1px solid #334155',
                borderRadius: '0.5rem',
                color: '#94a3b8', fontWeight: 600, fontSize: '0.875rem',
                cursor: 'pointer'
              }}
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                flex: 2, padding: '0.75rem',
                background: isSubmitting ? '#374151' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                border: 'none',
                borderRadius: '0.5rem',
                color: '#fff', fontWeight: 700, fontSize: '0.875rem',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem'
              }}
            >
              {isSubmitting ? (
                <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
              ) : (
                `Agregar ${tipo === 'repuesto' ? 'repuesto' : 'servicio'}`
              )}
            </button>
          </div>
        </form>
      </div>
    </div>

    {/* ProductFormModal — se abre al hacer clic en "Crear producto completo" */}
    <ProductFormModal
      isOpen={showProductForm}
      onClose={() => setShowProductForm(false)}
      onCreated={handleProductCreated}
      initialName={searchQuery.trim()}
      initialCost={parseFloat(costoUnitario) || undefined}
      initialQuantity={parseInt(cantidad) || 1}
      initialCurrency={baseCurrency}
      sourceType="manual"
      registerStock={false}
    />
    </>
  )
}
