import { Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { MainLayout } from './layouts/MainLayout'
import { LoadingProvider, useLoading } from './contexts/LoadingContext'
import { LoadingDino } from './components/LoadingDino'
import Comprobante from './pages/Comprobante'
import Comprobantes from './pages/Comprobantes'
import { AcceptInvite } from './pages/AcceptInvite'
import { CustomerDetail } from './pages/CustomerDetail'
import { CustomerPortal } from './pages/CustomerPortal'
import { Customers } from './pages/Customers'
import { CurrencySettings } from './pages/CurrencySettings'
import { Dashboard } from './pages/Dashboard'
import { Expenses } from './pages/Expenses'
import { Finance } from './pages/Finance'
import { Inventory } from './pages/Inventory'
import { AuthCallback } from './pages/AuthCallback'
import { Login } from './pages/Login'
import { ResetPassword } from './pages/ResetPassword'
import { NewCustomer } from './pages/NewCustomer'
import { NewOrder } from './pages/NewOrder'
import { NoBusiness } from './pages/NoBusiness'
import { OrderDetail } from './pages/OrderDetail'
import { Orders } from './pages/Orders'
import { Reports } from './pages/Reports'
import { Suppliers } from './pages/Suppliers'
import { CuentasCorrientes } from './pages/CuentasCorrientes'
import { Offers } from './pages/Offers'
import { Tasks } from './pages/Tasks'
import { Warranties } from './pages/Warranties'
import { UsersManagement } from './pages/UsersManagement'
import { CajaPage } from './pages/CajaPage'
import { Mayorista } from './pages/Mayorista'
import Settings from './pages/Settings'
import { LandingPage } from './pages/LandingPage'
// ── Subscription ─────────────────────────────────────────────
import { Subscription } from './pages/Subscription'
import { Plans } from './pages/Plans'
import { PaymentPending } from './pages/PaymentPending'
import { SubscriptionSuspended } from './pages/SubscriptionSuspended'
import { AdminSubscriptions } from './pages/AdminSubscriptions'
import { Tutorials } from './pages/Tutorials'
import WhatsAppPage from './pages/WhatsApp'
import { MpCallback } from './pages/MpCallback'

function AppContent() {
  const { loadingState } = useLoading()

  return (
    <>
      {loadingState.isLoading && (
        <LoadingDino 
          fullScreen 
          message={loadingState.message}
          progress={loadingState.progress}
          showProgress={loadingState.showProgress}
        />
      )}
      <Routes>
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/no-business" element={<NoBusiness />} />
        <Route path="/customer-portal" element={<CustomerPortal />} />
        <Route path="/mp/callback" element={<MpCallback />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<MainLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/new" element={<NewOrder />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/comprobantes" element={<Comprobantes />} />
            <Route path="/comprobantes/:id" element={<Comprobante />} />
            <Route path="/warranties" element={<Warranties />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/new" element={<NewCustomer />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/mayorista" element={<Mayorista />} />
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/cuentas" element={<CuentasCorrientes />} />
            <Route path="/offers" element={<Offers />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/users" element={<UsersManagement />} />
            <Route path="/caja" element={<CajaPage />} />
            <Route path="/currency-settings" element={<CurrencySettings />} />
            <Route path="/settings" element={<Settings />} />
            {/* Subscription */}
            <Route path="/subscription" element={<Subscription />} />
            <Route path="/subscription/plans" element={<Plans />} />
            <Route path="/subscription/pending" element={<PaymentPending />} />
            <Route path="/subscription/suspended" element={<SubscriptionSuspended />} />
            <Route path="/admin/subscriptions" element={<AdminSubscriptions />} />
            <Route path="/tutorials" element={<Tutorials />} />
            <Route path="/whatsapp" element={<WhatsAppPage />} />
            <Route path="/tasks" element={<Tasks />} />
          </Route>
        </Route>
      </Routes>
    </>
  )
}

function App() {
  return (
    <LoadingProvider>
      <AppContent />
    </LoadingProvider>
  )
}

export default App
