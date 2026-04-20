/**
 * Plans.tsx — Plan selection screen
 */
import { useState } from 'react'
import { CheckCircle, Loader2, Zap, Star } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { createSubscription, formatSubscriptionPrice } from '../services/subscriptionService'
import {
  PLANS,
  BILLING_LABELS,
  type SubscriptionPlan,
  type BillingCycle,
} from '../types/subscription'

export function Plans() {
  const { businessId, user } = useAuth()
  const [cycle, setCycle] = useState<BillingCycle>('monthly')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')

  function getPlanPrice(plan: typeof PLANS[0], c: BillingCycle) {
    if (c === 'monthly')   return plan.price_monthly
    if (c === 'quarterly') return plan.price_quarterly
    return plan.price_annual
  }

  function getDiscount(plan: typeof PLANS[0], c: BillingCycle): string | null {
    if (c === 'quarterly') {
      const pct = Math.round((1 - plan.price_quarterly / (plan.price_monthly * 3)) * 100)
      return pct > 0 ? `${pct}% descuento` : null
    }
    if (c === 'annual') {
      const pct = Math.round((1 - plan.price_annual / (plan.price_monthly * 12)) * 100)
      return pct > 0 ? `${pct}% descuento` : null
    }
    return null
  }

  async function handleSelect(planId: SubscriptionPlan) {
    if (!businessId || !user?.email) return
    setError('')
    setLoading(planId)
    try {
      const res = await createSubscription({
        business_id: businessId,
        plan: planId,
        billing_cycle: cycle,
        payer_email: user.email,
      })
      // Redirect to MP checkout
      window.location.href = res.init_point
    } catch (err: any) {
      setError(err.message || 'Error al iniciar el pago')
      setLoading(null)
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <h1 style={{ color: 'var(--text-primary)', fontSize: '2rem', fontWeight: 700, margin: 0 }}>
          Elegí tu plan
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.75rem', fontSize: '1rem' }}>
          Sin contratos. Cancelá cuando quieras.
        </p>
      </div>

      {/* Billing cycle toggle */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginBottom: '2.5rem' }}>
        {(['monthly', 'quarterly', 'annual'] as BillingCycle[]).map(c => (
          <button
            key={c}
            onClick={() => setCycle(c)}
            style={{
              padding: '0.5rem 1.25rem', borderRadius: '2rem', border: '1px solid',
              borderColor: cycle === c ? '#6366f1' : 'var(--border-color)',
              background: cycle === c ? '#6366f1' : 'transparent',
              color: cycle === c ? '#fff' : 'var(--text-muted)',
              fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer',
            }}
          >
            {BILLING_LABELS[c]}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: '0.875rem 1rem', background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.3)', borderRadius: '0.75rem',
          color: '#f87171', fontSize: '0.875rem', marginBottom: '1.5rem', textAlign: 'center',
        }}>
          {error}
        </div>
      )}

      {/* Plan cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>
        {PLANS.map(plan => {
          const price   = getPlanPrice(plan, cycle)
          const discount = getDiscount(plan, cycle)
          const isLoading = loading === plan.id

          return (
            <div
              key={plan.id}
              style={{
                background: 'var(--bg-card)',
                border: `1px solid ${plan.highlighted ? '#6366f1' : 'var(--border-color)'}`,
                borderRadius: '1.25rem',
                padding: '1.75rem',
                position: 'relative',
                boxShadow: plan.highlighted ? '0 0 0 1px #6366f1, 0 20px 40px rgba(99,102,241,0.15)' : 'var(--shadow-sm)',
                transform: plan.highlighted ? 'scale(1.025)' : 'none',
              }}
            >
              {plan.highlighted && (
                <div style={{
                  position: 'absolute', top: '-14px', left: '50%', transform: 'translateX(-50%)',
                  background: '#6366f1', color: '#fff', padding: '0.25rem 1rem',
                  borderRadius: '1rem', fontSize: '0.75rem', fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: '0.35rem',
                  whiteSpace: 'nowrap',
                }}>
                  <Star size={12} fill="#fff" />
                  Más popular
                </div>
              )}

              {/* Plan name */}
              <h2 style={{ color: 'var(--text-primary)', margin: '0 0 0.5rem', fontSize: '1.35rem', fontWeight: 700 }}>
                {plan.name}
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: '0 0 1.5rem', minHeight: '2.5rem' }}>
                {plan.description}
              </p>

              {/* Price */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
                  <span style={{ fontSize: '2.25rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
                    {formatSubscriptionPrice(price)}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem', paddingBottom: '0.25rem' }}>
                    / {cycle === 'monthly' ? 'mes' : cycle === 'quarterly' ? '3 meses' : 'año'}
                  </span>
                </div>
                {discount && (
                  <span style={{
                    display: 'inline-block', marginTop: '0.35rem',
                    background: 'rgba(52,211,153,0.15)', color: '#34d399',
                    padding: '0.2rem 0.6rem', borderRadius: '0.5rem', fontSize: '0.75rem', fontWeight: 600,
                  }}>
                    {discount}
                  </span>
                )}
              </div>

              {/* Features */}
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1.75rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                {plan.features.map(f => (
                  <li key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                    <CheckCircle size={15} color="#34d399" style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <button
                onClick={() => handleSelect(plan.id)}
                disabled={!!loading}
                style={{
                  width: '100%', padding: '0.75rem', borderRadius: '0.75rem',
                  border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                  background: plan.highlighted ? '#6366f1' : 'rgba(255,255,255,0.08)',
                  color: plan.highlighted ? '#fff' : 'var(--text-primary)',
                  fontSize: '0.95rem', fontWeight: 600, opacity: loading && !isLoading ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                }}
              >
                {isLoading ? (
                  <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <Zap size={16} />
                )}
                {isLoading ? 'Redirigiendo...' : 'Elegir este plan'}
              </button>
            </div>
          )
        })}
      </div>

      <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '2rem' }}>
        Los pagos son procesados de forma segura por Mercado Pago. Podés cancelar en cualquier momento.
      </p>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
