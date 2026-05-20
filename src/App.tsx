import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { PremiumErrorBoundary } from './components/ui/PremiumErrorBoundary'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { PersonalProtectedRoute } from './components/auth/PersonalProtectedRoute'
import { MainLayout } from './layouts/MainLayout'
import { LoadingProvider, useLoading } from './contexts/LoadingContext'
import { LoadingDino } from './components/LoadingDino'
import { PortalRouter, PORTAL_DOMAINS } from './portal/PortalRouter'
import { ProtectedRouteByFeature } from './components/auth/ProtectedRouteByFeature'
import { ProtectedRouteBySystemOwner } from './components/auth/ProtectedRouteBySystemOwner'
import { UpdateBanner } from './components/UpdateBanner'

// ── Personal Finance (Mi Guita) ──────────────────────────────────
const PersonalLayout      = lazy(() => import('./personal/layouts/PersonalLayout').then(m => ({ default: m.PersonalLayout })))
const PersonalDashboard   = lazy(() => import('./personal/pages/PersonalDashboard').then(m => ({ default: m.PersonalDashboard })))
const PersonalMovements   = lazy(() => import('./personal/pages/PersonalMovements').then(m => ({ default: m.PersonalMovements })))
const PersonalAccounts    = lazy(() => import('./personal/pages/PersonalAccounts').then(m => ({ default: m.PersonalAccounts })))
const OwnerWithdrawal     = lazy(() => import('./personal/pages/OwnerWithdrawal').then(m => ({ default: m.OwnerWithdrawalPage })))
const PersonalMore        = lazy(() => import('./personal/pages/PersonalStubs').then(m => ({ default: m.PersonalMore })))
const PersonalCreditCards = lazy(() => import('./personal/pages/PersonalCards').then(m => ({ default: m.PersonalCards })))
const PersonalSavings     = lazy(() => import('./personal/pages/PersonalSavings').then(m => ({ default: m.PersonalSavings })))
const PersonalDebts              = lazy(() => import('./personal/pages/PersonalDebts').then(m => ({ default: m.PersonalDebts })))
const PersonalRecurringExpenses  = lazy(() => import('./personal/pages/PersonalRecurringExpenses').then(m => ({ default: m.PersonalRecurringExpenses })))
const PersonalProjection  = lazy(() => import('./personal/pages/PersonalStubs').then(m => ({ default: m.PersonalProjection })))
const PersonalCategories  = lazy(() => import('./personal/pages/PersonalStubs').then(m => ({ default: m.PersonalCategories })))
const PersonalSettings    = lazy(() => import('./personal/pages/PersonalStubs').then(m => ({ default: m.PersonalSettings })))

// ── Auth / utility — always static (critical paths, small size) ───
import { AcceptInvite } from './pages/AcceptInvite'
import { AuthCallback } from './pages/AuthCallback'
import { Login } from './pages/Login'
import { MiGuitaBridge } from './pages/MiGuitaBridge'
import { NoBusiness } from './pages/NoBusiness'
import { Onboarding } from './pages/Onboarding'
import { ResetPassword } from './pages/ResetPassword'

// ── Lazy pages — default exports ──────────────────────────────────
const Comprobante = lazy(() => import('./pages/Comprobante'))
const Comprobantes = lazy(() => import('./pages/Comprobantes'))
const Settings = lazy(() => import('./pages/Settings'))
const WhatsAppPage = lazy(() => import('./pages/WhatsApp'))

