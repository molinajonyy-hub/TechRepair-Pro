import { Routes, Route, useParams } from 'react-router-dom'
import { PortalProvider } from './contexts/PortalContext'
import { PortalEntry }    from './pages/PortalEntry'
import { PortalLogin }    from './pages/PortalLogin'
import { PortalRegister } from './pages/PortalRegister'
import { PortalPending }  from './pages/PortalPending'
import { PortalCatalog }  from './pages/PortalCatalog'
import { PortalCart }     from './pages/PortalCart'
import { PortalOrders }     from './pages/PortalOrders'
import { PortalSuspendido } from './pages/PortalSuspendido'

// Dominios exclusivos del portal — sin prefijo /mayorista/:slug en la URL
export const PORTAL_DOMAINS: Record<string, string> = {
  'clicmayorista.com.ar':     'clic',
  'www.clicmayorista.com.ar': 'clic',
}

interface Props {
  forcedSlug?: string
}

export function PortalRouter({ forcedSlug }: Props) {
  const { slug: slugFromUrl } = useParams<{ slug: string }>()
  const slug     = forcedSlug || slugFromUrl || ''
  const basePath = forcedSlug ? '' : `/mayorista/${slug}`

  return (
    <PortalProvider slug={slug} basePath={basePath}>
      <Routes>
        <Route index           element={<PortalEntry />}    />
        <Route path="login"    element={<PortalLogin />}    />
        <Route path="registro" element={<PortalRegister />} />
        <Route path="pendiente" element={<PortalPending />} />
        <Route path="catalogo" element={<PortalCatalog />}  />
        <Route path="carrito"  element={<PortalCart />}     />
        <Route path="pedidos"     element={<PortalOrders />}     />
        <Route path="suspendido"  element={<PortalSuspendido />} />
      </Routes>
    </PortalProvider>
  )
}
