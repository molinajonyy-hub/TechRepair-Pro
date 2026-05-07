import { useEffect, useState, useCallback } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, User, Phone, Mail, MapPin, ClipboardList, Smartphone, Building2, CreditCard } from 'lucide-react'
import { Loader } from '../components/ui/Loader'
import { customersService } from '../services/api'
import { STATUS_CONFIG } from '../types/orderStatus'
import { cuentasService, getAccountStatus, type Account } from '../services/cuentasService'
import { ModalPagarCC } from '../components/comprobantes/ModalPagarCC'
import { useAuth } from '../contexts/AuthContext'

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
  customer_type?: string
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

const CC_STATUS = {
  al_dia:  { label: 'Al día',   color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.25)'  },
  deuda:   { label: 'En deuda', color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.25)' },
  a_favor: { label: 'A favor',  color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',  border: 'rgba(96,165,250,0.25)'  },
}

export function CustomerDetail() {
  const { id } = useParams<{ id: string }>()
  const { businessId, user } = useAuth()
  const [customer, setCustomer] = useState<CustomerDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ccAccount, setCcAccount] = useState<Account | null>(null)
  const [showPagarCC, setShowPagarCC] = useState(false)

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

  const loadCcAccount = useCallback(async () => {
    if (!businessId || !id) return
    const accounts = await cuentasService.getAccounts(businessId, 'cliente')
    const found = accounts.find(a => a.entity_id === id) || null
    setCcAccount(found)
  }, [businessId, id])

  useEffect(() => { void loadCcAccount() }, [loadCcAccount])

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

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
          {customer.name}
        </h1>
        {customer.customer_type === 'mayorista' ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.25rem 0.75rem', borderRadius: '999px',
            background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)',
            fontSize: '0.78rem', fontWeight: 700, color: '#818cf8', letterSpacing: '0.04em',
          }}>
            <Building2 size={12} /> Mayorista
          </span>
        ) : (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
            padding: '0.25rem 0.75rem', borderRadius: '999px',
            background: 'rgba(100,116,139,0.12)', border: '1px solid rgba(100,116,139,0.25)',
            fontSize: '0.78rem', fontWeight: 600, color: '#64748b',
          }}>
            <User size={12} /> Minorista
          </span>
        )}
      </div>

      {/* Cuenta Corriente widget (solo si existe deuda o saldo) */}
      {ccAccount && Math.abs(ccAccount.balance) > 0.01 && (() => {
        const status = getAccountStatus(ccAccount.balance)
        const sm = CC_STATUS[status]
        return (
          <div className="card" style={{ marginBottom: '1.5rem', borderColor: sm.border, background: sm.bg }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <CreditCard size={20} style={{ color: sm.color }} />
                <div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: sm.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cuenta Corriente</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: 'monospace', color: sm.color }}>
                    {ccAccount.balance > 0 ? '' : '+'}{formatCurrency(Math.abs(ccAccount.balance))}
                  </div>
                </div>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '0.2rem 0.625rem', borderRadius: '9999px', background: sm.bg, color: sm.color, border: `1px solid ${sm.border}` }}>
                  {sm.label}
                </span>
              </div>
              {ccAccount.balance > 0 && (
                <button
                  onClick={() => setShowPagarCC(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.625rem 1.125rem', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', border: 'none', borderRadius: '0.625rem', color: '#fff', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}
                >
                  <CreditCard size={14} /> Registrar pago
                </button>
              )}
            </div>
          </div>
        )
      })()}

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

      {/* Modal para registrar pago de cuenta corriente */}
      {ccAccount && (
        <ModalPagarCC
          isOpen={showPagarCC}
          onClose={() => setShowPagarCC(false)}
          onPagado={() => { setShowPagarCC(false); void loadCcAccount() }}
          account={ccAccount}
          businessId={businessId || ''}
          userId={user?.id || ''}
        />
      )}
    </div>
  )
}
