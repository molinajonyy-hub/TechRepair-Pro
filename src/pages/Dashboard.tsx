/**
 * Inicio — el centro operativo del taller (BETA-UX-1F).
 *
 *   DASHBOARD = operación.   FINANZAS = dinero.
 *
 * Inicio responde «¿qué está pasando en mi taller?»: qué órdenes están activas,
 * cuáles esperan algo, qué tareas necesitan atención y qué entró último. NO
 * muestra un solo importe del negocio —ni ganancia, ni cobrado, ni caja neta, ni
 * deuda—, y eso vale para todos los actores, incluido el dueño: no es un gate
 * por capacidad, es que acá no hay dinero. Para verlo están Finanzas y Caja.
 *
 * Y no sólo no lo muestra: no lo PIDE. Esta pantalla lee `orders` (vía
 * `useOperationalDashboardStats`) y las tareas del usuario (vía `taskService`).
 * No importa hooks financieros, ni comprobantes, ni movimientos de caja.
 *
 * El estado de la caja y la cotización del dólar viven en la barra superior
 * (`TopHeader`; en mobile, la fila de utilidades del shell). Los accesos rápidos
 * ya no existen: duplicaban la navegación. Las acciones están en el encabezado.
 */
import { useState, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useOperationalDashboardStats, type RecentOrder } from '../hooks/useOperationalDashboardStats'
import { refreshSharedDollarRate } from '../hooks/useDollarRate'
import { useCaja } from '../contexts/CajaContext'
import { usePermissions } from '../hooks/usePermissions'
import { DashboardTasks } from '../components/tasks/DashboardTasks'
import { FirstStepsChecklist } from '../components/onboarding/FirstStepsChecklist'
import { STATUS_CONFIG, type OrderStatus } from '../types/orderStatus'
import { fmtDateCompact } from '../utils/dateUtils'
import {
  AppButton, AppIconButton, AppPageHeader,
  AppErrorState, CompactList,
  type CompactListItem,
} from '../ui'
import {
  NewOrderIcon, InvoiceIcon, FinanceIcon, ExpenseReceiptIcon,
  RefreshIcon, DashboardIcon, OrderIcon, SuccessIcon, PendingIcon, ForwardIcon,
} from '../ui/icons'

const shortOrderId = (id: string) => id.slice(0, 8).toUpperCase()

// ─── Estado de la orden ───────────────────────────────────────────────────────

/**
 * Etiqueta canónica del estado (`types/orderStatus.ts`). El texto lleva el
 * estado; el punto de color sólo acompaña, así que se lee igual en claro y en
 * oscuro. Un estado que el catálogo no conoce se muestra tal cual, sin inventar
 * una etiqueta.
 */
function OrderStatusPill({ status }: { status: string }) {
  const config = Object.prototype.hasOwnProperty.call(STATUS_CONFIG, status)
    ? STATUS_CONFIG[status as OrderStatus]
    : null
  return (
    <span className="dash-status">
      <span
        className="dash-status__dot"
        aria-hidden="true"
        style={config ? { background: config.color } : undefined}
      />
      {config?.label ?? status}
    </span>
  )
}

// ─── Hoy ──────────────────────────────────────────────────────────────────────

interface TodayIndicator {
  key: 'active' | 'ready' | 'waiting'
  label: string
  value: number
  hint?: string
  icon: React.ReactNode
}

/**
 * Tres indicadores operativos, sin importes. Los tres llevan a Órdenes: hoy esa
 * pantalla no recibe un filtro por navegación (el filtro de estado es estado
 * local), y no se inventa uno en este lote.
 */
function TodayStrip({ indicators }: { indicators: TodayIndicator[] }) {
  return (
    <section className="dash-today" data-testid="dashboard-today" aria-label="Hoy en el taller">
      {indicators.map(indicator => (
        <Link
          key={indicator.key}
          to="/orders"
          className="dash-today__item"
          data-testid={`dashboard-today-${indicator.key}`}
          aria-label={`${indicator.label}: ${indicator.value}. Ver órdenes`}
        >
          <span className={`dash-today__icon dash-today__icon--${indicator.key}`} aria-hidden="true">
            {indicator.icon}
          </span>
          <span className="dash-today__copy">
            <span className="dash-today__value">{indicator.value}</span>
            <span className="dash-today__label">{indicator.label}</span>
            {indicator.hint && <span className="dash-today__hint">{indicator.hint}</span>}
          </span>
        </Link>
      ))}
    </section>
  )
}

