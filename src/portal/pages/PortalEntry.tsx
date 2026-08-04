import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'
import { PT } from '../components/PortalLayout'

export function PortalEntry() {
  const { business, customer, authLoading, bizLoading, notFound, basePath } = usePortal()
  const navigate = useNavigate()

  useEffect(() => {
    if (bizLoading || authLoading) return
    if (notFound || !business) return

    if (!customer) {
      navigate(`${basePath}/login`, { replace: true })
    } else if (customer.suspended) {
      navigate(`${basePath}/suspendido`, { replace: true })
    } else if (!customer.approved) {
      navigate(`${basePath}/pendiente`, { replace: true })
    } else {
      navigate(`${basePath}/catalogo`, { replace: true })
    }
  }, [business, customer, authLoading, bizLoading, notFound, basePath, navigate])

  // «Portal no disponible» y el error terminal los resuelve <PortalGate/> en el
  // shell, antes de montar ninguna ruta: así valen también para /catalogo,
  // /login y el resto, no sólo para la ruta índice. Acá sólo queda el spinner
  // mientras se resuelve el negocio y la sesión.
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
