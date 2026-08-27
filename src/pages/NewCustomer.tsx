import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, UserPlus, Save, User, Building2 } from 'lucide-react'
import { customersService } from '../services/api'
import { DOCUMENT_TYPES, useCustomerCore } from '../features/customer-core'

export function NewCustomer() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Las reglas (normalización del documento, regla de mayorista, armado del
  // payload) viven en el core y son las MISMAS que usa el alta rápida de
  // Nueva Orden. Acá sólo queda la presentación de página completa.
  const { values, errors, setField, setCustomerType, toCreatePayload } = useCustomerCore()

  const returnTo = location.state?.returnTo || '/customers'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')

    try {
      const customer = await customersService.create(toCreatePayload())

      if (returnTo === '/orders/new') {
        navigate('/orders/new', { 
          state: { 
            selectedCustomer: customer,
            step: 'customer'
          }
        })
      } else {
        navigate(`/customers/${customer.id}`)
      }
    } catch (err: any) {
      setError(err.message || 'Error al crear el cliente')
      setIsSubmitting(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <UserPlus size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Nuevo Cliente</h1>
            <p className="page-hdr-subtitle">Registra un nuevo cliente en el sistema</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={() => navigate(returnTo)} className="btn btn-outline btn-sm">
            <ArrowLeft size={15} /> Volver
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1.5rem' }}>
          {error}
        </div>
      )}

      <div className="card" style={{ maxWidth: '600px', backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem' }}>
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <UserPlus size={18} color="#6366f1" />
          <h3 className="card-title">Información del Cliente</h3>
        </div>
        <div className="card-body">
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Nombre Completo *</label>
              <input
                type="text"
                data-testid="customer-name-input"
                value={values.name}
                onChange={(e) => setField('name', e.target.value)}
                className="form-control"
                placeholder="Ej: Juan Pérez"
                required
              />
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Teléfono *</label>
              <input
                type="tel"
                data-testid="customer-phone-input"
                value={values.phone}
                onChange={(e) => setField('phone', e.target.value)}
                className="form-control"
                placeholder="Ej: +54 9 11 1234-5678"
                required
              />
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Email</label>
              <input
                type="email"
                data-testid="customer-email-input"
                value={values.email}
                onChange={(e) => setField('email', e.target.value)}
                className="form-control"
                placeholder="Ej: juan@email.com"
              />
            </div>

            {/* DNI / CUIT */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">DNI / CUIT <span style={{ color: 'var(--text-subtle)', fontWeight: 400, textTransform: 'none' }}>(opcional)</span></label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {/* Selector de tipo */}
                <div style={{ display: 'flex', background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: '0.5rem', overflow: 'hidden', flexShrink: 0 }}>
                  {DOCUMENT_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      data-testid={`customer-document-type-${t}`}
                      aria-pressed={values.documentType === t}
                      onClick={() => setField('documentType', t)}
                      style={{
                        padding: '0.5rem 0.875rem',
                        border: 'none',
                        background: values.documentType === t ? 'rgba(99,102,241,0.25)' : 'transparent',
                        color: values.documentType === t ? '#a5b4fc' : 'var(--text-subtle)',
                        fontWeight: 700,
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        letterSpacing: '0.04em',
                        transition: 'all 0.15s',
                      }}
                    >
                      {t.toUpperCase()}
                    </button>
                  ))}
                </div>
                {/* Input del número */}
                <input
                  type="text"
                  data-testid="customer-document-input"
                  value={values.document}
                  onChange={e => setField('document', e.target.value)}
                  className="form-control"
                  placeholder={values.documentType === 'dni' ? 'Ej: 30.123.456' : 'Ej: 20-30123456-7'}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label className="form-label">Dirección</label>
              <textarea
                data-testid="customer-address-input"
                value={values.address}
                onChange={(e) => setField('address', e.target.value)}
                className="form-control"
                rows={3}
                placeholder="Ej: Av. Corrientes 1234, CABA"
              />
            </div>

            {/* Tipo de cliente */}
            <div style={{ marginBottom: '1.5rem' }}>
              <label className="form-label">Tipo de cliente</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {([
                  { value: 'minorista', label: 'Minorista', icon: User,      desc: 'Precios de venta normal' },
                  { value: 'mayorista', label: 'Mayorista', icon: Building2, desc: 'Precios mayoristas automáticos' },
                ] as const).map(opt => {
                  const Icon = opt.icon
                  const active = values.customerType === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      data-testid={`customer-type-${opt.value}`}
                      aria-pressed={active}
                      onClick={() => setCustomerType(opt.value)}
                      style={{
                        flex: 1,
                        display: 'flex', alignItems: 'center', gap: '0.625rem',
                        padding: '0.75rem 1rem',
                        background: active
                          ? opt.value === 'mayorista' ? 'rgba(99,102,241,0.15)' : 'rgba(52,211,153,0.1)'
                          : 'rgba(255,255,255,0.03)',
                        border: `2px solid ${active
                          ? opt.value === 'mayorista' ? 'rgba(99,102,241,0.5)' : 'rgba(52,211,153,0.4)'
                          : 'rgba(255,255,255,0.08)'}`,
                        borderRadius: '0.625rem',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.15s',
                      }}
                    >
                      <Icon size={16} style={{ color: active ? (opt.value === 'mayorista' ? '#818cf8' : '#34d399') : '#475569', flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: '0.875rem', fontWeight: 700, color: active ? (opt.value === 'mayorista' ? '#818cf8' : '#34d399') : '#94a3b8' }}>
                          {opt.label}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: '0.1rem' }}>{opt.desc}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
              {values.customerType === 'mayorista' && (
                <div style={{ marginTop: '1rem', display: 'grid', gap: '1rem' }}>
                  <div>
                    <label className="form-label">Razón social *</label>
                    <input
                      className="form-control"
                      data-testid="customer-business-name-input"
                      value={values.businessName}
                      onChange={e => setField('businessName', e.target.value)}
                      aria-invalid={Boolean(errors.businessName)}
                      required
                    />
                    {errors.businessName && <p className="form-error" role="alert">{errors.businessName}</p>}
                  </div>
                  <div>
                    <label className="form-label">Persona de contacto</label>
                    <input
                      className="form-control"
                      data-testid="customer-contact-person-input"
                      value={values.contactPerson}
                      onChange={e => setField('contactPerson', e.target.value)}
                    />
                  </div>
                  <p style={{ margin: 0, fontSize: '0.75rem', color: '#818cf8', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <Building2 size={11} /> Al cobrarle se usarán precios mayoristas del inventario automáticamente.
                  </p>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button type="button" onClick={() => navigate(returnTo)} className="btn btn-ghost">
                Cancelar
              </button>
              <button
                type="submit"
                data-testid="customer-save-button"
                className="btn btn-primary btn-lift"
                // La condición ahora sale del core: además de nombre y teléfono,
                // cubre la regla de mayorista, que antes sólo la frenaba el
                // `required` del navegador.
                disabled={isSubmitting || Object.keys(errors).length > 0}
              >
                {isSubmitting ? 'Guardando...' : <><Save size={16} /> Guardar Cliente</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
