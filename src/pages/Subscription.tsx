/**
 * Subscription.tsx — Mi Suscripción
 * Shows current plan, status, payment history and management actions.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CreditCard, CheckCircle, AlertTriangle, XCircle,
  Clock, Loader2, RefreshCw, ExternalLink, ChevronDown, ChevronUp,
  Receipt, Zap
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import { cancelSubscription, getUpdatePaymentLink, formatSubscriptionPrice, reconcilePayment, getSubscriptionPayments } from '../services/subscriptionService'
import {
  PLANS,
  STATUS_LABELS,
  STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_COLORS,
  type SubscriptionStatus,
} from '../types/subscription'
import { PLAN_FEATURES, type PlanFeature } from '../config/planFeatures'
import { supabase } from '../lib/supabase'

function StatusIcon({ status }: { status: SubscriptionStatus }) {
  switch (status) {
    case 'active':   return <CheckCircle size={20} color="#34d399" />
    case 'trialing': return <Clock size={20} color="#60a5fa" />
    case 'past_due': return <AlertTriangle size={20} color="#fbbf24" />
    default:         return <XCircle size={20} color="#f87171" />
  }
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
  const [reconcileMsg, setReconcileMsg] = useState('')
  const [saasPayments, setSaasPayments] = useState<any[]>([])
  const [activeUserCount, setActiveUserCount] = useState<number | null>(null)

  const status       = (subscription?.subscription_status as SubscriptionStatus) || 'pending_activation'
  const plan         = PLANS.find(p => p.id === subscription?.subscription_plan)

  // Cargar cantidad de usuarios activos
  useState(() => {
    if (!businessId) return
    supabase.from('profiles').select('id', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('is_active', true)
      .then(({ count }) => setActiveUserCount(count ?? 0))
  })

  async function handleCancel() {
    if (!businessId) return
    try {
      setCanceling(true)
      await cancelSubscription(businessId)
      await refresh()
      setCancelConfirm(false)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setCanceling(false)
    }
  }

  async function handleReconcile() {
    if (!businessId) return
    setReconciling(true); setReconcileMsg('')
    try {
      const { activated, message } = await reconcilePayment(businessId)
      setReconcileMsg(message)
      if (activated) await refresh()
    } catch { setReconcileMsg('Error al verificar. Intentá de nuevo.') }
    finally { setReconciling(false) }
  }

  // Cargar pagos SaaS al abrir historial
  const loadSaasPayments = async () => {
    if (!businessId || saasPayments.length > 0) return
    setSaasPayments(await getSubscriptionPayments(businessId))
  }

  async function handleUpdatePayment() {
    if (!businessId) return
    try {
      setUpdatingPayment(true)
      const url = await getUpdatePaymentLink(businessId)
      window.open(url, '_blank')
    } catch (err: any) {
      alert(err.message)
    } finally {
      setUpdatingPayment(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40vh', gap: '1rem', color: 'var(--text-muted)' }}>
        <Loader2 size={24} style={{ animation: 'tr-spin 1s linear infinite' }} />
        Cargando suscripción...
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
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
      <div className="card" style={{ marginBottom: '1.5rem', borderColor: STATUS_COLORS[status] + '40' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: STATUS_COLORS[status] + '18',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <StatusIcon status={status} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <h2 style={{ color: 'var(--text-primary)', margin: 0, fontSize: '1.25rem' }}>
                {plan ? `Plan ${plan.name}` : 'Sin plan activo'}
              </h2>
              <span className="badge" style={{ background: STATUS_COLORS[status] + '20', color: STATUS_COLORS[status] }}>
                {STATUS_LABELS[status]}
              </span>
            </div>

            {/* Contextual info */}
            {isTrial && daysUntilTrialEnd !== null && (() => {
              const d = daysUntilTrialEnd
              const isUrgent  = d <= 3 && d > 0
              const isVencido = d <= 0
              return (
                <div style={{ marginTop: '0.625rem' }}>
                  <p style={{ margin: 0, fontSize: '0.875rem', color: isVencido ? '#f87171' : isUrgent ? '#fbbf24' : '#60a5fa', fontWeight: isUrgent || isVencido ? 600 : 400 }}>
                    {isVencido
                      ? 'Tu período de prueba venció. Elegí un plan para mantener el acceso premium.'
                      : isUrgent
                        ? `Tu prueba vence en ${d} día${d !== 1 ? 's' : ''}. Actualizá ahora para no perder el acceso.`
                        : `Período de prueba: ${d} días restantes con acceso completo al Plan Pro.`}
                  </p>
                  {(isUrgent || isVencido) && (
                    <button
                      onClick={() => navigate('/subscription/plans')}
                      className="btn btn-primary btn-lift"
                      style={{ marginTop: '0.5rem', padding: '0.4rem 1rem', fontSize: '0.78rem' }}
                    >
                      {isVencido ? 'Activar plan ahora' : 'Elegir plan'}
                    </button>
                  )}
                </div>
              )
            })()}
            {isPastDue && daysUntilGraceEnd !== null && daysUntilGraceEnd > 0 && (
              <p style={{ color: '#fbbf24', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
                Período de gracia: {daysUntilGraceEnd} día{daysUntilGraceEnd !== 1 ? 's' : ''} restante{daysUntilGraceEnd !== 1 ? 's' : ''}
              </p>
            )}
            {isActive && daysUntilPeriodEnd !== null && (
              <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
                Próximo cobro: {daysUntilPeriodEnd <= 0 ? 'hoy' : `en ${daysUntilPeriodEnd} días`}
                {subscription?.current_period_end && ` (${new Date(subscription.current_period_end).toLocaleDateString('es-AR')})`}
              </p>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {(isSuspended || isCanceled || isTrial) && (
              <button onClick={() => navigate('/subscription/plans')} className="btn btn-primary btn-lift">
                <Zap size={16} />
                {isSuspended || isCanceled ? 'Reactivar' : 'Elegir plan'}
              </button>
            )}
            {(isActive || isPastDue) && (
              <button onClick={() => navigate('/subscription/plans')} className="btn btn-ghost">
                Cambiar plan
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Plan details */}
      {plan && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header">
            <h3 className="card-title">Detalles del plan</h3>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '1rem' }}>
              <InfoRow label="Plan" value={plan.name} />
              <InfoRow label="Pago" value={formatSubscriptionPrice(plan.price_monthly)} />
              {subscription?.mp_payer_email && <InfoRow label="Email pagador" value={subscription.mp_payer_email} />}
              {subscription?.current_period_start && (
                <InfoRow label="Período desde" value={new Date(subscription.current_period_start).toLocaleDateString('es-AR')} />
              )}
              {subscription?.current_period_end && (
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <h3 className="card-title" style={{ margin: 0 }}>Funciones del plan</h3>
                {isTrial && (
                  <span style={{ padding: '0.2rem 0.625rem', borderRadius: '999px', fontSize: '0.72rem', fontWeight: 700, background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}>
                    Trial — acceso Pro
                  </span>
                )}
              </div>
            </div>
            <div className="card-body">
              {/* Usuarios */}
              <div style={{ marginBottom: '1.25rem', padding: '0.875rem 1rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.625rem', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', background: enabled ? 'rgba(52,211,153,0.05)' : 'rgba(255,255,255,0.02)' }}>
                      <span style={{ fontSize: '0.82rem', fontWeight: 700, color: enabled ? '#34d399' : '#334155' }}>
                        {enabled ? '✓' : '—'}
                      </span>
                      <span style={{ fontSize: '0.82rem', color: enabled ? 'var(--text-secondary)' : '#475569' }}>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* Upgrade CTA */}
              {planId && planId !== 'full' && (
                <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
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

      {/* Payment history */}
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
                          <span className="badge" style={{ background: PAYMENT_STATUS_COLORS[p.status] + '20', color: PAYMENT_STATUS_COLORS[p.status] }}>
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

      {/* Management actions */}
      {(isActive || isPastDue || isTrial) && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header"><h3 className="card-title">Administrar suscripción</h3></div>
          <div className="card-body" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {/* Verificar pago — útil cuando el webhook tardó */}
            <button onClick={handleReconcile} disabled={reconciling} className="btn btn-ghost">
              {reconciling ? <Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <RefreshCw size={16} />}
              Verificar pago
            </button>
            {reconcileMsg && (
              <span style={{ alignSelf: 'center', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{reconcileMsg}</span>
            )}
            <button onClick={handleUpdatePayment} disabled={updatingPayment} className="btn btn-ghost">
              {updatingPayment ? <Loader2 size={16} style={{ animation: 'tr-spin 1s linear infinite' }} /> : <CreditCard size={16} />}
              Actualizar método de pago
              <ExternalLink size={14} />
            </button>

            {!cancelConfirm ? (
              <button onClick={() => setCancelConfirm(true)} className="btn" style={{ color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}>
                Cancelar suscripción
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ color: '#f87171', fontSize: '0.875rem' }}>¿Confirmás la cancelación?</span>
                <button onClick={handleCancel} disabled={canceling} className="btn" style={{ color: '#f87171', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)' }}>
                  {canceling ? <Loader2 size={14} style={{ animation: 'tr-spin 1s linear infinite' }} /> : null}
                  Sí, cancelar
                </button>
                <button onClick={() => setCancelConfirm(false)} className="btn btn-ghost">
                  No, volver
                </button>
              </div>
            )}
          </div>
        </div>
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
