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
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
        <h1 style={{ margin: '0 0 0.625rem', fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.04em' }}>
          Elegí tu plan
        </h1>

        {isTrial ? (
          <span className="badge badge-info" style={{ display: 'inline-block', marginBottom: '0.875rem', fontSize: '0.82rem', padding: '0.4rem 1rem' }}>
            {daysUntilTrialEnd !== null && daysUntilTrialEnd <= 3 && daysUntilTrialEnd > 0
              ? `Tu prueba vence en ${daysUntilTrialEnd} día${daysUntilTrialEnd !== 1 ? 's' : ''}. Elegí un plan para mantener el acceso.`
              : 'Tu prueba gratuita incluye funciones del Plan Pro'}
          </span>
        ) : currentPlan && (
          <span className="badge badge-success" style={{ display: 'inline-block', marginBottom: '0.875rem', fontSize: '0.82rem', padding: '0.4rem 1rem' }}>
            Plan actual: {currentPlan.charAt(0).toUpperCase() + currentPlan.slice(1)}
          </span>
        )}

        <p style={{ margin: '0 0 1.75rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Sin contratos. Cancelás cuando querés.
        </p>

        {/* Toggle mensual / anual */}
        <div className="tabs" style={{ display: 'inline-flex' }}>
          {(['monthly', 'annual'] as Cycle[]).map(c => (
            <button key={c} onClick={() => setCycle(c)} className={`tab ${cycle === c ? 'tab-active' : ''}`}>
              {c === 'monthly' ? 'Mensual' : (
                <>Anual <span style={{ padding: '0.1rem 0.4rem', borderRadius: '999px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', fontSize: '0.7rem', fontWeight: 800 }}>−20%</span></>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="alert-inline alert-error" style={{ marginBottom: '1.75rem', justifyContent: 'center' }}>
          {error}
        </div>
      )}

      {/* Plan cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', alignItems: 'start' }}>
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
                className={isPro ? 'btn btn-primary btn-lift' : 'btn btn-ghost'}
                style={{
                  width: '100%', justifyContent: 'center', padding: '14px', fontSize: '0.9rem',
                  opacity: loading && !isBusy ? 0.5 : 1,
                  border: isPro ? undefined : `1px solid ${s.border}`,
                }}
              >
                {isBusy ? (
                  <Loader2 size={17} style={{ animation: 'tr-spin 0.7s linear infinite' }} />
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
        <button onClick={() => navigate(-1)} className="btn btn-ghost btn-sm">
          Volver
        </button>
      </div>
    </div>
  )
}
