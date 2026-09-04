import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDashboardStats } from '../hooks/useDashboardStats'
import { useFinancialDashboard } from '../hooks/useFinancialDashboard'
import { useComprobantes } from '../hooks/useComprobantes'
import { refreshDollarRate, refreshInventoryDollarPrices, type DollarRateResult } from '../services/dollarRateService'
import { useCaja } from '../contexts/CajaContext'
import { DollarRateBadge } from '../components/ui/DollarRateBadge'
import { DashboardTasks } from '../components/tasks/DashboardTasks'
import { FirstStepsChecklist } from '../components/onboarding/FirstStepsChecklist'
import { useAuth } from '../contexts/AuthContext'
import { usePermissions } from '../hooks/usePermissions'
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

import { fmtDateCompact as fmtDate } from '../utils/dateUtils'
import { COST_RESTRICTED_LABEL } from '../services/inventoryCostAccess'

// ─── Componente principal ─────────────────────────────────────────────────────

export function Dashboard() {
  const [activeTab, setActiveTab] = useState('orders')
  const [, setDolarResult]   = useState<DollarRateResult | null>(null)
  const [, setDolarLoading]  = useState(false)
  const [movimientosCaja, setMovimientosCaja] = useState<any[]>([])
  const [movimientosLoading, setMovimientosLoading] = useState(false)
  const [comprobantesLoaded, setComprobantesLoaded] = useState(false)

  const { isOpen: cajaIsOpen, cajaId, loading: cajaLoading, activeCaja: cajaActiva, canUseCaja } = useCaja()
  const cajaStatus = cajaIsOpen ? 'open' : 'closed'

  const { businessId } = useAuth()
  const { can } = usePermissions()

  /**
   * P0-P6 — Capacidad financiera del actor.
   *
   * Gobierna las tarjetas de Ganancia Real, Cobrado en Caja y Caja Neta, el
   * acceso a Finanzas y el atajo de Registrar Gasto. Un técnico no la tiene.
   *
   * Y no sólo esconde: también decide si la consulta SE HACE. Traer la ganancia
   * para después ocultar la tarjeta dejaría el dato en la respuesta HTTP, a la
   * vista en la pestaña Network. La RLS ya lo rechazaría server-side, pero
   * pedirlo igual sería ruido y una request condenada a fallar.
   */
  const puedeVerFinanzas = can('finance')

  const { stats, loading: statsLoading, error: statsError, refresh: refreshStats } = useDashboardStats()
  const { data: finData, loading: finLoading, cajaError: finCajaError } =
    useFinancialDashboard(puedeVerFinanzas ? businessId : null, puedeVerFinanzas ? cajaId : null)
  const { comprobantes, listarComprobantes } = useComprobantes()
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


  // ── Movimientos de caja activa ──
  // P0-P6: sin capacidad financiera NO se consulta. La RLS ya lo devolvería
  // vacío, pero la request no tiene por qué existir.
  useEffect(() => {
    if (!businessId || !cajaId || !puedeVerFinanzas) { setMovimientosCaja([]); return }
    setMovimientosLoading(true)
    void supabase.from('financial_movements').select('*')
      .eq('business_id', businessId)
      .eq('caja_id', cajaId)
      .order('created_at', { ascending: false })
      .limit(10)
      .then(
        ({ data }) => { setMovimientosCaja(data || []); setMovimientosLoading(false) },
        ()         => { setMovimientosLoading(false) }
      )
  }, [businessId, cajaId, puedeVerFinanzas])

  // ── Comprobantes lazy ──
  useEffect(() => {
    if (activeTab === 'comprobantes' && businessId && !comprobantesLoaded) {
      listarComprobantes(); setComprobantesLoaded(true)
    }
  }, [activeTab, businessId, comprobantesLoaded, listarComprobantes])


  // ── Handlers ──
  const handleCaja = () => { navigate('/caja') }

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
    <div className="page-shell" data-testid="dashboard-page">
      <FirstStepsChecklist />
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
            {/* P0-P6: los CTA de caja y gasto llevan a rutas que exigen
                `finance`. Mostrarlos a quien no la tiene sólo produce un rebote
                que el usuario no entiende. */}
            {canUseCaja && (
              <AppButton
                variant={cajaIsOpen ? 'secondary' : 'primary'}
                size="sm"
                leftIcon={cajaIsOpen ? <LockIcon size={15} /> : <FinanceIcon size={15} />}
                onClick={handleCaja}
                loading={cajaLoading}
              >
                {cajaIsOpen ? 'Gestionar Caja' : 'Abrir Caja'}
              </AppButton>
            )}
            {puedeVerFinanzas && (
              <AppButton variant="ghost" size="sm" leftIcon={<ExpenseReceiptIcon size={15} />}
                onClick={() => navigate('/expenses')}>
                Gasto
              </AppButton>
            )}
            <AppIconButton icon={<RefreshIcon size={14} />} label="Actualizar datos"
              onClick={refreshStats} size="sm" />
          </div>
        }
      />

      {/* ── 2. Mis Tareas ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '1.5rem' }}>
        <DashboardTasks />
      </div>


      {/* ── 3. Estado de Caja ───────────────────────────────────────────────
          P0-P6: el estado abierta/cerrada es información operativa de caja.
          Un actor sin `finance` no la ve, y tampoco el atajo "Gestionar →". */}
      {canUseCaja && (
      <div
        data-testid="dash-estado-caja"
        onClick={handleCaja}
        style={{
          display: 'flex', alignItems: 'center', gap: '1rem',
          padding: '0.875rem 1.25rem', marginBottom: '1.25rem', cursor: 'pointer',
          background: cajaIsOpen ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)',
          border: `1px solid ${cajaIsOpen ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
          borderRadius: 'var(--radius-lg)',
        }}
      >
        <div style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: cajaIsOpen ? '#34d399' : '#f87171',
          boxShadow: cajaIsOpen ? '0 0 6px #34d399' : '0 0 6px #f87171',
        }} />
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: '0.875rem', color: cajaIsOpen ? '#34d399' : '#f87171' }}>
            Caja {cajaIsOpen ? 'abierta' : 'cerrada'}
          </span>
          {cajaIsOpen && cajaActiva && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', marginLeft: '0.75rem' }}>
              Desde las {new Date(cajaActiva.opened_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {!cajaIsOpen && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-subtle)', marginLeft: '0.75rem' }}>
              Abrí caja para registrar ventas y gastos
            </span>
          )}
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>
          {cajaIsOpen ? 'Gestionar →' : 'Abrir →'}
        </span>
      </div>
      )}

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
        <div className="stats-grid" style={{ marginBottom: '1.5rem' }} data-testid="dashboard-kpis">

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

          {/* Ganancia hoy — P0-P6: sólo con capacidad financiera. */}
          {puedeVerFinanzas && (
          <div className="stat-card" data-testid="dash-ganancia-real">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="stat-card-label">Ganancia Real Hoy</div>
              <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--success-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--success)' }}>
                <RevenueIcon size={18} />
              </div>
            </div>
            {/* SEC-08B: sin autoridad de COGS el importe llega en null. Se dice
                que está restringido — mostrar $0 sería afirmar que hoy no hubo
                ganancia, que es falso y además indistinguible de una pérdida. */}
            <div className="stat-card-value" style={{ color: stats?.realProfitToday == null ? 'var(--text-subtle)' : 'var(--success)', fontSize: stats && stats.realProfitToday == null ? '1.1rem' : undefined }}>
              {!stats ? '—' : stats.realProfitToday == null ? COST_RESTRICTED_LABEL : fmtARS(stats.realProfitToday)}
            </div>
            {stats && stats.averageMarginPct != null && <div style={{ fontSize: '0.78rem', color: 'var(--text-subtle)' }}>{stats.averageMarginPct.toFixed(1)}% margen</div>}
          </div>
          )}

          {/* Dólar Blue */}
          <DollarRateBadge variant="full" autoRefresh={false} />
        </div>
      )}

      {/* ── 5. Snapshot financiero del día ──────────────────────────────────────
          P0-P6: bloque completo detrás de la capacidad `finance`. Con el gate en
          false los datos ni siquiera se piden (ver `puedeVerFinanzas` arriba),
          así que `finData` es null y `finLoading` false: la condición de abajo
          no se cumple igual. El chequeo explícito está para que la intención sea
          legible y para que quitarlo rompa un test. */}
      {puedeVerFinanzas && (finData || finLoading) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem', marginBottom: '1.5rem' }}>
          {/* Si la consulta de caja falla NO se muestra $0: un cero creíble es
              peor que un "no disponible" honesto. El resto del Dashboard sigue. */}
          <div className="stat-card">
            <div className="stat-card-label">Cobrado en caja</div>
            <div
              className="stat-card-value"
              style={{ color: finCajaError ? 'var(--text-subtle)' : 'var(--success)' }}
              title={finCajaError ? finCajaError.message : undefined}
            >
              {finLoading && !finData ? '…' : finCajaError ? 'No disponible' : fmtARS(finData?.ventasHoy ?? 0)}
            </div>
            <div style={{ fontSize: '0.75rem', color: finCajaError ? 'var(--error)' : 'var(--text-subtle)', marginTop: '0.125rem' }}>
              {finLoading ? '' : finCajaError ? '⚠ No se pudo cargar' : (finData?.cajaAbierta ? 'Caja abierta actual' : 'Caja cerrada')}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Caja neta</div>
            <div
              className="stat-card-value"
              style={{ color: finCajaError ? 'var(--text-subtle)' : (finData?.caja ? finData.caja.net : 0) >= 0 ? 'var(--success)' : 'var(--error)' }}
              title={finCajaError ? finCajaError.message : undefined}
            >
              {finLoading && !finData ? '…' : finCajaError ? 'No disponible' : fmtARS(finData?.caja ? finData.caja.net : 0)}
            </div>
            <div style={{ fontSize: '0.75rem', color: finCajaError ? 'var(--error)' : 'var(--text-subtle)', marginTop: '0.125rem' }}>
              {finLoading ? '' : finCajaError ? '⚠ No se pudo cargar' : (finData?.cajaAbierta ? 'Caja abierta actual' : 'Caja cerrada')}
            </div>
          </div>
          <Link to="/finance" style={{ textDecoration: 'none' }}>
            <div className="stat-card card-interactive" style={{ cursor: 'pointer' }}>
              <div className="stat-card-label">Finanzas →</div>
              <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--accent-primary)', marginTop: '0.25rem' }}>
                Ver dashboard completo
              </div>
            </div>
          </Link>
        </div>
      )}

      {/* ── 6. Accesos rápidos ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: '1.5rem' }} data-testid="dashboard-quick-actions">
        <AppSectionHeader title="Accesos rápidos" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '0.875rem' }}>
          {/* P0-P6: cada atajo declara la capacidad que necesita. Ofrecer un
              acceso directo a una pantalla que después rebota es peor que no
              ofrecerlo — el usuario no entiende por qué "no funciona". */}
          {([
            { label: 'Nueva Orden',    icon: <NewOrderIcon size={22} />,     color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/orders/new'), need: 'orders' as const },
            { label: 'Nuevo Comprobante', icon: <InvoiceIcon size={22} />, color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/comprobantes', { state: { openNew: true } }), need: 'comprobantes' as const },
            { label: 'Nuevo Cliente',  icon: <NewClientIcon size={22} />,    color: 'var(--accent-secondary)',bg: 'var(--accent-secondary-subtle)',onClick: () => navigate('/customers/new'), need: 'customers' as const },
            { label: 'Nuevo Producto', icon: <CurrencyIcon size={22} />,     color: 'var(--info)',           bg: 'var(--info-subtle)',            onClick: () => navigate('/inventory'), need: 'inventory' as const },
            { label: 'Nueva Garantía', icon: <WarrantyIcon size={22} />,     color: 'var(--accent-primary)', bg: 'var(--accent-primary-subtle)', onClick: () => navigate('/warranties'), need: 'orders' as const },
            { label: 'Registrar Gasto',icon: <ExpenseReceiptIcon size={22} />,color: 'var(--error)',         bg: 'var(--error-subtle)',           onClick: () => navigate('/expenses'), need: 'finance' as const },
          ]).filter(action => can(action.need)).map(action => (
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
            /* P0-P6: las pestañas se filtran por capacidad. `Movimientos Caja`
               lee movimientos financieros; `Comprobantes` exige su propia
               capacidad. Dejarlas visibles mostraría una tabla siempre vacía
               —la RLS ya las rechaza— que parece un bug del producto. */
            tabs={[
              { key: 'orders',        label: 'Órdenes',           icon: <OrderIcon size={14} /> },
              ...(can('comprobantes')
                ? [{ key: 'comprobantes', label: 'Comprobantes', icon: <ExpenseReceiptIcon size={14} /> }]
                : []),
              ...(canUseCaja
                ? [{ key: 'movimientos', label: 'Movimientos Caja', icon: <FinanceIcon size={14} /> }]
                : []),
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
          {activeTab === 'comprobantes' && can('comprobantes') && (
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
          {/* La pestaña ya no se renderiza sin capacidad, así que `activeTab`
              no puede llegar acá hoy. El chequeo igual va explícito: si mañana
              alguien persiste la pestaña activa, el contenido no se filtra. */}
          {activeTab === 'movimientos' && canUseCaja && (
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


