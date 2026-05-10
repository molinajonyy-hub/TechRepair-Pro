import { useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { Zap } from 'lucide-react'
import { usePortal } from '../contexts/PortalContext'
import { loginCustomer } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PortalInput, PT } from '../components/PortalLayout'

const IS_DEV = import.meta.env.DEV
const DEMO_EMAIL    = 'demo@clicmayorista.com'
const DEMO_PASSWORD = 'Demo1234'

export function PortalLogin() {
  const { slug } = useParams<{ slug: string }>()
  const { business, bizLoading, setCustomer } = usePortal()
  const navigate = useNavigate()

  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [loading,     setLoading]     = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [error,       setError]       = useState('')

  const doLogin = async (em: string, pw: string) => {
    setError('')

    if (bizLoading) {
      setError('El portal todavía está cargando. Intentá en un momento.')
      return
    }
    if (!business) {
      setError('No se pudo cargar el portal. Recargá la página.')
      return
    }

    console.log('[PortalLogin] iniciando login', { email: em, businessId: business.id, slug })

    let result: Awaited<ReturnType<typeof loginCustomer>>
    try {
      result = await loginCustomer(em, pw, business.id)
    } catch (e: any) {
      console.error('[PortalLogin] excepción en loginCustomer', e)
      setError('Error de conexión. Revisá tu internet e intentá de nuevo.')
      return
    }

    console.log('[PortalLogin] resultado', {
      hasCustomer: !!result.customer,
      error: result.error,
    })

    if (result.error) {
      setError(result.error)
      return
    }

    if (!result.customer) {
      setError('No existe un cliente mayorista vinculado a este email en este portal.')
      return
    }

    const c = result.customer
    console.log('[PortalLogin] customer ok', { approved: c.approved, suspended: c.suspended })

    setCustomer(c)

    if (c.suspended) {
      navigate(`/mayorista/${slug}/suspendido`, { replace: true })
    } else if (!c.approved) {
      navigate(`/mayorista/${slug}/pendiente`, { replace: true })
    } else {
      navigate(`/mayorista/${slug}/catalogo`, { replace: true })
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    console.log('[PortalLogin] form submit', { email })
    setLoading(true)
    try {
      await doLogin(email, password)
    } finally {
      setLoading(false)
    }
  }

  const handleDemo = async () => {
    console.log('[PortalLogin] demo click')
    setDemoLoading(true)
    try {
      await doLogin(DEMO_EMAIL, DEMO_PASSWORD)
    } finally {
      setDemoLoading(false)
    }
  }

  return (
    <PortalLayout showBack={false} showCart={false}>
      <div style={{ padding: '2.5rem 1.5rem 1.25rem', textAlign: 'center' }}>
        {business?.logo_url ? (
          <img
            src={business.logo_url}
            alt={business.name}
            style={{
              height: 72,
              maxWidth: 240,
              objectFit: 'contain',
              objectPosition: 'center',
              margin: '0 auto 1rem',
              display: 'block',
              imageRendering: '-webkit-optimize-contrast' as React.CSSProperties['imageRendering'],
            }}
          />
        ) : (
          <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 0.5rem', letterSpacing: '-0.04em', color: PT.text }}>
            {bizLoading ? 'Cargando...' : business?.name || 'Portal Mayorista'}
          </h1>
        )}
        <p style={{ color: PT.textSub, margin: 0, fontSize: '0.9rem', letterSpacing: '0.01em' }}>
          Acceso exclusivo para clientes mayoristas
        </p>
      </div>

      <div style={{ padding: '0 1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>

        {/* ── Botón demo (solo entorno local) ─────────────────────────────────── */}
        {IS_DEV && (
          <div style={{
            padding: '1rem 1.125rem',
            background: 'rgba(99,102,241,0.08)',
            border: '1px dashed rgba(99,102,241,0.35)',
            borderRadius: PT.radiusLg,
            display: 'flex', flexDirection: 'column', gap: '0.625rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Zap size={14} style={{ color: '#818cf8' }} />
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Modo Dev
              </span>
            </div>
            <p style={{ margin: 0, fontSize: '0.8rem', color: PT.textSub, lineHeight: 1.4 }}>
              Usuario demo aprobado con productos visibles y carrito listo para probar.
            </p>
            <button
              onClick={handleDemo}
              disabled={demoLoading || bizLoading}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                padding: '0.625rem 1rem',
                background: 'rgba(99,102,241,0.15)',
                border: '1px solid rgba(99,102,241,0.4)',
                borderRadius: PT.radius,
                color: '#818cf8',
                fontFamily: PT.font, fontSize: '0.9rem', fontWeight: 700,
                cursor: (demoLoading || bizLoading) ? 'not-allowed' : 'pointer',
                opacity: (demoLoading || bizLoading) ? 0.6 : 1,
              }}
            >
              <Zap size={16} />
              {demoLoading ? 'Ingresando...' : bizLoading ? 'Cargando portal...' : 'Ingresar como demo'}
            </button>
            <p style={{ margin: 0, fontSize: '0.68rem', color: '#334155', textAlign: 'center' }}>
              {DEMO_EMAIL} · {DEMO_PASSWORD}
            </p>
          </div>
        )}

        {/* ── Formulario ───────────────────────────────────────────────────────── */}
        <PortalCard style={{ padding: '1.5rem' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <PortalInput
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="tu@email.com"
              required
            />
            <PortalInput
              label="Contraseña"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              required
            />

            {error && (
              <div style={{
                padding: '0.75rem 1rem',
                background: `${PT.danger}15`,
                border: `1px solid ${PT.danger}40`,
                borderRadius: PT.radius,
                color: PT.danger,
                fontSize: '0.875rem',
                fontWeight: 500,
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            <PortalButton
              type="submit"
              loading={loading}
              disabled={bizLoading}
            >
              {bizLoading ? 'Cargando portal...' : 'Ingresar'}
            </PortalButton>
          </form>
        </PortalCard>

        <PortalCard style={{ padding: '1.25rem', textAlign: 'center' }}>
          <span style={{ color: PT.textSub, fontSize: '0.9rem' }}>¿Todavía no tenés acceso? </span>
          <Link
            to={`/mayorista/${slug}/registro`}
            style={{ color: PT.primary, fontWeight: 600, fontSize: '0.9rem', textDecoration: 'none' }}
          >
            Solicitá acceso
          </Link>
        </PortalCard>
      </div>
    </PortalLayout>
  )
}
