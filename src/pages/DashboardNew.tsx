import { useState } from 'react'
import { Link } from 'react-router-dom'
import { 
  ClipboardList, 
  Users, 
  DollarSign,
  AlertCircle,
  RefreshCw,
  TrendingUp
} from 'lucide-react'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { useOrders } from '../hooks/useOrders'
import { STATUS_CONFIG } from '../types/orderStatus'
import { Loader } from '../components/ui/Loader'

const getStatusBadgeClass = (status: string) => {
  const classes: Record<string, string> = {
    new: 'badge-new',
    diagnosis: 'badge-diagnosis',
    waiting_approval: 'badge-warning',
    repair: 'badge-repair',
    waiting_parts: 'badge-warning',
    ready_delivery: 'badge-ready',
    waiting_payment: 'badge-warning',
    completed: 'badge-completed',
    cancelled: 'badge-danger',
  }
  return classes[status] || 'badge-new'
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview')
  const { stats, loading: statsLoading, error: statsError, refresh: refreshStats } = useDashboardStats()
  const { orders, loading: ordersLoading, error: ordersError } = useOrders()

  const loading = statsLoading || ordersLoading
  const error = statsError || ordersError

  // Calcular órdenes activas (no completadas ni canceladas)
  const activeOrders = stats?.totalOrders 
    ? stats.totalOrders - (stats.ordersByStatus.completed || 0) - (stats.ordersByStatus.cancelled || 0)
    : 0

  // Stats cards data
  const statsCards = stats ? [
    { 
      label: 'Órdenes Activas', 
      value: activeOrders.toString(), 
      change: `+${stats.newOrdersToday}`,
      trend: 'up' as const,
      icon: ClipboardList, 
      color: '#6366f1',
      subtitle: 'nuevas hoy'
    },
    { 
      label: 'Clientes Totales', 
      value: stats.totalCustomers.toString(), 
      change: `+${stats.newCustomersThisMonth}`,
      trend: 'up' as const,
      icon: Users, 
      color: '#06b6d4',
      subtitle: 'nuevos este mes'
    },
    { 
      label: 'Ingresos Hoy', 
      value: `$${stats.revenueToday.toLocaleString()}`, 
      change: `$${stats.revenueThisWeek.toLocaleString()}`,
      trend: 'up' as const,
      icon: DollarSign, 
      color: '#10b981',
      subtitle: 'esta semana'
    },
    { 
      label: 'Saldo Pendiente', 
      value: `$${stats.pendingPayments.toLocaleString()}`, 
      change: `${stats.completedOrdersToday} completadas`,
      trend: 'down' as const,
      icon: TrendingUp, 
      color: '#f59e0b',
      subtitle: 'hoy'
    },
  ] : []

  const recentOrders = orders.slice(0, 5)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" text="Cargando dashboard..." />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <AlertCircle size={48} color="#dc2626" />
        <h3 style={{ color: '#f8fafc', marginTop: '1rem' }}>Error al cargar dashboard</h3>
        <p style={{ color: '#a0aec0' }}>{error}</p>
        <button onClick={refreshStats} className="btn btn-primary" style={{ marginTop: '1rem' }}>
          <RefreshCw size={16} style={{ marginRight: '0.5rem' }} />
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', marginBottom: '0.5rem' }}>
            Dashboard
          </h1>
          <p style={{ color: '#a0aec0', fontSize: '0.9375rem' }}>
            Resumen general del sistema y actividad reciente
          </p>
        </div>
        <button onClick={refreshStats} className="btn btn-outline btn-sm">
          <RefreshCw size={16} style={{ marginRight: '0.5rem' }} />
          Actualizar
        </button>
      </div>

      {/* Stats Grid */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
        gap: '1.5rem',
        marginBottom: '2rem'
      }}>
        {statsCards.map((stat, index) => (
          <div key={index} className="card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '0.875rem', color: '#a0aec0', marginBottom: '0.5rem' }}>
                  {stat.label}
                </p>
                <h3 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  {stat.value}
                </h3>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.25rem',
                  marginTop: '0.5rem',
                  color: stat.trend === 'up' ? '#10b981' : '#f59e0b',
                  fontSize: '0.875rem'
                }}>
                  <span>{stat.change}</span>
                  <span style={{ color: '#64748b' }}>({stat.subtitle})</span>
                </div>
              </div>
              <div style={{
                width: '48px',
                height: '48px',
                borderRadius: '0.75rem',
                backgroundColor: `${stat.color}20`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: stat.color
              }}>
                <stat.icon size={24} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem' }}>
        {/* Left Column - Orders & Activity */}
        <div>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
            {['overview', 'orders', 'activity'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '0.625rem 1rem',
                  borderRadius: '0.5rem',
                  border: 'none',
                  backgroundColor: activeTab === tab ? '#6366f1' : 'transparent',
                  color: activeTab === tab ? '#0a0e1a' : '#a0aec0',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                {tab === 'overview' && 'Resumen'}
                {tab === 'orders' && 'Órdenes'}
                {tab === 'activity' && 'Actividad'}
              </button>
            ))}
          </div>

          {/* Recent Orders Card */}
          <div className="card">
            <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 className="card-title">Órdenes Recientes</h3>
              <Link to="/orders" className="btn btn-sm btn-outline">
                Ver Todas
              </Link>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Cliente</th>
                    <th>Dispositivo</th>
                    <th>Estado</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                        No hay órdenes registradas
                      </td>
                    </tr>
                  ) : (
                    recentOrders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <Link 
                            to={`/orders/${order.id}`}
                            style={{ color: '#6366f1', fontWeight: 500, textDecoration: 'none' }}
                          >
                            #{order.id.slice(0, 8)}
                          </Link>
                        </td>
                        <td>{order.customer?.name || 'Sin cliente'}</td>
                        <td>{order.device ? `${order.device.brand} ${order.device.model}` : 'Sin dispositivo'}</td>
                        <td>
                          <span className={`badge ${getStatusBadgeClass(order.status)}`}>
                            {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                          </span>
                        </td>
                        <td style={{ color: '#64748b', fontSize: '0.875rem' }}>
                          {new Date(order.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column - Quick Stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Órdenes por Estado */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Órdenes por Estado</h3>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {Object.entries(stats?.ordersByStatus || {})
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 6)
                  .map(([status, count]) => (
                    <div key={status} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span 
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            backgroundColor: STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.color || '#64748b'
                          }} 
                        />
                        <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                          {STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]?.label || status}
                        </span>
                      </div>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc' }}>
                        {count}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Dispositivos Populares */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Dispositivos Populares</h3>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {stats?.popularDeviceTypes.slice(0, 5).map((device, index) => (
                  <div key={index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>
                      {({'smartphone':'Celular','celular':'Celular','tablet':'Tablet','laptop':'Notebook','smartwatch':'Smartwatch','other':'Otro','otro':'Otro'} as Record<string,string>)[device.type] || device.type}
                    </span>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc' }}>
                      {device.count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Rendimiento */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Rendimiento</h3>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Tiempo Promedio de Reparación</p>
                  <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', margin: '0.25rem 0 0 0' }}>
                    {Math.round(stats?.averageRepairTime || 0)}h
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Tasa de Entrega a Tiempo</p>
                  <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#f8fafc', margin: '0.25rem 0 0 0' }}>
                    {Math.round(stats?.onTimeDeliveryRate || 0)}%
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: '0.75rem', color: '#64748b', margin: 0 }}>Ingresos del Mes</p>
                  <p style={{ fontSize: '1.25rem', fontWeight: 600, color: '#10b981', margin: '0.25rem 0 0 0' }}>
                    ${stats?.revenueThisMonth.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Acciones Rápidas</h3>
            </div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <Link to="/orders/new" className="btn btn-primary">
                Nueva Orden
              </Link>
              <Link to="/customers/new" className="btn btn-secondary">
                Nuevo Cliente
              </Link>
              <Link to="/reports" className="btn btn-outline">
                Ver Reportes
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
