import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePortal } from '../contexts/PortalContext'

export function usePortalGuard() {
  const { customer, authLoading, bizLoading, basePath } = usePortal()
  const navigate = useNavigate()

  useEffect(() => {
    if (authLoading || bizLoading) return
    if (!customer) {
      navigate(`${basePath}/login`, { replace: true })
    } else if (customer.suspended) {
      navigate(`${basePath}/suspendido`, { replace: true })
    } else if (!customer.approved) {
      navigate(`${basePath}/pendiente`, { replace: true })
    }
  }, [customer, authLoading, bizLoading, basePath, navigate])
}
