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
  duplicate?: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso)
    return d.toLocaleDateString('es-AR')
  } catch { return iso }
}

// ─── Sub-components (mismo estilo que ServiceOrderPrint) ──────────────────────

const Row = ({ label, value }: { label: string; value?: string | null }) =>
  value ? (
    <div style={{ display: 'flex', gap: '4px', fontSize: '11px', lineHeight: 1.4 }}>
      <span style={{ color: '#475569', fontWeight: 600, minWidth: '90px', flexShrink: 0 }}>{label}:</span>
      <span style={{ color: '#0f172a', fontWeight: 400, wordBreak: 'break-word', flex: 1 }}>{value}</span>
    </div>
  ) : null

const Section = ({ title, accent = '#6366f1', children }: {
  title: string; accent?: string; children: React.ReactNode
}) => (
  <div style={{ border: '1px solid #e2e8f0', borderRadius: '5px', padding: '6px 9px' }}>
    <h3 style={{
      fontSize: '10px', fontWeight: 700, color: '#1e293b', margin: '0 0 5px 0',
      paddingBottom: '4px', borderBottom: `2px solid ${accent}`,
      textTransform: 'uppercase', letterSpacing: '0.6px',
    }}>{title}</h3>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>{children}</div>
  </div>
)

// ─── CSS mínimo (solo reset de fuente y page) ─────────────────────────────────

const PRINT_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  @page { size: A4 portrait; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    color: #0f172a;
  }
  a { color: inherit; text-decoration: none; }
  .wp-page-break { page-break-after: always; break-after: page; }
  @media screen {
    .wp-page-break { display: none; }
    .wp-cut-screen {
      border-top: 1px dashed #94a3b8; margin: 8px 0; position: relative; text-align: center;
    }
    .wp-cut-screen::after {
      content: '✂  corte aquí'; position: absolute; top: -8px; left: 50%;
      transform: translateX(-50%); background: #fff; color: #94a3b8;
      font-size: 9px; padding: 0 6px;
    }
  }