// ── Lazy pages — named exports ────────────────────────────────────
const AdminLeads = lazy(() => import('./pages/AdminLeads').then(m => ({ default: m.AdminLeads })))
const AdminPortalClic = lazy(() => import('./pages/AdminPortalClic').then(m => ({ default: m.AdminPortalClic })))
const AdminSubscriptions = lazy(() => import('./pages/AdminSubscriptions').then(m => ({ default: m.AdminSubscriptions })))
const CajaPage = lazy(() => import('./pages/CajaPage').then(m => ({ default: m.CajaPage })))
const CuentasCorrientes = lazy(() => import('./pages/CuentasCorrientes').then(m => ({ default: m.CuentasCorrientes })))
const CurrencySettings = lazy(() => import('./pages/CurrencySettings').then(m => ({ default: m.CurrencySettings })))
const CustomerDetail = lazy(() => import('./pages/CustomerDetail').then(m => ({ default: m.CustomerDetail })))
const CustomerPortal = lazy(() => import('./pages/CustomerPortal').then(m => ({ default: m.CustomerPortal })))
const Customers = lazy(() => import('./pages/Customers').then(m => ({ default: m.Customers })))
const Dashboard = lazy(() => import('./pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Expenses = lazy(() => import('./pages/Expenses').then(m => ({ default: m.Expenses })))
const Finance = lazy(() => import('./pages/Finance').then(m => ({ default: m.Finance })))
const Inventory = lazy(() => import('./pages/Inventory').then(m => ({ default: m.Inventory })))
const LandingPage = lazy(() => import('./pages/LandingPage').then(m => ({ default: m.LandingPage })))
const Mayorista = lazy(() => import('./pages/Mayorista').then(m => ({ default: m.Mayorista })))
const NewCustomer = lazy(() => import('./pages/NewCustomer').then(m => ({ default: m.NewCustomer })))
const NewOrder = lazy(() => import('./pages/NewOrder').then(m => ({ default: m.NewOrder })))
const Offers = lazy(() => import('./pages/Offers').then(m => ({ default: m.Offers })))
const OrderDetail = lazy(() => import('./pages/OrderDetail').then(m => ({ default: m.OrderDetail })))
const Orders = lazy(() => import('./pages/Orders').then(m => ({ default: m.Orders })))
const PaymentPending = lazy(() => import('./pages/PaymentPending').then(m => ({ default: m.PaymentPending })))
const Plans = lazy(() => import('./pages/Plans').then(m => ({ default: m.Plans })))
const Reports = lazy(() => import('./pages/Reports').then(m => ({ default: m.Reports })))
const Subscription = lazy(() => import('./pages/Subscription').then(m => ({ default: m.Subscription })))
const SubscriptionFailure = lazy(() => import('./pages/SubscriptionFailure').then(m => ({ default: m.SubscriptionFailure })))
const SubscriptionSuccess = lazy(() => import('./pages/SubscriptionSuccess').then(m => ({ default: m.SubscriptionSuccess })))
const SubscriptionSuspended = lazy(() => import('./pages/SubscriptionSuspended').then(m => ({ default: m.SubscriptionSuspended })))
const Suppliers = lazy(() => import('./pages/Suppliers').then(m => ({ default: m.Suppliers })))
const Tasks = lazy(() => import('./pages/Tasks').then(m => ({ default: m.Tasks })))
const Tutorials = lazy(() => import('./pages/Tutorials').then(m => ({ default: m.Tutorials })))
const UsersManagement = lazy(() => import('./pages/UsersManagement').then(m => ({ default: m.UsersManagement })))
const Warranties = lazy(() => import('./pages/Warranties').then(m => ({ default: m.Warranties })))

function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div style={{
        width: 36,
        height: 36,
        border: '3px solid rgba(99,102,241,0.2)',
        borderTopColor: '#6366f1',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }} />
    </div>
  )
}

