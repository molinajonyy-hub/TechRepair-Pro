import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, Zap } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { loginCustomer } from '../services/portalService'

const IS_DEV = import.meta.env.DEV
const DEMO_EMAIL    = 'demo@clicmayorista.com'
const DEMO_PASSWORD = 'Demo1234'

const F = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif"

const CSS = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .pl-wrap {
    animation: fadeUp 0.5s cubic-bezier(0.22,1,0.36,1) both;
  }
  .pl-input {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 16px;
    font-size: 16px;
    font-family: ${F};
    color: #1c1c1e;
    background: #f5f5f7;
    border: 1.5px solid rgba(0,0,0,0.08);
    border-radius: 12px;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
    -webkit-appearance: none;
  }
  .pl-input:focus {
    outline: none;
    border-color: #007aff;
    box-shadow: 0 0 0 4px rgba(0,122,255,0.10);
    background: #fff;
  }
  .pl-input::placeholder { color: #b0b0b5; }
  .pl-input-pw { padding-right: 50px; }

  .pl-btn {
    width: 100%;
    padding: 15.5px;
    font-size: 1rem;
    font-weight: 600;
    font-family: ${F};
    letter-spacing: 0.01em;
    color: #fff;
    background: linear-gradient(160deg, #1a8cff 0%, #0060d4 100%);
    border: none;
    border-radius: 14px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0,100,255,0.22), 0 1px 2px rgba(0,0,0,0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  }
  .pl-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 22px rgba(0,100,255,0.30), 0 2px 6px rgba(0,0,0,0.10);
  }
  .pl-btn:active:not(:disabled) {
    transform: translateY(0px);
    box-shadow: 0 2px 8px rgba(0,100,255,0.18);
  }
  .pl-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .pl-pw-toggle {
    position: absolute;
    right: 13px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    cursor: pointer;
    padding: 5px;
    color: #8e8e93;
    display: flex;
    align-items: center;
    transition: color 0.15s, opacity 0.15s;
    opacity: 0.65;
  }
  .pl-pw-toggle:hover { opacity: 1; color: #3c3c43; }

  .pl-register-link {
    color: #007aff;
    font-weight: 600;
    font-size: 0.9rem;
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .pl-register-link:hover { opacity: 0.75; }
`

export function PortalLogin() {
  const { business, bizLoading, setCustomer, slug, basePath } = usePortal()
  const navigate = useNavigate()

  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [showPw,      setShowPw]      = useState(false)
  const [loading,     setLoading]     = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [error,       setError]       = useState('')

  const doLogin = async (em: string, pw: string) => {
    setError('')
    if (bizLoading) { setError('El portal todavía está cargando. Intentá en un momento.'); return }
    if (!business)  { setError('No se pudo cargar el portal. Recargá la página.'); return }

    let result: Awaited<ReturnType<typeof loginCustomer>>
    try {
      result = await loginCustomer(em, pw, business.id)
    } catch {
      setError('Error de conexión. Revisá tu internet e intentá de nuevo.')
      return
    }

    if (result.error)    { setError(result.error); return }
    if (!result.customer){ setError('No existe un cliente mayorista vinculado a este email.'); return }

    const c = result.customer
    setCustomer(c)
    if (c.suspended)     navigate(`${basePath}/suspendido`, { replace: true })
    else if (!c.approved)navigate(`${basePath}/pendiente`,  { replace: true })
    else                 navigate(`${basePath}/catalogo`,   { replace: true })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try { await doLogin(email, password) } finally { setLoading(false) }
  }

  const handleDemo = async () => {
    setDemoLoading(true)
    try { await doLogin(DEMO_EMAIL, DEMO_PASSWORD) } finally { setDemoLoading(false) }
  }

  const busy = loading || demoLoading || bizLoading

  return (
    <div style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: F,
      padding: '2rem 1.25rem',
      background: `
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(0,122,255,0.06) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 90%, rgba(88,50,220,0.05) 0%, transparent 60%),
        radial-gradient(ellipse 100% 80% at 50% 50%, rgba(255,255,255,0.6) 0%, transparent 100%),
        #f2f2f7
      `,
    }}>
      <style>{CSS}</style>

      <div className="pl-wrap" style={{ width: '100%', maxWidth: 400 }}>

        {/* ── Branding ─────────────────────────────────────────────────────── */}
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          {business?.logo_url ? (
            <img
              src={business.logo_url}
              alt={business.name}
              style={{
                height: 'clamp(64px, 14vw, 90px)',
                maxWidth: 260,
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
                margin: '0 auto 1.25rem',
                imageRendering: '-webkit-optimize-contrast' as React.CSSProperties['imageRendering'],
              }}
            />
          ) : (
            <div style={{
              fontSize: 'clamp(2.25rem, 8vw, 3rem)',
              fontWeight: 800,
              letterSpacing: '-0.05em',
              color: '#1c1c1e',
              lineHeight: 1,
              marginBottom: '1.125rem',
            }}>
              {bizLoading ? ' ' : (business?.name || 'Portal')}
            </div>
          )}

          <p style={{
            margin: 0,
            fontSize: '0.875rem',
            color: '#8e8e93',
            fontWeight: 400,
            letterSpacing: '0.01em',
          }}>
            Acceso exclusivo para clientes mayoristas
          </p>
        </div>

        {/* ── Card ─────────────────────────────────────────────────────────── */}
        <div style={{
          background: 'rgba(255,255,255,0.88)',
          backdropFilter: 'saturate(180%) blur(28px)',
          WebkitBackdropFilter: 'saturate(180%) blur(28px)',
          borderRadius: 22,
          border: '1px solid rgba(255,255,255,0.9)',
          boxShadow: [
            '0 0 0 1px rgba(0,0,0,0.045)',
            '0 2px 4px rgba(0,0,0,0.04)',
            '0 12px 40px rgba(0,0,0,0.08)',
          ].join(', '),
          padding: '2rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}>

          {/* Dev demo */}
          {IS_DEV && (
            <div style={{
              padding: '0.875rem 1rem',
              background: 'rgba(99,102,241,0.07)',
              border: '1px dashed rgba(99,102,241,0.3)',
              borderRadius: 14,
              display: 'flex', flexDirection: 'column', gap: '0.625rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Zap size={13} color="#818cf8" />
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Modo Dev
                </span>
              </div>
              <button
                onClick={handleDemo}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem',
                  padding: '0.5rem 0.875rem',
                  background: 'rgba(99,102,241,0.13)',
                  border: '1px solid rgba(99,102,241,0.35)',
                  borderRadius: 10,
                  color: '#818cf8',
                  fontFamily: F, fontSize: '0.85rem', fontWeight: 700,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <Zap size={14} />
                {demoLoading ? 'Ingresando...' : 'Ingresar como demo'}
              </button>
            </div>
          )}

          {/* ── Form ── */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>

            {/* Email */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.78rem',
                fontWeight: 600,
                color: '#3c3c43',
                marginBottom: '0.5rem',
                letterSpacing: '0.005em',
              }}>
                Email
              </label>
              <input
                className="pl-input"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="tu@email.com"
                autoFocus
                autoComplete="email"
                required
              />
            </div>

            {/* Password */}
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.78rem',
                fontWeight: 600,
                color: '#3c3c43',
                marginBottom: '0.5rem',
                letterSpacing: '0.005em',
              }}>
                Contraseña
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  className="pl-input pl-input-pw"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="pl-pw-toggle"
                  onClick={() => setShowPw(v => !v)}
                  tabIndex={-1}
                  aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.5rem',
                padding: '0.75rem 1rem',
                background: 'rgba(255,59,48,0.06)',
                border: '1px solid rgba(255,59,48,0.16)',
                borderRadius: 12,
                color: '#c0001a',
                fontSize: '0.845rem',
                fontWeight: 500,
                lineHeight: 1.45,
              }}>
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              className="pl-btn"
              disabled={busy}
              style={{ marginTop: '0.25rem' }}
            >
              {loading ? (
                <>
                  <span style={{
                    width: 17, height: 17,
                    border: '2.5px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#fff',
                    borderRadius: '50%',
                    animation: 'spin 0.65s linear infinite',
                    display: 'inline-block',
                    flexShrink: 0,
                  }} />
                  Ingresando...
                </>
              ) : bizLoading ? 'Cargando...' : 'Ingresar'}
            </button>
          </form>
        </div>

        {/* ── Registro ─────────────────────────────────────────────────────── */}
        <p style={{
          textAlign: 'center',
          marginTop: '1.5rem',
          marginBottom: 0,
          fontSize: '0.875rem',
          color: '#8e8e93',
        }}>
          ¿Todavía no tenés acceso?{' '}
          <Link to={`${basePath}/registro`} className="pl-register-link">
            Solicitá acceso
          </Link>
        </p>

      </div>
    </div>
  )
}
