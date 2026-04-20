import React from 'react'
import {
  CHECKLIST_ITEMS,
  Warranty,
  computeWarrantyStatus,
} from '../../hooks/useWarranties'
import type { OrderPrintSettings } from '../../hooks/useOrderPrintSettings'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface WarrantyPrintLayoutProps {
  warranty: Warranty
  settings: OrderPrintSettings
  /** Mostrar la línea de corte (y duplicar el contenido para cliente/local). Default: true */
  duplicate?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso)
    return d.toLocaleDateString('es-AR')
  } catch {
    return iso
  }
}

// ─── Estilos compartidos (inline para impresión confiable) ────────────────────

const stylesheet = `
@page {
  size: A4 portrait;
  margin: 10mm;
}

.wp-root {
  width: 190mm;
  margin: 0 auto;
  background: #ffffff;
  color: #111827;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 10pt;
  line-height: 1.35;
}

.wp-copy {
  padding: 2mm 0;
}

.wp-cut {
  border: 0;
  border-top: 1px dashed #94a3b8;
  margin: 6mm 0;
  position: relative;
  text-align: center;
}

.wp-cut::after {
  content: '✂  corte aquí';
  position: absolute;
  top: -8pt;
  left: 50%;
  transform: translateX(-50%);
  background: #ffffff;
  color: #64748b;
  font-size: 8pt;
  padding: 0 6pt;
  letter-spacing: 0.02em;
}

.wp-header {
  display: flex;
  align-items: center;
  gap: 6mm;
  padding-bottom: 3mm;
  border-bottom: 2px solid #111827;
  margin-bottom: 3mm;
}

.wp-logo {
  width: 18mm;
  height: 18mm;
  object-fit: contain;
  flex-shrink: 0;
}

.wp-biz h1 {
  margin: 0;
  font-size: 14pt;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.wp-biz .wp-sub {
  margin: 0;
  font-size: 8.5pt;
  color: #475569;
}

.wp-biz .wp-contact {
  margin-top: 1mm;
  font-size: 8.5pt;
  color: #334155;
  display: flex;
  flex-wrap: wrap;
  gap: 3mm;
}

.wp-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 3mm;
}

.wp-title {
  margin: 0;
  font-size: 13pt;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.wp-number {
  font-size: 10pt;
  font-weight: 700;
  color: #1e293b;
  border: 1px solid #94a3b8;
  padding: 1mm 3mm;
  border-radius: 2mm;
  background: #f8fafc;
}

.wp-copy-label {
  display: inline-block;
  margin-left: 2mm;
  padding: 0.5mm 2mm;
  font-size: 8pt;
  font-weight: 600;
  border-radius: 1mm;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #ffffff;
  background: #6366f1;
}

.wp-copy-label.local {
  background: #0f172a;
}

.wp-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2mm 6mm;
  border: 1px solid #cbd5e1;
  border-radius: 2mm;
  padding: 2.5mm 3mm;
  background: #f8fafc;
  margin-bottom: 3mm;
}

.wp-field {
  display: flex;
  flex-direction: column;
  gap: 0.5mm;
  min-width: 0;
}

.wp-field .wp-label {
  font-size: 7.5pt;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  font-weight: 600;
}

.wp-field .wp-value {
  font-size: 9.5pt;
  color: #0f172a;
  font-weight: 600;
  word-break: break-word;
}

.wp-section-title {
  font-size: 9.5pt;
  font-weight: 700;
  color: #0f172a;
  margin: 3mm 0 1.5mm 0;
  padding-bottom: 0.5mm;
  border-bottom: 1px solid #cbd5e1;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.wp-checklist {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.8mm 5mm;
}

.wp-chk-item {
  display: flex;
  align-items: flex-start;
  gap: 1.5mm;
  font-size: 8.5pt;
  color: #1f2937;
}

.wp-chk-box {
  flex: 0 0 auto;
  width: 3mm;
  height: 3mm;
  border: 1px solid #475569;
  border-radius: 0.5mm;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 7pt;
  font-weight: 800;
  color: #111827;
  line-height: 1;
  margin-top: 0.6mm;
}

.wp-chk-box.checked {
  background: #111827;
  color: #ffffff;
}

.wp-text {
  font-size: 9pt;
  color: #1f2937;
  white-space: pre-wrap;
  margin: 1mm 0 0 0;
}

.wp-conditions {
  font-size: 8pt;
  color: #334155;
  white-space: pre-wrap;
  border: 1px dashed #94a3b8;
  border-radius: 2mm;
  padding: 2mm 3mm;
  background: #f8fafc;
  margin-top: 2mm;
}

.wp-status {
  display: inline-block;
  padding: 0.5mm 2.5mm;
  border-radius: 2mm;
  font-size: 8.5pt;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.wp-status.active {
  background: #dcfce7;
  color: #166534;
  border: 1px solid #86efac;
}
.wp-status.expiring {
  background: #fef9c3;
  color: #854d0e;
  border: 1px solid #fde68a;
}
.wp-status.expired {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}

.wp-footer {
  display: flex;
  justify-content: space-between;
  gap: 8mm;
  margin-top: 6mm;
}

.wp-signature {
  flex: 1;
  text-align: center;
  font-size: 8.5pt;
  color: #334155;
}

.wp-sig-line {
  height: 12mm;
  border-bottom: 1px solid #0f172a;
  margin-bottom: 1.5mm;
}

.wp-attended {
  font-size: 8pt;
  color: #64748b;
  margin-top: 1mm;
}

.wp-thanks {
  text-align: center;
  font-size: 9pt;
  color: #334155;
  font-style: italic;
  margin-top: 3mm;
}

@media screen {
  .wp-root {
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    padding: 8mm;
  }
}
`

