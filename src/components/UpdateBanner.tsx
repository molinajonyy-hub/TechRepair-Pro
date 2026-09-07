import { RefreshCw, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { useUpdateDetector } from '../hooks/useUpdateDetector'
import { clientUpdateSignal } from '../lib/clientUpdateSignal'

export function UpdateBanner() {
  const { updateAvailable, reload } = useUpdateDetector()
  const [dismissed, setDismissed] = useState(false)
  const mandatory = useSyncExternalStore(clientUpdateSignal.subscribe, clientUpdateSignal.getSnapshot)
  const [updating, setUpdating] = useState(false)
  const [reloadError, setReloadError] = useState(false)

  if (!mandatory && (!updateAvailable || dismissed)) return null

  const update = async () => {
    if (updating) return
    setUpdating(true)
    setReloadError(false)
    try { await reload() } catch {
      setReloadError(true)
      setUpdating(false)
    }
  }

  return (
    // Isla dark: el banner es deliberadamente oscuro sobre ambos temas.
    // data-theme="dark" evita que los overrides light de index.css re-mapeen
    // sus colores inline (texto claro → oscuro sobre fondo oscuro = ilegible).
    <div
      className="update-banner"
      data-testid="update-banner"
      data-theme="dark"
      role={mandatory ? 'alert' : 'status'}
      aria-live={mandatory ? 'assertive' : 'polite'}
      data-update-mode={mandatory ? 'mandatory' : 'optional'}
      style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem', flexWrap: 'wrap',
      padding: '0.75rem 1rem',
      background: 'linear-gradient(135deg, #1e293b, #0f172a)',
      border: '1px solid rgba(99,102,241,0.4)',
      borderRadius: '0.875rem',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.15)',
      fontFamily: "'Inter', sans-serif",
      backdropFilter: 'blur(8px)',
      animation: 'slideUp 0.3s ease',
    }}>
      <style>{`@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(12px) } to { opacity:1; transform:translateX(-50%) translateY(0) } }`}</style>

      <span data-testid="update-banner-message" style={{ fontSize: '0.8125rem', color: '#e2e8f0' }}>
        {reloadError ? 'No se pudo actualizar. Volvé a intentarlo.'
          : mandatory ? 'Actualizá la aplicación para continuar.' : 'Hay una nueva versión disponible'}
      </span>

      <button
        onClick={() => { void update() }}
        disabled={updating}
        className="mobile-touch-target"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
          padding: '0.375rem 0.875rem',
          background: 'linear-gradient(135deg,#6366f1,#4f46e5)',
          border: 'none', borderRadius: '0.5rem',
          color: '#fff', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
        }}
      >
        <RefreshCw size={13} />
        {updating ? 'Actualizando…' : 'Actualizar'}
      </button>

      {!mandatory && <button
        onClick={() => setDismissed(true)}
        className="mobile-touch-target"
        aria-label="Cerrar aviso de actualización"
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: '0.25rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        title="Cerrar"
      >
        <X size={14} />
      </button>}
    </div>
  )
}
