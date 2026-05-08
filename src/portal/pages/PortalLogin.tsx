import { useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'
import { loginCustomer } from '../services/portalService'
import { PortalLayout, PortalCard, PortalButton, PortalInput, PT } from '../components/PortalLayout'

export function PortalLogin() {
  const { slug } = useParams<{ slug: string }>()
  const { business, setCustomer } = usePortal()
  const navigate = useNavigate()

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!business) return
    setLoading(true); setError('')
    const { customer, error: err } = await loginCustomer(email, password, business.id)
    setLoading(false)
    if (err) { setError(err); return }
    if (!customer) return
    setCustomer(customer)
    if (!customer.approved) {
      navigate(`/mayorista/${slug}/pendiente`)
    } else {
      navigate(`/mayorista/${slug}/catalogo`)
    }
  }

  return (
    <PortalLayout showBack={false} showCart={false}>
      <div style={{ padding: '2rem 1rem 1rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 0.25rem', letterSpacing: '-0.03em' }}>
          {business?.name || 'Portal Mayorista'}
        </h1>
        <p style={{ color: PT.textSub, margin: 0, fontSize: '0.95rem' }}>
          Acceso exclusivo para clientes mayoristas
        </p>
      </div>

      <div style={{ padding: '0 1rem' }}>
        <PortalCard style={{ padding: '1.5rem', marginBottom: '1rem' }}>
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
                padding: '0.75rem 1rem', background: `${PT.danger}15`,
                border: `1px solid ${PT.danger}40`, borderRadius: PT.radius,
                color: PT.danger, fontSize: '0.875rem', fontWeight: 500,
              }}>
                {error}
              </div>
            )}

            <PortalButton type="submit" loading={loading}>
              Ingresar
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
