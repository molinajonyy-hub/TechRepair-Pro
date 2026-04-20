import { useRef } from 'react'
import { useReactToPrint } from 'react-to-print'
import { CloseButton } from '../ui/CloseButton'
import { Printer, Pencil, Copy as CopyIcon, Trash2 } from 'lucide-react'
import { Warranty, computeWarrantyStatus, CHECKLIST_ITEMS } from '../../hooks/useWarranties'
import { OrderPrintSettings } from '../../hooks/useOrderPrintSettings'
import { WarrantyPrintLayout } from './WarrantyPrintLayout'

interface WarrantyDetailModalProps {
  open: boolean
  onClose: () => void
  warranty: Warranty | null
  settings: OrderPrintSettings
  onEdit?: (w: Warranty) => void
  onDuplicate?: (w: Warranty) => void
  onDelete?: (w: Warranty) => void
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso)
    return d.toLocaleDateString('es-AR')
  } catch {
    return iso
  }
}

export function WarrantyDetailModal({
  open,
  onClose,
  warranty,
  settings,
  onEdit,
  onDuplicate,
  onDelete,
}: WarrantyDetailModalProps) {
  const printRef = useRef<HTMLDivElement>(null)

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: warranty ? `Garantia-${warranty.number}` : 'Garantia',
  })

  if (!open || !warranty) return null

  const { status, expiryDate, daysRemaining } = computeWarrantyStatus(
    warranty.issue_date,
    warranty.warranty_days
  )

  const statusBadge =
    status === 'active'
      ? { bg: 'rgba(34,197,94,0.15)', color: '#86efac', border: 'rgba(34,197,94,0.35)', text: '🟢 Vigente' }
      : status === 'expiring_soon'
      ? { bg: 'rgba(234,179,8,0.15)', color: '#fde68a', border: 'rgba(234,179,8,0.35)', text: '🟡 Por vencer' }
      : { bg: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: 'rgba(239,68,68,0.35)', text: '🔴 Vencida' }

  const checklistEntries = CHECKLIST_ITEMS.map((it) => ({
    ...it,
    checked: !!warranty.checklist?.[it.key],
  }))

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 70,
        padding: '1rem',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          backgroundColor: '#0b1120',
          borderRadius: '1rem',
          border: '1px solid rgba(255,255,255,0.08)',
          width: '100%',
          maxWidth: '720px',
          maxHeight: '92vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '1.1rem 1.5rem',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <div>
            <h2
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: '#ffffff',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              Garantía {warranty.number}
              <span
                style={{
                  padding: '0.2rem 0.65rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  borderRadius: '999px',
                  background: statusBadge.bg,
                  color: statusBadge.color,
                  border: `1px solid ${statusBadge.border}`,
                }}
              >
                {statusBadge.text}
              </span>
            </h2>
            <p style={{ fontSize: '0.8125rem', color: '#64748b', margin: '0.25rem 0 0 0' }}>
              Emitida el {fmtDate(warranty.issue_date)} · vence el {fmtDate(expiryDate)} (
              {daysRemaining >= 0 ? `${daysRemaining} día${daysRemaining === 1 ? '' : 's'} restantes` : `${Math.abs(daysRemaining)} día(s) vencida`})
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Body */}
        <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '0.75rem 1.5rem',
              marginBottom: '1rem',
            }}
          >
            <DetailRow label="Cliente" value={warranty.customer_name} />
            <DetailRow label="DNI" value={warranty.customer_dni} />
            <DetailRow label="Teléfono" value={warranty.customer_phone} />
            <DetailRow
              label="Condición"
              value={
                warranty.equipment_status === 'new'
                  ? 'Nuevo'
                  : `Usado${warranty.purchase_date ? ` · compra ${fmtDate(warranty.purchase_date)}` : ''}`
              }
            />
            <DetailRow label="Modelo" value={warranty.phone_model} />
            <DetailRow label="IMEI / Serial" value={warranty.imei || warranty.serial_number} />
            <DetailRow label="Días de garantía" value={`${warranty.warranty_days} días`} />
            <DetailRow label="Atendido por" value={warranty.attended_by_name} />
          </div>

          <div
            style={{
              marginTop: '0.75rem',
              padding: '0.85rem 1rem',
              background: 'rgba(15,23,42,0.5)',
              border: '1px solid rgba(51,65,85,0.6)',
              borderRadius: '0.625rem',
            }}
          >
            <div style={{ fontWeight: 600, color: '#f1f5f9', marginBottom: '0.5rem' }}>
              Checklist de verificación
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: '0.25rem 0.75rem',
              }}
            >
              {checklistEntries.map((it) => (
                <div
                  key={it.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '0.8125rem',
                    color: it.checked ? '#d1fae5' : '#64748b',
                  }}
                >
                  <span
                    style={{
                      width: '16px',
                      height: '16px',
                      borderRadius: '3px',
                      border: `1px solid ${it.checked ? '#22c55e' : '#475569'}`,
                      background: it.checked ? '#22c55e' : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#0f172a',
                      fontSize: '11px',
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {it.checked ? '✓' : ''}
                  </span>
                  <span>{it.label}</span>
                </div>
              ))}
            </div>
          </div>

          {warranty.observations && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
                Observaciones
              </div>
              <div
                style={{
                  background: 'rgba(15,23,42,0.5)',
                  border: '1px solid rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  padding: '0.75rem 0.9rem',
                  color: '#e2e8f0',
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {warranty.observations}
              </div>
            </div>
          )}

          {warranty.conditions && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
                Condiciones
              </div>
              <div
                style={{
                  background: 'rgba(15,23,42,0.5)',
                  border: '1px dashed rgba(51,65,85,0.6)',
                  borderRadius: '0.5rem',
                  padding: '0.75rem 0.9rem',
                  color: '#cbd5e1',
                  fontSize: '0.8125rem',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {warranty.conditions}
              </div>
            </div>
          )}
        </div>

        {/* Footer acciones */}
        <div
          style={{
            padding: '1rem 1.5rem',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            gap: '0.5rem',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          {onDelete && (
            <button
              onClick={() => onDelete(warranty)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.5rem 0.85rem',
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#fca5a5',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '0.875rem',
              }}
            >
              <Trash2 size={15} />
              Eliminar
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={() => onDuplicate(warranty)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.5rem 0.85rem',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#e2e8f0',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '0.875rem',
              }}
            >
              <CopyIcon size={15} />
              Duplicar
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(warranty)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.5rem 0.85rem',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: '#e2e8f0',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 500,
                fontSize: '0.875rem',
              }}
            >
              <Pencil size={15} />
              Editar
            </button>
          )}
          <button
            onClick={() => handlePrint()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.55rem 1.1rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)',
            }}
          >
            <Printer size={16} />
            Imprimir A4
          </button>
        </div>
      </div>

      {/* Print layout (hidden, used by react-to-print) */}
      <div style={{ position: 'fixed', left: '-10000px', top: 0 }}>
        <WarrantyPrintLayout ref={printRef} warranty={warranty} settings={settings} duplicate />
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </div>
      <div
        style={{
          color: '#f1f5f9',
          fontSize: '0.9rem',
          fontWeight: 500,
          wordBreak: 'break-word',
        }}
      >
        {value && value.trim() ? value : '-'}
      </div>
    </div>
  )
}
