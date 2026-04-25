// DEMO MODE — borrar junto con src/demo/ para desactivar
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { DEMO_EMAIL, DEMO_PASSWORD } from './DemoConstants'

export function DemoEntry() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'loading' | 'error'>('loading')
  const [msg, setMsg] = useState('Iniciando modo demo...')

  useEffect(() => {
    let cancelled = false

    const enter = async () => {
      // Cerrar sesión previa si la hay
      await supabase.auth.signOut()

      setMsg('Cargando datos de demostración...')

      const { error } = await supabase.auth.signInWithPassword({
        email:    DEMO_EMAIL,
        password: DEMO_PASSWORD,
      })

      if (cancelled) return

      if (error) {
        setStatus('error')
        setMsg(`Error al iniciar demo: ${error.message}`)
        return
      }

      // Marcar sesión como demo en sessionStorage para que el banner aparezca
      sessionStorage.setItem('demo_mode', '1')
      navigate('/dashboard', { replace: true })
    }

    enter()
    return () => { cancelled = true }
  }, [navigate])

  return (
    <div style={{
      minHeight: '100dvh', background: '#09090b',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '1.5rem', fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Banner demo visible desde el inicio */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        background: 'linear-gradient(90deg, #f59e0b, #d97706)',
        color: '#1c1917', fontWeight: 700, fontSize: '0.8rem',
        padding: '0.5rem 1rem', textAlign: 'center',
      }}>
        🧪 MODO DEMO / AUDITORÍA
      </div>

      <div style={{
        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: '1rem', padding: '2.5rem', textAlign: 'center', maxWidth: '360px',
      }}>
        {status === 'loading' ? (
          <>
            <Loader2 size={40} style={{ color: '#f59e0b', animation: 'spin 1s linear infinite', margin: '0 auto 1rem' }} />
            <h2 style={{ color: '#f8fafc', margin: '0 0 0.5rem', fontWeight: 700 }}>
              Preparando demo
            </h2>
            <p style={{ color: '#64748b', margin: 0, fontSize: '0.875rem' }}>{msg}</p>
          </>
        ) : (
          <>
            <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>⚠️</div>
            <h2 style={{ color: '#f87171', margin: '0 0 0.5rem', fontWeight: 700 }}>
              Error al iniciar demo
            </h2>
            <p style={{ color: '#94a3b8', margin: '0 0 1.25rem', fontSize: '0.875rem' }}>{msg}</p>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '0.5rem', padding: '0.5rem 1.25rem',
                color: '#f8fafc', cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
              }}
            >
              Reintentar
            </button>
          </>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