// ─── Sub-bloque reutilizable para cada copia ──────────────────────────────────

function Copy(props: {
  warranty: Warranty
  settings: OrderPrintSettings
  copyLabel: 'cliente' | 'local'
}) {
  const { warranty, settings, copyLabel } = props

  const { status, expiryDate, daysRemaining } = computeWarrantyStatus(
    warranty.issue_date,
    warranty.warranty_days
  )

  const statusInfo =
    status === 'active'
      ? { cls: 'active', label: 'VIGENTE' }
      : status === 'expiring_soon'
      ? { cls: 'expiring', label: 'POR VENCER' }
      : { cls: 'expired', label: 'VENCIDA' }

  const checklist = warranty.checklist || {}

  const mostrarCondiciones =
    settings.orden_mostrar_condiciones &&
    settings.orden_condiciones_activo &&
    (settings.orden_condiciones_en === 'ambas' ||
      settings.orden_condiciones_en === copyLabel)

  const contactParts: string[] = []
  if (settings.orden_mostrar_whatsapp && settings.orden_whatsapp)
    contactParts.push(`WhatsApp: ${settings.orden_whatsapp}`)
  if (settings.orden_mostrar_instagram && settings.orden_instagram)
    contactParts.push(`IG: ${settings.orden_instagram}`)
  if (settings.orden_mostrar_email && settings.orden_email_visible)
    contactParts.push(settings.orden_email_visible)
  if (settings.orden_mostrar_sitio_web && settings.orden_sitio_web)
    contactParts.push(settings.orden_sitio_web)

  const addressLine = [settings.domicilio_fiscal, settings.localidad, settings.provincia]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="wp-copy">
      {/* Header del negocio */}
      <div className="wp-header">
        {settings.orden_mostrar_logo && settings.logo_url ? (
          <img src={settings.logo_url} alt="logo" className="wp-logo" />
        ) : null}
        <div className="wp-biz" style={{ flex: 1 }}>
          <h1>{settings.nombre_comercial || 'Mi Negocio'}</h1>
          {settings.orden_mostrar_direccion && addressLine && (
            <p className="wp-sub">{addressLine}</p>
          )}
          {contactParts.length > 0 && (
            <div className="wp-contact">
              {contactParts.map((c, i) => (
                <span key={i}>{c}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Title */}
      <div className="wp-title-row">
        <div>
          <span className="wp-title">CERTIFICADO DE GARANTÍA</span>
          <span className={`wp-copy-label ${copyLabel}`}>
            {copyLabel === 'cliente' ? 'Cliente' : 'Local'}
          </span>
        </div>
        <div className="wp-number">N° {warranty.number}</div>
      </div>

      {/* Info grid */}
      <div className="wp-grid">
        <div className="wp-field">
          <span className="wp-label">Fecha de emisión</span>
          <span className="wp-value">{fmtDate(warranty.issue_date)}</span>
        </div>
        <div className="wp-field">
          <span className="wp-label">Estado</span>
          <span className="wp-value">
            <span className={`wp-status ${statusInfo.cls}`}>{statusInfo.label}</span>
            {status !== 'expired' && (
              <span style={{ marginLeft: '2mm', color: '#475569', fontWeight: 500 }}>
                {daysRemaining} día{daysRemaining === 1 ? '' : 's'} restantes
              </span>
            )}
          </span>
        </div>

        <div className="wp-field">
          <span className="wp-label">Cliente</span>
          <span className="wp-value">{warranty.customer_name || '-'}</span>
        </div>
        <div className="wp-field">
          <span className="wp-label">DNI</span>
          <span className="wp-value">{warranty.customer_dni || '-'}</span>
        </div>

        <div className="wp-field">
          <span className="wp-label">Teléfono</span>
          <span className="wp-value">{warranty.customer_phone || '-'}</span>
        </div>
        <div className="wp-field">
          <span className="wp-label">Condición del equipo</span>
          <span className="wp-value">
            {warranty.equipment_status === 'new' ? 'Nuevo' : 'Usado'}
            {warranty.equipment_status === 'used' && warranty.purchase_date && (
              <span style={{ color: '#475569', fontWeight: 500 }}>
                {' '}· compra {fmtDate(warranty.purchase_date)}
              </span>
            )}
          </span>
        </div>

        <div className="wp-field">
          <span className="wp-label">Modelo</span>
          <span className="wp-value">{warranty.phone_model || '-'}</span>
        </div>
        <div className="wp-field">
          <span className="wp-label">IMEI / Serial</span>
          <span className="wp-value">
            {warranty.imei || warranty.serial_number || '-'}
          </span>
        </div>

        <div className="wp-field">
          <span className="wp-label">Días de garantía</span>
          <span className="wp-value">{warranty.warranty_days} días</span>
        </div>
        <div className="wp-field">
          <span className="wp-label">Fecha de vencimiento</span>
          <span className="wp-value">{fmtDate(expiryDate)}</span>
        </div>
      </div>

      {/* Checklist */}
      <div className="wp-section-title">Checklist de verificación</div>
      <div className="wp-checklist">
        {CHECKLIST_ITEMS.map((it) => {
          const checked = !!checklist[it.key]
          return (
            <div key={it.key} className="wp-chk-item">
              <span className={`wp-chk-box ${checked ? 'checked' : ''}`}>
                {checked ? '✓' : ''}
              </span>
              <span>{it.label}</span>
            </div>
          )
        })}
      </div>

      {/* Observations */}
      {warranty.observations && (
        <>
          <div className="wp-section-title">Observaciones</div>
          <p className="wp-text">{warranty.observations}</p>
        </>
      )}

      {/* Conditions */}
      {mostrarCondiciones && warranty.conditions && (
        <>
          <div className="wp-section-title">Condiciones de la garantía</div>
          <div className="wp-conditions">{warranty.conditions}</div>
        </>
      )}

      {/* Signature + attended by */}
      <div className="wp-footer">
        <div className="wp-signature">
          <div className="wp-sig-line" />
          <div>Firma del cliente</div>
          <div style={{ marginTop: '1mm', color: '#64748b' }}>
            DNI: {warranty.customer_dni || '________________'}
          </div>
          <div style={{ color: '#64748b' }}>
            Aclaración: {warranty.customer_name || '________________'}
          </div>
        </div>
        <div className="wp-signature">
          <div className="wp-sig-line" />
          <div>Firma y sello del local</div>
          {warranty.attended_by_name && (
            <div className="wp-attended">Atendido por: {warranty.attended_by_name}</div>
          )}
        </div>
      </div>

      {settings.orden_mostrar_agradecimiento &&
        settings.orden_mensaje_agradecimiento && (
          <div className="wp-thanks">{settings.orden_mensaje_agradecimiento}</div>
        )}
    </div>
  )
}

// ─── Componente principal (con forwardRef para react-to-print) ────────────────

export const WarrantyPrintLayout = React.forwardRef<HTMLDivElement, WarrantyPrintLayoutProps>(
  ({ warranty, settings, duplicate = true }, ref) => {
    return (
      <div ref={ref} className="wp-root">
        <style>{stylesheet}</style>
        <Copy warranty={warranty} settings={settings} copyLabel="cliente" />
        {duplicate && (
          <>
            <hr className="wp-cut" />
            <Copy warranty={warranty} settings={settings} copyLabel="local" />
          </>
        )}
      </div>
    )
  }
)

WarrantyPrintLayout.displayName = 'WarrantyPrintLayout'
