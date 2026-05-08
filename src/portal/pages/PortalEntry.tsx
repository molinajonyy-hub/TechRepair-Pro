import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'
import { PT } from '../components/PortalLayout'

export function PortalEntry() {
  const { slug } = useParams<{ slug: string }>()
  const { business, customer, authLoading, bizLoading, notFound } = usePortal()
  const navigate = useNavigate()

  useEffect(() => {
    if (bizLoading || authLoading) return
    if (notFound || !business) return

    if (!customer) {
      navigate(`/mayorista/${slug}/login`, { replace: true })
    } else if (!customer.approved) {
      navigate(`/mayorista/${slug}/pendiente`, { replace: true })
    } else {
      navigate(`/mayorista/${slug}/catalogo`, { replace: true })
    }
  }, [business, customer, authLoading, bizLoading, notFound, slug, navigate])

  if (notFound) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: PT.bg, fontFamily: PT.font, flexDirection: 'column', gap: '1rem', padding: '2rem',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '3rem' }}>🔒</div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: PT.text, margin: 0 }}>Portal no disponible</h1>
        <p style={{ color: PT.textSub, margin: 0 }}>Este portal no existe o no está habilitado.</p>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: PT.bg, fontFamily: PT.font,
    }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', border: `3px solid ${PT.primary}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
