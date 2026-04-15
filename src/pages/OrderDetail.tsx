import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Smartphone,
  Package,
  FileText,
  History,
  Image,
  Bell,
  AlertCircle,
  ArrowRight,
  Receipt,
  FileCheck,
  Printer,
  MessageCircle,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { ModalEnviarWhatsApp } from '../components/whatsapp/ModalEnviarWhatsApp'
import { WhatsAppHistorial } from '../components/whatsapp/WhatsAppHistorial'
import { DocumentUploader } from '../components/order/DocumentUploader'
import { NotificationCard } from '../components/order/NotificationCard'
import { StatusChange } from '../components/order/StatusChange'
import { ChecklistCard } from '../components/order/ChecklistCard'
import { DeviceInspectionCard } from '../components/order/DeviceInspectionCard'
import { OrderCostManagement } from '../components/order/OrderCostManagement'
import { supabase } from '../lib/supabase'
import { useOrderSimple } from '../hooks/useOrderSimple'
import { useComprobantes } from '../hooks/useComprobantes'
import { Loader } from '../components/ui/Loader'
import { ModalGenerarComprobante } from '../components/comprobantes/ModalGenerarComprobante'
import { OrderPrintPreviewModal } from '../components/print/OrderPrintPreviewModal'
import { STATUS_CONFIG } from '../types/orderStatus'

interface Document {
  id: string
  file_name: string
  file_url: string
  file_type: string
  file_size?: number
  storage_path: string
  created_at: string
}

