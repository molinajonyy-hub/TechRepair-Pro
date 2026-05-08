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

// El padre ya capturó :slug con <Route path="/mayorista/:slug/*" />
export function PortalRouter() {
  const { slug } = useParams<{ slug: string }>()

  return (
    <PortalProvider slug={slug || ''}>
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
