import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, User, Phone, Mail, MapPin, ClipboardList, Smartphone } from 'lucide-react'
import { Loader } from '../components/ui/Loader'
import { customersService } from '../services/api'
import { STATUS_CONFIG } from '../types/orderStatus'

interface CustomerOrderSummary {
  id: string
  status: string
  total_cost?: number
  estimated_total?: number
  created_at: string
  device?: {
    brand?: string
    model?: string
  } | null
}

interface CustomerDetailData {
  id: string
  name: string
  phone?: string
  email?: string
  address?: string
  devices?: Array<{
    id: string
    brand?: string
    model?: string
  }>
  orders?: CustomerOrderSummary[]
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0)

const getStatusStyle = (status: string) => {
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]

  return {
    backgroundColor: config ? `${config.color}20` : 'rgba(100, 116, 139, 0.2)',
    color: config?.color || '#94a3b8',
    padding: '0.25rem 0.75rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
  }
}

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const [customer, setCustomer] = useState<CustomerDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) {
      setError('Cliente no encontrado')
      setLoading(false)
      return
    }

    const loadCustomer = async () => {
      try {
        setLoading(true)
        setError(null)
        const data = await customersService.getById(id)
        setCustomer(data as CustomerDetailData)
      } catch (err: any) {
        setError(err.message || 'Error al cargar cliente')
      } finally {
        setLoading(false)
      }
    }

    void loadCustomer()
  }, [id])

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" text="Cargando cliente..." />
      </div>
    )
  }

  if (error || !customer) {
    return (
      <div style={{ padding: '2rem' }}>
        <Link to="/customers" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}>
          <ArrowLeft size={16} />
          Volver a Clientes
        </Link>
        <div style={{ padding: '1.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '0.75rem' }}>
          <p style={{ color: '#f87171' }}>{error || 'Cliente no encontrado'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <Link to="/customers" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}>
        <ArrowLeft size={16} />
        Volver a Clientes
      </Link>

      <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', marginBottom: '2rem' }}>
        {customer.name}
      </h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1.5rem' }}>
        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <User size={18} color="#6366f1" />
            <h3 className="card-title">Informacion de Contacto</h3>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Phone size={18} color="#64748b" />
                <span>{customer.phone || 'Sin telefono'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Mail size={18} color="#64748b" />
                <span>{customer.email || 'Sin email'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                <MapPin size={18} color="#64748b" />
                <span>{customer.address || 'Sin direccion'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Smartphone size={18} color="#64748b" />
                <span>{customer.devices?.length || 0} dispositivo(s) registrado(s)</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ClipboardList size={18} color="#6366f1" />
            <h3 className="card-title">Historial de Ordenes</h3>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Dispositivo</th>
                  <th>Estado</th>
                  <th>Total</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {!customer.orders || customer.orders.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                      Este cliente todavia no tiene ordenes registradas.
                    </td>
                  </tr>
                ) : (
                  customer.orders.map((order) => {
                    const amount =
                      typeof order.total_cost === 'number' && order.total_cost > 0
                        ? order.total_cost
                        : order.estimated_total || 0

                    const deviceLabel = order.device
                      ? `${order.device.brand || ''} ${order.device.model || ''}`.trim()
                      : 'Dispositivo asociado'

                    return (
                      <tr key={order.id}>
                        <td>
                          <Link to={`/orders/${order.id}`} style={{ color: '#6366f1' }}>
                            #{order.id.slice(0, 8)}
                          </Link>
                        </td>
                        <td>{deviceLabel || 'Dispositivo asociado'}</td>
                        <td>
                          <span style={getStatusStyle(order.status)}>
                            {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{formatCurrency(amount)}</td>
                        <td style={{ color: '#64748b' }}>
                          {new Date(order.created_at).toLocaleDateString('es-AR')}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
