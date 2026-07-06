import { useState } from 'react'
import { Info, X, ChevronDown, ChevronUp } from 'lucide-react'
import { bannerStorageKey, isBannerDismissed, dismissBanner } from '../../utils/bannerDismissal'

// Aviso descartable del cambio de cálculo contable (Etapa 1). Se muestra una vez
// por negocio (persistencia en localStorage), es descartable y no bloquea el uso.
// Identidad índigo. NO usar en Mi Guita (finanzas personales).
const STORAGE_PREFIX = 'tr_accounting_model_banner_v1'

export function AccountingChangeBanner({ businessId }: { businessId?: string | null }) {
  const storageKey = bannerStorageKey(STORAGE_PREFIX, businessId)
  const store = typeof localStorage !== 'undefined' ? localStorage : undefined
  const [dismissed, setDismissed] = useState<boolean>(() => isBannerDismissed(store, storageKey))
  const [showHow, setShowHow] = useState(false)

  if (dismissed) return null

  const dismiss = () => {
    dismissBanner(store, storageKey)
    setDismissed(true)
  }

  return (
    <div
      role="status"
      aria-label="Aviso de cambio de cálculo financiero"
      data-testid="accounting-change-banner"
      style={{
        display: 'flex', flexDirection: 'column', gap: '0.5rem',
        padding: '0.875rem 1rem', marginBottom: '1.25rem',
        background: 'rgba(99,102,241,0.10)',
        border: '1px solid rgba(99,102,241,0.30)',
        borderRadius: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Info size={18} style={{ color: '#818cf8', flexShrink: 0, marginTop: '0.125rem' }} />
        <div style={{ flex: 1, minWidth: '220px' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
            Actualizamos el cálculo financiero para separar la rentabilidad del negocio, los movimientos
            de caja, las compras de inventario y los retiros del dueño. No modificamos tus ventas, pagos
            ni movimientos históricos.
          </p>
          <button
            type="button"
            onClick={() => setShowHow(v => !v)}
            aria-expanded={showHow}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
              marginTop: '0.5rem', padding: 0, background: 'none', border: 'none',
              color: '#818cf8', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Ver cómo se calcula {showHow ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Descartar aviso"
          style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            cursor: 'pointer', padding: '0.25rem', borderRadius: '0.375rem', flexShrink: 0,
          }}
        >
          <X size={16} />
        </button>
      </div>

      {showHow && (
        <div
          data-testid="accounting-change-formula"
          style={{
            marginLeft: '2.5rem', marginTop: '0.25rem', padding: '0.75rem 1rem',
            background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)',
            borderRadius: '0.5rem', fontFamily: 'monospace', fontSize: '0.8rem',
            color: 'var(--text-secondary)', lineHeight: 1.7, maxWidth: '360px',
          }}
        >
          <div>Ventas netas</div>
          <div>− Costo de ventas</div>
          <div>− Gastos operativos</div>
          <div style={{ borderTop: '1px solid rgba(99,102,241,0.25)', marginTop: '0.25rem', paddingTop: '0.25rem', color: 'var(--text-primary)', fontWeight: 700 }}>
            = Resultado operativo
          </div>
        </div>
      )}
    </div>
  )
}
