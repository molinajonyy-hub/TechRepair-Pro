import React from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  useOrderPrintSettings,
  OrderPrintSettings,
  DEFAULT_PRINT_SETTINGS,
} from '../../hooks/useOrderPrintSettings'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrintOrderItem {
  tipo: 'repuesto' | 'servicio'
  descripcion: string
  cantidad: number
  precio_unitario: number
  cliente_paga_repuesto: boolean
}

export interface ServiceOrderData {
  id: string
  created_at: string
  status: string
  technician?: string
  customer: {
    name: string
    phone?: string
    email?: string
    address?: string
    dni?: string
  }
  device: {
    type?: string
    brand?: string
    model?: string
    imei?: string
    serial?: string
    color?: string
    accessories?: string
    password?: string
    aesthetic_condition?: string
  }
  reported_issue?: string
  diagnosis?: string
  parts_used?: string
  labor?: string
  observations?: string
  estimated_total?: number
  final_total?: number
  orderItems?: PrintOrderItem[]
}

interface ServiceOrderPrintProps {
  order: ServiceOrderData
  printSettings?: OrderPrintSettings
  /** Cuando es true elimina el wrapper gris externo — para usar en vistas previas */
  previewMode?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

const getStatusLabel = (status: string) => {
  const map: Record<string, string> = {
    received: 'Recibido', diagnosis: 'En diagnóstico', budget_pending: 'Pdte. de presupuesto',
    budget_approved: 'Pres. aprobado', in_repair: 'En reparación',
    waiting_parts: 'Esperando repuestos', completed: 'Completado',
    delivered: 'Entregado', cancelled: 'Cancelado',
  }
  return map[status] ?? status.replace(/_/g, ' ').toUpperCase()
}

const getDeviceTypeLabel = (type?: string) => {
  const map: Record<string, string> = {
    celular: 'Celular',
    tablet: 'Tablet',
    laptop: 'Laptop',
    smartwatch: 'Smartwatch',
    otro: 'Otro',
  }
  return map[type || ''] || type || '-'
}

// ─── Shared sub-components ────────────────────────────────────────────────────

const Row = ({ label, value }: { label: string; value?: string | null }) =>
  value ? (
    <div style={{ display: 'flex', gap: '5px', fontSize: '8.5px', lineHeight: '1.3' }}>
      <span style={{ color: '#475569', fontWeight: 600, minWidth: '72px', flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#1e293b', wordBreak: 'break-word' }}>{value}</span>
    </div>
  ) : null

const Block = ({ label, value }: { label: string; value?: string | null }) =>
  value ? (
    <div style={{ marginBottom: '3px' }}>
      <div style={{ fontSize: '8.5px', fontWeight: 600, color: '#475569', marginBottom: '1px' }}>{label}:</div>
      <div style={{ fontSize: '8.5px', color: '#1e293b', lineHeight: '1.35' }}>{value}</div>
    </div>
  ) : null

const SectionBox = ({ title, children, accentColor = '#6366f1' }: { title: string; children: React.ReactNode; accentColor?: string }) => (
  <div style={{ border: '1px solid #e2e8f0', borderRadius: '4px', padding: '5px 8px', marginBottom: '4px' }}>
    <h3 style={{ fontSize: '8px', fontWeight: 700, color: '#1e293b', margin: '0 0 4px 0', paddingBottom: '3px', borderBottom: `1.5px solid ${accentColor}`, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
      {title}
    </h3>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {children}
    </div>
  </div>
)

// ─── Print CSS ────────────────────────────────────────────────────────────────

const PRINT_STYLES = `
  @media print {
    @page {
      size: A4 portrait;
      margin: 0;
    }
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 210mm;
      height: 297mm;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
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
      page-break-after: avoid !important;
    }
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  }
`

// ─── Main component ───────────────────────────────────────────────────────────

export const ServiceOrderPrint = React.forwardRef<HTMLDivElement, ServiceOrderPrintProps>(
  ({ order, printSettings: externalSettings, previewMode = false }, ref) => {
    const { businessId } = useAuth()
    const { settings: loadedSettings } = useOrderPrintSettings(
      externalSettings ? null : businessId
    )

    const s: OrderPrintSettings = externalSettings ?? loadedSettings ?? DEFAULT_PRINT_SETTINGS

    // Total: from order_items (sin costos) or fallback
    const itemsTotal = order.orderItems
      ? order.orderItems.reduce((sum, item) => {
          if (item.tipo === 'servicio' || item.cliente_paga_repuesto) {
            return sum + item.precio_unitario * item.cantidad
          }
          return sum
        }, 0)
      : null

    const orderNumber = order.id.slice(0, 8).toUpperCase()
    const orderDate = new Date(order.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const orderTime = new Date(order.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    const total = itemsTotal !== null ? itemsTotal : (order.final_total || order.estimated_total || 0)
    const businessName = s.nombre_comercial || s.razon_social || 'Mi Negocio'

    // Footer contact items
    const footerItems: string[] = []
    if (s.orden_mostrar_direccion && s.domicilio_fiscal) footerItems.push(`📍 ${s.domicilio_fiscal}${s.localidad ? `, ${s.localidad}` : ''}`)
    if (s.orden_mostrar_whatsapp && s.orden_whatsapp) footerItems.push(`💬 ${s.orden_whatsapp}`)
    if (s.orden_mostrar_instagram && s.orden_instagram) footerItems.push(`📸 ${s.orden_instagram}`)
    if (s.orden_mostrar_email && s.orden_email_visible) footerItems.push(`✉ ${s.orden_email_visible}`)
    if (s.orden_mostrar_sitio_web && s.orden_sitio_web) footerItems.push(`🌐 ${s.orden_sitio_web}`)

    const showTermsInCopy = (copyType: 'cliente' | 'local') => {
      if (!s.orden_condiciones_activo || !s.orden_mostrar_condiciones) return false
      if (s.orden_condiciones_en === 'ambas') return true
      return s.orden_condiciones_en === copyType
    }

    // ── COPIA CLIENTE ─────────────────────────────────────────────────────────
    const renderClientCopy = () => (
      <div style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: "'Inter', 'Segoe UI', sans-serif", minHeight: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexShrink: 0 }}>
          {s.orden_mostrar_logo && s.logo_url ? (
            <img src={s.logo_url} alt="Logo" style={{ maxWidth: '52px', maxHeight: '34px', objectFit: 'contain', flexShrink: 0 }} />
          ) : null}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#0f172a', lineHeight: '1.2' }}>{businessName}</div>
          </div>
        </div>

        {/* Title bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: '4px', padding: '5px 10px', flexShrink: 0 }}>
          <span style={{ fontSize: '10px', fontWeight: 700, color: '#ffffff', letterSpacing: '0.5px' }}>ORDEN DE SERVICIO</span>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#818cf8' }}>N° {orderNumber}</span>
        </div>

        {/* Copy badge + order info in one row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <span style={{ display: 'inline-block', fontSize: '7.5px', fontWeight: 700, color: '#059669', backgroundColor: '#d1fae5', padding: '2px 10px', borderRadius: '10px', letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>
            COPIA CLIENTE
          </span>
          <div style={{ display: 'flex', gap: '12px', backgroundColor: '#f8fafc', borderRadius: '4px', padding: '4px 8px', flex: 1 }}>
            <Row label="Fecha" value={orderDate} />
            <Row label="Hora" value={orderTime} />
            <Row label="Estado" value={getStatusLabel(order.status)} />
            {order.technician && <Row label="Técnico" value={order.technician} />}
          </div>
        </div>

        {/* Cliente + Equipo en dos columnas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', flexShrink: 0 }}>
          <SectionBox title="Datos del Cliente" accentColor="#059669">
            <Row label="Nombre" value={order.customer.name} />
            <Row label="Teléfono" value={order.customer.phone} />
            <Row label="DNI" value={order.customer.dni} />
            {order.customer.email && <Row label="Email" value={order.customer.email} />}
          </SectionBox>

          <SectionBox title="Equipo" accentColor="#6366f1">
            {(order.device.brand || order.device.model) && (
              <Row label="Dispositivo" value={[order.device.brand, order.device.model].filter(Boolean).join(' ')} />
            )}
            {order.device.type && <Row label="Tipo" value={getDeviceTypeLabel(order.device.type)} />}
            {order.device.color && <Row label="Color" value={order.device.color} />}
            {order.device.imei && <Row label="IMEI" value={order.device.imei} />}
          </SectionBox>
        </div>

        {/* Servicio */}
        <SectionBox title="Detalle del Servicio" accentColor="#6366f1">
          <Block label="Falla reportada" value={order.reported_issue} />
          {order.diagnosis && <Block label="Diagnóstico inicial" value={order.diagnosis} />}

          {/* Tabla de ítems (sin costos internos) */}
          {order.orderItems && order.orderItems.length > 0 && (
            <div style={{ marginTop: '4px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '7.5px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f1f5f9' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px', color: '#475569', fontWeight: 700 }}>Descripción</th>
                    <th style={{ textAlign: 'center', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '30px' }}>Cant.</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '60px' }}>Precio</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '60px' }}>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {order.orderItems
                    .filter(item => item.tipo === 'servicio' || item.cliente_paga_repuesto)
                    .map((item, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '2px 4px', color: '#1e293b' }}>
                          {item.descripcion}
                          <span style={{ fontSize: '6.5px', color: '#94a3b8', marginLeft: '3px' }}>
                            {item.tipo === 'servicio' ? '(servicio)' : '(repuesto)'}
                          </span>
                        </td>
                        <td style={{ padding: '2px 4px', textAlign: 'center', color: '#475569' }}>{item.cantidad}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', color: '#475569' }}>{fmtCurrency(item.precio_unitario)}</td>
                        <td style={{ padding: '2px 4px', textAlign: 'right', color: '#1e293b', fontWeight: 600 }}>{fmtCurrency(item.precio_unitario * item.cantidad)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {total > 0 && (
            <div style={{ marginTop: '3px', padding: '4px 7px', backgroundColor: '#f0fdf4', borderRadius: '4px', border: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '7.5px', color: '#64748b' }}>{order.orderItems && order.orderItems.length > 0 ? 'Total del servicio' : 'Presupuesto estimado'}</div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#059669' }}>{fmtCurrency(total)}</div>
              </div>
              {!(order.orderItems && order.orderItems.length > 0) && (
                <div style={{ fontSize: '7px', color: '#64748b', fontStyle: 'italic', flex: 1 }}>
                  * El presupuesto es orientativo y puede variar según el diagnóstico final.
                </div>
              )}
            </div>
          )}
        </SectionBox>

        {/* Condiciones */}
        {showTermsInCopy('cliente') && (
          <div style={{ padding: '4px 7px', backgroundColor: '#fffbeb', borderRadius: '4px', border: '1px solid #fde68a', flexShrink: 0 }}>
            <div style={{ fontSize: '7px', color: '#92400e', lineHeight: '1.35', whiteSpace: 'pre-line' }}>
              {s.orden_condiciones}
            </div>
          </div>
        )}

        {/* Footer del local */}
        {(footerItems.length > 0 || (s.orden_mostrar_agradecimiento && s.orden_mensaje_agradecimiento)) && (
          <div style={{ paddingTop: '5px', borderTop: '1px solid #e2e8f0', textAlign: 'center', flexShrink: 0 }}>
            {footerItems.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px', marginBottom: '2px' }}>
                {footerItems.map((item, i) => (
                  <span key={i} style={{ fontSize: '7.5px', color: '#475569' }}>{item}</span>
                ))}
              </div>
            )}
            {s.orden_mostrar_agradecimiento && s.orden_mensaje_agradecimiento && (
              <div style={{ fontSize: '8.5px', fontWeight: 600, color: '#6366f1', fontStyle: 'italic' }}>
                {s.orden_mensaje_agradecimiento}
              </div>
            )}
          </div>
        )}
      </div>
    )

    // ── COPIA LOCAL ───────────────────────────────────────────────────────────
    const renderLocalCopy = () => (
      <div style={{ flex: 1, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: "'Inter', 'Segoe UI', sans-serif", minHeight: 0, overflow: 'hidden' }}>
        {/* Header compacto */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {s.orden_mostrar_logo && s.logo_url && (
              <img src={s.logo_url} alt="" style={{ maxWidth: '36px', maxHeight: '24px', objectFit: 'contain' }} />
            )}
            <span style={{ fontSize: '10px', fontWeight: 700, color: '#0f172a' }}>{businessName}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '8px', color: '#64748b' }}>Ingreso: {orderDate} {orderTime}</div>
          </div>
        </div>

        {/* Title bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1e293b', borderRadius: '4px', padding: '5px 10px', flexShrink: 0 }}>
          <span style={{ fontSize: '10px', fontWeight: 700, color: '#ffffff', letterSpacing: '0.5px' }}>ORDEN DE SERVICIO</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', fontSize: '7px', fontWeight: 700, color: '#6366f1', backgroundColor: '#e0e7ff', padding: '2px 7px', borderRadius: '8px' }}>
              COPIA LOCAL
            </span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#818cf8' }}>N° {orderNumber}</span>
          </div>
        </div>

        {/* Cliente + Equipo en dos columnas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', flexShrink: 0 }}>
          <SectionBox title="Datos del Cliente" accentColor="#059669">
            <Row label="Nombre" value={order.customer.name} />
            <Row label="Teléfono" value={order.customer.phone} />
            <Row label="DNI" value={order.customer.dni || '—'} />
            <Row label="Email" value={order.customer.email} />
            <Row label="Dirección" value={order.customer.address} />
          </SectionBox>

          <SectionBox title="Datos del Equipo" accentColor="#6366f1">
            <Row label="Tipo" value={order.device.type} />
            <Row label="Marca" value={order.device.brand} />
            <Row label="Modelo" value={order.device.model} />
            <Row label="Color" value={order.device.color} />
            <Row label="IMEI" value={order.device.imei} />
            <Row label="Serie" value={order.device.serial} />
            <Row label="Contraseña" value={order.device.password} />
            <Row label="Accesorios" value={order.device.accessories} />
            <Row label="Estado" value={order.device.aesthetic_condition} />
          </SectionBox>
        </div>

        {/* Detalle técnico */}
        <SectionBox title="Detalle Técnico" accentColor="#8b5cf6">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Block label="Falla reportada" value={order.reported_issue} />
              <Block label="Diagnóstico" value={order.diagnosis || '—'} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Block label="Trabajo a realizar" value={order.labor} />
              {!order.orderItems && <Block label="Repuestos" value={order.parts_used} />}
              {order.observations && <Block label="Observaciones" value={order.observations} />}
            </div>
          </div>
          {/* Tabla de ítems (sin costos internos) */}
          {order.orderItems && order.orderItems.length > 0 && (
            <div style={{ marginTop: '4px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '7.5px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f1f5f9' }}>
                    <th style={{ textAlign: 'left', padding: '2px 4px', color: '#475569', fontWeight: 700 }}>Descripción</th>
                    <th style={{ textAlign: 'center', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '30px' }}>Cant.</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '65px' }}>Precio unit.</th>
                    <th style={{ textAlign: 'right', padding: '2px 4px', color: '#475569', fontWeight: 700, width: '65px' }}>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {order.orderItems.map((item, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '2px 4px', color: '#1e293b' }}>
                        {item.descripcion}
                        {item.tipo === 'repuesto' && !item.cliente_paga_repuesto && (
                          <span style={{ fontSize: '6.5px', color: '#f59e0b', marginLeft: '3px' }}>(no cobrado)</span>
                        )}
                      </td>
                      <td style={{ padding: '2px 4px', textAlign: 'center', color: '#475569' }}>{item.cantidad}</td>
                      <td style={{ padding: '2px 4px', textAlign: 'right', color: '#475569' }}>{fmtCurrency(item.precio_unitario)}</td>
                      <td style={{ padding: '2px 4px', textAlign: 'right', color: '#1e293b', fontWeight: 600 }}>
                        {(item.tipo === 'servicio' || item.cliente_paga_repuesto) ? fmtCurrency(item.precio_unitario * item.cantidad) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} style={{ padding: '3px 4px', textAlign: 'right', fontSize: '8px', fontWeight: 700, color: '#1e293b', borderTop: '1.5px solid #cbd5e1' }}>TOTAL AL CLIENTE</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right', fontSize: '9px', fontWeight: 700, color: '#059669', borderTop: '1.5px solid #cbd5e1' }}>{fmtCurrency(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {!order.orderItems && total > 0 && (
            <Row label="Presupuesto" value={fmtCurrency(total)} />
          )}
        </SectionBox>

        {/* Condiciones del servicio */}
        {showTermsInCopy('local') && (
          <div style={{ padding: '4px 7px', backgroundColor: '#fffbeb', borderRadius: '4px', border: '1px solid #fde68a', flexShrink: 0 }}>
            <div style={{ fontSize: '7px', fontWeight: 700, color: '#92400e', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Condiciones del servicio</div>
            <div style={{ fontSize: '6.5px', color: '#78350f', lineHeight: '1.35', whiteSpace: 'pre-line' }}>
              {s.orden_condiciones}
            </div>
          </div>
        )}

        {/* Firma y datos */}
        <div style={{ paddingTop: '5px', borderTop: '1px solid #e2e8f0', flexShrink: 0 }}>
          <div style={{ marginBottom: '3px', fontSize: '7.5px', color: '#64748b' }}>
            El cliente declara haber leído y aceptado las condiciones del servicio.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <div style={{ fontSize: '7.5px', color: '#64748b', marginBottom: '2px' }}>Firma del cliente</div>
              <div style={{ height: '20px', borderBottom: '1px solid #94a3b8' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '6px' }}>
              <div style={{ fontSize: '7.5px', color: '#64748b' }}>Aclaración: ______________________</div>
              <div style={{ fontSize: '7.5px', color: '#64748b' }}>DNI: ___________  Fecha: __/__/____</div>
            </div>
          </div>
        </div>
      </div>
    )

    // ── Contenido de la hoja ──────────────────────────────────────────────────
    const pageContent = (
      <>
        {renderClientCopy()}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 14px', flexShrink: 0 }}>
          <div style={{ flex: 1, borderTop: '1.5px dashed #94a3b8' }} />
          <span style={{ fontSize: '7.5px', color: '#94a3b8', whiteSpace: 'nowrap', fontWeight: 500, letterSpacing: '0.5px' }}>✂ CORTAR POR AQUÍ</span>
          <div style={{ flex: 1, borderTop: '1.5px dashed #94a3b8' }} />
        </div>
        {renderLocalCopy()}
      </>
    )

    // ── Render ────────────────────────────────────────────────────────────────
    // previewMode: ancho fijo en px (no mm) para que la escala CSS sea exacta
    if (previewMode) {
      return (
        <div
          ref={ref}
          className="sop-page"
          style={{
            backgroundColor: '#ffffff',
            width: '794px',        // 210mm @ 96dpi exacto
            minHeight: '1123px',   // 297mm @ 96dpi exacto
            display: 'flex',
            flexDirection: 'column',
            fontFamily: "'Inter', 'Segoe UI', sans-serif",
            boxSizing: 'border-box',
          }}
        >
          {pageContent}
        </div>
      )
    }

    return (
      <div className="sop-screen-wrapper" style={{ padding: '16px', backgroundColor: '#e2e8f0', fontFamily: "'Inter', 'Segoe UI', sans-serif" }}>
        <div
          ref={ref}
          className="sop-page"
          style={{
            backgroundColor: '#ffffff',
            width: '210mm',
            minHeight: '297mm',
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          }}
        >
          {pageContent}
        </div>
        <style>{PRINT_STYLES}</style>
      </div>
    )
  }
)

ServiceOrderPrint.displayName = 'ServiceOrderPrint'
