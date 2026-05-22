import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Plus, Search, UserPlus, Smartphone, Loader2 } from 'lucide-react'
import { ordersService, customersService, devicesService } from '../services/api'
import {
  getBrands, getModels,
  ensureBrand, ensureModel, ensureBrandAndModel,
  DEFAULT_BRANDS, DEFAULT_MODELS_BY_BRAND,
  type BrandItem, type ModelItem,
} from '../services/deviceCatalogService'
import { Autocomplete } from '../components/ui/Autocomplete'


interface NewOrderForm {
  customer_id: string
  device_type: string
  brand: string
  model: string
  serial: string
  imei: string
  issue: string
  priority: string
  technician_id: string
  estimated_total: string
}

export function NewOrder() {
  const navigate = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState<'customer' | 'device' | 'details'>('customer')
  const [searchQuery, setSearchQuery] = useState('')
  const [customers, setCustomers] = useState<any[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [allCustomers, setAllCustomers] = useState<any[]>([])
  const [error, setError] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [brandItems, setBrandItems]       = useState<BrandItem[]>([])
  const [modelItems, setModelItems]       = useState<ModelItem[]>([])
  const [isLoadingBrands, setIsLoadingBrands] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null)

  // Derived string arrays for Autocomplete
  const brands = brandItems.map(b => b.name)
  const models = modelItems.map(m => m.name)

  const [formData, setFormData] = useState<NewOrderForm>({
    customer_id: '',
    device_type: 'smartphone',
    brand: '',
    model: '',
    serial: '',
    imei: '',
    issue: '',
    priority: 'medium',
    technician_id: '',
    estimated_total: ''
  })

  // Load all customers on mount
  useEffect(() => {
    const loadAllCustomers = async () => {
      setIsSearching(true)
      try {
        const data = await customersService.getAll()
        setAllCustomers(data || [])
        setCustomers(data || [])
      } catch (err: any) {
        console.error('Error loading customers:', err)
      } finally {
        setIsSearching(false)
      }
    }
    loadAllCustomers()
  }, [])

  // Check if we have a pre-selected customer from NewCustomer page
  useEffect(() => {
    const state = location.state as { selectedCustomer?: any; step?: string } | null
    if (state?.selectedCustomer) {
      const createdCustomer = state.selectedCustomer

      setSelectedCustomer(createdCustomer)
      setAllCustomers(prev => {
        const rest = prev.filter(c => c.id !== createdCustomer.id)
        return [createdCustomer, ...rest]
      })
      setCustomers(prev => {
        const rest = prev.filter(c => c.id !== createdCustomer.id)
        return [createdCustomer, ...rest]
      })
      setSearchQuery(createdCustomer.name || '')
      setFormData(prev => ({ ...prev, customer_id: createdCustomer.id }))
      if (state.step) {
        setStep(state.step as any)
      }
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [])

  // Debounced filter as user types
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)

    if (!searchQuery.trim()) {
      setCustomers(allCustomers)
      return
    }

    searchTimer.current = setTimeout(() => {
      const q = searchQuery.toLowerCase()
      const filtered = allCustomers.filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q)
      )
      setCustomers(filtered)
    }, 200)

    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [searchQuery, allCustomers])

  // Load brands on component mount: DB brands + DEFAULT_BRANDS combined
  useEffect(() => {
    const loadBrands = async () => {
      setIsLoadingBrands(true)
      try {
        const dbBrands = await getBrands()

        // Merge DB brands with defaults — defaults ensure non-empty list even for new businesses
        const dbNames = new Set(dbBrands.map(b => b.name.toLowerCase()))
        const extraDefaults = DEFAULT_BRANDS.filter(n => !dbNames.has(n.toLowerCase()))
        const defaultItems: BrandItem[] = extraDefaults.map(n => ({ id: `default:${n.toLowerCase()}`, name: n }))
        const merged = [...dbBrands, ...defaultItems]

        setBrandItems(merged)
      } catch (err) {
        console.error('Error loading brands, using defaults:', err)
        setBrandItems(DEFAULT_BRANDS.map(n => ({ id: `default:${n.toLowerCase()}`, name: n })))
      } finally {
        setIsLoadingBrands(false)
      }
    }
    loadBrands()
  }, [])

  // Load models when brand is selected: DB models + DEFAULT_MODELS combined
  useEffect(() => {
    const loadModels = async () => {
      setModelItems([])
      if (!formData.brand.trim()) return

      setIsLoadingModels(true)
      try {
        // Get default models for this brand name (case-insensitive)
        const brandKey = Object.keys(DEFAULT_MODELS_BY_BRAND).find(
          k => k.toLowerCase() === formData.brand.trim().toLowerCase()
        )
        const defaultModelNames = brandKey ? DEFAULT_MODELS_BY_BRAND[brandKey] : []

        // Get DB models (only if we have a real UUID brand ID)
        let dbModels: ModelItem[] = []
        if (selectedBrandId && !selectedBrandId.startsWith('default:')) {
          dbModels = await getModels(selectedBrandId)
        }

        // Merge: DB models + default models that don't duplicate
        const dbNames = new Set(dbModels.map(m => m.name.toLowerCase()))
        const extraDefaults = defaultModelNames.filter(n => !dbNames.has(n.toLowerCase()))
        const defaultItems: ModelItem[] = extraDefaults.map(n => ({
          id: `default:${n.toLowerCase()}`, name: n, brand_id: selectedBrandId ?? ''
        }))
        const merged = [...dbModels, ...defaultItems]

        setModelItems(merged)
      } catch (err) {
        console.error('Error loading models, using defaults:', err)
        const brandKey = Object.keys(DEFAULT_MODELS_BY_BRAND).find(
          k => k.toLowerCase() === formData.brand.trim().toLowerCase()
        )
        const defaults = brandKey ? DEFAULT_MODELS_BY_BRAND[brandKey] : []
        setModelItems(defaults.map(n => ({ id: `default:${n.toLowerCase()}`, name: n, brand_id: selectedBrandId ?? '' })))
      } finally {
        setIsLoadingModels(false)
      }
    }
    loadModels()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBrandId, formData.brand])

  const handleChange = (field: keyof NewOrderForm, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleBrandChange = async (value: string) => {
    handleChange('brand', value)
    handleChange('model', '') // Reset model when brand changes

    if (value.trim()) {
      // Fast path: look in already-loaded brand items
      const local = brandItems.find(b => b.name.toLowerCase() === value.trim().toLowerCase())
      if (local) {
        // If it's a default: item, resolve to real DB ID
        if (local.id.startsWith('default:')) {
          // Will be persisted when form submits via ensureBrandAndModel
          setSelectedBrandId(null)
        } else {
          setSelectedBrandId(local.id)
        }
        return
      }
      // Unknown brand typed: no DB ID yet (ensureBrandAndModel at submit handles it)
      setSelectedBrandId(null)
    } else {
      setSelectedBrandId(null)
    }
  }

  const handleCreateBrand = async (name: string): Promise<string> => {
    const trimmed = name.trim()
    if (!trimmed) return trimmed

    // Persist in DB immediately so models can be saved under this brand
    const brandId = await ensureBrand(trimmed)
    if (brandId) {
      setSelectedBrandId(brandId)
      const updated = await getBrands()
      // Merge with defaults, preserving order
      const dbNames = new Set(updated.map(b => b.name.toLowerCase()))
      const extraDefaults = DEFAULT_BRANDS.filter(n => !dbNames.has(n.toLowerCase()))
      setBrandItems([...updated, ...extraDefaults.map(n => ({ id: `default:${n.toLowerCase()}`, name: n }))])
      const canonical = updated.find(b => b.id === brandId)
      return canonical?.name ?? trimmed
    }
    return trimmed
  }

  const handleCreateModel = async (name: string): Promise<string> => {
    const trimmed = name.trim()
    if (!trimmed) return trimmed

    // If brand is a default: item, persist it first to get a real UUID
    let realBrandId = selectedBrandId
    if (!realBrandId || realBrandId.startsWith('default:')) {
      realBrandId = await ensureBrand(formData.brand) ?? null
      if (realBrandId) setSelectedBrandId(realBrandId)
    }

    if (!realBrandId) {
      // Brand unknown: will be handled at submit by ensureBrandAndModel
      return trimmed
    }

    const modelId = await ensureModel(trimmed, realBrandId)
    if (modelId) {
      const updated = await getModels(realBrandId)
      setModelItems(updated)
      const canonical = updated.find(m => m.id === modelId)
      return canonical?.name ?? trimmed
    }
    return trimmed
  }

  const handleSelectCustomer = (customer: any) => {
    setSelectedCustomer(customer)
    handleChange('customer_id', customer.id)
    setStep('device')
  }

  const handleCreateNewCustomer = () => {
    navigate('/customers/new', { state: { returnTo: '/orders/new' } })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')

    try {
      // ── Persist brand + model in catalog (non-blocking: failure doesn't abort order) ──
      // This guarantees that even if the user typed the brand/model without clicking
      // "Crear", they are saved for future orders.
      if (formData.brand && formData.model) {
        try {
          await ensureBrandAndModel(formData.brand, formData.model)
        } catch {
          // Catalog persistence failure is non-blocking — order creation continues
        }
      }

      const device = await devicesService.create({
        customer_id: formData.customer_id,
        type: formData.device_type as any,
        brand: formData.brand,
        model: formData.model,
        serial: formData.serial || undefined,
        imei: formData.imei || undefined,
        issue: formData.issue,
        diagnosis: undefined
      })

      const order = await ordersService.create({
        customer_id: formData.customer_id,
        device_id: device.id,
        technician_id: formData.technician_id || null,
        status: 'new',
        priority: formData.priority as any,
        estimated_total: parseFloat(formData.estimated_total) || 0,
        labor_cost: 0,
        total_cost: 0
      })

      navigate(`/orders/${order.id}`)
    } catch (err: any) {
      setError(err.message || 'Error al crear la orden')
      setIsSubmitting(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <div style={{ marginBottom: '2rem' }}>
        <button onClick={() => navigate('/orders')} className="btn btn-ghost btn-sm" style={{ marginBottom: '1rem' }}>
          <ArrowLeft size={15} />
          Volver a Órdenes
        </button>
        <div className="page-hdr" style={{ marginBottom: 0 }}>
          <div className="page-hdr-left">
            <div className="page-hdr-icon"><Plus size={20} /></div>
            <div>
              <h1 className="page-hdr-title">Nueva Orden de Trabajo</h1>
              <p className="page-hdr-subtitle">Crea una nueva orden paso a paso</p>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        {[
          { id: 'customer', label: '1. Cliente',     icon: UserPlus,  clickable: true },
          { id: 'device',   label: '2. Dispositivo', icon: Smartphone, clickable: !!selectedCustomer },
          { id: 'details',  label: '3. Detalles',    icon: Plus,       clickable: !!selectedCustomer }
        ].map((s) => (
          <button
            key={s.id}
            onClick={() => s.clickable && setStep(s.id as any)}
            disabled={!s.clickable}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.625rem 1rem',
              borderRadius: '0.625rem',
              background: step === s.id
                ? 'linear-gradient(135deg,#6366f1,#8b5cf6)'
                : s.clickable ? 'rgba(255,255,255,0.04)' : 'transparent',
              color: step === s.id ? '#fff' : s.clickable ? 'var(--text-secondary)' : 'var(--text-muted)',
              fontWeight: step === s.id ? 700 : 500,
              fontSize: '0.875rem',
              border: `1px solid ${step === s.id ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`,
              cursor: s.clickable ? 'pointer' : 'not-allowed',
              opacity: s.clickable ? 1 : 0.45,
              transition: 'all 0.15s',
              boxShadow: step === s.id ? '0 4px 12px rgba(99,102,241,0.3)' : 'none',
            }}
          >
            <s.icon size={15} />
            {s.label}
            {s.id === 'customer' && selectedCustomer && (
              <span style={{ marginLeft: '0.125rem', color: step === s.id ? '#a5f3fc' : '#34d399', fontSize: '0.8rem' }}>✓</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1.5rem' }}>{error}</div>
      )}

      {step === 'customer' && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">Paso 1: Seleccionar Cliente</h3>
              <p style={{ fontSize: '0.875rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
                Busca un cliente existente o crea uno nuevo para continuar con la orden
              </p>
            </div>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={18} style={{ position: 'absolute', left: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                <input
                  type="text"
                  data-testid="new-order-customer-search"
                  placeholder="Filtrar por nombre, teléfono o email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="form-control"
                  style={{ paddingLeft: '2.5rem', paddingRight: isSearching ? '2.5rem' : undefined }}
                  autoFocus
                />
                {isSearching && (
                  <Loader2 size={16} style={{ position: 'absolute', right: '0.875rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b', animation: 'tr-spin 1s linear infinite' }} />
                )}
              </div>
              <button
                onClick={handleCreateNewCustomer}
                className="btn btn-outline"
              >
                <UserPlus size={18} />
                Nuevo Cliente
              </button>
            </div>

            {customers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  {searchQuery
                    ? `${customers.length} resultado${customers.length !== 1 ? 's' : ''} — hacé clic en uno para seleccionarlo`
                    : `${customers.length} cliente${customers.length !== 1 ? 's' : ''} — hacé clic en uno para seleccionarlo`
                  }
                </p>
                {customers.map((customer) => (
                  <div
                    key={customer.id}
                    data-testid="new-order-customer-card"
                    onClick={() => handleSelectCustomer(customer)}
                    style={{
                      padding: '1rem',
                      backgroundColor: selectedCustomer?.id === customer.id ? 'rgba(99, 102, 241, 0.2)' : 'rgba(15,23,42,0.8)',
                      borderRadius: '0.5rem',
                      cursor: 'pointer',
                      border: selectedCustomer?.id === customer.id ? '2px solid #6366f1' : '1px solid transparent',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div>
                        <h4 style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '0.5rem' }}>
                          {customer.name}
                          {selectedCustomer?.id === customer.id && (
                            <span style={{ marginLeft: '0.5rem', color: '#10b981' }}>✓ Seleccionado</span>
                          )}
                        </h4>
                        <div style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                          <span style={{ marginRight: '1rem' }}>
                            <i className="fas fa-phone me-2"></i>
                            {customer.phone}
                          </span>
                          {customer.email && (
                            <span>
                              <i className="fas fa-envelope me-2"></i>
                              {customer.email}
                            </span>
                          )}
                        </div>
                      </div>
                      {selectedCustomer?.id === customer.id && (
                        <button
                          data-testid="new-order-customer-continue"
                          onClick={(e) => {
                            e.stopPropagation()
                            setStep('device')
                          }}
                          className="btn btn-primary btn-sm"
                        >
                          Continuar →
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {customers.length === 0 && !isSearching && (
              <div style={{ textAlign: 'center', padding: '2.5rem 2rem', color: '#64748b', backgroundColor: 'rgba(15,23,42,0.8)', borderRadius: '0.5rem' }}>
                <UserPlus size={40} style={{ marginBottom: '1rem', opacity: 0.4 }} />
                {searchQuery ? (
                  <>
                    <p style={{ fontSize: '1rem', marginBottom: '0.5rem', color: '#a0aec0' }}>
                      Sin resultados para "{searchQuery}"
                    </p>
                    <p style={{ fontSize: '0.875rem', margin: '0 auto 1.25rem' }}>
                      Probá con otro término o creá el cliente nuevo
                    </p>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: '1rem', marginBottom: '0.5rem', color: '#a0aec0' }}>
                      No hay clientes registrados aún
                    </p>
                    <p style={{ fontSize: '0.875rem', margin: '0 auto 1.25rem' }}>
                      Creá el primer cliente para continuar
                    </p>
                  </>
                )}
                <button
                  onClick={handleCreateNewCustomer}
                  className="btn btn-primary"
                >
                  <UserPlus size={17} />
                  Crear Nuevo Cliente
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {(step === 'device' || step === 'details') && selectedCustomer && (
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            <div className="card" style={{ gridColumn: 'span 2' }}>
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 className="card-title">Cliente Seleccionado</h3>
                <button 
                  type="button"
                  onClick={() => {
                    setSelectedCustomer(null)
                    setStep('customer')
                  }}
                  className="btn btn-sm btn-outline"
                >
                  Cambiar
                </button>
              </div>
              <div className="card-body">
                <h4 style={{ fontWeight: 600, color: '#f8fafc' }}>{selectedCustomer.name}</h4>
                <p style={{ color: '#a0aec0', fontSize: '0.875rem' }}>
                  {selectedCustomer.phone} • {selectedCustomer.email}
                </p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Información del Dispositivo</h3>
              </div>
              <div className="card-body">
                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Tipo de Dispositivo</label>
                  <select
                    data-testid="new-order-device-type-select"
                    value={formData.device_type}
                    onChange={(e) => handleChange('device_type', e.target.value)}
                    className="form-select"
                  >
                    <option value="smartphone">Celular</option>
                    <option value="tablet">Tablet</option>
                    <option value="laptop">Notebook</option>
                    <option value="smartwatch">Smartwatch</option>
                    <option value="other">Otro</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <Autocomplete
                    testId="new-order-brand-input"
                    value={formData.brand}
                    onChange={handleBrandChange}
                    options={brands}
                    label="Marca"
                    placeholder="Ej: Apple, Samsung, Xiaomi"
                    required
                    allowCreate
                    onCreate={handleCreateBrand}
                    isLoading={isLoadingBrands}
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <Autocomplete
                    testId="new-order-model-input"
                    value={formData.model}
                    onChange={(value) => handleChange('model', value)}
                    options={models}
                    label="Modelo"
                    placeholder="Ej: iPhone 13 Pro"
                    required
                    allowCreate
                    onCreate={handleCreateModel}
                    isLoading={isLoadingModels}
                    disabled={!formData.brand}
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Serial / IMEI</label>
                  <input
                    type="text"
                    value={formData.serial}
                    onChange={(e) => handleChange('serial', e.target.value)}
                    className="form-control"
                    placeholder="Número de serie o IMEI"
                  />
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h3 className="card-title">Detalles de la Orden</h3>
              </div>
              <div className="card-body">
                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Problema Reportado *</label>
                  <textarea
                    data-testid="new-order-issue-input"
                    value={formData.issue}
                    onChange={(e) => handleChange('issue', e.target.value)}
                    className="form-control"
                    rows={4}
                    placeholder="Describe el problema que reporta el cliente..."
                    required
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Prioridad</label>
                  <select
                    value={formData.priority}
                    onChange={(e) => handleChange('priority', e.target.value)}
                    className="form-select"
                  >
                    <option value="urgent">Urgente</option>
                    <option value="high">Alta</option>
                    <option value="medium">Media</option>
                    <option value="low">Baja</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">ID Técnico (opcional)</label>
                  <input
                    type="text"
                    value={formData.technician_id}
                    onChange={(e) => handleChange('technician_id', e.target.value)}
                    className="form-control"
                    placeholder="ID del técnico asignado"
                  />
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label className="form-label">Presupuesto Estimado</label>
                  <input
                    data-testid="new-order-budget-input"
                    type="number"
                    value={formData.estimated_total}
                    onChange={(e) => handleChange('estimated_total', e.target.value)}
                    className="form-control"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                  />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
            <button
              type="button"
              onClick={() => setStep('customer')}
              className="btn btn-outline"
            >
              Anterior
            </button>
            <button
              data-testid="new-order-save-button"
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || !formData.brand || !formData.model || !formData.issue}
            >
              {isSubmitting ? (
                <>
                  <span className="spinner-border spinner-border-sm" style={{ marginRight: '0.5rem' }}></span>
                  Creando...
                </>
              ) : (
                <>
                  <Plus size={18} />
                  Crear Orden
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
