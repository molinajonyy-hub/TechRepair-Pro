import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { useComprobantes } from '../hooks/useComprobantes'
import { refreshDollarRate, refreshInventoryDollarPrices, type DollarRateResult } from '../services/dollarRateService'
import { DollarRateBadge } from '../components/ui/DollarRateBadge'
import { DashboardTasks } from '../components/tasks/DashboardTasks'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  AppButton, AppIconButton,
  AppPageHeader, AppSectionHeader,
  AppTabs, AppStatusBadge,
  AppEmptyState, AppLoadingState, AppErrorState,
  TableActions,
} from '../ui'
import {
  NewOrderIcon, FinanceIcon, InvoiceIcon,
  OrderIcon, ClientsIcon, RevenueIcon,
  RefreshIcon, NewClientIcon, WarrantyIcon,
  ExpenseReceiptIcon, ViewIcon,
  CloseLockIcon as LockIcon, DashboardIcon, CurrencyIcon,
  PrintIcon,
} from '../ui/icons'

// ─── Labels de tipos de comprobante ──────────────────────────────────────────
const TIPO_LABELS: Record<string, string> = {
  factura_a:    'Factura A',
  factura_b:    'Factura B',
  factura_c:    'Factura C',
  remito:       'Remito',
  nota_credito: 'Nota de Crédito',
  presupuesto:  'Presupuesto',
  ticket:       'Ticket',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtARS = (n: number) =>
  '$' + Math.round(n).toLocaleString('es-AR')

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' })

// ─── Componente principal ─────────────────────────────────────────────────────

export function Dashboard() {
  const [activeTab, setActiveTab] = useState('orders')
  const [, setDolarResult]   = useState<DollarRateResult | null>(null)
  const [, setDolarLoading]  = useState(false)
  const [cajaStatus, setCajaStatus]         = useState<'open' | 'closed' | null>(null)
  const [cajaId, setCajaId]                 = useState<string | null>(null)
  const [cajaLoading, setCajaLoading]       = useState(false)
  const [movimientosCaja, setMovimientosCaja] = useState<any[]>([])
  const [movimientosLoading, setMovimientosLoading] = useState(false)
  const [comprobantesLoaded, setComprobantesLoaded] = useState(false)

  const { stats, loading: statsLoading, error: statsError, refresh: refreshStats } = useDashboardStats()
  const { comprobantes, listarComprobantes } = useComprobantes()
  const { businessId } = useAuth()
  const navigate = useNavigate()

  // ── Cargar tipo de cambio ──
  useEffect(() => {
    if (!businessId) return
    let active = true
    const load = async () => {
      if (!active) return
      setDolarLoading(true)
      try {
        const result = await refreshDollarRate(businessId, false)
        if (!active) return
        setDolarResult(result)
        if (result?.sellPrice)
          await refreshInventoryDollarPrices(businessId)
      } catch { /* silencioso */ }
      finally { if (active) setDolarLoading(false) }
    }
    load()
    const t = setInterval(load, 15 * 60_000)
    return () => { active = false; clearInterval(t) }
  }, [businessId])


  // ── Estado de caja ──
  const loadCajaStatus = useCallback(async () => {
    if (!businessId) return
    const today = new Date().toISOString().split('T')[0]
    const { data } = await supabase.from('cash_registers').select('id, status')
      .eq('business_id', businessId).eq('date', today).maybeSingle()
    setCajaStatus(data ? (data.status as 'open' | 'closed') : 'closed')
    setCajaId(data?.id || null)
  }, [businessId])

  useEffect(() => { loadCajaStatus() }, [loadCajaStatus])

  // ── Movimientos de caja ──
  useEffect(() => {
    if (!businessId || !cajaId) return
    setMovimientosLoading(true)
    void Promise.resolve(
      supabase.from('financial_movements').select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false }).limit(10)
    ).then(({ data }) => setMovimientosCaja(data || []))
     .finally(() => setMovimientosLoading(false))
  }, [businessId, cajaId])

  // ── Comprobantes lazy ──
  useEffect(() => {
    if (activeTab === 'comprobantes' && businessId && !comprobantesLoaded) {
      listarComprobantes(); setComprobantesLoaded(true)
    }
  }, [activeTab, businessId, comprobantesLoaded, listarComprobantes])


  // ── Handlers ──
  const handleCaja = async () => {
    if (cajaStatus === 'open' && cajaId) {
      if (!confirm('¿Cerrar la caja del día?')) return
      setCajaLoading(true)
      await supabase.from('cash_registers').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', cajaId)
      await loadCajaStatus()
      setCajaLoading(false)
    } else {
      navigate('/caja')
    }
  }

  // ── Datos derivados ──
  const activeOrders = stats
    ? stats.totalOrders - (stats.ordersByStatus.completed || 0) - (stats.ordersByStatus.cancelled || 0)
    : 0

  const recentOrders = stats?.recentOrders ?? []

  // ── Error state ──
  if (statsError) return (
    <div className="page-shell">
      <AppErrorState message={statsError} onRetry={refreshStats} />
    </div>
  )

  const hasNoData = stats && stats.totalOrders === 0 && stats.totalCustomers === 0

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="page-shell">
      {/* ── 1. Page Header ─────────────────────────────────────────────────── */}
      <AppPageHeader
        icon={<DashboardIcon size={20} />}
        title="Inicio"
        description="Resumen general del sistema y actividad reciente"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <AppButton variant="primary" size="sm" leftIcon={<NewOrderIcon size={15} />}
              onClick={() => navigate('/orders/new')}>
              Nueva Orden
            </AppButton>
            <AppButton variant="indigo" size="sm" leftIcon={<InvoiceIcon size={15} />}
              onClick={() => navigate('/comprobantes', { state: { openNew: true } })}>
              Nuevo Comprobante
            </AppButton>
            <AppButton
              variant={cajaStatus === 'open' ? 'danger' : 'secondary'}
              size="sm"
              leftIcon={cajaStatus === 'open' ? <LockIcon size={15} /> : <FinanceIcon size={15} />}
              onClick={handleCaja}
              loading={cajaLoading}
            >
              {cajaStatus === 'open' ? 'Cerrar Caja' : 'Abrir Caja'}
            </AppButton>
            <AppButton variant="ghost" size="sm" leftIcon={<ExpenseReceiptIcon size={15} />}
              onClick={() => navigate('/expenses')}>
              Gasto
            </AppButton>
            <AppIconButton icon={<RefreshIcon size={14} />} label="Actualizar datos"
              onClick={refreshStats} size="sm" />
          </div>
        }
      />

      {/* ── 2. Mis Tareas ─────────────────────────────────────────────────── */}
      <DashboardTasks />


      {/* ── 4. Métricas ───────────────────────────────────────────────────── */}
      {statsLoading && !stats ? (
        <AppLoadingState rows={4} type="cards" />
      ) : hasNoData ? (
        /* Bienvenida primer uso */
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <AppEmptyState
            icon={<OrderIcon size={28} />}
            title="¡Bienvenido a TechRepair Pro!"
            description="Todo listo para arrancar. Creá una orden, registrá un cobro o cargá tu inventario."
            action={{ label: 'Crear primera orden', icon: <NewOrderIcon size={15} />, onClick: () => navigate('/orders/new'), variant: 'primary' }}
          />
        </div>
      ) : (
        <div className="stats-grid" style={{ marginBottom: '1.5rem' }}>

          {/* Órdenes activas */}
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="stat-card-label">Órdenes Activas</div>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--accent-primary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)' }}>
                <OrderIcon size={18} />
              </div>
            </div>
            <div className="stat-card-value" style={{ color: 'var(--accent-primary)' }}>{activeOrders}</div>
            {stats && <div style={{ fontSize: '0.78rem', color: 'var(--success)' }}>+{stats.newOrdersToday} nuevas hoy</div>}
          </div>

          {/* Clientes */}
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="stat-card-label">Clientes Totales</div>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--accent-secondary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-secondary)' }}>
                <ClientsIcon size={18} />
              </div>
            </div>
            <div className="stat-card-value" style={{ color: 'var(--accent-secondary)' }}>{stats?.totalCustomers ?? '—'}</div>
            {stats && <div style={{ fontSize: '0.78rem', color: 'var(--text-subtle)' }}>+{stats.newCustomersThisMonth} este mes</div>}
          </div>

          {/* Ganancia hoy */}
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="stat-card-label">Ganancia Real Hoy</div>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--success-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--success)' }}>
                <RevenueIcon size={18} />
              </div>
            </div>
            <div className="stat-card-value" style={{ color: 'var(--success)' }}>
              {stats ? fmtARS(stats.realProfitToday) : '—'}
            </div>
            {stats && <div style={{ fontSize: '0.78rem', color: 'var(--text-subtle)' }}>{stats.averageMarginPct.toFixed(1)}% margen</div>}
          </div>

          {/* Dólar Blue */}
          <DollarRateBadge variant="full" autoRefresh={false} />
        </div>
      )}

      {/* ── 5. Rentabilidad del mes ─────────────────────────────────────────── */}
      {stats && stats.topProfitableItems.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          {[
            { label: 'Ganancia real del mes', value: fmtARS(stats.realProfitThisMonth), color: 'var(--success)' },
            { label: 'Margen promedio', value: `${stats.averageMarginPct.toFixed(1)}%`, color: 'var(--accent-primary)' },
            { label: 'Ganancia por orden', value: fmtARS(stats.profitPerOperation), color: 'var(--warning)' },
          ].map(m => (
            <div key={m.label} className="stat-card">
              <div className="stat-card-label">{m.label}</div>
              <div className="stat-card-value" style={{ color: m.color }}>{m.value}</div>
            </div>
          ))}

          {/* Top rentables */}
          <div className="card" style={{ padding: '1.125rem 1.25rem' }}>
            <div className="stat-card-label" style={{ marginBottom: '0.75rem' }}>Top trabajos rentables</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {stats.topProfitableItems.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: 'var(--radius-full)', fontSize: '0.65rem', fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    background: i === 0 ? 'var(--warning-subtle)' : 'var(--bg-surface)',
                    color: i === 0 ? 'var(--warning)' : 'var(--text-subtle)',
                  }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--success)', fontWeight: 600 }}>
                    +{fmtARS(item.profit)}
                  </span>
                  <span className="badge badge-primary badge-no-dot" style={{ fontSize: '0.6rem' }}>
                    {item.margin.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 6. Accesos rápidos ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }}>
        <AppSectionHeader title="Accesos rápidos" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.875rem' }}>
          {([
            { label: 'Nueva Orden',    icon: <NewOrderIcon size={22} />,     color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/orders/new') },
            { label: 'Nuevo Comprobante', icon: <InvoiceIcon size={22} />, color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/comprobantes', { state: { openNew: true } }) },
            { label: 'Nuevo Cliente',  icon: <NewClientIcon size={22} />,    color: 'var(--accent-secondary)',bg: 'var(--accent-secondary-subtle)',onClick: () => navigate('/customers/new') },
            { label: 'Nuevo Producto', icon: <CurrencyIcon size={22} />,     color: 'var(--info)',           bg: 'var(--info-subtle)',            onClick: () => navigate('/inventory') },
            { label: 'Nueva Garantía', icon: <WarrantyIcon size={22} />,     color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/warranties') },
            { label: 'Registrar Gasto',icon: <ExpenseReceiptIcon size={22} />,color: 'var(--error)',         bg: 'var(--error-subtle)',           onClick: () => navigate('/expenses') },
          ]).map(action => (
            <button
              key={action.label}
              className="card card-interactive"
              onClick={action.onClick}
              style={{ padding: '1.25rem 0.75rem', textAlign: 'center', width: '100%', border: 'none', cursor: 'pointer', background: 'var(--bg-card-solid)' }}
            >
              <div style={{
                width: 44, height: 44, borderRadius: 'var(--radius-lg)',
                background: action.bg, display: 'flex', alignItems: 'center',
                justifyContent: 'center', margin: '0 auto 0.75rem',
                color: action.color,
              }}>
                {action.icon}
              </div>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {action.label}
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ── 7. Actividad reciente ───────────────────────────────────────────── */}
      <section>
        <div style={{ marginBottom: '1rem' }}>
          <AppTabs
            activeTab={activeTab}
            onChange={setActiveTab}
            tabs={[
              { key: 'orders',        label: 'Órdenes',           icon: <OrderIcon size={14} /> },
              { key: 'comprobantes',  label: 'Comprobantes',      icon: <ExpenseReceiptIcon size={14} /> },
              { key: 'movimientos',   label: 'Movimientos Caja',  icon: <FinanceIcon size={14} /> },
            ]}
          />
        </div>

        <div className="card" style={{ overflow: 'hidden', padding: 0 }}>

          {/* Header de sección */}
          <div className="card-header">
            <h3 className="card-title">
              {activeTab === 'orders' && 'Órdenes Recientes'}
              {activeTab === 'comprobantes' && 'Comprobantes Recientes'}
              {activeTab === 'movimientos' && 'Movimientos de Caja'}
            </h3>
            <Link
              to={activeTab === 'orders' ? '/orders' : activeTab === 'comprobantes' ? '/comprobantes' : '/caja'}
              className="btn btn-secondary btn-sm"
              style={{ textDecoration: 'none' }}
            >
              Ver todos
            </Link>
          </div>

          {/* Tab: Órdenes */}
          {activeTab === 'orders' && (
            recentOrders.length === 0
              ? <AppEmptyState icon={<OrderIcon size={24} />} title="No hay órdenes registradas" compact
                  action={{ label: 'Nueva orden', icon: <NewOrderIcon size={14} />, onClick: () => navigate('/orders/new') }} />
              : (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Orden</th>
                      <th>Cliente</th>
                      <th className="hide-mobile">Dispositivo</th>
                      <th>Estado</th>
                      <th className="hide-mobile">Fecha</th>
                      <th style={{ textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map(order => (
                      <tr key={order.id} onClick={() => navigate(`/orders/${order.id}`)}>
                        <td>
                          <span style={{ color: 'var(--accent-primary)', fontWeight: 700, fontSize: '0.875rem' }}>
                            #{order.id.slice(0, 8).toUpperCase()}
                          </span>
                        </td>
                        <td style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{order.customer_name || '—'}</td>
                        <td className="hide-mobile" style={{ color: 'var(--text-secondary)' }}>{order.device_label || '—'}</td>
                        <td><AppStatusBadge status={order.status} type="order" /></td>
                        <td className="hide-mobile" style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
                          {fmtDate(order.created_at)}
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          <TableActions>
                            <AppIconButton icon={<ViewIcon size={13} />} label="Ver orden" size="xs"
                              onClick={() => navigate(`/orders/${order.id}`)} />
                          </TableActions>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          )}

          {/* Tab: Comprobantes */}
          {activeTab === 'comprobantes' && (
            comprobantes.length === 0
              ? <AppEmptyState icon={<ExpenseReceiptIcon size={24} />} title="No hay comprobantes registrados" compact
                  action={{ label: 'Nuevo comprobante', icon: <InvoiceIcon size={14} />, onClick: () => navigate('/comprobantes', { state: { openNew: true } }) }} />
              : (
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th className="hide-mobile">Cliente</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th>Estado</th>
                      <th className="hide-mobile">Fecha</th>
                      <th style={{ textAlign: 'right' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {comprobantes.slice(0, 8).map(comp => (
                      <tr key={comp.id} onClick={() => navigate(`/comprobantes/${comp.id}`)}>
                        <td>
                          <span className="tipo-chip">
                            {TIPO_LABELS[comp.tipo || ''] || (comp.tipo?.replace(/_/g, ' ') || '—')}
                          </span>
                        </td>
                        <td className="hide-mobile" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                          {(comp as any).customer?.name || 'Consumidor Final'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9375rem' }}>
                          {fmtARS(comp.total || 0)}
                        </td>
                        <td><AppStatusBadge status={comp.estado || ''} type="comprobante" /></td>
                        <td className="hide-mobile" style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
                          {fmtDate(comp.created_at)}
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          <TableActions>
                            <AppIconButton icon={<ViewIcon size={13} />} label="Ver comprobante" size="xs"
                              onClick={() => navigate(`/comprobantes/${comp.id}`)} />
                            <AppIconButton icon={<PrintIcon size={13} />} label="Imprimir" size="xs"
                              onClick={() => window.open(`/comprobantes/${comp.id}?print=1`, '_blank')} />
                          </TableActions>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          )}

          {/* Tab: Movimientos de caja */}
          {activeTab === 'movimientos' && (
            movimientosLoading
              ? <AppLoadingState rows={4} />
              : movimientosCaja.length === 0
                ? <AppEmptyState
                    icon={<FinanceIcon size={24} />}
                    title={cajaStatus === 'open' ? 'Sin movimientos registrados' : 'La caja está cerrada'}
                    description={cajaStatus !== 'open' ? 'Abrí la caja para registrar movimientos del día.' : undefined}
                    compact
                  />
                : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tipo</th>
                        <th>Descripción</th>
                        <th style={{ textAlign: 'right' }}>Monto</th>
                        <th className="hide-mobile">Hora</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movimientosCaja.map(mov => {
                        const isIn = mov.type === 'income' || mov.type === 'in'
                        return (
                          <tr key={mov.id}>
                            <td>
                              <span className={`badge badge-no-dot ${isIn ? 'badge-success' : 'badge-error'}`}>
                                {isIn ? 'Ingreso' : 'Egreso'}
                              </span>
                            </td>
                            <td style={{ color: 'var(--text-secondary)' }}>{mov.description || '—'}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: isIn ? 'var(--success)' : 'var(--error)', fontSize: '0.9375rem' }}>
                              {isIn ? '+' : '-'}{fmtARS(Math.abs(mov.amount_ars || mov.amount || 0))}
                            </td>
                            <td className="hide-mobile" style={{ color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
                              {new Date(mov.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )
          )}
        </div>
      </section>
    </div>
  )
}