function AppContent() {
  const { loadingState } = useLoading()

  const loadingNode = loadingState.isLoading && (
    <LoadingDino
      fullScreen
      message={loadingState.message}
      progress={loadingState.progress}
      showProgress={loadingState.showProgress}
    />
  )

  // Si el hostname es un dominio exclusivo del portal, montar el portal en la raíz
  const portalSlug = PORTAL_DOMAINS[window.location.hostname]
  if (portalSlug) {
    return (
      <>
        {loadingNode}
        <Routes>
          <Route path="/*" element={<PortalRouter forcedSlug={portalSlug} />} />
        </Routes>
      </>
    )
  }

  return (
    <>
      {loadingNode}
      <UpdateBanner />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/no-business" element={<NoBusiness />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/customer-portal" element={<CustomerPortal />} />

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
              <Route path="/suppliers" element={<Suppliers />} />
              <Route path="/offers" element={<Offers />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/caja" element={<CajaPage />} />
              <Route path="/currency-settings" element={<CurrencySettings />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/users" element={<UsersManagement />} />

              {/* ── Rutas PRO — currentAccounts ── */}
              <Route element={<ProtectedRouteByFeature feature="currentAccounts" />}>
                <Route path="/cuentas" element={<CuentasCorrientes />} />
              </Route>

              {/* ── Rutas PRO — advancedFinance ── */}
              <Route element={<ProtectedRouteByFeature feature="advancedFinance" />}>
                <Route path="/finance" element={<Finance />} />
              </Route>

              {/* ── Rutas PRO — reports ── */}
              <Route element={<ProtectedRouteByFeature feature="reports" />}>
                <Route path="/reports" element={<Reports />} />
              </Route>

              {/* ── Rutas PRO — tasks ── */}
              <Route element={<ProtectedRouteByFeature feature="tasks" />}>
                <Route path="/tasks" element={<Tasks />} />
              </Route>

              {/* ── Rutas PRO — mayorista ── */}
              <Route element={<ProtectedRouteByFeature feature="mayorista" />}>
                <Route path="/mayorista" element={<Mayorista />} />
                <Route path="/portal-clic" element={<AdminPortalClic />} />
              </Route>

              {/* ── Rutas SaaS Admin — solo system owner ── */}
              <Route element={<ProtectedRouteBySystemOwner />}>
                <Route path="/admin/subscriptions" element={<AdminSubscriptions />} />
                <Route path="/admin/leads" element={<AdminLeads />} />
              </Route>

              {/* Subscription (siempre accesible) */}
              <Route path="/subscription" element={<Subscription />} />
              <Route path="/subscription/plans" element={<Plans />} />
              <Route path="/subscription/pending"  element={<PaymentPending />} />
              <Route path="/subscription/success"  element={<SubscriptionSuccess />} />
              <Route path="/subscription/failure"  element={<SubscriptionFailure />} />
              <Route path="/subscription/suspended" element={<SubscriptionSuspended />} />
              <Route path="/tutorials" element={<Tutorials />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
            </Route>
          </Route>

          {/* ── Mi Guita — Bridge (desktop) ──────────────────────────── */}
          <Route path="/mi-guita" element={<MiGuitaBridge />} />

          {/* ── Mi Guita — Finanzas Personales ─────────────────────── */}
          {/* Uses PersonalProtectedRoute: auth-only, no business access required */}
          <Route element={<PersonalProtectedRoute />}>
            <Route element={<PersonalLayout />}>
              <Route path="/personal"                  element={<PersonalDashboard />} />
              <Route path="/personal/movimientos"      element={<PersonalMovements />} />
              <Route path="/personal/movimientos/nuevo" element={<PersonalMovements />} />
              <Route path="/personal/cuentas"          element={<PersonalAccounts />} />
              <Route path="/personal/sueldo"           element={<OwnerWithdrawal />} />
              <Route path="/personal/tarjetas"         element={<PersonalCreditCards />} />
              <Route path="/personal/tarjetas/compra"  element={<PersonalCreditCards />} />
              <Route path="/personal/ahorros"          element={<PersonalSavings />} />
              <Route path="/personal/deudas"           element={<PersonalDebts />} />
              <Route path="/personal/gastos-fijos"     element={<PersonalRecurringExpenses />} />
              <Route path="/personal/proyecciones"     element={<PersonalProjection />} />
              <Route path="/personal/categorias"       element={<PersonalCategories />} />
              <Route path="/personal/configuracion"    element={<PersonalSettings />} />
              <Route path="/personal/mas"              element={<PersonalMore />} />
            </Route>
          </Route>

          {/* Portal Mayorista Privado (/mayorista/clic, /mayorista/clic/catalogo, etc.)
              Declarado DESPUÉS del admin /mayorista (exacto) para que React Router v6
              prefiera la ruta exacta cuando el usuario navega a /mayorista sin slug. */}
          <Route path="/mayorista/:slug/*" element={<PortalRouter />} />
        </Routes>
      </Suspense>
    </>
  )
}

function App() {
  return (
    <PremiumErrorBoundary context="App">
      <LoadingProvider>
        <AppContent />
      </LoadingProvider>
    </PremiumErrorBoundary>
  )
}

export default App
