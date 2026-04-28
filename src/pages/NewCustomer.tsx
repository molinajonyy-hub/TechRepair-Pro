import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, UserPlus, Save } from 'lucide-react'
import { customersService } from '../services/api'

export function NewCustomer() {
  const navigate = useNavigate()
  const location = useLocation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    document: '',
    documentType: 'dni' as 'dni' | 'cuit',
  })

  const returnTo = location.state?.returnTo || '/customers'

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')

    try {
      const customer = await customersService.create({
        name: formData.name,
        phone: formData.phone,
        email: formData.email || undefined,
        address: formData.address || undefined,
        document: formData.document
          ? `${formData.documentType.toUpperCase()}: ${formData.document}`
          : undefined,
      })

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
      <div style={{ marginBottom: '2rem' }}>
        <button 
          onClick={() => navigate(returnTo)} 
          className="btn btn-outline btn-sm" 
          style={{ marginBottom: '1rem' }}
        >
          <ArrowLeft size={16} />
          Volver
        </button>
        
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc' }}>
          Nuevo Cliente
        </h1>
        <p style={{ color: '#475569' }}>
          Registra un nuevo cliente en el sistema
        </p>
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
                value={formData.name}
                onChange={(e) => handleChange('name', e.target.value)}
                className="form-control"
                placeholder="Ej: Juan Pérez"
                required
              />
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Teléfono *</label>
              <input
                type="tel"
                value={formData.phone}
                onChange={(e) => handleChange('phone', e.target.value)}
                className="form-control"
                placeholder="Ej: +54 9 11 1234-5678"
                required
              />
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => handleChange('email', e.target.value)}
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
                  {(['dni', 'cuit'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleChange('documentType', t)}
                      style={{
                        padding: '0.5rem 0.875rem',
                        border: 'none',
                        background: formData.documentType === t ? 'rgba(99,102,241,0.25)' : 'transparent',
                        color: formData.documentType === t ? '#a5b4fc' : 'var(--text-subtle)',
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
                  value={formData.document}
                  onChange={e => handleChange('document', e.target.value)}
                  className="form-control"
                  placeholder={formData.documentType === 'dni' ? 'Ej: 30.123.456' : 'Ej: 20-30123456-7'}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label className="form-label">Dirección</label>
              <textarea
                value={formData.address}
                onChange={(e) => handleChange('address', e.target.value)}
                className="form-control"
                rows={3}
                placeholder="Ej: Av. Corrientes 1234, CABA"
              />
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="button"
                onClick={() => navigate(returnTo)}
                className="btn"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#94a3b8',
                  borderRadius: '0.5rem',
                  fontWeight: 600
                }}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="btn"
                disabled={isSubmitting || !formData.name || !formData.phone}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.625rem',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
                  cursor: 'pointer'
                }}
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner-border spinner-border-sm" style={{ marginRight: '0.5rem' }}></span>
                    Guardando...
                  </>
                ) : (
                  <>
                    <Save size={18} />
                    Guardar Cliente
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
