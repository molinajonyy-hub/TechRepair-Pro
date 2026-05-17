import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, Eye, EyeOff, Loader2, CheckCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'

export function ResetPassword() {
  const navigate = useNavigate()
  const [password, setPassword]     = useState('')
  const [confirm, setConfirm]       = useState('')
  const [showPwd, setShowPwd]       = useState(false)
  const [showCfm, setShowCfm]       = useState(false)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [done, setDone]             = useState(false)
  const [ready, setReady]           = useState(false)

  useEffect(() => {
    // Activar formulario cuando Supabase dispara PASSWORD_RECOVERY
    // (ocurre cuando el usuario llega desde el link del email)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setReady(true)
      }
    })

    // En algunos flujos PKCE el evento ya ocurrió antes de montar el componente.
    // Verificar si hay sesión Y si la URL contiene indicadores de recovery.
    const hash   = window.location.hash
    const search = window.location.search
    const isRecovery =
      hash.includes('type=recovery') ||
      hash.includes('access_token') ||
      search.includes('code=')       ||
      sessionStorage.getItem('is_password_recovery') === '1'

    if (isRecovery) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          sessionStorage.removeItem('is_password_recovery')
          setReady(true)
        }
      })
    }

    return () => subscription.unsubscribe()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) { setError('La contraseña debe tener al menos 8 caracteres'); return }
    if (password !== confirm)  { setError('Las contraseñas no coinciden'); return }

    setLoading(true)
    setError('')

    const { error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError) {
      setError(updateError.message)
      setLoading(false)
      return
    }

    setDone(true)
    setTimeout(() => navigate('/dashboard', { replace: true }), 2500)
  }

  const pageStyle: React.CSSProperties = {
    minHeight: '100dvh',
    background: '#09090b',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '1.5rem',
    fontFamily: "'Inter', -apple-system, sans-serif",
  }

  const cardStyle: React.CSSProperties = {
    width: '100%', maxWidth: '400px',
    background: 'rgba(255,255,255,0.025)',
    backdropFilter: 'blur(24px)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '1.5rem',
    padding: '2rem',
    boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.875rem 3rem 0.875rem 3rem',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '0.875rem', color: '#f1f5f9',
    fontSize: '0.9375rem', outline: 'none', boxSizing: 'border-box',
  }

  if (done) {
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <CheckCircle size={48} style={{ color: '#22c55e', margin: '0 auto 1rem' }} />
          <h2 style={{ color: '#f1f5f9', margin: '0 0 0.5rem', fontSize: '1.2rem', fontWeight: 700 }}>
            ¡Contraseña actualizada!
          </h2>
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            Redirigiendo al panel...
          </p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '50%',
            border: '3px solid rgba(99,102,241,0.15)',
            borderTop: '3px solid #6366f1',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 1.25rem',
          }} />
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            Verificando enlace...
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      {/* Blobs de fondo */}
      <div style={{ position: 'fixed', top: '-15%', left: '-10%', width: '55vw', height: '55vw', maxWidth: '600px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)', pointerEvents: 'none' }} />
      <div style={{ position: 'fixed', bottom: '-15%', right: '-10%', width: '50vw', height: '50vw', maxWidth: '550px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,85,247,0.09) 0%, transparent 70%)', pointerEvents: 'none' }} />

      <div style={{ width: '100%', maxWidth: '400px', position: 'relative', zIndex: 1 }}>
        <div style={cardStyle}>
          {/* Glow top */}
          <div style={{ position: 'absolute', top: 0, left: '20%', right: '20%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.6), transparent)' }} />

          {/* Ícono */}
          <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
            <div style={{
              width: '56px', height: '56px', borderRadius: '1rem',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 1rem',
              boxShadow: '0 8px 24px rgba(99,102,241,0.4)',
            }}>
              <Lock size={24} color="white" />
            </div>
            <h1 style={{ fontSize: '1.375rem', fontWeight: 800, color: '#f8fafc', margin: '0 0 0.3rem', letterSpacing: '-0.03em' }}>
              Nueva contraseña
            </h1>
            <p style={{ color: '#475569', fontSize: '0.875rem', margin: 0 }}>
              Ingresá tu nueva contraseña para continuar
            </p>
          </div>

          {error && (
            <div style={{
              padding: '0.75rem 1rem', borderRadius: '0.75rem',
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
              color: '#f87171', fontSize: '0.875rem', marginBottom: '1.25rem',
            }}>
              ⚠️ {error}
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Nueva contraseña */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.5rem' }}>
                Nueva contraseña
              </label>
              <div style={{ position: 'relative' }}>
                <Lock size={17} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none' }} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError('') }}
                  placeholder="Mínimo 8 caracteres"
                  autoComplete="new-password"
                  required
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'rgba(99,102,241,0.7)'; e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.15)' }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; e.target.style.boxShadow = 'none' }}
                />
                <button type="button" onClick={() => setShowPwd(v => !v)} style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex' }}>
                  {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            {/* Confirmar */}
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#94a3b8', marginBottom: '0.5rem' }}>
                Confirmar contraseña
              </label>
              <div style={{ position: 'relative' }}>
                <Lock size={17} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: '#334155', pointerEvents: 'none' }} />
                <input
                  type={showCfm ? 'text' : 'password'}
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError('') }}
                  placeholder="Repetí la contraseña"
                  autoComplete="new-password"
                  required
                  style={inputStyle}
                  onFocus={e => { e.target.style.borderColor = 'rgba(99,102,241,0.7)'; e.target.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.15)' }}
                  onBlur={e => { e.target.style.borderColor = 'rgba(255,255,255,0.1)'; e.target.style.boxShadow = 'none' }}
                />
                <button type="button" onClick={() => setShowCfm(v => !v)} style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#334155', display: 'flex' }}>
                  {showCfm ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !password || !confirm}
              style={{
                width: '100%', padding: '0.9375rem',
                background: loading || !password || !confirm
                  ? 'rgba(99,102,241,0.4)'
                  : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                border: 'none', borderRadius: '0.875rem',
                color: '#fff', fontWeight: 700, fontSize: '0.9375rem',
                cursor: loading || !password || !confirm ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                boxShadow: '0 4px 20px rgba(99,102,241,0.4)',
                marginTop: '0.25rem',
              }}
            >
              {loading
                ? <><Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> Guardando...</>
                : 'Guardar nueva contraseña'
              }
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
