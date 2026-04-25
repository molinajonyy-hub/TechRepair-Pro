import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ModalCobro } from '../components/cobro/ModalCobro'
import {
  ClipboardList,
  Users,
  DollarSign,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  Plus,
  Receipt,
  Cloud,
  Wallet,
  Lock
} from 'lucide-react'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { useComprobantes } from '../hooks/useComprobantes'
import { STATUS_CONFIG } from '../types/orderStatus'
import { currencyService } from '../services/currencyService'
import { TasksModule } from '../components/tasks/TasksModule'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const getStatusBadgeStyle = (status: string) => {
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
  return {
    backgroundColor: config ? `${config.color}20` : 'rgba(100, 116, 139, 0.2)',
    color: config?.color || '#94a3b8',
    padding: '0.25rem 0.75rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500
  }
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState('orders')
  const [cobroOpen, setCobroOpen] = useState(false)
  const { stats, loading: statsLoading, error: statsError, refresh: refreshStats } = useDashboardStats()
  const { comprobantes, listarComprobantes } = useComprobantes()
  const { businessId } = useAuth()
  const navigate = useNavigate()
  const [comprobantesLoaded, setComprobantesLoaded] = useState(false)
  const [dolarRate, setDolarRate] = useState<number | null>(null)
  const [dolarLoading, setDolarLoading] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [cajaStatus, setCajaStatus] = useState<'open' | 'closed' | null>(null)
  const [cajaId, setCajaId] = useState<string | null>(null)
  const [cajaLoading, setCajaLoading] = useState(false)
  const [movimientosCaja, setMovimientosCaja] = useState<any[]>([])
  const [movimientosLoading, setMovimientosLoading] = useState(false)

  const error = statsError

  useEffect(() => {
    let isMounted = true
    const safeFetch = async () => { if (isMounted) await loadDolarRate() }
    safeFetch()
    const interval = setInterval(safeFetch, 5 * 60 * 1000)
    return () => { isMounted = false; clearInterval(interval) }
  }, [])

  const loadDolarRate = async () => {
    setDolarLoading(true)
    try {
      const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS')
      setDolarRate(rate)
      setLastUpdate(new Date())

      // Actualizar precios de productos vinculados al dólar
      if (businessId && rate) {
        await currencyService.updateProductPricesByExchangeRate(businessId, rate)
      }
    } catch {
      // Fallo silencioso — el valor anterior se mantiene visible
    } finally {
      setDolarLoading(false)
    }
  }

  const handleRefreshDolar = async () => {
    await loadDolarRate()
  }

  const loadCajaStatus = useCallback(async () => {
    if (!businessId) return
    const today = new Date().toISOString().split('T')[0]
    const { data } = await supabase
      .from('cash_registers')
      .select('id, status')
      .eq('business_id', businessId)
      .eq('date', today)
      .maybeSingle()
    if (data) {
      setCajaStatus(data.status as 'open' | 'closed')
      setCajaId(data.id)
    } else {
      setCajaStatus('closed')
      setCajaId(null)
    }
  }, [businessId])

  useEffect(() => {
    loadCajaStatus()
  }, [loadCajaStatus])

  // Comprobantes: lazy — solo carga cuando el usuario abre esa pestaña
  useEffect(() => {
    if (activeTab === 'comprobantes' && businessId && !comprobantesLoaded) {
      listarComprobantes()
      setComprobantesLoaded(true)
    }
  }, [activeTab, businessId, comprobantesLoaded, listarComprobantes])

  useEffect(() => {
    if (businessId && cajaId) {
      loadMovimientosCaja()
    }
  }, [businessId, cajaId])

  const loadMovimientosCaja = async () => {
    if (!businessId || !cajaId) return
    setMovimientosLoading(true)
    try {
      const { data } = await supabase
        .from('financial_movements')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(10)
      setMovimientosCaja(data || [])
    } catch {
      // error silencioso — tabla puede no existir en todos los planes
    } finally {
      setMovimientosLoading(false)
    }
  }

  const handleCajaButton = async () => {
    if (cajaStatus === 'open' && cajaId) {
      if (!confirm('¿Cerrar la caja del día?')) return
      setCajaLoading(true)
      await supabase.from('cash_registers').update({
        status: 'closed',
        closed_at: new Date().toISOString()
      }).eq('id', cajaId)
      await loadCajaStatus()
      setCajaLoading(false)
    } else {
      navigate('/caja')
    }
  }

  const activeOrders = stats?.totalOrders 
    ? stats.totalOrders - (stats.ordersByStatus.completed || 0) - (stats.ordersByStatus.cancelled || 0)
    : 0

  const statsCards = stats ? [
    { label: 'Órdenes Activas', value: activeOrders.toString(), change: `+${stats.newOrdersToday}`, trend: 'up' as const, icon: ClipboardList, color: '#6366f1', subtitle: 'nuevas hoy' },
    { label: 'Clientes Totales', value: stats.totalCustomers.toString(), change: `+${stats.newCustomersThisMonth}`, trend: 'up' as const, icon: Users, color: '#06b6d4', subtitle: 'nuevos este mes' },
    { label: 'Ganancia Real Hoy', value: `$${stats.realProfitToday.toLocaleString()}`, change: `${stats.averageMarginPct.toFixed(1)}% margen`, trend: 'up' as const, icon: TrendingUp, color: '#10b981', subtitle: `$${stats.realProfitThisWeek.toLocaleString()} esta semana` },
  ] : []

  const hasNoData = stats && stats.totalOrders === 0 && stats.totalCustomers === 0

  const dolarCard = {
    label: 'Dólar Blue',
    value: dolarRate ? `$${dolarRate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Cargando...',
    change: lastUpdate ? `Actualizado: ${lastUpdate.toLocaleTimeString('es-AR')}` : '',
    trend: 'up' as const,
    icon: Cloud,
    color: '#059669',
    subtitle: 'USD/ARS'
  }

  const recentOrders = stats?.recentOrders ?? []

  if (error) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <AlertCircle size={48} style={{ color: 'var(--error)' }} />
        <h3 style={{ color: 'var(--text-primary)', marginTop: '1rem' }}>Error al cargar inicio</h3>
        <p style={{ color: 'var(--text-muted)' }}>{error}</p>
        <button onClick={refreshStats} style={{
          marginTop: '1rem',
          padding: '0.625rem 1.25rem',
          backgroundColor: 'var(--accent-primary)',
          border: 'none',
          color: '#ffffff',
          borderRadius: '0.5rem',
          cursor: 'pointer',
          fontWeight: 500
        }}>
          <RefreshCw size={16} style={{ marginRight: '0.5rem' }} />
          Reintentar
        </button>
      </div>
    )
  }

  return (
    <div>
      <ModalCobro isOpen={cobroOpen} onClose={() => setCobroOpen(false)} />
      <div className="dash-header-row" style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="page-title-h1" style={{ fontSize: '1.875rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
            Inicio
          </h1>
          <p className="page-subtitle" style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Resumen general del sistema y actividad reciente
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button onClick={() => setCobroOpen(true)} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1.125rem',
            background: 'linear-gradient(135deg, #22c55e, #16a34a)',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 700,
            fontSize: '0.9rem',
            boxShadow: '0 4px 14px rgba(34,197,94,0.35)',
          }}>
            💰 + Cobrar
          </button>
          <Link to="/orders/new" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1rem',
            backgroundColor: 'var(--accent-primary)',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 500,
            textDecoration: 'none',
            fontSize: '0.875rem'
          }}>
            <Plus size={16} />
            Nueva Orden
          </Link>
          <Link to="/comprobantes" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1rem',
            backgroundColor: '#10b981',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 500,
            textDecoration: 'none',
            fontSize: '0.875rem'
          }}>
            <Receipt size={16} />
            Nuevo Comprobante
          </Link>
          <Link to="/expenses" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1rem',
            backgroundColor: '#f59e0b',
            border: 'none',
            color: '#ffffff',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontWeight: 500,
            textDecoration: 'none',
            fontSize: '0.875rem'
          }}>
            <DollarSign size={16} />
            Gasto
          </Link>
          <button
            onClick={handleCajaButton}
            disabled={cajaLoading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.625rem 1rem',
              backgroundColor: cajaStatus === 'open' ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)',
              border: `1px solid ${cajaStatus === 'open' ? 'rgba(239,68,68,0.4)' : 'rgba(16,185,129,0.4)'}`,
              color: cajaStatus === 'open' ? '#f87171' : '#34d399',
              borderRadius: '0.5rem',
              cursor: cajaLoading ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              opacity: cajaLoading ? 0.6 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {cajaStatus === 'open'
              ? <><Lock size={15} /> Cerrar Caja</>
              : <><Wallet size={15} /> Abrir Caja</>}
          </button>
          <button onClick={refreshStats} style={{
            padding: '0.5rem 1rem',
            backgroundColor: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8',
            borderRadius: '0.5rem',
            cursor: 'pointer',
            fontSize: '0.875rem',
            fontWeight: 500
          }}>
            <RefreshCw size={16} style={{ marginRight: '0.5rem' }} />
            Actualizar
          </button>
        </div>
      </div>

      {/* Módulo de Tareas */}
      <TasksModule />

      {statsLoading && !stats ? (
        /* Skeleton cards mientras carga la primera vez */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} style={{
              padding: '1.5rem',
              backgroundColor: '#0f1829',
              border: '1px solid rgba(255,255,255,0.06)',
              borderTop: '3px solid rgba(255,255,255,0.08)',
              borderRadius: '0.75rem',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              <div style={{ height: '0.875rem', width: '60%', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: '0.25rem', marginBottom: '0.75rem' }} />
              <div style={{ height: '1.875rem', width: '40%', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '0.25rem', marginBottom: '0.75rem' }} />
              <div style={{ height: '0.75rem', width: '70%', backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: '0.25rem' }} />
            </div>
          ))}
        </div>
      ) : hasNoData ? (
        <div style={{
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          padding: '3rem',
          textAlign: 'center',
          marginBottom: '2rem'
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            backgroundColor: 'rgba(15,23,42,0.8)',
            margin: '0 auto 1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <ClipboardList size={40} style={{ color: '#64748b' }} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
            ¡Bienvenido a tu sistema!
          </h2>
          <p style={{ color: '#94a3b8', fontSize: '1rem', marginBottom: '2rem', maxWidth: '400px', margin: '0 auto 2rem' }}>
            Aún no tenés datos registrados. Comenzá creando tu primera orden o agregando clientes.
          </p>
          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/orders/new" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.625rem',
              cursor: 'pointer',
              fontWeight: 600,
              textDecoration: 'none',
              fontSize: '0.875rem',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
            }}>
              <Plus size={16} />
              Crear Primera Orden
            </Link>
            <Link to="/customers/new" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              backgroundColor: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8',
              borderRadius: '0.625rem',
              cursor: 'pointer',
              fontWeight: 600,
              textDecoration: 'none',
              fontSize: '0.875rem'
            }}>
              <Users size={16} />
              Agregar Cliente
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        {statsCards.map((stat, index) => (
          <div key={index} style={{
            padding: '1.5rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(255,255,255,0.06)',
            borderTop: `3px solid ${stat.color}`,
            borderRadius: '0.75rem'
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>{stat.label}</p>
                <h3 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>{stat.value}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem', color: stat.trend === 'up' ? '#34d399' : '#fbbf24', fontSize: '0.875rem' }}>
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
        
        {/* Dólar Rate Card */}
        <div style={{
          padding: '1.5rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderTop: `3px solid ${dolarCard.color}`,
          borderRadius: '0.75rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>{dolarCard.label}</p>
              <h3 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>{dolarCard.value}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.5rem', color: '#059669', fontSize: '0.875rem' }}>
                <span>{dolarCard.change}</span>
                <span style={{ color: '#64748b' }}>({dolarCard.subtitle})</span>
              </div>
            </div>
            <div style={{
              width: '48px',
              height: '48px',
              borderRadius: '0.75rem',
              backgroundColor: `${dolarCard.color}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: dolarCard.color,
              cursor: 'pointer'
            }} onClick={handleRefreshDolar} title="Actualizar tipo de cambio">
              {dolarLoading ? (
                <RefreshCw size={24} className="animate-spin" />
              ) : (
                <dolarCard.icon size={24} />
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ── Sección Rentabilidad ── */}
      {stats && stats.topProfitableItems.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: '1rem',
          marginBottom: '2rem',
        }}>
          {/* Ganancia del mes */}
          <div style={{
            padding: '1.25rem 1.5rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(52,211,153,0.2)',
            borderTop: '3px solid #34d399',
            borderRadius: '0.75rem',
          }}>
            <p style={{ margin: '0 0 0.375rem', fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Ganancia real del mes
            </p>
            <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#34d399', fontFamily: 'monospace' }}>
              ${stats.realProfitThisMonth.toLocaleString('es-AR', { maximumFractionDigits: 0 })}
            </p>
          </div>
          {/* Margen promedio */}
          <div style={{
            padding: '1.25rem 1.5rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(129,140,248,0.2)',
            borderTop: '3px solid #818cf8',
            borderRadius: '0.75rem',
          }}>
            <p style={{ margin: '0 0 0.375rem', fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Margen promedio
            </p>
            <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#818cf8', fontFamily: 'monospace' }}>
              {stats.averageMarginPct.toFixed(1)}%
            </p>
          </div>
          {/* Ganancia por operación */}
          <div style={{
            padding: '1.25rem 1.5rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(251,191,36,0.2)',
            borderTop: '3px solid #fbbf24',
            borderRadius: '0.75rem',
          }}>
            <p style={{ margin: '0 0 0.375rem', fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Ganancia por orden
            </p>
            <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#fbbf24', fontFamily: 'monospace' }}>
              ${stats.profitPerOperation.toLocaleString('es-AR', { maximumFractionDigits: 0 })}
            </p>
          </div>
          {/* Ranking de items más rentables */}
          <div style={{
            padding: '1.25rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '0.75rem',
          }}>
            <p style={{ margin: '0 0 0.75rem', fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Top trabajos más rentables
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {stats.topProfitableItems.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <span style={{
                    width: '18px', height: '18px', borderRadius: '50%', fontSize: '0.65rem',
                    fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    backgroundColor: i === 0 ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.05)',
                    color: i === 0 ? '#fbbf24' : '#475569', flexShrink: 0,
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, fontSize: '0.8rem', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: '#34d399', fontFamily: 'monospace', fontWeight: 600, flexShrink: 0 }}>
                    +${item.profit.toLocaleString('es-AR', { maximumFractionDigits: 0 })}
                  </span>
                  <span style={{
                    fontSize: '0.65rem', padding: '0.1rem 0.35rem', borderRadius: '0.25rem',
                    backgroundColor: 'rgba(129,140,248,0.12)', color: '#818cf8', flexShrink: 0,
                  }}>
                    {item.margin.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem' }}>
        <div>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
            {['orders', 'comprobantes', 'movimientos'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '0.625rem 1rem',
                  borderRadius: '0.625rem',
                  border: activeTab === tab ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  background: activeTab === tab ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : 'rgba(255,255,255,0.05)',
                  boxShadow: activeTab === tab ? '0 4px 12px rgba(99,102,241,0.35)' : 'none',
                  color: activeTab === tab ? '#ffffff' : '#94a3b8',
                  fontSize: '0.875rem',
                  fontWeight: activeTab === tab ? 600 : 500,
                  cursor: 'pointer'
                }}
              >
                {tab === 'orders' && 'Órdenes'}
                {tab === 'comprobantes' && 'Comprobantes'}
                {tab === 'movimientos' && 'Movimientos de Caja'}
              </button>
            ))}
          </div>

          <div style={{ backgroundColor: '#0f1829', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '0.75rem' }}>
            <div style={{ padding: '1.5rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>
                {activeTab === 'orders' && 'Órdenes Recientes'}
                {activeTab === 'comprobantes' && 'Comprobantes Recientes'}
                {activeTab === 'movimientos' && 'Movimientos de Caja'}
              </h3>
              <Link to={activeTab === 'orders' ? '/orders' : activeTab === 'comprobantes' ? '/comprobantes' : '/caja'} style={{
                padding: '0.5rem 1rem',
                backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#94a3b8',
                borderRadius: '0.5rem',
                textDecoration: 'none',
                fontSize: '0.875rem',
                fontWeight: 500
              }}>
                Ver Todas
              </Link>
            </div>
            <div style={{ padding: 0 }}>
              {activeTab === 'orders' && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Orden</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Cliente</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Dispositivo</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Estado</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>No hay órdenes registradas</td>
                      </tr>
                    ) : (
                      recentOrders.map((order) => (
                        <tr key={order.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '1rem' }}>
                            <Link to={`/orders/${order.id}`} style={{ color: '#818cf8', fontWeight: 500, textDecoration: 'none' }}>
                              #{order.id.slice(0, 8)}
                            </Link>
                          </td>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{order.customer_name || '—'}</td>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{order.device_label || '—'}</td>
                          <td style={{ padding: '1rem' }}>
                            <span style={getStatusBadgeStyle(order.status)}>
                              {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                            </span>
                          </td>
                          <td style={{ padding: '1rem', color: '#64748b', fontSize: '0.875rem' }}>
                            {new Date(order.created_at).toLocaleDateString('es-ES')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}

              {activeTab === 'comprobantes' && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Tipo</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Cliente</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Total</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Estado</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comprobantes.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>No hay comprobantes registrados</td>
                      </tr>
                    ) : (
                      comprobantes.slice(0, 5).map((comp) => (
                        <tr key={comp.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{comp.tipo}</td>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{comp.customer_id ? 'Cliente #' + comp.customer_id.slice(0, 6) : 'Sin cliente'}</td>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>${comp.total?.toLocaleString() || '0'}</td>
                          <td style={{ padding: '1rem' }}>
                            <span style={{
                              backgroundColor: comp.estado === 'emitido' ? 'rgba(16, 185, 129, 0.2)' : comp.estado === 'anulado' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                              color: comp.estado === 'emitido' ? '#34d399' : comp.estado === 'anulado' ? '#f87171' : '#fbbf24',
                              padding: '0.25rem 0.75rem',
                              borderRadius: '9999px',
                              fontSize: '0.75rem',
                              fontWeight: 500
                            }}>
                              {comp.estado}
                            </span>
                          </td>
                          <td style={{ padding: '1rem', color: '#64748b', fontSize: '0.875rem' }}>
                            {new Date(comp.created_at).toLocaleDateString('es-ES')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}

              {activeTab === 'movimientos' && (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Tipo</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Descripción</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Monto</th>
                      <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Fecha</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimientosLoading ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                          Cargando movimientos...
                        </td>
                      </tr>
                    ) : movimientosCaja.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                          {cajaStatus === 'open' ? 'No hay movimientos registrados' : 'La caja está cerrada'}
                        </td>
                      </tr>
                    ) : (
                      movimientosCaja.map((mov) => (
                        <tr key={mov.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{mov.type}</td>
                          <td style={{ padding: '1rem', color: '#94a3b8' }}>{mov.description || '-'}</td>
                          <td style={{ padding: '1rem', color: mov.type === 'in' ? '#34d399' : '#f87171' }}>
                            {mov.type === 'in' ? '+' : '-'}${mov.amount?.toLocaleString() || '0'}
                          </td>
                          <td style={{ padding: '1rem', color: '#64748b', fontSize: '0.875rem' }}>
                            {new Date(mov.created_at).toLocaleString('es-ES')}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
