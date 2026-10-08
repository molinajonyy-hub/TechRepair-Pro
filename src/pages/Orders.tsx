import { useState, useRef, useMemo, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search, Eye, Edit, Trash2, ClipboardList, Printer, Loader2, X } from 'lucide-react'
import { OrderFinancialBadge, type OrderPaymentStatus } from '../components/orders/OrderFinancialBadge'
import { smartSearch } from '../utils/searchUtils'
import { CloseButton } from '../components/ui/CloseButton'
import { EmptyState } from '../components/ui/EmptyState'
import { useOrders, OrderListItem } from '../hooks/useOrders'
import { STATUS_CONFIG } from '../types/orderStatus'
import { ServiceOrderPrint } from '../components/print/ServiceOrderPrint'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useOrderPrintSettings } from '../hooks/useOrderPrintSettings'
import { buildOrderPrintTitle } from '../lib/printFilename'
import { CompactList, OverflowMenu, type CompactListItem } from '../ui'

const getStatusStyle = (status: string) => {
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

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja'
}


const getPriorityStyle = (priority: string) => {
  const colors: Record<string, string> = {
    urgent: '#ef4444',
    high: '#f97316',
    medium: '#eab308',
    low: '#64748b'
  }
  const color = colors[priority] || '#64748b'
  return {
    backgroundColor: `${color}20`,
    color: color,
    padding: '0.25rem 0.75rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500
  }
}

