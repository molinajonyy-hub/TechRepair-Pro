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
import { cancelSubscription, getUpdatePaymentLink, formatSubscriptionPrice } from '../services/subscriptionService'
import {
  PLANS,
  STATUS_LABELS,
  STATUS_COLORS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_COLORS,
  type SubscriptionStatus,
} from '../types/subscription'
import { PLAN_FEATURES, PLAN_DISPLAY, type PlanFeature } from '../config/planFeatures'
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
        <Loader2 size={24} style={{ animation: 'spin 1s linear infinite' }} />
        Cargando suscripción...
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ color: 'var(--text-primary)', margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>
            Mi Suscripción
          </h1>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>
            {user?.email}
          </p>
        </div>
        <button onClick={refresh} style={btnStyle('ghost')}>
          <RefreshCw size={16} />
          Actualizar
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

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
              <span style={{
                padding: '0.25rem 0.75rem', borderRadius: '1rem', fontSize: '0.8rem', fontWeight: 600,
                background: STATUS_COLORS[status] + '20', color: STATUS_COLORS[status],
              }}>
                {STATUS_LABELS[status]}
              </span>
            </div>

            {/* Contextual info */}
            {isTrial && daysUntilTrialEnd !== null && (
              <p style={{ color: '#60a5fa', margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
                Período de prueba: {daysUntilTrialEnd <= 0 ? 'vencido' : `${daysUntilTrialEnd} días restantes`}
              </p>
            )}
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
              <button onClick={() => navigate('/subscription/plans')} style={btnStyle('primary')}>
                <Zap size={16} />
                {isSuspended || isCanceled ? 'Reactivar' : 'Elegir plan'}
              </button>
            )}
            {(isActive || isPastDue) && (
              <button onClick={() => navigate('/subscription/plans')} style={btnStyle('ghost')}>
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
                  <button onClick={() => navigate('/subscription/plans')} style={{ ...btnStyle('primary'), padding: '0.4rem 1rem', fontSize: '0.8rem' }}>
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
          onClick={() => setShowHistory(v => !v)}
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
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                    {['Fecha', 'Importe', 'Plan', 'Estado'].map(h => (
                      <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payments.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={tdStyle}>{p.paid_at ? new Date(p.paid_at).toLocaleDateString('es-AR') : new Date(p.created_at).toLocaleDateString('es-AR')}</td>
                      <td style={tdStyle}>{formatSubscriptionPrice(p.amount, p.currency)}</td>
                      <td style={tdStyle}>{PLANS.find(pl => pl.id === p.subscription_plan)?.name || p.subscription_plan || '—'}</td>
                      <td style={tdStyle}>
                        <span style={{
                          padding: '0.2rem 0.6rem', borderRadius: '1rem', fontSize: '0.75rem', fontWeight: 600,
                          background: PAYMENT_STATUS_COLORS[p.status] + '20',
                          color: PAYMENT_STATUS_COLORS[p.status],
                        }}>
                          {PAYMENT_STATUS_LABELS[p.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Management actions */}
      {(isActive || isPastDue) && (
        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-header"><h3 className="card-title">Administrar suscripción</h3></div>
          <div className="card-body" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <button onClick={handleUpdatePayment} disabled={updatingPayment} style={btnStyle('ghost')}>
              {updatingPayment ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <CreditCard size={16} />}
              Actualizar método de pago
              <ExternalLink size={14} />
            </button>

            {!cancelConfirm ? (
              <button onClick={() => setCancelConfirm(true)} style={btnStyle('danger')}>
                Cancelar suscripción
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{ color: '#f87171', fontSize: '0.875rem' }}>¿Confirmás la cancelación?</span>
                <button onClick={handleCancel} disabled={canceling} style={btnStyle('danger')}>
                  {canceling ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                  Sí, cancelar
                </button>
                <button onClick={() => setCancelConfirm(false)} style={btnStyle('ghost')}>
                  No, volver
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 500 }}>{value}</div>
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      padding: '0.875rem 1rem', background: 'rgba(248,113,113,0.08)',
      border: '1px solid rgba(248,113,113,0.3)', borderRadius: '0.75rem',
      color: '#f87171', fontSize: '0.875rem', marginBottom: '1rem',
    }}>
      {message}
    </div>
  )
}

const tdStyle: React.CSSProperties = { padding: '0.75rem 1rem', color: 'var(--text-secondary)', fontSize: '0.875rem' }

function btnStyle(variant: 'primary' | 'ghost' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.5rem 1rem', borderRadius: '0.625rem',
    fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer', border: '1px solid transparent',
  }
  if (variant === 'primary') return { ...base, background: '#6366f1', color: '#fff', borderColor: '#6366f1' }
  if (variant === 'danger')  return { ...base, background: 'rgba(248,113,113,0.1)', color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }
  return { ...base, background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }
}
