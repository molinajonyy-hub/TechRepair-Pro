import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, Plus, Search, UserPlus, Smartphone } from 'lucide-react'
import { ordersService, customersService, devicesService, brandsService, deviceModelsService } from '../services/api'
import { Autocomplete } from '../components/ui/Autocomplete'

const createLocalBrandId = (value: string) =>
  `local:${value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'brand'}`

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
  const [error, setError] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])
  const [isLoadingBrands, setIsLoadingBrands] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null)

  const [formData, setFormData] = useState<NewOrderForm>({
    customer_id: '',
    device_type: 'smartphone',
    brand: '',
    model: '',
    serial: '',
    imei: '',
    issue: '',
    priority: 'media',
    technician_id: '',
    estimated_total: ''
  })

  // Check if we have a pre-selected customer from NewCustomer
  useEffect(() => {
    const state = location.state as { selectedCustomer?: any; step?: string } | null
    if (state?.selectedCustomer) {
      const createdCustomer = state.selectedCustomer

      setSelectedCustomer(state.selectedCustomer)
      setCustomers(prev => {
        const remainingCustomers = prev.filter(customer => customer.id !== createdCustomer.id)
        return [createdCustomer, ...remainingCustomers]
      })
      setSearchQuery(createdCustomer.name || '')
      setFormData(prev => ({ ...prev, customer_id: createdCustomer.id }))
      if (state.step) {
        setStep(state.step as any)
      }
      // Clear the state to avoid re-processing
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [])

  // Load brands on component mount
  useEffect(() => {
    const loadBrands = async () => {
      setIsLoadingBrands(true)
      try {
        const data = await brandsService.getAll()
        setBrands(data.map((b: any) => b.name))
      } catch (err) {
        console.error('Error loading brands:', err)
      } finally {
        setIsLoadingBrands(false)
      }
    }
    loadBrands()
  }, [])

  // Load models when brand is selected
  useEffect(() => {
    const loadModels = async () => {
      if (!selectedBrandId) {
        setModels([])
        return
      }
      setIsLoadingModels(true)
      try {
        const data = await deviceModelsService.getAll(selectedBrandId)
        setModels(data.map((m: any) => m.name))
      } catch (err) {
        console.error('Error loading models:', err)
      } finally {
        setIsLoadingModels(false)
      }
    }
    loadModels()
  }, [selectedBrandId])

  const handleChange = (field: keyof NewOrderForm, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleBrandChange = async (value: string) => {
    handleChange('brand', value)
    handleChange('model', '') // Reset model when brand changes
    
    // Find brand ID by name
    if (value) {
      const brandData = await brandsService.getAll()
      const brand = brandData.find((b: any) => b.name === value)
      setSelectedBrandId(brand?.id || createLocalBrandId(value))
    } else {
      setSelectedBrandId(null)
    }
  }

  const handleCreateBrand = async (name: string) => {
    try {
      const brand = await brandsService.create(name)
      setBrands(prev => [...prev, name])
      setSelectedBrandId(brand.id)
      return brand
    } catch (err) {
      console.error('Error creating brand:', err)
      throw err
    }
  }

  const handleCreateModel = async (name: string) => {
    if (!selectedBrandId) {
      throw new Error('Seleccioná una marca primero')
    }
    try {
      const model = await deviceModelsService.create(name, selectedBrandId)
      setModels(prev => [...prev, name])
      return model
    } catch (err) {
      console.error('Error creating model:', err)
      throw err
    }
  }

  const handleSearchCustomers = async () => {
    if (!searchQuery.trim()) {
      setError('Ingresá un término de búsqueda')
      return
    }
    
    setIsSearching(true)
    setError('')
    
    try {
      const data = await customersService.search(searchQuery)
      setCustomers(data)
      if (data.length === 0) {
        setError(`No se encontraron clientes con "${searchQuery}"`)
      }
    } catch (err: any) {
      console.error('Error searching customers:', err)
      setError('Error al buscar clientes: ' + (err.message || 'Intentá de nuevo'))
    } finally {
      setIsSearching(false)
    }
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
        <button 
          onClick={() => navigate('/orders')} 
          className="btn btn-outline btn-sm" 
          style={{ marginBottom: '1rem' }}
        >
          <ArrowLeft size={16} />
          Volver a Órdenes
        </button>
        
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc' }}>
          Nueva Orden de Trabajo
        </h1>
        <p style={{ color: '#a0aec0' }}>
          Crea una nueva orden paso a paso
        </p>
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
        {[
          { id: 'customer', label: '1. Cliente', icon: UserPlus, clickable: true },
          { id: 'device', label: '2. Dispositivo', icon: Smartphone, clickable: !!selectedCustomer },
          { id: 'details', label: '3. Detalles', icon: Plus, clickable: !!selectedCustomer }
        ].map((s) => (
          <button 
            key={s.id}
            onClick={() => s.clickable && setStep(s.id as any)}
            disabled={!s.clickable}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1rem',
              borderRadius: '0.5rem',
              backgroundColor: step === s.id ? '#6366f1' : s.clickable ? 'rgba(15,23,42,0.8)' : '#0b1120',
              color: step === s.id ? '#0a0e1a' : s.clickable ? '#a0aec0' : '#475569',
              fontWeight: 500,
              fontSize: '0.875rem',
              border: 'none',
              cursor: s.clickable ? 'pointer' : 'not-allowed',
              opacity: s.clickable ? 1 : 0.5,
              transition: 'all 0.2s ease'
            }}
          >
            <s.icon size={16} />
            {s.label}
            {s.id === 'customer' && selectedCustomer && <span style={{ marginLeft: '0.25rem' }}>✓</span>}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: '1rem',
          backgroundColor: 'rgba(220, 38, 38, 0.1)',
          border: '1px solid rgba(220, 38, 38, 0.3)',
          borderRadius: '0.5rem',
          color: '#dc2626',
          marginBottom: '1.5rem'
        }}>
          {error}
        </div>
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
                  placeholder="Buscar por nombre, teléfono o email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="form-control"
                  style={{ paddingLeft: '2.5rem' }}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearchCustomers()}
                />
              </div>
              <button 
                onClick={handleSearchCustomers}
                className="btn btn-primary"
                disabled={isSearching}
              >
                {isSearching ? (
                  <>
                    <span className="spinner-border spinner-border-sm" style={{ marginRight: '0.5rem' }}></span>
                    Buscando...
                  </>
                ) : (
                  <>
                    <Search size={18} />
                    Buscar
                  </>
                )}
              </button>
              <button 
                onClick={handleCreateNewCustomer}
                className="btn btn-outline"
              >
                <UserPlus size={18} />
                Nuevo Cliente
              </button>
              <button 
                onClick={async () => {
                  setIsSearching(true)
                  setError('')
                  try {
                    const data = await customersService.getAll()
                    setCustomers(data || [])
                    if (!data || data.length === 0) {
                      setError('No hay clientes registrados. Creá uno nuevo.')
                    }
                  } catch (err: any) {
                    setError('Error al cargar clientes: ' + err.message)
                  } finally {
                    setIsSearching(false)
                  }
                }}
                className="btn btn-outline"
                disabled={isSearching}
              >
                Ver Todos
              </button>
            </div>

            {customers.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  {customers.length} cliente{customers.length !== 1 ? 's' : ''} encontrado{customers.length !== 1 ? 's' : ''}. Hacé clic en uno para seleccionarlo:
                </p>
                {customers.map((customer) => (
                  <div 
                    key={customer.id}
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

            {customers.length === 0 && searchQuery && (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                <p>No se encontraron clientes con "{searchQuery}"</p>
                <button 
                  onClick={handleCreateNewCustomer}
                  className="btn btn-primary"
                  style={{ marginTop: '1rem' }}
                >
                  <UserPlus size={18} />
                  Crear Nuevo Cliente
                </button>
              </div>
            )}

            {customers.length === 0 && !searchQuery && (
              <div style={{ textAlign: 'center', padding: '3rem 2rem', color: '#64748b', backgroundColor: 'rgba(15,23,42,0.8)', borderRadius: '0.5rem' }}>
                <UserPlus size={48} style={{ marginBottom: '1rem', opacity: 0.5 }} />
                <p style={{ fontSize: '1.125rem', marginBottom: '0.5rem', color: '#a0aec0' }}>
                  Busca un cliente existente
                </p>
                <p style={{ fontSize: '0.875rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                  Escribe el nombre, teléfono o email del cliente en el campo de búsqueda arriba
                </p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: '#475569' }}>o</span>
                </div>
                <button 
                  onClick={handleCreateNewCustomer}
                  className="btn btn-outline"
                  style={{ marginTop: '1rem' }}
                >
                  <UserPlus size={18} />
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
                    value={formData.device_type}
                    onChange={(e) => handleChange('device_type', e.target.value)}
                    className="form-select"
                  >
                    <option value="smartphone">Smartphone</option>
                    <option value="tablet">Tablet</option>
                    <option value="laptop">Laptop</option>
                    <option value="smartwatch">Smartwatch</option>
                    <option value="other">Otro</option>
                  </select>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <Autocomplete
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
                    <option value="urgente">Urgente</option>
                    <option value="alta">Alta</option>
                    <option value="media">Media</option>
                    <option value="baja">Baja</option>
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
