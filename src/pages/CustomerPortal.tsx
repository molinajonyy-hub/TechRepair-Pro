import { useState } from 'react'
import { Smartphone, Clock, CheckCircle, DollarSign, Search } from 'lucide-react'

const mockOrders = [
  { id: '001', device: 'iPhone 13 Pro', status: 'repair', statusLabel: 'En Reparación', total: '$450', updatedAt: '2024-01-15' },
  { id: '005', device: 'iPad Air', status: 'completed', statusLabel: 'Completada', total: '$320', updatedAt: '2024-01-10' },
]

const statusConfig: Record<string, { color: string; bg: string }> = {
  repair: { color: '#6366f1', bg: 'rgba(99, 102, 241, 0.1)' },
  completed: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
}

export function CustomerPortal() {
  const [orderNumber, setOrderNumber] = useState('')
  const [showResults, setShowResults] = useState(false)

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setShowResults(true)
  }

  return (
    <div style={{ 
      minHeight: '100vh', 
      backgroundColor: '#0a0e1a',
      padding: '2rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center'
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
        <h1 style={{ 
          fontSize: '2rem', 
          fontWeight: 700, 
          color: '#6366f1',
          marginBottom: '0.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem'
        }}>
          <i className="fas fa-mobile-alt"></i>
          TechRepair Pro
        </h1>
        <p style={{ color: '#a0aec0' }}>
          Portal de Consulta de Órdenes
        </p>
      </div>

      {/* Search Form */}
      <div className="card" style={{ width: '100%', maxWidth: '500px', marginBottom: '2rem' }}>
        <div className="card-body">
          <form onSubmit={handleSearch}>
            <label style={{ display: 'block', marginBottom: '0.75rem', color: '#a0aec0', fontSize: '0.875rem' }}>
              Ingresa tu número de orden o DNI
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
                <input
                  type="text"
                  placeholder="Ej: ORD-001 o 12345678"
                  value={orderNumber}
                  onChange={(e) => setOrderNumber(e.target.value)}
                  className="form-control"
                  style={{ paddingLeft: '2.5rem' }}
                />
              </div>
              <button type="submit" className="btn btn-primary">
                Buscar
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Results */}
      {showResults && (
        <div style={{ width: '100%', maxWidth: '800px' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', marginBottom: '1rem' }}>
            Tus Órdenes
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {mockOrders.map((order) => {
              const config = statusConfig[order.status]
              return (
                <div key={order.id} className="card">
                  <div className="card-body">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div style={{
                          width: '48px',
                          height: '48px',
                          borderRadius: '0.75rem',
                          backgroundColor: config.bg,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          <Smartphone size={24} color={config.color} />
                        </div>
                        <div>
                          <p style={{ fontWeight: 600, color: '#f8fafc', marginBottom: '0.25rem' }}>
                            Orden #{order.id}
                          </p>
                          <p style={{ color: '#a0aec0', fontSize: '0.875rem' }}>
                            {order.device}
                          </p>
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        <div style={{ textAlign: 'right' }}>
                          <span 
                            className="badge"
                            style={{ 
                              backgroundColor: config.bg, 
                              color: config.color,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.375rem'
                            }}
                          >
                            {order.status === 'repair' && <Clock size={14} />}
                            {order.status === 'completed' && <CheckCircle size={14} />}
                            {order.statusLabel}
                          </span>
                          <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.25rem' }}>
                            Actualizado: {order.updatedAt}
                          </p>
                        </div>
                        
                        <div style={{ textAlign: 'right' }}>
                          <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.25rem' }}>
                            Total
                          </p>
                          <p style={{ fontWeight: 600, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            <DollarSign size={16} />
                            {order.total}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 'auto', paddingTop: '3rem', textAlign: 'center' }}>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          ¿Necesitas ayuda? Contactanos al <a href="tel:+541112345678" style={{ color: '#6366f1' }}>+54 9 11 1234-5678</a>
        </p>
      </div>
    </div>
  )
}
