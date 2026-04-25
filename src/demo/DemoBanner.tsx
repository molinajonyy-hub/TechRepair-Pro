// DEMO MODE — borrar junto con src/demo/ para desactivar
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export function DemoBanner() {
  const navigate = useNavigate()

  const handleExit = async () => {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      background: 'linear-gradient(90deg, #f59e0b, #d97706)',
      color: '#1c1917',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.5rem 1.25rem',
      fontSize: '0.8rem', fontWeight: 700,
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        🧪 <span>MODO DEMO / AUDITORÍA — Los datos son ficticios. Las acciones no afectan datos reales.</span>
      </span>
      <button
        onClick={handleExit}
        style={{
          background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(0,0,0,0.2)',
          borderRadius: '0.375rem', padding: '0.2rem 0.75rem',
          fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', color: '#1c1917',
        }}
      >
        Salir del demo
      </button>
    </div>
  )
}
