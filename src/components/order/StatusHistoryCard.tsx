import { 
  CheckCircle, 
  Clock, 
  Wrench, 
  DollarSign, 
  FileText,
  XCircle
} from 'lucide-react'

interface StatusHistoryItem {
  id: string
  status: string
  note?: string
  created_at: string
}

interface StatusHistoryCardProps {
  history: StatusHistoryItem[]
}

const statusConfig: Record<string, { 
  label: string
  color: string
  icon: any
  description: string
}> = {
  new: {
    label: 'Nueva',
    color: '#64748b',
    icon: FileText,
    description: 'Orden creada'
  },
  diagnosis: {
    label: 'Diagnóstico',
    color: '#06b6d4',
    icon: Clock,
    description: 'Evaluando el equipo'
  },
  waiting_approval: {
    label: 'Esperando Aprobación',
    color: '#f59e0b',
    icon: DollarSign,
    description: 'Esperando confirmación del cliente'
  },
  repair: {
    label: 'En Reparación',
    color: '#6366f1',
    icon: Wrench,
    description: 'Reparando el equipo'
  },
  waiting_parts: {
    label: 'Esperando Repuestos',
    color: '#f59e0b',
    icon: Clock,
    description: 'Esperando llegada de repuestos'
  },
  ready_delivery: {
    label: 'Lista para Entrega',
    color: '#10b981',
    icon: CheckCircle,
    description: 'Equipo listo para retirar'
  },
  waiting_payment: {
    label: 'Esperando Pago',
    color: '#f59e0b',
    icon: DollarSign,
    description: 'Esperando pago del cliente'
  },
  completed: {
    label: 'Completada',
    color: '#10b981',
    icon: CheckCircle,
    description: 'Orden finalizada'
  },
  cancelled: {
    label: 'Cancelada',
    color: '#dc2626',
    icon: XCircle,
    description: 'Orden cancelada'
  }
}

export function StatusHistoryCard({ history }: StatusHistoryCardProps) {
  // Sort by date, newest first
  const sortedHistory = [...history].sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Clock size={18} color="#6366f1" />
        <h3 className="card-title">Historial de Estados</h3>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {sortedHistory.map((item, index) => {
            const config = statusConfig[item.status] || statusConfig.new
            const StatusIcon = config.icon
            const isLast = index === sortedHistory.length - 1
            
            return (
              <div 
                key={item.id} 
                style={{ 
                  display: 'flex', 
                  gap: '1rem',
                  position: 'relative'
                }}
              >
                {/* Timeline line */}
                {!isLast && (
                  <div 
                    style={{
                      position: 'absolute',
                      left: '19px',
                      top: '40px',
                      bottom: '-20px',
                      width: '2px',
                      backgroundColor: '#374151'
                    }}
                  />
                )}
                
                {/* Icon */}
                <div 
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    backgroundColor: `${config.color}20`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: config.color,
                    flexShrink: 0,
                    zIndex: 1
                  }}
                >
                  <StatusIcon size={18} />
                </div>
                
                {/* Content */}
                <div style={{ flex: 1, paddingBottom: '1.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                    <span 
                      className="badge"
                      style={{ 
                        backgroundColor: `${config.color}20`, 
                        color: config.color
                      }}
                    >
                      {config.label}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      {new Date(item.created_at).toLocaleString('es-ES', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                  </div>
                  
                  {item.note && (
                    <p style={{ color: '#a0aec0', fontSize: '0.875rem', margin: 0 }}>
                      {item.note}
                    </p>
                  )}
                  
                  {!item.note && (
                    <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0, fontStyle: 'italic' }}>
                      {config.description}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {history.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
            <Clock size={48} style={{ opacity: 0.5, marginBottom: '1rem' }} />
            <p>No hay historial de estados</p>
          </div>
        )}
      </div>
    </div>
  )
}
