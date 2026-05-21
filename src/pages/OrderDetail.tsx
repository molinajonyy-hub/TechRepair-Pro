import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Smartphone,
  FileText,
  History,
  Image,
  AlertCircle,
  ArrowRight,
  Receipt,
  FileCheck,
  Printer,
  MessageCircle,
  Save,
  Loader2,
  Phone,
  Mail,
  MapPin,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { ModalEnviarWhatsApp } from '../components/whatsapp/ModalEnviarWhatsApp'
import { WhatsAppHistorial } from '../components/whatsapp/WhatsAppHistorial'
import { DocumentUploader } from '../components/order/DocumentUploader'
import { NotificationCard } from '../components/order/NotificationCard'
import { StatusChange } from '../components/order/StatusChange'
import { OrderItemsCard } from '../components/order/OrderItemsCard'
import { supabase } from '../lib/supabase'
import { useOrderSimple } from '../hooks/useOrderSimple'
import { useComprobantes } from '../hooks/useComprobantes'
import { Loader } from '../components/ui/Loader'
import { ComprobanteProModal as ModalCrearComprobante } from '../components/comprobantes/ComprobanteProModal'
import { OrderPrintPreviewModal } from '../components/print/OrderPrintPreviewModal'
import { STATUS_CONFIG } from '../types/orderStatus'
import { DeviceLockCard } from '../components/order/DeviceLockCard'

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
  const [showModalCrearComprobante, setShowModalCrearComprobante] = useState(false)
  const [showPrintModal, setShowPrintModal] = useState(false)
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
  const [notesText, setNotesText] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesSaved, setNotesSaved] = useState(false)
  // serviceTotal is now derived synchronously from order.orderItems (loaded by useOrderSimple)

  // Cargar datos reales desde Supabase
  const { order, loading, error, refresh } = useOrderSimple(id)

  // Comprobantes
  const {
    comprobantes,
    cargarComprobantesByOrder
  } = useComprobantes()

  // Cargar documentos y comprobantes
  useEffect(() => {
    if (id) {
      loadDocuments()
      cargarComprobantesByOrder(id)
    }
  }, [id, cargarComprobantesByOrder])

  // Sincronizar notas cuando carga la orden
  useEffect(() => {
    if (order) setNotesText(order.notes || '')
  }, [order?.id])

  async function handleSaveNotes() {
    if (!id) return
    setSavingNotes(true)
    try {
      const { error } = await supabase
        .from('orders')
        .update({ notes: notesText })
        .eq('id', id)
      if (error) throw error
      setNotesSaved(true)
      setTimeout(() => setNotesSaved(false), 2000)
      await refresh()
    } catch (err: any) {
      console.error('Error saving notes:', err)
    } finally {
      setSavingNotes(false)
    }
  }

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
                onClick={() => setShowModalCrearComprobante(true)}
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
              data-testid="order-print-preview-button"
              onClick={() => setShowPrintModal(true)}
              className="btn btn-outline btn-sm"
            >
              <Printer size={15} />
              Imprimir
            </button>

            <button
              onClick={() => setShowWhatsAppModal(true)}
              className="btn btn-ghost btn-sm"
              style={{ color: '#25d366', borderColor: 'rgba(37,211,102,0.3)', background: 'rgba(37,211,102,0.08)' }}
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
      <div className="tabs" style={{ marginBottom: '1.5rem' }}>
        {[
          { id: 'overview',     label: 'General',       icon: Smartphone   },
          { id: 'notes',        label: 'Notas',         icon: FileText     },
          { id: 'documents',    label: 'Documentos',    icon: Image        },
          { id: 'comunicacion', label: 'Comunicación',  icon: MessageCircle },
          { id: 'history',      label: 'Historial',     icon: History      },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`tab${activeTab === tab.id ? ' tab-active' : ''}`}
          >
            <tab.icon size={15} />
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    <span className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Phone size={13} style={{ flexShrink: 0 }} /> {order.customer.phone}
                    </span>
                    {order.customer.email && (
                      <span className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Mail size={13} style={{ flexShrink: 0 }} /> {order.customer.email}
                      </span>
                    )}
                    {order.customer.address && (
                      <span className="body-sm" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <MapPin size={13} style={{ flexShrink: 0 }} /> {order.customer.address}
                      </span>
                    )}
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
                        <p className="label-caps" style={{ marginBottom: '0.25rem' }}>Marca</p>
                        <p style={{ fontWeight: 500, color: '#f8fafc' }}>{order.device.brand}</p>
                      </div>
                      <div>
                        <p className="label-caps" style={{ marginBottom: '0.25rem' }}>Modelo</p>
                        <p style={{ fontWeight: 500, color: '#f8fafc' }}>{order.device.model}</p>
                      </div>
                    </div>
                    <div>
                      <p className="label-caps" style={{ marginBottom: '0.25rem' }}>Problema</p>
                      <p style={{ color: '#f8fafc' }}>{order.device.issue}</p>
                    </div>
                  </>
                ) : (
                  <p style={{ color: '#64748b' }}>No hay información del dispositivo</p>
                )}
              </div>
            </div>

            {/* Device Lock / Password */}
            <DeviceLockCard
              orderId={order.id}
              initialValue={(order as any).device_password ?? null}
              onSave={async (encoded) => {
                await supabase
                  .from('orders')
                  .update({ device_password: encoded, updated_at: new Date().toISOString() })
                  .eq('id', order.id)
                await refresh()
              }}
            />

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

            {/* Order Items */}
            <div style={{ gridColumn: 'span 2' }}>
              <OrderItemsCard orderId={order.id} onTotalsChange={refresh} />
            </div>

          </>
        )}

        {activeTab === 'notes' && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <FileText size={17} color="#6366f1" />
                Notas internas
              </h3>
              <button
                onClick={handleSaveNotes}
                disabled={savingNotes}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.375rem',
                  padding: '0.375rem 0.875rem',
                  background: notesSaved
                    ? 'rgba(16,185,129,0.15)'
                    : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                  border: notesSaved ? '1px solid rgba(16,185,129,0.4)' : 'none',
                  borderRadius: '0.5rem',
                  color: notesSaved ? '#10b981' : '#fff',
                  fontWeight: 600, fontSize: '0.8125rem',
                  cursor: savingNotes ? 'not-allowed' : 'pointer',
                  opacity: savingNotes ? 0.7 : 1,
                  transition: 'all 0.2s'
                }}
              >
                {savingNotes
                  ? <><Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</>
                  : notesSaved
                    ? '✓ Guardado'
                    : <><Save size={14} /> Guardar</>
                }
              </button>
            </div>
            <div className="card-body">
              <textarea
                value={notesText}
                onChange={(e) => setNotesText(e.target.value)}
                placeholder="Escribí notas internas sobre esta orden: diagnóstico, acuerdos con el cliente, observaciones..."
                rows={7}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '0.75rem',
                  backgroundColor: '#0f172a',
                  border: '1px solid #1e293b',
                  borderRadius: '0.5rem',
                  color: '#e2e8f0',
                  fontSize: '0.9375rem',
                  lineHeight: 1.6,
                  resize: 'vertical',
                  outline: 'none',
                  fontFamily: 'inherit'
                }}
                onFocus={e => e.target.style.borderColor = '#6366f1'}
                onBlur={e => e.target.style.borderColor = '#1e293b'}
              />
              <p style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.5rem' }}>
                Las notas son solo visibles internamente, no las ve el cliente.
              </p>
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

        {activeTab === 'comunicacion' && (
          <div style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <NotificationCard
              orderId={order.id}
              customerEmail={order.customer?.email || ''}
              customerName={order.customer?.name || ''}
              currentStatus={order.status}
            />
            {id && <WhatsAppHistorial orderId={id} />}
          </div>
        )}

        {/* Modal Crear Comprobante */}
        {order && (() => {
          // ── Build billable comprobante items from order.orderItems ──────────
          // order.orderItems is the authoritative source: it always has the
          // correct cliente_paga_repuesto value (set at insertion time) and the
          // real precio_unitario (no async race conditions).
          //
          // Rule: include servicio items always + repuesto items only when
          // cliente_paga_repuesto !== false.
          //
          // Fallback path: parts that live only in order_parts (added via
          // orderPartsService without inventory link — no order_items record).
          // These are always billable because orderPartsService has no
          // "not charged" option for non-inventory parts.

          const orderItemsDescriptions = new Set(
            (order.orderItems ?? [])
              .filter(i => i.tipo === 'repuesto')
              .map(i => i.descripcion)
          )

          const billableFromOrderItems = (order.orderItems ?? [])
            .filter(i =>
              i.tipo === 'servicio' ||
              (i.tipo === 'repuesto' && i.cliente_paga_repuesto !== false)
            )
            .map(i => ({
              descripcion:     i.descripcion,
              cantidad:        i.cantidad,
              precio_unitario: i.precio_unitario,
              currency:        'ARS' as const,
              tipo_linea:      (i.tipo === 'servicio' ? 'servicio' : 'repuesto') as 'servicio' | 'repuesto',
              costo_unitario:  i.costo_unitario ?? 0,
              inventory_id:    i.product_id ?? undefined,
            }))

          // Parts in order_parts with no corresponding order_items entry
          const billableFromPartsOnly = (order.parts ?? [])
            .filter(p =>
              p.sale_price > 0 &&
              !orderItemsDescriptions.has(p.name)
            )
            .map(p => ({
              descripcion:     p.name,
              cantidad:        p.quantity,
              precio_unitario: p.sale_price,
              currency:        'ARS' as const,
              tipo_linea:      'repuesto' as const,
              costo_unitario:  p.internal_cost ?? 0,
            }))

          const computedItems = [...billableFromOrderItems, ...billableFromPartsOnly]

          return (
            <ModalCrearComprobante
              isOpen={showModalCrearComprobante}
              onClose={() => setShowModalCrearComprobante(false)}
              initialClienteId={order.customer_id || order.customer?.id || ''}
              initialItems={computedItems}
              onCreado={() => {
                setShowModalCrearComprobante(false)
                refresh()
              }}
            />
          )
        })()}

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
                          {entry.created_at && new Date(entry.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
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
