import { User, Phone, Mail, MapPin, History, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'

interface Customer {
  id: string
  name: string
  phone: string
  email: string
  address: string
}

interface CustomerInfoCardProps {
  customer: Customer
}

export function CustomerInfoCard({ customer }: CustomerInfoCardProps) {
  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <User size={18} color="#6366f1" />
          <h3 className="card-title">Cliente</h3>
        </div>
        <Link 
          to={`/customers/${customer.id}`}
          className="btn btn-sm btn-outline"
        >
          <ExternalLink size={14} />
          Ver Perfil
        </Link>
      </div>
      <div className="card-body">
        <h4 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f8fafc', marginBottom: '1rem' }}>
          {customer.name}
        </h4>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#a0aec0' }}>
            <Phone size={16} />
            <a href={`tel:${customer.phone}`} style={{ color: '#a0aec0', textDecoration: 'none' }}>
              {customer.phone}
            </a>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#a0aec0' }}>
            <Mail size={16} />
            <a href={`mailto:${customer.email}`} style={{ color: '#a0aec0', textDecoration: 'none' }}>
              {customer.email}
            </a>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', color: '#a0aec0' }}>
            <MapPin size={16} style={{ flexShrink: 0, marginTop: '0.125rem' }} />
            <span>{customer.address}</span>
          </div>
        </div>

        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #374151' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#64748b', fontSize: '0.875rem' }}>
            <History size={14} />
            <span>5 órdenes previas</span>
          </div>
        </div>
      </div>
    </div>
  )
}