`

// ─── Una copia del certificado ────────────────────────────────────────────────

function Copy({
  warranty, settings, copyLabel,
}: {
  warranty: Warranty
  settings: OrderPrintSettings
  copyLabel: 'cliente' | 'local'
}) {
  const { status, expiryDate, daysRemaining } = computeWarrantyStatus(
    warranty.issue_date, warranty.warranty_days
  )

  const statusColor =
    status === 'active' ? { bg: '#dcfce7', color: '#166534', border: '#86efac', label: 'VIGENTE' }
    : status === 'expiring_soon' ? { bg: '#fef9c3', color: '#854d0e', border: '#fde68a', label: 'POR VENCER' }
    : { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5', label: 'VENCIDA' }

  const checklist = warranty.checklist || {}
  const businessName = settings.nombre_comercial || settings.razon_social || 'Mi Negocio'

  const contactParts: string[] = []
  if (settings.orden_mostrar_direccion) {
    const addr = [settings.domicilio_fiscal, settings.localidad, settings.provincia].filter(Boolean).join(' · ')
    if (addr) contactParts.push(addr)
  }
  if (settings.orden_mostrar_whatsapp && settings.orden_whatsapp) contactParts.push(`WhatsApp: ${settings.orden_whatsapp}`)
  if (settings.orden_mostrar_instagram && settings.orden_instagram) contactParts.push(`IG: ${settings.orden_instagram}`)

  const showConditions = settings.orden_condiciones_activo && settings.orden_mostrar_condiciones &&
    (settings.orden_condiciones_en === 'ambas' || settings.orden_condiciones_en === copyLabel)

  return (
    <div style={{
      padding: '11mm 11mm 8mm',
      fontFamily: "'Inter','Segoe UI',Arial,sans-serif",
      color: '#0f172a',
      display: 'flex', flexDirection: 'column', gap: '6px',
      position: 'relative',
    }}>
      {/* Marca de agua del logo */}
      {settings.orden_mostrar_logo && settings.logo_url && (
        <img src={settings.logo_url} alt="" aria-hidden style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%,-50%)',
          width: '180px', height: '180px', objectFit: 'contain',
          opacity: 0.04, pointerEvents: 'none', zIndex: 0,
        }} />
      )}

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>

        {/* ── HEADER ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '2px' }}>
          {settings.orden_mostrar_logo && settings.logo_url ? (
            <img src={settings.logo_url} alt="Logo" style={{ width: '70px', height: '50px', objectFit: 'contain', flexShrink: 0 }} />
          ) : <div style={{ width: '70px', height: '50px', flexShrink: 0 }} />}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a', lineHeight: 1.1, marginBottom: '2px' }}>{businessName}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 12px' }}>
              {contactParts.map((c, i) => (
                <span key={i} style={{ fontSize: '10px', color: '#475569' }}>{c}</span>
              ))}
            </div>
          </div>

          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            <div style={{ fontSize: '9px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Certificado de Garantía</div>
            <div style={{ fontSize: '19px', fontWeight: 700, color: '#0f172a', letterSpacing: '-0.5px', lineHeight: 1.1 }}>N° {warranty.number}</div>
            <div style={{ fontSize: '9px', color: '#64748b', marginTop: '2px' }}>{fmtDate(warranty.issue_date)}</div>
          </div>
        </div>

        {/* ── BARRA DE ESTADO ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          backgroundColor: '#0f172a', borderRadius: '5px', padding: '5px 10px',
        }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#ffffff', flex: 1, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            CERTIFICADO DE GARANTÍA
          </span>
          <span style={{
            fontSize: '9px', fontWeight: 700, padding: '2px 8px', borderRadius: '3px',
            backgroundColor: copyLabel === 'cliente' ? '#6366f1' : '#334155',
            color: '#ffffff', textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>
            {copyLabel === 'cliente' ? 'CLIENTE' : 'LOCAL'}
          </span>
          <span style={{
            fontSize: '9.5px', fontWeight: 700, padding: '2px 8px', borderRadius: '3px',
            backgroundColor: statusColor.bg, color: statusColor.color,
            border: `1px solid ${statusColor.border}`,
          }}>
            {statusColor.label}
            {status !== 'expired' && ` · ${daysRemaining} día${daysRemaining === 1 ? '' : 's'}`}
          </span>
          <span style={{ fontSize: '9px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
            Vence: {fmtDate(expiryDate)}
          </span>
        </div>

        {/* ── DATOS DEL CLIENTE Y EQUIPO ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
          <Section title="Datos del cliente" accent="#6366f1">
            <Row label="Cliente" value={warranty.customer_name} />
            <Row label="DNI" value={warranty.customer_dni} />
            <Row label="Teléfono" value={warranty.customer_phone} />
          </Section>

          <Section title="Equipo" accent="#0ea5e9">
            <Row label="Modelo" value={warranty.phone_model} />
            <Row label="IMEI / Serial" value={warranty.imei || warranty.serial_number} />
            <Row label="Condición" value={warranty.equipment_status === 'new' ? 'Nuevo' : 'Usado'} />
            <Row label="Días de garantía" value={`${warranty.warranty_days} días`} />
          </Section>
        </div>

        {/* ── CHECKLIST ── */}
        <Section title="Checklist de verificación" accent="#10b981">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
            {CHECKLIST_ITEMS.map(it => {
              const checked = !!checklist[it.key]
              return (
                <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#1e293b' }}>
                  <span style={{
                    flexShrink: 0, width: '11px', height: '11px',
                    border: `1px solid ${checked ? '#0f172a' : '#94a3b8'}`,
                    borderRadius: '2px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '8px', fontWeight: 800,
                    backgroundColor: checked ? '#0f172a' : '#ffffff',
                    color: '#ffffff',
                  }}>
                    {checked ? '✓' : ''}
                  </span>
                  {it.label}
                </div>
              )
            })}
          </div>
        </Section>

        {/* ── OBSERVACIONES (si las hay) ── */}
        {warranty.observations && (
          <Section title="Observaciones" accent="#f59e0b">
            <p style={{ fontSize: '10.5px', color: '#0f172a', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
              {warranty.observations}
            </p>
          </Section>
        )}

        {/* ── CONDICIONES ── */}
        {showConditions && warranty.conditions && (
          <Section title="Condiciones de la garantía" accent="#ef4444">
            <p style={{ fontSize: '9.5px', color: '#334155', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
              {warranty.conditions}
            </p>
          </Section>
        )}

        {/* ── FIRMAS ── */}
        <div style={{ display: 'flex', gap: '20px', marginTop: '4px' }}>
          {/* Firma cliente */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '5px' }}>
              El cliente declara haber recibido el equipo en las condiciones indicadas.
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 2 }}>
                <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>Firma del cliente</div>
                <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>DNI</div>
                <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
              </div>
            </div>
            <div style={{ marginTop: '3px' }}>
              <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>Aclaración</div>
              <div style={{ borderBottom: '1px solid #94a3b8', height: '18px' }} />
            </div>
          </div>

          {/* Firma local */}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '5px' }}>
              {warranty.attended_by_name ? `Atendido por: ${warranty.attended_by_name}` : 'Firma y sello del local'}
            </div>
            <div>
              <div style={{ fontSize: '9px', color: '#64748b', marginBottom: '2px' }}>Firma y sello del local</div>
              <div style={{ borderBottom: '1px solid #94a3b8', height: '20px' }} />
            </div>
          </div>
        </div>

        {/* ── AGRADECIMIENTO (solo copia cliente) ── */}
        {copyLabel === 'cliente' && settings.orden_mostrar_agradecimiento && settings.orden_mensaje_agradecimiento && (
          <div style={{ textAlign: 'center', fontSize: '9.5px', color: '#64748b', fontStyle: 'italic', marginTop: '4px' }}>
            {settings.orden_mensaje_agradecimiento}
          </div>
        )}

      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export const WarrantyPrintLayout = React.forwardRef<HTMLDivElement, WarrantyPrintLayoutProps>(
  ({ warranty, settings, duplicate = true }, ref) => (
    <div ref={ref}>
      <style>{PRINT_STYLES}</style>
      <Copy warranty={warranty} settings={settings} copyLabel="cliente" />
      {duplicate && (
        <>
          {/* Pantalla: línea de corte visual */}
          <div className="wp-cut-screen" />
          {/* Impresión: salto de página forzado */}
          <div className="wp-page-break" />
          <Copy warranty={warranty} settings={settings} copyLabel="local" />
        </>
      )}
    </div>
  )
)

WarrantyPrintLayout.displayName = 'WarrantyPrintLayout'
