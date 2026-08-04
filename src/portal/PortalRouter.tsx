import { Routes, Route, useParams } from 'react-router-dom'
import { PortalProvider } from './contexts/PortalContext'
import { PortalGate }     from './components/PortalGate'
import { UpdateBanner }   from '../components/UpdateBanner'
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

// Mapa inverso: slug → dominio público dedicado del portal
const PORTAL_PUBLIC_DOMAINS: Record<string, string> = {
  clic: 'https://clicmayorista.com.ar',
}

/** URL pública del portal para un slug dado (dominio dedicado si existe, sino /mayorista/:slug). */
export function getPortalUrl(slug: string, path = ''): string {
  const dedicated = PORTAL_PUBLIC_DOMAINS[slug]
  if (dedicated) return `${dedicated}${path}`
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/mayorista/${slug}${path}`
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
      {/* Detector de versión: se REUSA el existente (useUpdateDetector +
          /version.json), no se crea un segundo sistema de actualización.
          Sólo en el dominio dedicado del portal: en el dominio principal
          App.tsx ya monta <UpdateBanner/>, y montarlo dos veces duplicaría el
          poller y el banner. Es el caso que faltaba: la rama de PORTAL_DOMAINS
          en App.tsx devuelve el router del portal SIN el banner, así que un
          bundle viejo en clicmayorista.com.ar no tenía forma de enterarse de
          que hay una versión nueva. */}
      {forcedSlug && <UpdateBanner />}
      <PortalGate>
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
      </PortalGate>
    </PortalProvider>
  )
}
