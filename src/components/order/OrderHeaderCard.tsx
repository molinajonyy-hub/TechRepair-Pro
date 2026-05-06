import { useState } from 'react'
import { Edit, CheckCircle, Clock, AlertCircle, Wrench } from 'lucide-react'
import { getStatusLabel, getStatusColor, getPriorityLabel, getPriorityColor } from '../../data/mockData'

interface Order {
  id: string
  status: string
  priority: string
  created_at: string
  estimated_total: number
}

interface OrderHeaderCardProps {
  order: Order
}

const statusIcons: Record<string, any> = {
  new: AlertCircle,
  diagnosis: Clock,
  repair: Wrench,
  ready: CheckCircle,
  completed: CheckCircle,
}

export function OrderHeaderCard({ order }: OrderHeaderCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const StatusIcon = statusIcons[order.status] || AlertCircle

  return (
    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div className="card-body">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 700, color: '#f8fafc', marginBottom: '0.5rem' }}>
              Orden #{order.id}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span 
                className="badge"
                style={{ 
                  backgroundColor: `${getStatusColor(order.status)}20`, 
                  color: getStatusColor(order.status),
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  fontSize: '0.875rem'
                }}
              >
                <StatusIcon size={16} />
                {getStatusLabel(order.status)}
              </span>
              <span 
                className="badge"
                style={{ 
                  backgroundColor: `${getPriorityColor(order.priority)}20`, 
                  color: getPriorityColor(order.priority)
                }}
              >
                {getPriorityLabel(order.priority)}
              </span>
              <span style={{ color: '#64748b', fontSize: '0.875rem' }}>
                Creada: {new Date(order.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}
              </span>
            </div>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '0.875rem', color: '#64748b', marginBottom: '0.25rem' }}>
                Total Estimado
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 700, color: '#6366f1' }}>
                ${order.estimated_total}
              </p>
            </div>
            <button 
              className="btn btn-outline"
              onClick={() => setIsEditing(!isEditing)}
            >
              <Edit size={18} />
              Cambiar Estado
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