export function Orders() {
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()

  // P0-A.1U1 — El filtro FINANCIERO viaja al server (v_order_financial_status);
  // el técnico también, para que la combinación de ambos se resuelva en la DB.
  const [paymentFilter, setPaymentFilter] = useState<'' | OrderPaymentStatus>('')
  const { orders, error, financial, financialError, amountsAuthorized, refresh: refetch } =
    useOrders({ status: statusFilter, payment: paymentFilter })
  const navigate = useNavigate()
  const [printingOrder, setPrintingOrder] = useState<any>(null)
  const printRef = useRef<HTMLDivElement>(null)

  // Load business print settings once at page level so ServiceOrderPrint
  // always receives them synchronously (no per-render async race condition).
  const { businessId } = useAuth()
  const { settings: orderPrintSettings } = useOrderPrintSettings(businessId)

  // Debounce 300ms
  useEffect(() => {
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => clearTimeout(searchTimer.current)
  }, [searchTerm])

  // Filtrado inteligente
  const filteredOrders = useMemo(() => {
    let result = smartSearch(orders, debouncedSearch, [
      { getValue: o => o.id.slice(0, 8),              weight: 4 },
      { getValue: o => o.customer?.name,              weight: 3 },
      { getValue: o => (o.customer as any)?.phone,    weight: 3 },
      { getValue: o => o.device?.brand,               weight: 2 },
      { getValue: o => o.device?.model,               weight: 2 },
      { getValue: o => o.device ? `${o.device.brand} ${o.device.model}` : null, weight: 3 },
      { getValue: o => (o as any).imei,               weight: 4 },
      { getValue: o => (o as any).serial_number,      weight: 3 },
      { getValue: o => (o as any).reported_issue,     weight: 1 },
      { getValue: o => (o as any).diagnosis,          weight: 1 },
      { getValue: o => STATUS_CONFIG[o.status as keyof typeof STATUS_CONFIG]?.label, weight: 1 },
    ])
    // El estado técnico y el financiero YA vinieron filtrados por el server
    // (useOrders). Acá sólo queda la prioridad, que no es financiera.
    if (priorityFilter) result = result.filter(o => o.priority === priorityFilter)
    return result
  }, [orders, debouncedSearch, priorityFilter])

  // Delete state
  const [deletingOrder, setDeletingOrder] = useState<OrderListItem | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDeleteConfirm = async () => {
    if (!deletingOrder) return
    setDeleteLoading(true)
    setDeleteError(null)
    try {
      const { error: err } = await supabase.from('orders').delete().eq('id', deletingOrder.id)
      if (err) throw err
      setDeletingOrder(null)
      refetch()
    } catch (e: any) {
      setDeleteError(e.message || 'Error al eliminar la orden')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handlePrint = (order: any) => {
    // SEC-08A: el presupuesto impreso sale de la ruta autorizada, no de la fila
    // de la orden. Un rol sin `orders_view_financials` imprime la orden sin
    // importe propio en vez de imprimir un cero inventado.
    const montos = amountsAuthorized === true && !financialError ? financial[order.id] : undefined
    setPrintingOrder({ ...order, estimated_total: montos?.estimated_total })
    // Wait for React to render ServiceOrderPrint with the resolved settings,
    // then capture innerHTML. 500ms gives render + logo time.
    setTimeout(() => {
      if (printRef.current) {
        const printContent = printRef.current.innerHTML
        const printWindow = window.open('', '_blank', 'width=900,height=700')
        if (printWindow) {
          const bizName = orderPrintSettings.nombre_comercial || orderPrintSettings.razon_social || null
          const title = buildOrderPrintTitle(bizName, order.id)
          printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>${title}</title>
              <style>
                @page { size: A4 portrait; margin: 0; }
                html, body {
                  margin: 0 !important;
                  padding: 0 !important;
                  width: 210mm;
                  -webkit-print-color-adjust: exact;
                  print-color-adjust: exact;
                }
                * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                .sop-screen-wrapper {
                  padding: 0 !important;
                  background: none !important;
                }
                .sop-page {
                  width: 210mm !important;
                  height: 297mm !important;
                  min-height: unset !important;
                  max-height: 297mm !important;
                  overflow: hidden !important;
                  box-shadow: none !important;
                  margin: 0 !important;
                }
              </style>
            </head>
            <body>${printContent}</body>
            </html>
          `)
          printWindow.document.close()
          printWindow.focus()
          setTimeout(() => {
            printWindow.print()
            printWindow.close()
          }, 250)
        }
        setPrintingOrder(null)
      }
    }, 500)
  }

  const clearFilters = () => {
    setSearchTerm(''); setStatusFilter(''); setPaymentFilter(''); setPriorityFilter('')
  }
  /** Filtros que YA condicionan la lista (la búsqueda aplica con debounce). */
  const filtersApplied = Boolean(debouncedSearch || statusFilter || paymentFilter || priorityFilter)

  /**
   * Importes de UNA orden, tal como los entregó el servidor.
   *
   * BETA-UX-1D: la tabla de escritorio y las tarjetas de mobile son dos
   * presentaciones del mismo dato y las dos leen de acá. No hay una segunda
   * vía: sin autorización (o con el bloque financiero caído) devuelve `null`,
   * nunca un cero, y la presentación dice que está restringido.
   *
   * SEC-08A: `labor_cost` y `estimated_total` ya no viajan en la fila de la
   * orden. Llegan por la ruta autorizada (`get_order_financial_amounts`) o no
   * llegan. Fase B retiró el atajo que sumaba `order_items.precio_unitario` de
   * la fila anidada: devolvía el importe SIN pasar por la capacidad y
   * reconstruía `estimated_total` exactamente.
   */
  const orderAmounts = (orderId: string): { total: number; saldo: number } | null => {
    if (financialError || amountsAuthorized !== true) return null
    const montos = financial[orderId]
    return {
      total: montos?.labor_cost || montos?.estimated_total || 0,
      saldo: montos?.saldo_pendiente ?? 0,
    }
  }
  const formatMoney = (value: number) => `$${value.toLocaleString('es-AR')}`
  const formatOrderDate = (iso: string) =>
    new Date(iso).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })

  const askDelete = (order: OrderListItem) => { setDeleteError(null); setDeletingOrder(order) }

  // BETA-UX-1D — tarjetas de la lista mobile. Mismo `filteredOrders`, mismo mapa
  // `financial`, mismos handlers que la tabla: es otra presentación, no otra
  // consulta. Tocar la tarjeta abre el detalle; «Editar» de la tabla navega al
  // mismo lugar, así que el menú lleva sólo lo que agrega algo.
  const mobileItems: CompactListItem[] = filteredOrders.map(order => {
    const shortId = order.id.slice(0, 8)
    const customerName = order.customer?.name || 'Sin cliente'
    const statusLabel = STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status
    const amounts = orderAmounts(order.id)
    // La prioridad se nombra sólo cuando cambia qué orden se atiende primero.
    const priorityLabel = order.priority === 'urgent' || order.priority === 'high'
      ? `Prioridad ${PRIORITY_LABELS[order.priority].toLowerCase()}`
      : null

    return {
      id: order.id,
      testId: 'orders-mobile-item',
      accessibleLabel: `Abrir la orden #${shortId} de ${customerName}`,
      onSelect: () => navigate(`/orders/${order.id}`),
      primary: (
        <span className="order-card__title">
          <span>{customerName}</span>
          <span className="order-card__id">#{shortId}</span>
        </span>
      ),
      secondary: order.device ? `${order.device.brand} ${order.device.model}` : 'Sin dispositivo',
      metadata: (
        <span className="order-card__meta">
          <span>{formatOrderDate(order.created_at)}</span>
          {priorityLabel && <span className="order-card__priority">· {priorityLabel}</span>}
        </span>
      ),
      status: (
        <span className="order-card__badges">
          <span className="badge" style={getStatusStyle(order.status)}>{statusLabel}</span>
          {/* Estado de COBRO: mismo badge y mismas props que la tabla. */}
          <OrderFinancialBadge
            status={financialError ? null : (financial[order.id]?.payment_status ?? null)}
            unavailable={financialError || !financial[order.id]}
            size="sm"
          />
        </span>
      ),
      amount: amounts ? (
        <>
          <span data-testid="orders-mobile-total">{formatMoney(amounts.total)}</span>
          {amounts.saldo > 0 && (
            <span className="order-card__balance" data-testid="orders-mobile-balance">Saldo {formatMoney(amounts.saldo)}</span>
          )}
        </>
      ) : !financialError && amountsAuthorized === false ? (
        <span className="list-card__restricted" data-testid="orders-mobile-amounts-restricted">Importes restringidos</span>
      ) : (
        <span className="list-card__restricted" data-testid="orders-mobile-amounts-unavailable">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Importe no disponible</span>
        </span>
      ),
      trailingAction: (
        <OverflowMenu
          label={`Acciones de la orden #${shortId}`}
          testId="orders-mobile-actions"
          actions={[
            { label: 'Imprimir', icon: <Printer size={16} aria-hidden="true" />, onSelect: () => handlePrint(order) },
            { label: 'Eliminar', icon: <Trash2 size={16} aria-hidden="true" />, destructive: true, onSelect: () => askDelete(order) },
          ]}
        />
      ),
    }
  })

  if (error) {
    return (
      <div>
        <div className="page-hdr">
          <div className="page-hdr-left">
            <div className="page-hdr-icon"><ClipboardList size={22} /></div>
            <div><h1 className="page-hdr-title">Órdenes de Trabajo</h1></div>
          </div>
        </div>
        <div className="alert-inline alert-error">{error}</div>
      </div>
    )
  }

  return (
    <div className="mobile-list-page">
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><ClipboardList size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Órdenes de Trabajo</h1>
            <p className="page-hdr-subtitle">Gestiona todas las órdenes de reparación del taller</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <Link to="/orders/new" data-testid="orders-new-button" className="btn btn-primary btn-sm btn-lift" style={{ textDecoration: 'none' }}>
            <Plus size={16} />
            Nueva Orden
          </Link>
        </div>
      </div>

      {/* BETA-UX-1D: los anchos mínimos de la barra pasaron a clases para que
          mobile pueda acomodarla (búsqueda de lado a lado, filtros de a dos). */}
      <div className="filter-bar list-filter-bar" data-testid="orders-filter-bar">
        <div className="list-filter-bar__search">
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            type="text"
            data-testid="orders-search-input"
            placeholder="Buscar por cliente, teléfono, dispositivo, IMEI..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="form-control"
            style={{ paddingLeft: '2.25rem', paddingRight: searchTerm ? '2rem' : undefined }}
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="icon-btn" aria-label="Limpiar búsqueda"
              style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', width: 22, height: 22 }}>
              <X size={12} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="form-select orders-filter-status"
          aria-label="Filtrar por estado"
          data-testid="orders-status-filter"
        >
          <option value="">Todos los estados</option>
          <option value="new">Nueva</option>
          <option value="diagnosis">Diagnóstico</option>
          <option value="repair">En Reparación</option>
          <option value="ready">Listo</option>
          <option value="completed">Completada</option>
          <option value="cancelled">Cancelada</option>
        </select>
        {/* Estado de COBRO — eje independiente del estado técnico. */}
        <select
          value={paymentFilter}
          onChange={e => setPaymentFilter(e.target.value as '' | OrderPaymentStatus)}
          className="form-select orders-filter-payment"
          aria-label="Filtrar por estado de cobro"
          data-testid="orders-payment-filter"
        >
          <option value="">Todos los cobros</option>
          <option value="sin_facturar">Sin facturar</option>
          <option value="pending">Pendientes</option>
          <option value="partial">Parciales</option>
          <option value="paid">Cobradas</option>
        </select>
        <select
          value={priorityFilter}
          onChange={e => setPriorityFilter(e.target.value)}
          className="form-select orders-filter-priority"
          aria-label="Filtrar por prioridad"
          data-testid="orders-priority-filter"
        >
          <option value="">Todas las prioridades</option>
          <option value="urgent">Urgente</option>
          <option value="high">Alta</option>
          <option value="medium">Media</option>
          <option value="low">Baja</option>
        </select>
        {(searchTerm || statusFilter || priorityFilter || paymentFilter) && (
          <button onClick={clearFilters} className="btn btn-ghost btn-sm" data-testid="orders-clear-filters">
            Limpiar filtros
          </button>
        )}
        {debouncedSearch && (
          <span className="body-sm list-filter-bar__count">
            {filteredOrders.length} resultado{filteredOrders.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* BETA-UX-1D — el estado vacío vive FUERA de la tabla. Adentro de un
          `<td colSpan>` heredaba el ancho de las nueve columnas y en mobile
          quedaba recortado; ahora, sin filas, no se monta ni tabla ni lista. */}
      {filteredOrders.length === 0 ? (
        <div
          className="surface-raised list-empty-state"
          data-testid="orders-empty-state"
          data-empty-kind={filtersApplied ? 'no-results' : 'no-data'}
        >
          {filtersApplied ? (
            <EmptyState
              icon={Search}
              title="Sin resultados"
              description="Probá con otro término o limpiá los filtros"
              action={{ label: 'Limpiar filtros', onClick: clearFilters }}
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="Todavía no tenés órdenes"
              description="Comenzá creando tu primera orden de reparación."
              action={{ label: 'Nueva Orden', onClick: () => navigate('/orders/new') }}
            />
          )}
        </div>
      ) : (
        <>
          {/* >=768px: la tabla de siempre. <768px la oculta el CSS y se muestra la
              lista de tarjetas de abajo, armada con las mismas órdenes. */}
          <div className="surface-raised orders-desktop-table" data-testid="orders-desktop-table" style={{ overflow: 'hidden' }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Cliente</th>
                    <th>Dispositivo</th>
                    <th>Estado</th>
                    <th>Cobro</th>
                    <th>Prioridad</th>
                    <th style={{ textAlign: 'right' }}>Total</th>
                    <th>Fecha</th>
                    <th style={{ textAlign: 'right' }}>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => {
                    const amounts = orderAmounts(order.id)
                    return (
                      <tr key={order.id}>
                        <td>
                          <Link to={`/orders/${order.id}`} style={{ color: 'var(--accent-primary)', fontWeight: 600, textDecoration: 'none' }}>
                            #{order.id.slice(0, 8)}
                          </Link>
                        </td>
                        <td style={{ color: 'var(--text-primary)' }}>{order.customer?.name || 'Sin cliente'}</td>
                        <td>{order.device ? `${order.device.brand} ${order.device.model}` : <span className="body-sm">Sin dispositivo</span>}</td>
                        <td>
                          <span className="badge" style={getStatusStyle(order.status)}>
                            {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                          </span>
                        </td>
                        {/* Estado de COBRO: eje separado del técnico. El valor y el
                            saldo llegan de v_order_financial_status; acá no se calcula nada. */}
                        <td data-testid="order-financial-cell">
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', alignItems: 'flex-start' }}>
                            <OrderFinancialBadge
                              status={financialError ? null : (financial[order.id]?.payment_status ?? null)}
                              unavailable={financialError || !financial[order.id]}
                              size="sm"
                            />
                            {/* El saldo sólo existe si el servidor lo entregó. Sin
                                permiso no se muestra un cero: se dice que está restringido. */}
                            {amounts && amounts.saldo > 0 && (
                              <span className="body-sm" style={{ fontSize: '0.68rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>
                                Saldo {formatMoney(amounts.saldo)}
                              </span>
                            )}
                            {!financialError && amountsAuthorized === false && (
                              <span data-testid="order-amounts-restricted" className="body-sm"
                                    title="Tu rol no tiene acceso a los importes."
                                    style={{ fontSize: '0.62rem', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>
                                Importes restringidos
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="badge" style={getPriorityStyle(order.priority)}>
                            {PRIORITY_LABELS[order.priority] || 'Baja'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {/* SEC-08A: sin permiso se dice que está restringido, nunca
                              $0. La regla vive en `orderAmounts`, compartida con
                              las tarjetas de mobile. */}
                          {amounts
                            ? formatMoney(amounts.total)
                            : <span data-testid="order-total-restricted" style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>—</span>}
                        </td>
                        <td className="body-sm">{formatOrderDate(order.created_at)}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                            <button data-testid="order-print-button" onClick={() => handlePrint(order)} className="icon-btn icon-btn-primary" title="Imprimir Orden">
                              <Printer size={15} />
                            </button>
                            <Link to={`/orders/${order.id}`} className="icon-btn" title="Ver detalle" style={{ textDecoration: 'none' }}>
                              <Eye size={15} />
                            </Link>
                            <button onClick={() => navigate(`/orders/${order.id}`)} className="icon-btn icon-btn-violet" title="Editar">
                              <Edit size={15} />
                            </button>
                            <button onClick={() => askDelete(order)} className="icon-btn icon-btn-danger" title="Eliminar">
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="orders-mobile-list" data-testid="orders-mobile-list">
            <CompactList items={mobileItems} label="Órdenes de trabajo" />
          </div>
        </>
      )}

      {/* Modal confirmar eliminación */}
      {deletingOrder && (
        <div className="modal-overlay-dark" onClick={e => { if (e.target === e.currentTarget) setDeletingOrder(null) }}>
          <div className="modal-card">
            <div className="modal-hdr">
              <h3>Eliminar Orden</h3>
              <CloseButton onClick={() => setDeletingOrder(null)} />
            </div>
            <div className="modal-body-scroll">
              <p className="body-md" style={{ marginBottom: '0.5rem' }}>
                ¿Estás seguro que querés eliminar la orden{' '}
                <strong style={{ color: 'var(--text-primary)' }}>#{deletingOrder.id.slice(0, 8)}</strong>
                {deletingOrder.customer?.name ? ` de ${deletingOrder.customer.name}` : ''}?
              </p>
              <p className="body-sm" style={{ marginBottom: '1rem' }}>Esta acción no se puede deshacer.</p>
              {deleteError && <div className="alert-inline alert-error" style={{ marginBottom: '0.75rem' }}>{deleteError}</div>}
            </div>
            <div className="modal-ftr">
              <button onClick={() => setDeletingOrder(null)} disabled={deleteLoading} className="btn btn-ghost btn-sm">Cancelar</button>
              <button onClick={handleDeleteConfirm} disabled={deleteLoading} className="btn btn-danger btn-sm btn-lift">
                {deleteLoading ? <><Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> Eliminando...</> : <><Trash2 size={14} /> Eliminar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Componente de impresión oculto — printSettings resueltos en el nivel
          de la página para evitar la carga asíncrona interna y el race condition
          que causa "Mi Negocio" si la DB no responde antes del captura de innerHTML */}
      {printingOrder && (
        <div data-testid="order-print-hidden-root" style={{ position: 'fixed', left: '-9999px', top: '-9999px' }}>
          <div ref={printRef}>
            <ServiceOrderPrint order={printingOrder} printSettings={orderPrintSettings} />
          </div>
        </div>
      )}
    </div>
  )
}
