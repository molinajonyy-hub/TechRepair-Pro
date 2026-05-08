import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'

/**
 * Guard para páginas protegidas del portal.
 * Redirige al destino correcto si el cliente no cumple los requisitos.
 * Debe llamarse al inicio de cada página protegida (catálogo, carrito, pedidos).
 */
export function usePortalGuard() {
  const { slug } = useParams<{ slug: string }>()
  const { customer, authLoading, bizLoading } = usePortal()
  const navigate = useNavigate()

  useEffect(() => {
    if (authLoading || bizLoading) return
    if (!customer) {
      navigate(`/mayorista/${slug}/login`, { replace: true })
    } else if (customer.suspended) {
      navigate(`/mayorista/${slug}/suspendido`, { replace: true })
    } else if (!customer.approved) {
      navigate(`/mayorista/${slug}/pendiente`, { replace: true })
    }
  }, [customer, authLoading, bizLoading, slug, navigate])
}
