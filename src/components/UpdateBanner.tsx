import { RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useUpdateDetector } from '../hooks/useUpdateDetector'

export function UpdateBanner() {
  const { updateAvailable, reload } = useUpdateDetector()
  const [dismissed, setDismissed] = useState(false)

  if (!updateAvailable || dismissed) return null

  return (
    <div style={{
      position: 'fixed', bottom: '1.25rem', left: '50%', transform: 'translateX(-50%)',
      zIndex: 99999,
      display: 'flex', alignItems: 'center', gap: '0.75rem',
      padding: '0.75rem 1rem',
      background: 'linear-gradient(135deg, #1e293b, #0f172a)',
      border: '1px solid rgba(99,102,241,0.4)',
      borderRadius: '0.875rem',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.15)',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap',
      backdropFilter: 'blur(8px)',
      animation: 'slideUp 0.3s ease',
    }}>
      <style>{`@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(12px) } to { opacity:1; transform:translateX(-50%) translateY(0) } }`}</style>

      <span style={{ fontSize: '0.8125rem', color: '#94a3b8' }}>
        Hay una nueva versión disponible
      </span>

      <button
        onClick={reload}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
          padding: '0.375rem 0.875rem',
          background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
          border: 'none', borderRadius: '0.5rem',
          color: '#fff', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
        }}
      >
        <RefreshCw size={13} />
        Actualizar
      </button>

      <button
        onClick={() => setDismissed(true)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: '0.25rem', display: 'flex', alignItems: 'center' }}
        title="Cerrar"
      >
        <X size={14} />
      </button>
    </div>
  )
}
