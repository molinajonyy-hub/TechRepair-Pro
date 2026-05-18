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
  previewMode?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

const STATUS_MAP: Record<string, { label: string; bg: string; color: string; border: string }> = {
  new:             { label: 'Recibida',              bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  received:        { label: 'Recibido',              bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  diagnosis:       { label: 'En diagnóstico',        bg: '#ffedd5', color: '#c2410c', border: '#fdba74' },
  budget_pending:  { label: 'Pdte. de presupuesto',  bg: '#fef9c3', color: '#a16207', border: '#fde047' },
  budget_approved: { label: 'Pres. aprobado',        bg: '#dcfce7', color: '#15803d', border: '#86efac' },
  in_repair:       { label: 'En reparación',         bg: '#ede9fe', color: '#7c3aed', border: '#c4b5fd' },
  waiting_parts:   { label: 'Esperando repuestos',   bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
  completed:       { label: 'Completado',            bg: '#dcfce7', color: '#15803d', border: '#86efac' },
  delivered:       { label: 'Entregado',             bg: '#f0fdf4', color: '#166534', border: '#4ade80' },
  cancelled:       { label: 'Cancelado',             bg: '#fee2e2', color: '#b91c1c', border: '#fca5a5' },
}

const getStatus = (status: string) =>
  STATUS_MAP[status] ?? { label: status.replace(/_/g, ' ').toUpperCase(), bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' }

const getDeviceTypeLabel = (type?: string) => {
  const map: Record<string, string> = {
    smartphone: 'Celular', celular: 'Celular', tablet: 'Tablet',
    laptop: 'Notebook', smartwatch: 'Smartwatch', other: 'Otro', otro: 'Otro',
  }
  return map[type || ''] || type || '-'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Fila label: valor en línea */
const Row = ({ label, value, bold }: { label: string; value?: string | null; bold?: boolean }) =>
  value ? (
    <div style={{ display: 'flex', gap: '4px', fontSize: '11px', lineHeight: '1.4' }}>
      <span style={{ color: '#475569', fontWeight: 600, minWidth: '78px', flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#0f172a', fontWeight: bold ? 700 : 400, wordBreak: 'break-word', flex: 1 }}>{value}</span>
    </div>
  ) : null

/** Bloque label en línea propia + valor abajo */
const Block = ({ label, value, minHeight }: { label: string; value?: string | null; minHeight?: number }) =>
  value ? (
    <div style={{ marginBottom: '2px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color: '#475569', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</div>
      <div style={{ fontSize: '11px', color: '#0f172a', lineHeight: '1.45', whiteSpace: 'pre-wrap', minHeight: minHeight ? `${minHeight}px` : undefined }}>{value}</div>
    </div>
  ) : null

/** Sección con título y borde de acento */
const Section = ({ title, children, accent = '#6366f1', style: extraStyle }: {
  title: string; children: React.ReactNode; accent?: string; style?: React.CSSProperties
}) => (
  <div style={{ border: '1px solid #e2e8f0', borderRadius: '5px', padding: '6px 9px', ...extraStyle }}>
    <h3 style={{
      fontSize: '10px', fontWeight: 700, color: '#1e293b', margin: '0 0 5px 0',
      paddingBottom: '4px', borderBottom: `2px solid ${accent}`,
      textTransform: 'uppercase', letterSpacing: '0.6px',
    }}>
      {title}
    </h3>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {children}
    </div>
  </div>
)

/** Línea de firma horizontal: Firma | Aclaración | DNI */
const SignatureRow = ({ label = 'Firma del cliente', showTech = false }: { label?: string; showTech?: boolean }) => (
  <div style={{ marginTop: '6px' }}>
    <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '5px' }}>
      {showTech
        ? 'Técnico responsable / Aclaración y legajo'
        : 'El cliente declara haber recibido y aceptado el equipo en las condiciones indicadas.'}
    </div>
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
      {/* Firma */}
      <div style={{ flex: '0 0 110px' }}>
        <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>{label}</div>
        <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
      </div>
      {/* Aclaración */}
      <div style={{ flex: '1' }}>
        <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>Aclaración</div>
        <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
      </div>
      {/* DNI */}
      <div style={{ flex: '0 0 90px' }}>
        <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>DNI</div>
        <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
      </div>
      {/* Fecha */}
      <div style={{ flex: '0 0 70px' }}>
        <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>Fecha</div>
        <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
      </div>
    </div>
  </div>
)

// ─── Print CSS ────────────────────────────────────────────────────────────────

const PRINT_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  @media print {
    @page { size: A4 portrait; margin: 0; }
    html, body {
      margin: 0 !important; padding: 0 !important;
      width: 210mm; height: 297mm;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
      font-family: 'Inter', 'Segoe UI', sans-serif;
    }
    .sop-screen-wrapper { padding: 0 !important; background: none !important; }
    .sop-page {
      width: 210mm !important; height: 297mm !important;
      min-height: unset !important; max-height: 297mm !important;
      overflow: hidden !important; box-shadow: none !important; margin: 0 !important;
    }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
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

    const itemsTotal = order.orderItems
      ? order.orderItems.reduce((sum, item) => {
          if (item.tipo === 'servicio' || item.cliente_paga_repuesto)
            return sum + item.precio_unitario * item.cantidad
          return sum
        }, 0)
      : null

    const orderNumber = order.id.slice(0, 8).toUpperCase()
    const orderDate = new Date(order.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: '2-digit', year: 'numeric' })
    const orderTime = new Date(order.created_at).toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Cordoba', hour: '2-digit', minute: '2-digit' })
    const total = itemsTotal !== null ? itemsTotal : (order.final_total || order.estimated_total || 0)
    const businessName = s.nombre_comercial || s.razon_social || 'Mi Negocio'
    const statusInfo = getStatus(order.status)

    // QR URL para seguimiento (usa servicio público)
    const qrData = `ORD-${orderNumber}`
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=56x56&data=${encodeURIComponent(qrData)}&bgcolor=ffffff&color=0f172a&margin=2`

    // Footer contact items
    const footerItems: string[] = []
    if (s.orden_mostrar_direccion && s.domicilio_fiscal) footerItems.push(`${s.domicilio_fiscal}${s.localidad ? `, ${s.localidad}` : ''}`)
    if (s.orden_mostrar_whatsapp && s.orden_whatsapp) footerItems.push(`WhatsApp: ${s.orden_whatsapp}`)
    if (s.orden_mostrar_instagram && s.orden_instagram) footerItems.push(`IG: ${s.orden_instagram}`)
    if (s.orden_mostrar_email && s.orden_email_visible) footerItems.push(s.orden_email_visible)
    if (s.orden_mostrar_sitio_web && s.orden_sitio_web) footerItems.push(s.orden_sitio_web)

    const showTerms = (copy: 'cliente' | 'local') => {
      if (!s.orden_condiciones_activo || !s.orden_mostrar_condiciones) return false
      if (s.orden_condiciones_en === 'ambas') return true
      return s.orden_condiciones_en === copy
    }

    // ── SHARED HEADER COMPONENTS ──────────────────────────────────────────────

    /** Header completo (mitad cliente) */
    const renderFullHeader = () => (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '7px', flexShrink: 0 }}>
        {/* Logo */}
        {s.orden_mostrar_logo && s.logo_url ? (
          <img src={s.logo_url} alt="Logo" style={{ width: '70px', height: '50px', objectFit: 'contain', flexShrink: 0 }} />
        ) : (
          <div style={{ width: '70px', height: '50px', flexShrink: 0 }} />
        )}

        {/* Datos del local */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a', lineHeight: 1.1, marginBottom: '2px' }}>{businessName}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 12px' }}>
            {footerItems.slice(0, 3).map((item, i) => (
              <span key={i} style={{ fontSize: '10px', color: '#475569' }}>{item}</span>
            ))}
          </div>
          {s.cuit && <div style={{ fontSize: '9.5px', color: '#64748b', marginTop: '1px' }}>CUIT: {s.cuit}</div>}
        </div>

        {/* Orden info (derecha) */}
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{ fontSize: '9px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>ORDEN DE SERVICIO</div>
          <div style={{ fontSize: '19px', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.5px', lineHeight: 1.1 }}>N° {orderNumber}</div>
          <div style={{ fontSize: '9px', color: '#64748b', marginTop: '2px' }}>{orderDate} · {orderTime}</div>
          {/* QR */}
          <img src={qrUrl} alt={qrData} style={{ width: '42px', height: '42px', marginTop: '3px', borderRadius: '3px', border: '1px solid #e2e8f0' }} />
        </div>
      </div>
    )

    /** Header compacto (mitad taller) */
    const renderCompactHeader = () => (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexShrink: 0 }}>
        {s.orden_mostrar_logo && s.logo_url ? (
          <img src={s.logo_url} alt="Logo" style={{ width: '44px', height: '30px', objectFit: 'contain', flexShrink: 0 }} />
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>{businessName}</div>
          {footerItems[0] && <div style={{ fontSize: '9px', color: '#64748b' }}>{footerItems[0]}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>N° {orderNumber}</div>
          <div style={{ fontSize: '8.5px', color: '#64748b' }}>{orderDate} {orderTime}</div>
        </div>
      </div>
    )

    // ── MITAD SUPERIOR — CLIENTE ───────────────────────────────────────────────
    const renderClientCopy = () => (
      <div style={{
        flex: 1, padding: '11mm 11mm 8mm',
        display: 'flex', flexDirection: 'column', gap: '6px',
        fontFamily: "'Inter','Segoe UI',sans-serif",
        minHeight: 0, overflow: 'hidden', boxSizing: 'border-box',
        position: 'relative',
      }}>
        {/* Marca de agua */}
        {s.orden_mostrar_logo && s.logo_url && (
          <img src={s.logo_url} alt="" aria-hidden="true" style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '180px', height: '180px', objectFit: 'contain',
            opacity: 0.04, pointerEvents: 'none', zIndex: 0,
          }} />
        )}
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
          {renderFullHeader()}

          {/* Barra de estado + badge copia */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            backgroundColor: '#0f172a', borderRadius: '5px', padding: '5px 10px', flexShrink: 0,
          }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#fff', letterSpacing: '0.5px', flex: 1 }}>COPIA CLIENTE</span>
            <span style={{
              fontSize: '10px', fontWeight: 700, color: statusInfo.color,
              backgroundColor: statusInfo.bg, border: `1px solid ${statusInfo.border}`,
              padding: '2px 10px', borderRadius: '10px',
            }}>
              {statusInfo.label}
            </span>
            {order.technician && (
              <span style={{ fontSize: '9.5px', color: '#94a3b8' }}>Téc: {order.technician}</span>
            )}
          </div>

          {/* Cliente + Equipo — 2 columnas */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', flexShrink: 0 }}>
            <Section title="Datos del Cliente" accent="#059669">
              <Row label="Nombre" value={order.customer.name} bold />
              <Row label="Teléfono" value={order.customer.phone} />
              <Row label="DNI" value={order.customer.dni} />
              {order.customer.email && <Row label="Email" value={order.customer.email} />}
              {order.customer.address && <Row label="Dirección" value={order.customer.address} />}
            </Section>

            <Section title="Datos del Equipo" accent="#6366f1">
              {(order.device.brand || order.device.model) && (
                <Row label="Dispositivo" value={[order.device.brand, order.device.model].filter(Boolean).join(' ')} bold />
              )}
              {order.device.type && <Row label="Tipo" value={getDeviceTypeLabel(order.device.type)} />}
              {order.device.color && <Row label="Color" value={order.device.color} />}
              {order.device.imei && <Row label="IMEI" value={order.device.imei} />}
              {order.device.serial && <Row label="Serie" value={order.device.serial} />}
              {order.device.accessories && <Row label="Accesorios" value={order.device.accessories} />}
            </Section>
          </div>

          {/* Falla reportada — más espacio */}
          <Section title="Falla Reportada" accent="#f59e0b" style={{ flexShrink: 0 }}>
            <div style={{
              fontSize: '11.5px', color: '#0f172a', lineHeight: '1.5',
              minHeight: '32px', whiteSpace: 'pre-wrap',
            }}>
              {order.reported_issue || <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Sin descripción</span>}
            </div>
          </Section>

          {/* Items / total */}
          {order.orderItems && order.orderItems.length > 0 ? (
            <div style={{ flexShrink: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f1f5f9' }}>
                    <th style={{ textAlign: 'left', padding: '3px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px' }}>Descripción</th>
                    <th style={{ textAlign: 'center', padding: '3px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '32px' }}>Cant.</th>
                    <th style={{ textAlign: 'right', padding: '3px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '68px' }}>Precio</th>
                    <th style={{ textAlign: 'right', padding: '3px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '68px' }}>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {order.orderItems.filter(i => i.tipo === 'servicio' || i.cliente_paga_repuesto).map((item, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '3px 5px', color: '#1e293b' }}>
                        {item.descripcion}
                        <span style={{ fontSize: '8.5px', color: '#94a3b8', marginLeft: '3px' }}>
                          ({item.tipo === 'servicio' ? 'servicio' : 'repuesto'})
                        </span>
                      </td>
                      <td style={{ padding: '3px 5px', textAlign: 'center', color: '#475569' }}>{item.cantidad}</td>
                      <td style={{ padding: '3px 5px', textAlign: 'right', color: '#475569' }}>{fmtCurrency(item.precio_unitario)}</td>
                      <td style={{ padding: '3px 5px', textAlign: 'right', color: '#1e293b', fontWeight: 700 }}>{fmtCurrency(item.precio_unitario * item.cantidad)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > 0 && (
                <div style={{
                  display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px',
                  marginTop: '4px', padding: '4px 8px',
                  backgroundColor: '#f0fdf4', borderRadius: '4px', border: '1px solid #bbf7d0',
                }}>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>TOTAL</span>
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#059669' }}>{fmtCurrency(total)}</span>
                </div>
              )}
            </div>
          ) : total > 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '6px 10px', backgroundColor: '#f0fdf4', borderRadius: '4px', border: '1px solid #bbf7d0', flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: '9px', color: '#64748b' }}>Presupuesto estimado</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: '#059669' }}>{fmtCurrency(total)}</div>
              </div>
              <div style={{ fontSize: '9px', color: '#64748b', fontStyle: 'italic', flex: 1 }}>
                * Puede variar según diagnóstico final.
              </div>
            </div>
          ) : null}

          {/* Condiciones */}
          {showTerms('cliente') && (
            <div style={{
              padding: '5px 8px', backgroundColor: '#fffbeb',
              borderRadius: '4px', border: '1px solid #fde68a', flexShrink: 0,
            }}>
              <div style={{ fontSize: '8.5px', fontWeight: 700, color: '#92400e', marginBottom: '2px', textTransform: 'uppercase' }}>Condiciones del servicio</div>
              <div style={{ fontSize: '8px', color: '#78350f', lineHeight: '1.35', whiteSpace: 'pre-line' }}>
                {s.orden_condiciones}
              </div>
            </div>
          )}

          {/* Footer agradecimiento */}
          {s.orden_mostrar_agradecimiento && s.orden_mensaje_agradecimiento && (
            <div style={{ textAlign: 'center', fontSize: '10px', fontWeight: 600, color: '#6366f1', fontStyle: 'italic', flexShrink: 0 }}>
              {s.orden_mensaje_agradecimiento}
            </div>
          )}

        </div>
      </div>
    )

    // ── MITAD INFERIOR — TALLER ────────────────────────────────────────────────
    const renderLocalCopy = () => (
      <div style={{
        flex: 1, padding: '8mm 11mm 10mm',
        display: 'flex', flexDirection: 'column', gap: '5px',
        fontFamily: "'Inter','Segoe UI',sans-serif",
        minHeight: 0, overflow: 'hidden', boxSizing: 'border-box',
      }}>
        {renderCompactHeader()}

        {/* Barra título taller */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          backgroundColor: '#1e293b', borderRadius: '5px', padding: '5px 10px', flexShrink: 0,
        }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#fff', letterSpacing: '0.5px', flex: 1 }}>USO INTERNO — COPIA LOCAL</span>
          <span style={{
            fontSize: '10px', fontWeight: 700,
            color: statusInfo.color, backgroundColor: statusInfo.bg,
            border: `1px solid ${statusInfo.border}`,
            padding: '2px 10px', borderRadius: '10px',
          }}>
            {statusInfo.label}
          </span>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#818cf8' }}>N° {orderNumber}</span>
        </div>

        {/* Resumen cliente + equipo en 1 línea cada uno */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', flexShrink: 0 }}>
          <Section title="Cliente" accent="#059669">
            <Row label="Nombre" value={order.customer.name} bold />
            <Row label="Teléfono" value={order.customer.phone} />
            <Row label="DNI" value={order.customer.dni || '—'} />
            {order.customer.email && <Row label="Email" value={order.customer.email} />}
            {order.customer.address && <Row label="Dirección" value={order.customer.address} />}
          </Section>

          <Section title="Equipo" accent="#6366f1">
            {(order.device.brand || order.device.model) && (
              <Row label="Dispositivo" value={[order.device.brand, order.device.model].filter(Boolean).join(' ')} bold />
            )}
            {order.device.type && <Row label="Tipo" value={getDeviceTypeLabel(order.device.type)} />}
            {order.device.color && <Row label="Color" value={order.device.color} />}
            {order.device.imei && <Row label="IMEI" value={order.device.imei} />}
            {order.device.serial && <Row label="Serie" value={order.device.serial} />}
            {order.device.password && <Row label="Contraseña" value={order.device.password} />}
            {order.device.aesthetic_condition && <Row label="Estado estético" value={order.device.aesthetic_condition} />}
            {order.device.accessories && <Row label="Accesorios" value={order.device.accessories} />}
          </Section>
        </div>

        {/* Diagnóstico + Trabajo — 2 columnas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', flexShrink: 0 }}>
          <Section title="Diagnóstico técnico" accent="#8b5cf6">
            <Block label="Falla reportada" value={order.reported_issue} />
            <Block label="Diagnóstico" value={order.diagnosis || '—'} />
          </Section>
          <Section title="Trabajo realizado" accent="#0ea5e9">
            <Block label="Trabajo" value={order.labor} />
            {!order.orderItems && <Block label="Repuestos" value={order.parts_used} />}
            {order.observations && <Block label="Observaciones" value={order.observations} />}
          </Section>
        </div>

        {/* Repuestos — tabla o texto */}
        {order.orderItems && order.orderItems.length > 0 && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: '5px', padding: '6px 9px', flexShrink: 0 }}>
            <h3 style={{ fontSize: '10px', fontWeight: 700, color: '#1e293b', margin: '0 0 5px 0', paddingBottom: '4px', borderBottom: '2px solid #f59e0b', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
              Repuestos y Servicios
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10.5px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f8fafc' }}>
                  <th style={{ textAlign: 'left', padding: '2px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px' }}>Descripción</th>
                  <th style={{ textAlign: 'center', padding: '2px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '32px' }}>Cant.</th>
                  <th style={{ textAlign: 'right', padding: '2px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '68px' }}>Precio unit.</th>
                  <th style={{ textAlign: 'right', padding: '2px 5px', color: '#475569', fontWeight: 700, fontSize: '9.5px', width: '68px' }}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {order.orderItems.map((item, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '2px 5px', color: '#1e293b' }}>
                      {item.descripcion}
                      {item.tipo === 'repuesto' && !item.cliente_paga_repuesto && (
                        <span style={{ fontSize: '8px', color: '#f59e0b', marginLeft: '3px' }}>(no cobrado al cliente)</span>
                      )}
                    </td>
                    <td style={{ padding: '2px 5px', textAlign: 'center', color: '#475569' }}>{item.cantidad}</td>
                    <td style={{ padding: '2px 5px', textAlign: 'right', color: '#475569' }}>{fmtCurrency(item.precio_unitario)}</td>
                    <td style={{ padding: '2px 5px', textAlign: 'right', color: '#1e293b', fontWeight: 700 }}>
                      {(item.tipo === 'servicio' || item.cliente_paga_repuesto) ? fmtCurrency(item.precio_unitario * item.cantidad) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ padding: '3px 5px', textAlign: 'right', fontSize: '9.5px', fontWeight: 700, color: '#1e293b', borderTop: '1.5px solid #cbd5e1' }}>TOTAL AL CLIENTE</td>
                  <td style={{ padding: '3px 5px', textAlign: 'right', fontSize: '11px', fontWeight: 700, color: '#059669', borderTop: '1.5px solid #cbd5e1' }}>{fmtCurrency(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Checklist técnico */}
        <Section title="Checklist técnico" accent="#64748b" style={{ flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px' }}>
            {[
              'Pantalla / Display', 'Batería', 'Cámara', 'Micrófono / Altavoz',
              'Conectores y puertos', 'Botones físicos', 'Touch / Táctil', 'Software / Sistema',
            ].map((item) => (
              <div key={item} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#334155' }}>
                <div style={{ width: '11px', height: '11px', border: '1px solid #94a3b8', borderRadius: '2px', flexShrink: 0 }} />
                {item}
              </div>
            ))}
          </div>
          <div style={{ marginTop: '4px', fontSize: '9px', color: '#64748b' }}>
            Observaciones internas: ____________________________________________
          </div>
        </Section>

        {/* Condiciones taller */}
        {showTerms('local') && (
          <div style={{
            padding: '4px 8px', backgroundColor: '#fffbeb',
            borderRadius: '4px', border: '1px solid #fde68a', flexShrink: 0,
          }}>
            <div style={{ fontSize: '8.5px', fontWeight: 700, color: '#92400e', marginBottom: '2px', textTransform: 'uppercase' }}>Condiciones del servicio</div>
            <div style={{ fontSize: '7.5px', color: '#78350f', lineHeight: '1.35', whiteSpace: 'pre-line' }}>
              {s.orden_condiciones}
            </div>
          </div>
        )}

        {/* Firma del cliente — solo en copia local */}
        <SignatureRow label="Firma del cliente" />
      </div>
    )

    // ── Contenido completo A4 ─────────────────────────────────────────────────
    const pageContent = (
      <>
        {renderClientCopy()}
        {/* Línea de corte */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '1px 14px', flexShrink: 0 }}>
          <div style={{ flex: 1, borderTop: '1.5px dashed #94a3b8' }} />
          <span style={{ fontSize: '8px', color: '#94a3b8', whiteSpace: 'nowrap', fontWeight: 500, letterSpacing: '0.5px' }}>✂ CORTAR POR AQUÍ</span>
          <div style={{ flex: 1, borderTop: '1.5px dashed #94a3b8' }} />
        </div>
        {renderLocalCopy()}
      </>
    )

    // ── Render ────────────────────────────────────────────────────────────────
    if (previewMode) {
      return (
        <div
          ref={ref}
          className="sop-page"
          style={{
            backgroundColor: '#ffffff',
            width: '794px',
            minHeight: '1123px',
            display: 'flex',
            flexDirection: 'column',
            fontFamily: "'Inter','Segoe UI',sans-serif",
            boxSizing: 'border-box',
          }}
        >
          {pageContent}
        </div>
      )
    }

    return (
      <div className="sop-screen-wrapper" style={{ padding: '16px', backgroundColor: '#e2e8f0', fontFamily: "'Inter','Segoe UI',sans-serif" }}>
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
