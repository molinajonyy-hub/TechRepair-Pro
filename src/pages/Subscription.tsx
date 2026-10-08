/**
 * Subscription.tsx — Mi Suscripción
 * Shows current plan, status, payment history and management actions.
 *
 * BETA-UX-1C — la pantalla se dibuja a partir del estado REAL, que resuelve
 * `lib/subscriptionPresentation` con señales que ya escribe el servidor. Acá no
 * hay condiciones sueltas por botón: cada acción aparece si el estado la ofrece.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CreditCard, CheckCircle, AlertTriangle, XCircle,
  Clock, Loader2, RefreshCw, ExternalLink, ChevronDown, ChevronUp,
  Receipt, Zap, LifeBuoy, ShieldCheck,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import {
  cancelSubscription, createSubscription, formatSubscriptionPrice, getCheckoutStatus,
  getSubscriptionPayments, getUpdatePaymentLink, reconcilePayment,
  MP_PAYER_EMAIL_REQUIRED, subscriptionErrorCode,
} from '../services/subscriptionService'
import {
  BILLING_LABELS,
  PLANS,
  STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  type BillingCycle,
  type CheckoutSummary,
  type PaymentStatus,
  type SubscriptionPlan,
  type SubscriptionStatus,
} from '../types/subscription'
import { PLAN_FEATURES, type PlanFeature } from '../config/planFeatures'
import {
  offersAction, offersPlans, resolveSubscriptionPresentation, shouldLookUpPendingCheckout,
  type SubscriptionActionId, type SubscriptionPresentation,
} from '../lib/subscriptionPresentation'
import { MercadoPagoEmailDialog } from '../components/subscription/MercadoPagoEmailDialog'
import { supabase } from '../lib/supabase'

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'neutral'

/** Dónde se dibuja el resultado de una acción: junto al estado o en «Administrar». */
type Zone = 'status' | 'manage'

interface Feedback {
  zone: Zone
  kind: 'info' | 'error'
  text: string
}

/** El pedido del email de Mercado Pago, abierto sobre un checkout a continuar. */
interface PayerEmailPrompt {
  plan: SubscriptionPlan
  billingCycle: BillingCycle
  /** El email que se intentó y no funcionó; vacío si todavía no se pidió ninguno. */
  email: string
  error: string
}

const ACTION_LABEL: Record<SubscriptionActionId, string> = {
  choose_plan: 'Elegir plan',
  reactivate: 'Reactivar',
  continue_checkout: 'Continuar pago',
  verify_payment: 'Verificar pago',
  change_plan: 'Cambiar plan',
  update_payment_method: 'Actualizar método de pago',
  cancel_subscription: 'Cancelar suscripción',
  help: 'Ayuda',
}

const PAYMENT_TONE: Record<PaymentStatus, Tone> = {
  approved: 'success',
  pending: 'warning',
  in_process: 'info',
  rejected: 'danger',
  cancelled: 'neutral',
  refunded: 'accent',
  charged_back: 'danger',
}

const SPIN = { animation: 'tr-spin 1s linear infinite' } as const

const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback

function toneOf(presentation: SubscriptionPresentation, status: SubscriptionStatus): Tone {
  switch (presentation.state) {
    case 'trial':
    case 'trial_pending_checkout':
      return 'info'
    case 'past_due':
      return 'warning'
    case 'blocked':
      // Un trial vencido no es una deuda: conserva el tono informativo del trial.
      if (presentation.wall === 'trial_ended') return 'info'
      return status === 'suspended' ? 'danger' : status === 'canceled' ? 'neutral' : 'accent'
    default:
      return 'success'
  }
}

function StatusIcon({ presentation }: { presentation: SubscriptionPresentation }) {
  switch (presentation.state) {
    case 'manual_access':
      return <ShieldCheck size={22} />
    case 'mp_active':
    case 'active_unlinked':
      return <CheckCircle size={22} />
    case 'trial':
    case 'trial_pending_checkout':
      return <Clock size={22} />
    case 'past_due':
      return <AlertTriangle size={22} />
    default:
      return presentation.wall === 'trial_ended' ? <Clock size={22} /> : <XCircle size={22} />
  }
}

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** «Te quedan N días de prueba…», con lo que se sepa de la fecha de fin. */
function trialDaysLine(days: number | null): string {
  if (days === null) return 'Estás en período de prueba, con acceso completo al Plan Pro.'
  if (days <= 0) return 'Tu prueba termina hoy.'
  return `${plural(days, 'Te queda', 'Te quedan')} ${days} ${plural(days, 'día', 'días')} de prueba, con acceso completo al Plan Pro.`
}

