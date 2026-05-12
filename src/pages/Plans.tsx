/**
 * Plans.tsx — Pantalla de selección de plan con checkout Mercado Pago.
 * Diseño iOS premium. Trial users ven Pro recomendado.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSubscription } from '../hooks/useSubscription'
import { createSubscription } from '../services/subscriptionService'
import { PLANS, type SubscriptionPlan } from '../types/subscription'

const F = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif"
type Cycle = 'monthly' | 'annual'

// Features visibles por plan en la card interna
const PLAN_CARD_FEATURES: Record<SubscriptionPlan, string[]> = {
  basico: [
    'Órdenes de servicio ilimitadas',
    'Clientes e historial',
    'Inventario y stock',
    'Caja diaria',
    'Comprobantes internos',
    '1 usuario',
  ],
  pro: [
    'Todo lo del plan Básico',
    'Facturación ARCA / CAE',
    'Finanzas Pro y métricas',
    'Cuentas corrientes',
    'Tareas y empleados',
    'Reportes avanzados',
    'Hasta 3 usuarios',
  ],
  full: [
    'Todo lo del plan Pro',
    'Multi-sucursal completo',
    'Stock y caja por local',
    'Hasta 10 usuarios',
    'Permisos granulares',
    'Auditoría completa',
  ],
}

const PLAN_STYLES = {
  basico: { accent: '#64748b', border: 'rgba(100,116,139,0.2)', bg: 'rgba(100,116,139,0.04)', glow: '' },
  pro:    { accent: '#6366f1', border: 'rgba(99,102,241,0.45)', bg: 'rgba(99,102,241,0.07)', glow: '0 0 0 1px rgba(99,102,241,0.4), 0 20px 48px rgba(99,102,241,0.15)' },
  full:   { accent: '#475569', border: 'rgba(148,163,184,0.2)', bg: 'rgba(30,41,59,0.5)',    glow: '' },
}

function fmt(n: number) {
  return '$' + Math.round(n).toLocaleString('es-AR')
}

export function Plans() {
  const { businessId, user } = useAuth()
  const { isTrial, daysUntilTrialEnd, currentPlan } = useSubscription()
  const navigate = useNavigate()
  const [cycle, setCycle]     = useState<Cycle>('monthly')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError]     = useState('')

  const isAnnual = cycle === 'annual'

  async function handleSelect(planId: SubscriptionPlan) {
    if (!businessId || !user?.email) return
    setError(''); setLoading(planId)
    try {
      const res = await createSubscription({
        business_id:   businessId,
        plan:          planId,
        billing_cycle: cycle,
        payer_email:   user.email,
      })
      window.location.href = res.init_point
    } catch (e: any) {
      setError(e.message || 'Error al iniciar el pago')
      setLoading(null)
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', fontFamily: F }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <h1 style={{ margin: '0 0 0.625rem', fontSize: '2rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.04em' }}>
          Elegí tu plan
        </h1>

        {isTrial ? (
          <div style={{
            display: 'inline-block', padding: '0.4rem 1rem',
            background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)',
            borderRadius: '999px', marginBottom: '0.875rem',
          }}>
            <span style={{ fontSize: '0.82rem', color: '#818cf8', fontWeight: 600 }}>
              {daysUntilTrialEnd !== null && daysUntilTrialEnd <= 3 && daysUntilTrialEnd > 0
                ? `Tu prueba vence en ${daysUntilTrialEnd} día${daysUntilTrialEnd !== 1 ? 's' : ''}. Elegí un plan para mantener el acceso.`
                : 'Tu prueba gratuita incluye funciones del Plan Pro'}
            </span>
          </div>
        ) : currentPlan && (
          <div style={{ display: 'inline-block', padding: '0.4rem 1rem', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: '999px', marginBottom: '0.875rem' }}>
            <span style={{ fontSize: '0.82rem', color: '#34d399', fontWeight: 600 }}>
              Plan actual: {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
            </span>
          </div>
        )}

        <p style={{ margin: '0 0 1.75rem', color: '#64748b', fontSize: '0.9rem' }}>
          Sin contratos. Cancelás cuando querés.
        </p>

        {/* Toggle mensual / anual */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '999px', padding: '0.25rem' }}>
          {(['monthly', 'annual'] as Cycle[]).map(c => (
            <button key={c} onClick={() => setCycle(c)} style={{
              padding: '0.4rem 1.125rem', borderRadius: '999px', border: 'none',
              background: cycle === c ? 'rgba(255,255,255,0.1)' : 'transparent',
              color: cycle === c ? '#f1f5f9' : '#64748b',
              fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              fontFamily: F, transition: 'all 0.2s',
            }}>
              {c === 'monthly' ? 'Mensual' : (
                <>Anual <span style={{ padding: '0.1rem 0.4rem', borderRadius: '999px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', fontSize: '0.7rem', fontWeight: 800 }}>−20%</span></>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ padding: '0.875rem 1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '0.875rem', color: '#f87171', fontSize: '0.875rem', marginBottom: '1.75rem', textAlign: 'center' }}>
          {error}
        </div>
      )}

      {/* Plan cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1rem', alignItems: 'start' }}>
        {PLANS.map(plan => {
          const s     = PLAN_STYLES[plan.id]
          const price = isAnnual ? Math.round(plan.price_annual / 12) : plan.price_monthly
          const isPro = plan.id === 'pro'
          const isBusy = loading === plan.id
          const features = PLAN_CARD_FEATURES[plan.id]

          return (
            <div key={plan.id} style={{
              position: 'relative',
              background: s.bg,
              border: `1px solid ${s.border}`,
              borderRadius: '1.125rem',
              padding: isPro ? '2rem 1.625rem 1.75rem' : '1.75rem 1.5rem',
              display: 'flex', flexDirection: 'column', gap: '1.25rem',
              marginTop: isPro ? '-0.75rem' : 0,
              boxShadow: s.glow || 'none',
            }}>

              {/* Badge Pro */}
              {isPro && (
                <div style={{
                  position: 'absolute', top: '-1px', left: '50%', transform: 'translateX(-50%)',
                  background: 'linear-gradient(135deg, #6366f1, #818cf8)',
                  color: '#fff', fontSize: '0.68rem', fontWeight: 800,
                  padding: '0.2rem 0.875rem', borderRadius: '0 0 0.625rem 0.625rem',
                  letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                  boxShadow: '0 4px 16px rgba(99,102,241,0.4)',
                }}>
                  {isTrial ? 'Tu plan de prueba' : 'Más elegido'}
                </div>
              )}

              {/* Header */}
              <div>
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: s.accent, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  {plan.name}
                </span>
                <p style={{ margin: '0.35rem 0 0', color: '#64748b', fontSize: '0.8rem', lineHeight: 1.55 }}>
                  {plan.description}
                </p>
              </div>

              {/* Precio */}
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                  <span style={{ color: '#64748b', fontSize: '0.95rem', fontWeight: 600 }}>$</span>
                  <span style={{ color: '#f1f5f9', fontSize: '2.375rem', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1 }}>
                    {Math.round(price).toLocaleString('es-AR')}
                  </span>
                  <span style={{ color: '#475569', fontSize: '0.8rem' }}>/mes</span>
                </div>
                {isAnnual && (
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.72rem', color: '#22c55e', fontWeight: 600 }}>
                    {fmt(plan.price_annual)} al año · Ahorrás {fmt(plan.price_monthly * 12 - plan.price_annual)}
                  </p>
                )}
              </div>

              {/* Features */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                {features.map((f, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
                      <circle cx="7.5" cy="7.5" r="7.5" fill={isPro ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)'} />
                      <path d="M4.5 7.5L6.5 9.5L10.5 5.5" stroke={isPro ? '#818cf8' : '#64748b'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span style={{ color: isPro ? '#94a3b8' : '#64748b', fontSize: '0.8rem', lineHeight: 1.5 }}>{f}</span>
                  </div>
                ))}
              </div>

              {/* CTA */}
              <button
                onClick={() => handleSelect(plan.id)}
                disabled={!!loading}
                style={{
                  width: '100%', padding: '14px',
                  background: isPro ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : 'rgba(255,255,255,0.05)',
                  border: isPro ? 'none' : `1px solid ${s.border}`,
                  borderRadius: '0.875rem',
                  color: isPro ? '#fff' : '#94a3b8',
                  fontWeight: 700, fontSize: '0.9rem',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading && !isBusy ? 0.5 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                  boxShadow: isPro ? '0 4px 20px rgba(99,102,241,0.3)' : 'none',
                  transition: 'opacity 0.15s, transform 0.15s',
                  fontFamily: F,
                }}
                onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.88' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = loading && !isBusy ? '0.5' : '1' }}
              >
                {isBusy ? (
                  <Loader2 size={17} style={{ animation: 'spin 0.7s linear infinite' }} />
                ) : null}
                {isBusy ? 'Redirigiendo...' : `Elegir ${plan.name}`}
              </button>
            </div>
          )
        })}
      </div>

      <p style={{ textAlign: 'center', color: '#334155', fontSize: '0.78rem', marginTop: '2rem' }}>
        Pagos procesados de forma segura por Mercado Pago · Sin contratos · Cancelás cuando querés
      </p>

      {/* Botón volver */}
      <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
        <button
          onClick={() => navigate(-1)}
          style={{ background: 'none', border: 'none', color: '#475569', fontSize: '0.82rem', cursor: 'pointer', fontFamily: F }}
        >
          Volver
        </button>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
