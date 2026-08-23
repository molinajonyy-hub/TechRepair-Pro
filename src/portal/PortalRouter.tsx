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

// Los mapas de dominios viven en `portalDomains.ts` para que un consumidor
// liviano (AuthCallback) pueda preguntar por un hostname sin importar el árbol
// entero de páginas del portal. Se re-exporta PORTAL_DOMAINS porque App.tsx ya
// lo importa desde acá.
import { PORTAL_DOMAINS, PORTAL_PUBLIC_DOMAINS } from './portalDomains'
export { PORTAL_DOMAINS }

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