export function OrderDetail() {
  const { id } = useParams<{ id: string }>()
  const [activeTab, setActiveTab] = useState('overview')
  const [documents, setDocuments] = useState<Document[]>([])
  const [showModalComprobante, setShowModalComprobante] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
  
  // Cargar datos reales desde Supabase
  const { order, loading, error, refresh } = useOrderSimple(id)
  
  // Comprobantes
  const {
    comprobantes,
    loading: loadingComprobantes,
    crearComprobante,
    cargarComprobantesByOrder
  } = useComprobantes()
  
  // Cargar documentos y comprobantes
  useEffect(() => {
    if (id) {
      loadDocuments()
      cargarComprobantesByOrder(id)
    }
  }, [id, cargarComprobantesByOrder])

  async function loadDocuments() {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('order_id', id)
        .order('created_at', { ascending: false })
      
      if (error) throw error
      setDocuments(data || [])
    } catch (err) {
      console.error('Error loading documents:', err)
    }
  }
  
  // Estados de carga y error
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" text="Cargando orden..." />
      </div>
    )
  }

  if (error || !order) {
    return (
      <div className="animate-fade-in">
        <div style={{ marginBottom: '2rem' }}>
          <Link to="/orders" className="btn btn-outline btn-sm">
            <ArrowLeft size={16} /> Volver a Órdenes
          </Link>
        </div>
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: '3rem' }}>
            <AlertCircle size={48} color="#dc2626" style={{ marginBottom: '1rem' }} />
            <h3 style={{ color: '#f8fafc', marginBottom: '0.5rem' }}>Error al cargar la orden</h3>
            <p style={{ color: '#a0aec0' }}>{error || 'Orden no encontrada'}</p>
          </div>
        </div>
      </div>
    )
  }

  const status = STATUS_CONFIG[order.status]

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <Link to="/orders" className="btn btn-outline btn-sm" style={{ marginBottom: '1rem' }}>
          <ArrowLeft size={16} /> Volver a Órdenes
        </Link>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#f8fafc', marginBottom: '0.5rem' }}>
              Orden #{order.id.slice(0, 8)}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span 
                className="badge"
                style={{ 
                  backgroundColor: `${status.color}20`, 
                  color: status.color,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.375rem'
                }}
              >
                {status.label}
              </span>
              <span style={{ color: '#64748b', fontSize: '0.875rem' }}>
                Creada: {new Date(order.created_at).toLocaleDateString('es-ES')}
              </span>
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Botón Generar Comprobante */}
            {comprobantes.length === 0 && (
              <button
                onClick={() => setShowModalComprobante(true)}
                className="btn btn-primary btn-sm"
              >
                <Receipt size={15} />
                Generar Comprobante
              </button>
            )}

            {/* Botón Ver Comprobante si existe */}
            {comprobantes.length > 0 && (
              <Link
                to={`/comprobantes/${comprobantes[0].id}`}
                className="btn btn-outline btn-sm"
              >
                <FileCheck size={15} />
                Ver Comprobante
              </Link>
            )}

            <button
              onClick={() => setShowPrintModal(true)}
              className="btn btn-outline btn-sm"
            >
              <Printer size={15} />
              Imprimir
            </button>

            <button
              onClick={() => setShowWhatsAppModal(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.375rem',
                padding: '0.375rem 0.875rem',
                backgroundColor: 'rgba(37,211,102,0.12)',
                border: '1px solid rgba(37,211,102,0.3)',
                borderRadius: '0.5rem', color: '#25d366',
                fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                transition: 'all 0.2s'
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(37,211,102,0.22)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(37,211,102,0.12)')}
            >
              <MessageCircle size={15} />
              WhatsApp
            </button>
          </div>
        </div>
      </div>

      {/* Status Change Component - Solo visible en overview */}
      {activeTab === 'overview' && (
        <StatusChange 
          orderId={order.id}
          currentStatus={order.status}
          order={order}
          onStatusChange={refresh}
        />
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', borderBottom: '1px solid #374151' }}>
        {[
          { id: 'overview', label: 'General', icon: Smartphone },
          { id: 'parts', label: 'Repuestos', icon: Package },
          { id: 'notes', label: 'Notas', icon: FileText },
          { id: 'documents', label: 'Documentos', icon: Image },
          { id: 'notifications', label: 'Notificar', icon: Bell },
          { id: 'history', label: 'Historial', icon: History },
          { id: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '0.75rem 1rem',
              backgroundColor: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${activeTab === tab.id ? '#6366f1' : 'transparent'}`,
              color: activeTab === tab.id ? '#6366f1' : '#a0aec0',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '-1px'
            }}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {activeTab === 'overview' && (
          <>
            {/* Customer Info */}
            <div className="card">
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 className="card-title">Cliente</h3>
              </div>
              <div className="card-body">
                <p style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.5rem' }}>
                  {order.customer?.name || 'Sin cliente'}
                </p>
                {order.customer?.phone && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#a0aec0', fontSize: '0.875rem' }}>
                    <span>📞 {order.customer.phone}</span>
                    {order.customer.email && <span>✉️ {order.customer.email}</span>}
                    {order.customer.address && <span>📍 {order.customer.address}</span>}
                  </div>
                )}
              </div>
            </div>

            {/* Device Info */}
            <div className="card">
              <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h3 className="card-title">Dispositivo</h3>
              </div>
              <div className="card-body">
                {order.device ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                      <div>
                        <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Marca</p>
                        <p style={{ fontWeight: 500, color: '#f8fafc' }}>{order.device.brand}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Modelo</p>
                        <p style={{ fontWeight: 500, color: '#f8fafc' }}>{order.device.model}</p>
                      </div>
                    </div>
                    <div>
                      <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Problema</p>
                      <p style={{ color: '#f8fafc' }}>{order.device.issue}</p>
                    </div>
                  </>
                ) : (
                  <p style={{ color: '#64748b' }}>No hay información del dispositivo</p>
                )}
              </div>
            </div>

            {/* Order Cost Management - Repuestos, Pagos y Rentabilidad */}
            <div style={{ gridColumn: 'span 2' }}>
              <OrderCostManagement 
                orderId={order.id}
                laborCost={order.labor_cost || 0}
                totalQuoted={order.total_cost || order.estimated_total || 0}
                onDataChange={refresh}
              />
            </div>

            {/* Checklist */}
            <div style={{ gridColumn: 'span 2' }}>
              <ChecklistCard 
                orderId={order.id}
                checklist={order.checklist}
                onChecklistChange={refresh}
              />
            </div>

            {/* Comprobante Section */}
            {comprobantes.length > 0 && (
              <div style={{ gridColumn: 'span 2' }} className="card">
                <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <FileCheck size={18} color="#6366f1" />
                    <h3 className="card-title">Comprobante</h3>
                  </div>
                  <span 
                    className="badge" 
                    style={{ 
                      backgroundColor: comprobantes[0].estado === 'emitido' ? '#10b98120' : '#f59e0b20',
                      color: comprobantes[0].estado === 'emitido' ? '#10b981' : '#f59e0b'
                    }}
                  >
                    {comprobantes[0].estado === 'emitido' ? 'Emitido' : 'Borrador'}
                  </span>
                </div>
                <div className="card-body">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                    <div>
                      <p style={{ fontSize: '0.875rem', color: '#64748b' }}>
                        Tipo: <span style={{ color: '#f8fafc', fontWeight: 500 }}>
                          {comprobantes[0].tipo === 'factura_a' ? 'Factura A' : 
                           comprobantes[0].tipo === 'factura_c' ? 'Factura C' :
                           comprobantes[0].tipo === 'remito' ? 'Remito' : 'Nota de Crédito'}
                        </span>
                      </p>
                      {comprobantes[0].numero && (
                        <p style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.25rem' }}>
                          Número: <span style={{ color: '#f8fafc', fontWeight: 500, fontFamily: 'monospace' }}>{comprobantes[0].numero}</span>
                        </p>
                      )}
                      <p style={{ fontSize: '0.875rem', color: '#64748b', marginTop: '0.25rem' }}>
                        Total: <span style={{ color: '#f8fafc', fontWeight: 500 }}>${comprobantes[0].total.toFixed(2)}</span>
                      </p>
                    </div>
                    <Link 
                      to={`/comprobantes/${comprobantes[0].id}`}
                      className="btn btn-primary btn-sm"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                    >
                      Ver Detalle
                      <ArrowRight size={16} />
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* Checklist de Recepción */}
            <div style={{ gridColumn: 'span 2' }}>
              <DeviceInspectionCard 
                orderId={order.id}
                checklist={order.inspections?.reception}
                type="reception"
                onChecklistChange={refresh}
              />
            </div>

            {/* Checklist Final */}
            <div style={{ gridColumn: 'span 2' }}>
              <DeviceInspectionCard 
                orderId={order.id}
                checklist={order.inspections?.final}
                type="final"
                onChecklistChange={refresh}
              />
            </div>
          </>
        )}

        {activeTab === 'parts' && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-header">
              <h3 className="card-title">Repuestos</h3>
            </div>
            <div className="card-body">
              <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
                No hay repuestos registrados.
              </p>
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-header">
              <h3 className="card-title">Notas</h3>
            </div>
            <div className="card-body">
              {order.notes ? (
                <p style={{ color: '#a0aec0' }}>{order.notes}</p>
              ) : (
                <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
                  No hay notas registradas.
                </p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'documents' && id && (
          <div style={{ gridColumn: 'span 2' }}>
            <DocumentUploader 
              orderId={id} 
              documents={documents} 
              onDocumentsChange={setDocuments}
            />
          </div>
        )}

        {activeTab === 'notifications' && (
          <div style={{ gridColumn: 'span 2' }}>
            <NotificationCard 
              orderId={order.id}
              customerEmail={order.customer?.email || ''}
              customerName={order.customer?.name || ''}
              currentStatus={order.status}
            />
          </div>
        )}

        {/* Modal Generar Comprobante */}
        <ModalGenerarComprobante
          isOpen={showModalComprobante}
          onClose={() => setShowModalComprobante(false)}
          onGenerar={async (data) => {
            if (!order || !id) return;
            
            // Preparar items desde la orden
            const items = [];
            
            // Agregar servicio técnico
            if (order.labor_cost && order.labor_cost > 0) {
              items.push({
                descripcion: `Servicio técnico - ${order.device?.brand} ${order.device?.model}`,
                cantidad: 1,
                precio_unitario: order.labor_cost,
                inventory_id: undefined
              });
            }
            
            // Agregar repuestos si existen
            if (order.parts && order.parts.length > 0) {
              order.parts.forEach((part: any) => {
                items.push({
                  descripcion: part.name || 'Repuesto',
                  cantidad: part.quantity || 1,
                  precio_unitario: part.price || 0,
                  inventory_id: part.inventory_id
                });
              });
            }
            
            // Si no hay items, agregar uno genérico
            if (items.length === 0) {
              items.push({
                descripcion: `Reparación - ${order.device?.brand} ${order.device?.model}`,
                cantidad: 1,
                precio_unitario: order.total_cost || order.estimated_total || 0,
                inventory_id: undefined
              });
            }
            
            const success = await crearComprobante({
              order_id: id,
              customer_id: order.customer_id || order.customer?.id || '',
              tipo: data.tipo,
              punto_venta: data.puntoVenta,
              condicion_fiscal: data.condicionFiscal,
              items
            });
            
            if (success) {
              setShowModalComprobante(false);
              await refresh();
            }
          }}
          orderData={order ? {
            orderId: order.id,
            customerId: order.customer_id || order.customer?.id || '',
            customerName: order.customer?.name || 'Sin cliente',
            customerCuit: (order.customer as any)?.cuit || undefined,
            total: order.total_cost || order.estimated_total || 0,
            items: []
          } : null}
          loading={loadingComprobantes}
        />

        {activeTab === 'whatsapp' && id && (
          <div style={{ gridColumn: 'span 2' }}>
            <WhatsAppHistorial orderId={id} />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-header">
              <h3 className="card-title">Historial de Estados</h3>
            </div>
            <div className="card-body">
              {order.history && order.history.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {order.history.map((entry, index) => (
                    <div key={index} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                      <div style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        backgroundColor: `${STATUS_CONFIG[entry.to_status].color}20`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: STATUS_CONFIG[entry.to_status].color,
                        flexShrink: 0
                      }}>
                        <ArrowRight size={16} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontWeight: 600, color: '#f8fafc', margin: 0 }}>
                          {STATUS_CONFIG[entry.from_status].label} 
                          <ArrowRight size={14} style={{ display: 'inline', margin: '0 0.5rem' }} />
                          {STATUS_CONFIG[entry.to_status].label}
                        </p>
                        {entry.notes && (
                          <p style={{ color: '#a0aec0', margin: '0.25rem 0 0 0', fontSize: '0.875rem' }}>
                            {entry.notes}
                          </p>
                        )}
                        <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.25rem' }}>
                          {entry.created_at && new Date(entry.created_at).toLocaleString('es-ES')}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>
                  No hay cambios de estado registrados.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modal de impresión */}
      <OrderPrintPreviewModal
        isOpen={showPrintModal}
        onClose={() => setShowPrintModal(false)}
        order={order}
      />

      {/* Modal WhatsApp */}
      <ModalEnviarWhatsApp
        isOpen={showWhatsAppModal}
        onClose={() => setShowWhatsAppModal(false)}
        order={order}
      />

    </div>
  )
}
