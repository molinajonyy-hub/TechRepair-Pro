import { useState, useRef, useMemo, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Search, Eye, Edit, Trash2, ClipboardList, Printer, Loader2, X } from 'lucide-react'
import { smartSearch } from '../utils/searchUtils'
import { CloseButton } from '../components/ui/CloseButton'
import { EmptyState } from '../components/ui/EmptyState'
import { useOrders, OrderListItem } from '../hooks/useOrders'
import { STATUS_CONFIG } from '../types/orderStatus'
import { ServiceOrderPrint } from '../components/print/ServiceOrderPrint'
import { supabase } from '../lib/supabase'

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

  const { orders, error, refresh: refetch } = useOrders()
  const navigate = useNavigate()
  const [printingOrder, setPrintingOrder] = useState<any>(null)
  const printRef = useRef<HTMLDivElement>(null)

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
    if (statusFilter) result = result.filter(o => o.status === statusFilter)
    if (priorityFilter) result = result.filter(o => o.priority === priorityFilter)
    return result
  }, [orders, debouncedSearch, statusFilter, priorityFilter])

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
    setPrintingOrder(order)
    setTimeout(() => {
      if (printRef.current) {
        const printContent = printRef.current.innerHTML
        const printWindow = window.open('', '_blank', 'width=900,height=700')
        if (printWindow) {
          printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Orden de Servicio #${order.id.slice(0, 8)}</title>
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
    }, 150)
  }

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
    <div>
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon"><ClipboardList size={22} /></div>
          <div>
            <h1 className="page-hdr-title">Órdenes de Trabajo</h1>
            <p className="page-hdr-subtitle">Gestiona todas las órdenes de reparación del taller</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <Link to="/orders/new" className="btn btn-primary btn-sm btn-lift" style={{ textDecoration: 'none' }}>
            <Plus size={16} />
            Nueva Orden
          </Link>
        </div>
      </div>

      <div className="filter-bar">
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={15} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            type="text"
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
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="form-select" style={{ minWidth: 150 }}>
          <option value="">Todos los estados</option>
          <option value="new">Nueva</option>
          <option value="diagnosis">Diagnóstico</option>
          <option value="repair">En Reparación</option>
          <option value="ready">Listo</option>
          <option value="completed">Completada</option>
          <option value="cancelled">Cancelada</option>
        </select>
        <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} className="form-select" style={{ minWidth: 130 }}>
          <option value="">Todas las prioridades</option>
          <option value="urgent">Urgente</option>
          <option value="high">Alta</option>
          <option value="medium">Media</option>
          <option value="low">Baja</option>
        </select>
        {(searchTerm || statusFilter || priorityFilter) && (
          <button onClick={() => { setSearchTerm(''); setStatusFilter(''); setPriorityFilter('') }} className="btn btn-ghost btn-sm">
            Limpiar filtros
          </button>
        )}
        {debouncedSearch && (
          <span className="body-sm" style={{ whiteSpace: 'nowrap', alignSelf: 'center' }}>
            {filteredOrders.length} resultado{filteredOrders.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="surface-raised" style={{ overflow: 'hidden' }}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Orden</th>
                <th>Cliente</th>
                <th>Dispositivo</th>
                <th>Estado</th>
                <th>Prioridad</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Fecha</th>
                <th style={{ textAlign: 'right' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={8}>
                    {debouncedSearch || statusFilter || priorityFilter ? (
                      <EmptyState
                        icon={Search}
                        title="Sin resultados"
                        description="Probá con otro término o limpiá los filtros"
                        action={{ label: 'Limpiar filtros', onClick: () => { setSearchTerm(''); setStatusFilter(''); setPriorityFilter('') } }}
                      />
                    ) : (
                      <EmptyState
                        icon={ClipboardList}
                        title="Todavía no tenés órdenes"
                        description="Comenzá creando tu primera orden de reparación."
                        action={{ label: 'Nueva Orden', onClick: () => navigate('/orders/new') }}
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
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
                    <td>
                      <span className="badge" style={getPriorityStyle(order.priority)}>
                        {PRIORITY_LABELS[order.priority] || 'Baja'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {(() => {
                        if (order.order_items && order.order_items.length > 0) {
                          const serviceTotal = order.order_items
                            .filter(i => i.tipo === 'servicio')
                            .reduce((s, i) => s + i.precio_unitario * i.cantidad, 0)
                          if (serviceTotal > 0) return `$${serviceTotal.toLocaleString('es-AR')}`
                        }
                        const total = order.labor_cost || order.estimated_total || 0
                        return `$${total.toLocaleString('es-AR')}`
                      })()}
                    </td>
                    <td className="body-sm">{new Date(order.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'flex-end' }}>
                        <button onClick={() => handlePrint(order)} className="icon-btn icon-btn-primary" title="Imprimir Orden">
                          <Printer size={15} />
                        </button>
                        <Link to={`/orders/${order.id}`} className="icon-btn" title="Ver detalle" style={{ textDecoration: 'none' }}>
                          <Eye size={15} />
                        </Link>
                        <button onClick={() => navigate(`/orders/${order.id}`)} className="icon-btn icon-btn-violet" title="Editar">
                          <Edit size={15} />
                        </button>
                        <button onClick={() => { setDeleteError(null); setDeletingOrder(order) }} className="icon-btn icon-btn-danger" title="Eliminar">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

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

      {/* Componente de impresión oculto */}
      {printingOrder && (
        <div style={{ position: 'fixed', left: '-9999px', top: '-9999px' }}>
          <div ref={printRef}>
            <ServiceOrderPrint order={printingOrder} />
          </div>
        </div>
      )}
    </div>
  )
}