export function Subscription() {
  const { businessId, user } = useAuth()
  const navigate = useNavigate()
  const { subscription, payments, loading, error, refresh,
          isTrial, isActive, isPastDue, isSuspended, isCanceled,
          daysUntilTrialEnd, daysUntilGraceEnd, daysUntilPeriodEnd } = useSubscription()

  const [canceling, setCanceling] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const [updatingPayment, setUpdatingPayment] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [payerPrompt, setPayerPrompt] = useState<PayerEmailPrompt | null>(null)
  const [saasPayments, setSaasPayments] = useState<any[]>([])
  const [activeUserCount, setActiveUserCount] = useState<number | null>(null)
  // Último checkout según el servidor. `null`: no hay, no se consultó o falló.
  const [checkout, setCheckout] = useState<CheckoutSummary | null>(null)
  const [checkoutLookup, setCheckoutLookup] = useState(0)

  // Estado EFECTIVO: el de `resolveEntitlement` (ya con el rescate por override),
  // que `useSubscription` expone como flags.
  const rawStatus = (subscription?.subscription_status as SubscriptionStatus) || 'pending_activation'
  const status: SubscriptionStatus =
    isTrial ? 'trialing' : isActive ? 'active' : isPastDue ? 'past_due'
      : isSuspended ? 'suspended' : isCanceled ? 'canceled' : rawStatus

  // ── BETA-UX-1C · sólo presentación ────────────────────────────────────────
  const presentation = resolveSubscriptionPresentation({
    status,
    accessSource: subscription?.access_source,
    mpPreapprovalId: subscription?.mp_preapproval_id,
    lastPaymentStatus: subscription?.last_payment_status,
    trialEndsAt: subscription?.trial_ends_at,
    currentPeriodEnd: subscription?.current_period_end,
    overrideExpiresAt: subscription?.override_expires_at,
    checkout,
  })
  const offers = (action: SubscriptionActionId) => offersAction(presentation, action)
  const trialEnded = presentation.wall === 'trial_ended'
  const inTrial = presentation.state === 'trial' || presentation.state === 'trial_pending_checkout'

  // Durante la prueba el acceso es el del Plan Pro, tenga o no un plan cargado.
  const plan = PLANS.find(p => p.id === subscription?.subscription_plan)
    ?? (inTrial ? PLANS.find(p => p.id === 'pro') : undefined)

  // ¿Hay un pago iniciado? Se le pregunta al servidor (acción `status`), una vez
  // por visita y sólo durante un trial: es el único estado que cambia con la
  // respuesta. Si la lectura falla, la pantalla queda en el trial de siempre:
  // nunca se inventa un checkout pendiente.
  const lookUpCheckout = !loading && shouldLookUpPendingCheckout({ status, accessSource: subscription?.access_source })
  useEffect(() => {
    if (!businessId || !lookUpCheckout) return
    let alive = true
    getCheckoutStatus(businessId)
      .then(found => { if (alive) setCheckout(found) })
      .catch(() => { if (alive) setCheckout(null) })
    return () => { alive = false }
  }, [businessId, lookUpCheckout, checkoutLookup])

  // Cargar cantidad de usuarios activos
  useState(() => {
    if (!businessId) return
    supabase.from('profiles').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('is_active', true)
      .then(({ count }) => setActiveUserCount(count ?? 0))
  })

  async function handleCancel() {
    if (!businessId || !offers('cancel_subscription')) return
    try {
      setCanceling(true)
      setFeedback(null)
      await cancelSubscription(businessId)
      await refresh()
      setCancelConfirm(false)
    } catch (err) {
      setFeedback({ zone: 'manage', kind: 'error', text: messageOf(err, 'No pudimos cancelar la suscripción.') })
    } finally {
      setCanceling(false)
    }
  }

  // BETA-MP: «Verificar pago» le pide al servidor que consulte a Mercado Pago. El
  // resultado puede cambiar el estado (activar, o reflejar una baja), así que
  // siempre se relee; el mensaje y el checkout son los del servidor.
  async function handleReconcile(zone: Zone) {
    if (!businessId || !offers('verify_payment')) return
    setReconciling(true); setFeedback(null)
    try {
      const result = await reconcilePayment(businessId)
      setFeedback({ zone, kind: 'info', text: result.message })
      setCheckout(result.checkout)
      await refresh()
    } catch (err) {
      setFeedback({ zone, kind: 'error', text: messageOf(err, 'Error al verificar. Intentá de nuevo.') })
    } finally { setReconciling(false) }
  }

  // Cargar pagos SaaS al abrir historial
  const loadSaasPayments = async () => {
    if (!businessId || saasPayments.length > 0) return
    setSaasPayments(await getSubscriptionPayments(businessId))
  }

  async function handleUpdatePayment(zone: Zone) {
    if (!businessId || !offers('update_payment_method')) return
    try {
      setUpdatingPayment(true)
      setFeedback(null)
      const url = await getUpdatePaymentLink(businessId)
      window.open(url, '_blank')
    } catch (err) {
      setFeedback({ zone, kind: 'error', text: messageOf(err, 'No pudimos obtener el enlace de Mercado Pago.') })
    } finally {
      setUpdatingPayment(false)
    }
  }

  /**
   * «Continuar pago»: el mismo camino que Planes. El navegador propone el plan y
   * el ciclo del checkout que informó el SERVIDOR; el servidor reutiliza esa
   * intención y devuelve su `init_point`. Acá no se arma ninguna URL.
   *
   * Sin `email` el servidor usa el del login. Si ese checkout se había abierto
   * con otro email de Mercado Pago, lo pide de nuevo (`mp_payer_email_required`).
   */
  async function continueCheckout(plan: SubscriptionPlan, billingCycle: BillingCycle, email: string) {
    if (!businessId) return
    setContinuing(true); setFeedback(null)
    try {
      const res = await createSubscription({
        business_id:   businessId,
        plan,
        billing_cycle: billingCycle,
        ...(email ? { mp_payer_email: email } : {}),
      })
      window.location.href = res.init_point
    } catch (err) {
      setContinuing(false)
      if (email) {
        // El reintento falló: se muestra el motivo y NO se reintenta solo.
        setPayerPrompt({ plan, billingCycle, email, error: messageOf(err, 'Error al iniciar el pago') })
      } else if (subscriptionErrorCode(err) === MP_PAYER_EMAIL_REQUIRED) {
        setPayerPrompt({ plan, billingCycle, email: '', error: '' })
      } else {
        setFeedback({ zone: 'status', kind: 'error', text: messageOf(err, 'Error al iniciar el pago') })
        // El servidor pudo haber cerrado ese checkout: se relee en vez de suponer.
        setCheckoutLookup(n => n + 1)
      }
    }
  }

  function handleContinueCheckout() {
    if (!offers('continue_checkout') || !checkout) return
    void continueCheckout(checkout.plan, checkout.billing_cycle, '')
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40vh', gap: '1rem', color: 'var(--text-muted)' }}>
        <Loader2 size={24} style={SPIN} />
        Cargando suscripción...
      </div>
    )
  }

  const tone = toneOf(presentation, status)
  const hasManageCard = presentation.manage.length > 0 || presentation.destructive.length > 0
  const feedbackZone: Zone | null = feedback ? (feedback.zone === 'manage' && hasManageCard ? 'manage' : 'status') : null

  const renderFeedback = (zone: Zone) => {
    if (!feedback || feedbackZone !== zone) return null
    // El motivo que devuelve el servidor, en la pantalla y no en un alert().
    return feedback.kind === 'error' ? (
      <div className="alert-inline alert-error sub-feedback" role="alert" data-testid="subscription-manage-error">
        {feedback.text}
      </div>
    ) : (
      <p className="sub-feedback sub-feedback--info" role="status" data-testid="subscription-action-message">
        {feedback.text}
      </p>
    )
  }

  /** Un botón por acción. El estilo sale del lugar que ocupa, no de la acción. */
  const renderAction = (action: SubscriptionActionId, variant: 'primary' | 'secondary', zone: Zone) => {
    const className = variant === 'primary' ? 'btn btn-primary btn-lift' : 'btn btn-outline'
    const testId = `subscription-action-${action}`
    switch (action) {
      case 'choose_plan':
      case 'reactivate':
        return (
          <button key={action} type="button" onClick={() => navigate('/subscription/plans')} className={className} data-testid={testId}>
            <Zap size={16} />
            {ACTION_LABEL[action]}
          </button>
        )
      case 'change_plan':
        return (
          <button key={action} type="button" onClick={() => navigate('/subscription/plans')} className={className} data-testid={testId}>
            {ACTION_LABEL[action]}
          </button>
        )
      case 'help':
        return (
          <button key={action} type="button" onClick={() => navigate('/ayuda')} className={className} data-testid={testId}>
            <LifeBuoy size={16} />
            {ACTION_LABEL[action]}
          </button>
        )
      case 'continue_checkout':
        return (
          <button key={action} type="button" onClick={handleContinueCheckout} disabled={continuing} className={className} data-testid={testId}>
            {continuing ? <Loader2 size={16} style={SPIN} /> : <ExternalLink size={16} />}
            {continuing ? 'Redirigiendo...' : ACTION_LABEL[action]}
          </button>
        )
      case 'verify_payment':
        // Verificar pago — útil cuando el webhook tardó
        return (
          <button key={action} type="button" onClick={() => handleReconcile(zone)} disabled={reconciling} className={className} data-testid={testId}>
            {reconciling ? <Loader2 size={16} style={SPIN} /> : <RefreshCw size={16} />}
            {ACTION_LABEL[action]}
          </button>
        )
      case 'update_payment_method':
        return (
          <button key={action} type="button" onClick={() => handleUpdatePayment(zone)} disabled={updatingPayment} className={className} data-testid={testId}>
            {updatingPayment ? <Loader2 size={16} style={SPIN} /> : <CreditCard size={16} />}
            {ACTION_LABEL[action]}
            <ExternalLink size={14} />
          </button>
        )
      default:
        return null
    }
  }

  const statusActions = [
    ...(presentation.primary ? [renderAction(presentation.primary, 'primary', 'status')] : []),
    ...presentation.secondary.map(action => renderAction(action, 'secondary', 'status')),
  ]

  const badge = trialEnded ? 'Prueba finalizada' : STATUS_LABELS[status]
  const pendingPlanName = PLANS.find(p => p.id === checkout?.plan)?.name

  return (
    <div className="sub-page" style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <CreditCard size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Mi Suscripción</h1>
            <p className="page-hdr-subtitle">{user?.email}</p>
          </div>
        </div>
        <div className="page-hdr-right">
          <button onClick={refresh} className="btn btn-ghost btn-sm">
            <RefreshCw size={15} /> Actualizar
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* Status card */}
      <div
        className={`card sub-status-card sub-tone-${tone}`}
        style={{ marginBottom: '1.5rem' }}
        data-testid="subscription-status-card"
        data-presentation={presentation.state}
      >
        <div className="card-body">
          <div className="sub-status">
            <div className="sub-status__main">
              <div className="sub-status__icon" aria-hidden="true">
                <StatusIcon presentation={presentation} />
              </div>

              <div className="sub-status__heading">
                <h2 className="sub-status__title">
                  {plan ? `Plan ${plan.name}` : 'Sin plan activo'}
                </h2>
                <span className="sub-status__badge" data-testid="subscription-status-badge">
                  {badge}
                </span>
              </div>

              <div className="sub-status__detail">
                {/* BETA-1: un trial vencido no es una deuda. */}
                {trialEnded && (
                  <p data-testid="subscription-trial-ended">
                    Tu período de prueba terminó. Elegí un plan para seguir usando TechRepair Pro; tus datos siguen guardados y protegidos.
                  </p>
                )}

                {presentation.state === 'manual_access' && (
                  <>
                    <p data-testid="subscription-manual-access">
                      <strong>Acceso otorgado por TechRepair Pro.</strong>
                    </p>
                    {presentation.manualAccessExpiresAt && (
                      <p data-testid="subscription-manual-expiry">
                        {new Date(presentation.manualAccessExpiresAt).getTime() > Date.now() ? 'Tu acceso vence el ' : 'Tu acceso venció el '}
                        {longDate(presentation.manualAccessExpiresAt)}.
                      </p>
                    )}
                    <p>Si necesitás cambiar algo de tu acceso, escribinos desde Ayuda.</p>
                  </>
                )}

                {presentation.state === 'trial_pending_checkout' && (
                  <p data-testid="subscription-pending-checkout">
                    <strong>Tenés un pago iniciado en Mercado Pago.</strong>{' '}
                    {pendingPlanName && checkout && `Plan ${pendingPlanName}, ${BILLING_LABELS[checkout.billing_cycle]?.toLowerCase() ?? ''}. `}
                    Si ya pagaste, tocá «Verificar pago»; si no lo terminaste, podés continuarlo.
                  </p>
                )}

                {inTrial && (
                  <p data-testid="subscription-trial-days">{trialDaysLine(daysUntilTrialEnd)}</p>
                )}
                {presentation.state === 'trial' && (
                  <p data-testid="subscription-trial-next">
                    Cuando termine tu prueba, elegí un plan para seguir usando TechRepair Pro. Tus datos quedan guardados.
                  </p>
                )}

                {presentation.state === 'past_due' && (
                  <p data-testid="subscription-past-due">
                    <strong>Tenemos un pago pendiente de tu suscripción.</strong>{' '}
                    {daysUntilGraceEnd !== null && daysUntilGraceEnd > 0
                      ? `Tu acceso sigue activo durante el período de gracia: ${plural(daysUntilGraceEnd, 'queda', 'quedan')} ${daysUntilGraceEnd} ${plural(daysUntilGraceEnd, 'día', 'días')} para regularizarlo.`
                      : 'Tu acceso está en período de gracia: regularizalo para no perderlo.'}
                  </p>
                )}

                {/* «Próximo cobro» sólo si hay una suscripción que cobre: un acceso
                    otorgado a mano también tiene `current_period_end`. */}
                {presentation.showNextCharge && daysUntilPeriodEnd !== null && (
                  <p data-testid="subscription-next-charge">
                    Próximo cobro: {daysUntilPeriodEnd <= 0 ? 'hoy' : `en ${daysUntilPeriodEnd} días`}
                    {subscription?.current_period_end && ` (${new Date(subscription.current_period_end).toLocaleDateString('es-AR')})`}
                  </p>
                )}
              </div>
            </div>

            {/* Actions */}
            {statusActions.length > 0 && (
              <div className="sub-status__actions" data-testid="subscription-status-actions">
                {statusActions}
              </div>
            )}
          </div>

          {renderFeedback('status')}
        </div>
      </div>

      {/* Plan details */}
      {plan && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header">
            <h3 className="card-title">Detalles del plan</h3>
          </div>
          <div className="card-body">
            <div data-testid="subscription-plan-details" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '1rem' }}>
              <InfoRow label="Plan" value={plan.name} />
              {presentation.price === 'current' && (
                <InfoRow label="Pago" value={formatSubscriptionPrice(plan.price_monthly)} />
              )}
              {/* Durante la prueba no se cobra nada: el precio es lo que viene después. */}
              {presentation.price === 'after_trial' && (
                <InfoRow label="Al terminar la prueba" value={`${formatSubscriptionPrice(plan.price_monthly)}/mes`} />
              )}
              {presentation.state === 'manual_access' && (
                <>
                  <InfoRow label="Acceso" value="Otorgado por TechRepair Pro" />
                  {presentation.manualAccessExpiresAt && (
                    <InfoRow label="Vencimiento" value={longDate(presentation.manualAccessExpiresAt)} />
                  )}
                </>
              )}
              {presentation.showBillingDetails && subscription?.mp_payer_email && <InfoRow label="Email pagador" value={subscription.mp_payer_email} />}
              {presentation.showBillingDetails && subscription?.current_period_start && (
                <InfoRow label="Período desde" value={new Date(subscription.current_period_start).toLocaleDateString('es-AR')} />
              )}
              {presentation.showBillingDetails && subscription?.current_period_end && (
                <InfoRow label="Período hasta" value={new Date(subscription.current_period_end).toLocaleDateString('es-AR')} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Plan features & limits */}
      {(() => {
        const planId = subscription?.subscription_plan as keyof typeof PLAN_FEATURES | undefined
        const features = planId ? PLAN_FEATURES[planId] : (isTrial ? PLAN_FEATURES.pro : null)
        if (!features) return null

        const featureRows: { key: PlanFeature; label: string }[] = [
          { key: 'arca',            label: 'Facturación electrónica ARCA' },
          { key: 'currentAccounts', label: 'Cuentas corrientes' },
          { key: 'reports',         label: 'Reportes avanzados' },
          { key: 'advancedFinance', label: 'Finanzas Pro' },
          { key: 'tasks',           label: 'Módulo de tareas' },
          { key: 'mayorista',       label: 'Módulo mayorista' },
          { key: 'advancedRoles',   label: 'Permisos granulares' },
          { key: 'audit',           label: 'Auditoría del sistema' },
          { key: 'multisucursal',   label: 'Multi-sucursal' },
        ]

        return (
          <div className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', width: '100%' }}>
                <h3 className="card-title" style={{ margin: 0 }}>Funciones del plan</h3>
                {isTrial && (
                  <span className="sub-pill sub-tone-info">
                    Trial — acceso Pro
                  </span>
                )}
              </div>
            </div>
            <div className="card-body">
              {/* Usuarios */}
              <div className="sub-users" data-testid="subscription-users">
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Usuarios incluidos</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {activeUserCount !== null && (
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {activeUserCount} usados de
                    </span>
                  )}
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                    {features.maxUsers}
                  </span>
                </div>
              </div>

              {/* Feature grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.5rem' }}>
                {featureRows.map(({ key, label }) => {
                  const enabled = features[key]
                  return (
                    <div key={key} className={enabled ? 'sub-feature sub-feature--on' : 'sub-feature'}>
                      <span className="sub-feature__mark" aria-hidden="true">
                        {enabled ? '✓' : '—'}
                      </span>
                      <span>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* Upgrade CTA — nunca sobre un acceso otorgado a mano. */}
              {planId && planId !== 'full' && offersPlans(presentation) && (
                <div className="sub-upgrade">
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    Actualizá para desbloquear más funciones
                  </span>
                  <button onClick={() => navigate('/subscription/plans')} className="btn btn-primary" style={{ padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
                    Ver planes
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Payment history — un acceso manual sin pagos no tiene historial que mostrar. */}
      {(presentation.state !== 'manual_access' || payments.length > 0) && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div
            className="card-header"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={() => { setShowHistory(v => !v); if (!showHistory) loadSaasPayments() }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <h3 className="card-title" style={{ margin: 0 }}>
                <Receipt size={16} style={{ marginRight: '0.5rem', verticalAlign: 'middle' }} />
                Historial de pagos
              </h3>
              {showHistory ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </div>
          </div>

          {showHistory && (
            <div className="card-body" style={{ padding: 0 }}>
              {payments.length === 0 ? (
                <p style={{ padding: '1.5rem', color: 'var(--text-muted)', textAlign: 'center', fontSize: '0.875rem' }}>
                  No hay pagos registrados aún.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {['Fecha', 'Importe', 'Plan', 'Estado'].map(h => (
                          <th key={h} className="label-caps">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map(p => (
                        <tr key={p.id}>
                          <td>{p.paid_at ? new Date(p.paid_at).toLocaleDateString('es-AR') : new Date(p.created_at).toLocaleDateString('es-AR')}</td>
                          <td>{formatSubscriptionPrice(p.amount, p.currency)}</td>
                          <td>{PLANS.find(pl => pl.id === p.subscription_plan)?.name || p.subscription_plan || '—'}</td>
                          <td>
                            <span className={`sub-status__badge sub-tone-${PAYMENT_TONE[p.status] ?? 'neutral'}`}>
                              {PAYMENT_STATUS_LABELS[p.status]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Management actions — sólo las de una suscripción de Mercado Pago que existe. */}
      {hasManageCard && (
        <div className="card" style={{ marginBottom: '1.5rem' }} data-testid="subscription-manage-card">
          <div className="card-header"><h3 className="card-title">Administrar suscripción</h3></div>
          <div className="card-body sub-manage">
            {presentation.manage.map(action => renderAction(action, 'secondary', 'manage'))}

            {offers('cancel_subscription') && (!cancelConfirm ? (
              <button type="button" onClick={() => setCancelConfirm(true)} className="btn btn-danger" data-testid="subscription-action-cancel_subscription">
                {ACTION_LABEL.cancel_subscription}
              </button>
            ) : (
              <div className="sub-manage__confirm">
                <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem' }}>¿Confirmás la cancelación?</span>
                <button type="button" onClick={handleCancel} disabled={canceling} className="btn btn-danger">
                  {canceling ? <Loader2 size={14} style={SPIN} /> : null}
                  Sí, cancelar
                </button>
                <button type="button" onClick={() => setCancelConfirm(false)} className="btn btn-ghost">
                  No, volver
                </button>
              </div>
            ))}

            {renderFeedback('manage')}
          </div>
        </div>
      )}

      {/* Mismo fallback que Planes: sólo si Mercado Pago no pudo iniciar con el email del login. */}
      {payerPrompt && (
        <MercadoPagoEmailDialog
          planName={PLANS.find(p => p.id === payerPrompt.plan)?.name ?? ''}
          attemptedEmail={payerPrompt.email}
          submitting={continuing}
          error={payerPrompt.error}
          onSubmit={email => continueCheckout(payerPrompt.plan, payerPrompt.billingCycle, email)}
          onClose={() => { setPayerPrompt(null); setContinuing(false); setCheckoutLookup(n => n + 1) }}
        />
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label-caps" style={{ marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 500 }}>{value}</div>
    </div>
  )
}