function TodaySkeleton() {
  return (
    <div className="dash-today" data-testid="dashboard-today-loading" aria-hidden="true">
      {[0, 1, 2].map(i => (
        <div key={i} className="dash-today__item">
          <div className="skeleton" style={{ width: 64, height: 28 }} />
          <div className="skeleton skeleton-text" style={{ width: '70%' }} />
        </div>
      ))}
    </div>
  )
}

// ─── Órdenes recientes ────────────────────────────────────────────────────────

function RecentOrders({ orders, loading }: { orders: RecentOrder[]; loading: boolean }) {
  const navigate = useNavigate()
  const open = (id: string) => navigate(`/orders/${id}`)

  // La fila entera abre la orden. El número además es un enlace real, para que
  // el teclado tenga dónde pararse; si el clic vino de ahí, el enlace ya navegó.
  const openFromRow = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((event.target as HTMLElement).closest('a')) return
    open(id)
  }

  // Mobile: la misma lista como tarjetas. Es otra presentación del mismo dato
  // —el CSS elige cuál se ve—, no otra consulta.
  const mobileItems: CompactListItem[] = orders.map(order => ({
    id: order.id,
    testId: 'dashboard-recent-order-card',
    accessibleLabel: `Abrir la orden #${shortOrderId(order.id)}${order.customer_name ? ` de ${order.customer_name}` : ''}`,
    onSelect: () => open(order.id),
    primary: <span className="dash-order-card__id">#{shortOrderId(order.id)}</span>,
    secondary: order.customer_name || 'Sin cliente',
    metadata: (
      <span className="dash-order-card__meta">
        <span>{order.device_label || 'Sin dispositivo'}</span>
        <span>{fmtDateCompact(order.created_at)}</span>
      </span>
    ),
    status: <OrderStatusPill status={order.status} />,
  }))

  return (
    <section className="card dash-orders" data-testid="dashboard-recent-orders" aria-labelledby="dash-orders-title">
      <div className="card-header">
        <h2 className="card-title" id="dash-orders-title">Órdenes recientes</h2>
        <Link to="/orders" className="btn btn-secondary btn-sm dash-link" aria-label="Ver todas las órdenes">
          Ver todas <ForwardIcon size={14} aria-hidden="true" />
        </Link>
      </div>

      {loading ? (
        <div className="dash-orders__loading" data-testid="dashboard-recent-orders-loading" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="skeleton skeleton-text" style={{ height: 18 }} />)}
        </div>
      ) : orders.length === 0 ? (
        <div className="dash-empty" data-testid="dashboard-recent-orders-empty">
          <span className="dash-empty__icon" aria-hidden="true"><OrderIcon size={22} /></span>
          <p className="dash-empty__title">Todavía no hay órdenes</p>
          <p className="dash-empty__copy">Cuando recibas un equipo, lo vas a ver acá.</p>
        </div>
      ) : (
        <>
          <div className="dash-orders__desktop" data-testid="dashboard-recent-orders-table">
            <table className="table table-clickable">
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
                {orders.map(order => (
                  <tr
                    key={order.id}
                    data-testid="dashboard-recent-order-row"
                    onClick={event => openFromRow(event, order.id)}
                  >
                    <td>
                      <Link to={`/orders/${order.id}`} className="dash-orders__id">
                        #{shortOrderId(order.id)}
                      </Link>
                    </td>
                    <td className="dash-orders__customer">{order.customer_name || 'Sin cliente'}</td>
                    <td className="dash-orders__muted">{order.device_label || 'Sin dispositivo'}</td>
                    <td><OrderStatusPill status={order.status} /></td>
                    <td className="dash-orders__muted">{fmtDateCompact(order.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dash-orders__mobile" data-testid="dashboard-recent-orders-list">
            <CompactList items={mobileItems} label="Órdenes recientes" />
          </div>
        </>
      )}
    </section>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function Dashboard() {
  const navigate = useNavigate()
  const { can } = usePermissions()
  const { canUseCaja, refresh: refreshCaja } = useCaja()
  const { stats, loading, error, refresh: refreshStats } = useOperationalDashboardStats()
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0)

  /**
   * El encabezado no ofrece lo que el actor no puede hacer (PRE-BETA-3A-0). Cada
   * acción usa la capacidad CANÓNICA de su destino, nunca el nombre del rol:
   *
   *   Nueva Orden        `orders_create`  — la que exige la recepción y su RPC
   *   Nuevo Comprobante  `comprobantes`   — la que gatea `/comprobantes`
   *   Gestionar Caja     `canUseCaja`     — `finance`, la que gatea `/caja`
   *   Registrar gasto    `finance`        — la que gatea `/expenses`
   */
  const puedeCrearOrden = can('orders_create')
  const puedeEmitirComprobante = can('comprobantes')
  const puedeRegistrarGasto = can('finance')

  const accionesSecundarias =
    Number(puedeEmitirComprobante) + Number(canUseCaja) + Number(puedeRegistrarGasto)

  /**
   * «Actualizar» refresca lo que Inicio muestra y nada más: órdenes, tareas, el
   * estado de la caja y la cotización de la barra superior. Ninguna de esas
   * lecturas es financiera, y no hay recarga del navegador.
   */
  const handleRefresh = () => {
    refreshStats()
    setTasksRefreshKey(key => key + 1)
    void refreshCaja()
    void refreshSharedDollarRate()
  }

  const indicators: TodayIndicator[] = stats ? [
    {
      key: 'active',
      label: 'Órdenes activas',
      value: stats.activeOrders,
      hint: stats.newOrdersToday > 0
        ? `+${stats.newOrdersToday} ${stats.newOrdersToday === 1 ? 'nueva hoy' : 'nuevas hoy'}`
        : undefined,
      icon: <OrderIcon size={18} />,
    },
    {
      key: 'ready',
      label: 'Listas para entregar',
      value: stats.readyForDelivery,
      icon: <SuccessIcon size={18} />,
    },
    {
      key: 'waiting',
      label: 'Esperando aprobación',
      value: stats.waitingApproval,
      icon: <PendingIcon size={18} />,
    },
  ] : []

  return (
    <div className="page-shell dash-page" data-testid="dashboard-page">
      {/* ── 1. Encabezado: las acciones del día ──────────────────────────────── */}
      <AppPageHeader
        icon={<DashboardIcon size={20} />}
        title="Inicio"
        description="Tu taller hoy"
        actionsClassName="dash-actions-slot"
        actions={
          <div className="dash-actions" data-testid="dashboard-actions" data-secondary={accionesSecundarias}>
            {puedeCrearOrden && (
              <AppButton
                variant="primary"
                className="btn-primary-aa dash-action dash-action--primary"
                leftIcon={<NewOrderIcon size={17} />}
                onClick={() => navigate('/orders/new')}
              >
                Nueva Orden
              </AppButton>
            )}
            {puedeEmitirComprobante && (
              <AppButton
                variant="indigo"
                size="sm"
                className="btn-indigo-aa dash-action dash-action--secondary"
                leftIcon={<InvoiceIcon size={15} />}
                onClick={() => navigate('/comprobantes', { state: { openNew: true } })}
              >
                Nuevo Comprobante
              </AppButton>
            )}
            {canUseCaja && (
              <AppButton
                variant="secondary"
                size="sm"
                className="dash-action dash-action--secondary"
                leftIcon={<FinanceIcon size={15} />}
                onClick={() => navigate('/caja')}
              >
                Gestionar Caja
              </AppButton>
            )}
            {puedeRegistrarGasto && (
              <AppButton
                variant="danger"
                size="sm"
                className="btn-danger-aa dash-action dash-action--secondary"
                leftIcon={<ExpenseReceiptIcon size={15} />}
                onClick={() => navigate('/expenses')}
              >
                Registrar gasto
              </AppButton>
            )}
            <AppIconButton
              icon={<RefreshIcon size={15} />}
              label="Actualizar datos"
              className="dash-action dash-action--refresh"
              onClick={handleRefresh}
              loading={loading && stats !== null}
            />
          </div>
        }
      />

      {/* ── 2. Primeros pasos: la ÚNICA guía ─────────────────────────────────────
          Se dibuja sólo mientras haya pasos pendientes que este actor pueda
          hacer; completa o descartada no deja hueco. Reemplaza a la bienvenida
          que Inicio mostraba además de ésta. */}
      <FirstStepsChecklist />

      {/* ── 3. Hoy ──────────────────────────────────────────────────────────── */}
      {error
        ? <AppErrorState message={error} onRetry={refreshStats} />
        : stats
          ? <TodayStrip indicators={indicators} />
          : <TodaySkeleton />}

      {/* ── 4. Mis tareas: protagonista, a todo el ancho ─────────────────────── */}
      <DashboardTasks refreshKey={tasksRefreshKey} />

      {/* ── 5. Órdenes recientes ─────────────────────────────────────────────── */}
      {!error && <RecentOrders orders={stats?.recentOrders ?? []} loading={!stats} />}
    </div>
  )
}
