import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Search, Filter, Eye, Edit, Trash2, ClipboardList, Printer } from 'lucide-react'
import { useOrders } from '../hooks/useOrders'
import { STATUS_CONFIG } from '../types/orderStatus'
import { useLoading } from '../contexts/LoadingContext'
import { ServiceOrderPrint } from '../components/print/ServiceOrderPrint'

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

const DEVICE_TYPE_LABELS: Record<string, string> = {
  smartphone: 'Celular',
  celular: 'Celular',
  tablet: 'Tablet',
  laptop: 'Notebook',
  smartwatch: 'Smartwatch',
  other: 'Otro',
  otro: 'Otro'
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
  const { orders, loading, error } = useOrders()
  const { showLoading, hideLoading } = useLoading()
  const [printingOrder, setPrintingOrder] = useState<any>(null)
  const printRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (loading) {
      showLoading('Cargando órdenes...')
    } else {
      hideLoading()
    }
  }, [loading, showLoading, hideLoading])

  if (error) {
    return (
      <div style={{ padding: '2rem' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff', marginBottom: '1rem' }}>
          Órdenes de Trabajo
        </h1>
        <div style={{ padding: '1.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '0.75rem' }}>
          <p style={{ color: '#f87171' }}>Error al cargar órdenes: {error}</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <ClipboardList size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Órdenes de Trabajo</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Gestiona todas las órdenes de reparación del taller</p>
          </div>
        </div>
        <Link to="/orders/new" style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.625rem 1.25rem',
          background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
          border: 'none', color: '#ffffff', borderRadius: '0.625rem',
          cursor: 'pointer', fontWeight: 600, textDecoration: 'none',
          boxShadow: '0 4px 12px rgba(99,102,241,0.35)', fontSize: '0.875rem'
        }}>
          <Plus size={18} />
          Nueva Orden
        </Link>
      </div>

      <div style={{
        marginBottom: '1.5rem',
        padding: '1rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        display: 'flex',
        gap: '1rem',
        flexWrap: 'wrap'
      }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '240px' }}>
          <Search size={18} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} />
          <input
            type="text"
            placeholder="Buscar por cliente, dispositivo o número de orden..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '0.625rem 0.75rem 0.625rem 2.5rem',
              backgroundColor: 'rgba(15,23,42,0.8)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.5rem',
              color: '#f1f5f9',
              outline: 'none'
            }}
          />
        </div>
        <select style={{
          width: 'auto',
          minWidth: '160px',
          padding: '0.625rem 0.75rem',
          backgroundColor: 'rgba(15,23,42,0.8)',
          border: '1px solid rgba(51,65,85,0.6)',
          borderRadius: '0.5rem',
          color: '#f1f5f9',
          outline: 'none'
        }}>
          <option value="">Todos los estados</option>
          <option value="new">Nueva</option>
          <option value="diagnosis">Diagnóstico</option>
          <option value="repair">En Reparación</option>
          <option value="ready">Listo</option>
          <option value="completed">Completada</option>
        </select>
        <button style={{
          padding: '0.625rem 1rem',
          backgroundColor: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#94a3b8',
          borderRadius: '0.5rem',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontWeight: 500
        }}>
          <Filter size={18} />
          Filtros
        </button>
      </div>

      <div style={{
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        overflow: 'hidden'
      }}>
        <div style={{ padding: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Orden</th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Cliente</th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Dispositivo</th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Estado</th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Prioridad</th>
                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Total</th>
                <th style={{ padding: '1rem', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Fecha</th>
                <th style={{ padding: '1rem', textAlign: 'right', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div style={{ padding: '4rem 2rem', textAlign: 'center' }}>
                      <div style={{
                        width: '64px',
                        height: '64px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(15,23,42,0.8)',
                        margin: '0 auto 1.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <ClipboardList size={32} style={{ color: '#64748b' }} />
                      </div>
                      <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
                        Todavía no tenés órdenes
                      </h3>
                      <p style={{ color: '#94a3b8', fontSize: '0.9375rem', marginBottom: '1.5rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
                        Comenzá creando tu primera orden de reparación para empezar a gestionar el trabajo del taller.
                      </p>
                      <Link
                        to="/orders/new"
                        style={{
                          display: 'inline-flex',
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
                        }}
                      >
                        <Plus size={16} />
                        Crear Primera Orden
                      </Link>
                    </div>
                  </td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '1rem' }}>
                      <Link to={`/orders/${order.id}`} style={{ color: '#818cf8', fontWeight: 500, textDecoration: 'none' }}>
                        #{order.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td style={{ padding: '1rem', color: '#94a3b8' }}>{order.customer?.name || 'Sin cliente'}</td>
                    <td style={{ padding: '1rem', color: '#94a3b8' }}>{order.device ? `${order.device.brand} ${order.device.model}` : 'Sin dispositivo'}</td>
                    <td style={{ padding: '1rem' }}>
                      <span style={getStatusStyle(order.status)}>
                        {STATUS_CONFIG[order.status as keyof typeof STATUS_CONFIG]?.label || order.status}
                      </span>
                    </td>
                    <td style={{ padding: '1rem' }}>
                      <span style={getPriorityStyle(order.priority)}>
                        {PRIORITY_LABELS[order.priority] || 'Baja'}
                      </span>
                    </td>
                    <td style={{ padding: '1rem', textAlign: 'right', fontWeight: 600, color: '#ffffff' }}>${order.estimated_total || 0}</td>
                    <td style={{ padding: '1rem', color: '#64748b' }}>{new Date(order.created_at).toLocaleDateString('es-ES')}</td>
                    <td style={{ padding: '1rem', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <button 
                          onClick={() => handlePrint(order)}
                          style={{
                            padding: '0.5rem',
                            backgroundColor: 'rgba(99, 102, 241, 0.1)',
                            border: '1px solid rgba(99, 102, 241, 0.2)',
                            borderRadius: '0.375rem',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center'
                          }} title="Imprimir Orden">
                          <Printer size={16} style={{ color: '#6366f1' }} />
                        </button>
                        <Link to={`/orders/${order.id}`} style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          textDecoration: 'none'
                        }} title="Ver">
                          <Eye size={16} style={{ color: '#94a3b8' }} />
                        </Link>
                        <button style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }} title="Editar">
                          <Edit size={16} style={{ color: '#94a3b8' }} />
                        </button>
                        <button style={{
                          padding: '0.5rem',
                          backgroundColor: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '0.375rem',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center'
                        }} title="Eliminar">
                          <Trash2 size={16} style={{ color: '#ef4444' }} />
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
