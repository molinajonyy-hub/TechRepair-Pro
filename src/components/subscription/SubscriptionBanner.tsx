/**
 * SubscriptionBanner
 *
 * Shows persistent top-banner warnings based on subscription state:
 * - trialing: days remaining in trial
 * - past_due: payment overdue, grace period warning
 * - trial ending soon (≤3 days)
 * - period ending soon (≤5 days for active)
 *
 * PRE-BETA-3A-0 — sólo lo ve quien tiene la capacidad `subscription`. El estado
 * del plan y sus CTA (Ver planes / Regularizar / Gestionar) son del dueño: a un
 * técnico o cajero invitado le ofrecían una pantalla que después no podía usar.
 * Filtro por capacidad efectiva, nunca por nombre de rol.
 *
 * BETA-1 — el aviso de «método de pago» sólo aparece si hay una suscripción
 * paga: un acceso otorgado a mano (SaaS Admin) también tiene
 * `current_period_end` y no tiene ningún método de pago que revisar.
 */
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Clock, CreditCard, X } from 'lucide-react'
import { useState } from 'react'
import { useSubscription } from '../../hooks/useSubscription'
import { usePermissions } from '../../hooks/usePermissions'
import { hasPaidSubscription } from '../../lib/subscriptionWall'

const CLOSE_LABEL = 'Cerrar aviso de suscripción'

function BannerInner() {
  const { subscription, isTrial, isPastDue, daysUntilTrialEnd, daysUntilGraceEnd, daysUntilPeriodEnd, isActive, loading } = useSubscription()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)

  if (!can('subscription')) return null
  if (loading || dismissed) return null

  // Trial expiring soon (≤ 5 days)
  const trialEndingSoon = isTrial && daysUntilTrialEnd !== null && daysUntilTrialEnd <= 5 && daysUntilTrialEnd >= 0
  // Period ending soon (≤ 3 days) — sólo para una suscripción que cobra.
  const periodEndingSoon = isActive && hasPaidSubscription(subscription)
    && daysUntilPeriodEnd !== null && daysUntilPeriodEnd <= 3 && daysUntilPeriodEnd >= 0

  if (!isTrial && !isPastDue && !trialEndingSoon && !periodEndingSoon) return null

  // ── Past due ──────────────────────────────────────────────────
  if (isPastDue) {
    const graceText = daysUntilGraceEnd !== null && daysUntilGraceEnd > 0
      ? `Tenés ${daysUntilGraceEnd} día${daysUntilGraceEnd !== 1 ? 's' : ''} de gracia para regularizar.`
      : 'El período de gracia venció. El sistema se suspenderá pronto.'

    return (
      <div style={styles.banner('#f59e0b', 'rgba(245,158,11,0.08)', 'rgba(245,158,11,0.25)')}>
        <AlertTriangle size={16} />
        <span>
          <strong>Pago vencido.</strong> {graceText}
        </span>
        <button onClick={() => navigate('/subscription')} style={styles.actionBtn('#f59e0b')}>
          Regularizar
        </button>
        <button type="button" onClick={() => setDismissed(true)} style={styles.closeBtn} aria-label={CLOSE_LABEL}>
          <X size={14} />
        </button>
      </div>
    )
  }

  // ── Trial ending soon ─────────────────────────────────────────
  if (isTrial && daysUntilTrialEnd !== null) {
    const isExpired = daysUntilTrialEnd <= 0
    const text = isExpired
      ? 'Tu período de prueba ha vencido.'
      : `Tu período de prueba vence en ${daysUntilTrialEnd} día${daysUntilTrialEnd !== 1 ? 's' : ''}.`

    return (
      <div style={styles.banner('#60a5fa', 'rgba(96,165,250,0.08)', 'rgba(96,165,250,0.25)')}>
        <Clock size={16} />
        <span>
          <strong>{text}</strong> Elegí un plan para continuar sin interrupciones.
        </span>
        <button onClick={() => navigate('/subscription/plans')} style={styles.actionBtn('#60a5fa')}>
          Ver planes
        </button>
        <button type="button" onClick={() => setDismissed(true)} style={styles.closeBtn} aria-label={CLOSE_LABEL}>
          <X size={14} />
        </button>
      </div>
    )
  }

  // ── Period ending soon ────────────────────────────────────────
  if (periodEndingSoon) {
    return (
      <div style={styles.banner('#a78bfa', 'rgba(167,139,250,0.08)', 'rgba(167,139,250,0.25)')}>
        <CreditCard size={16} />
        <span>
          <strong>Tu suscripción vence en {daysUntilPeriodEnd} día{daysUntilPeriodEnd !== 1 ? 's' : ''}.</strong> Verificá que tu método de pago esté actualizado.
        </span>
        <button onClick={() => navigate('/subscription')} style={styles.actionBtn('#a78bfa')}>
          Gestionar
        </button>
        <button type="button" onClick={() => setDismissed(true)} style={styles.closeBtn} aria-label={CLOSE_LABEL}>
          <X size={14} />
        </button>
      </div>
    )
  }

  return null
}

const styles = {
  banner: (color: string, bg: string, border: string): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem 1rem',
    marginBottom: '1rem',
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: '0.75rem',
    color,
    fontSize: '0.875rem',
    flexWrap: 'wrap' as const,
  }),
  actionBtn: (color: string): React.CSSProperties => ({
    marginLeft: 'auto',
    padding: '0.35rem 0.875rem',
    borderRadius: '0.5rem',
    border: `1px solid ${color}`,
    background: 'transparent',
    color,
    fontSize: '0.8rem',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  }),
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    padding: '0.25rem',
    flexShrink: 0,
  } as React.CSSProperties,
}

export function SubscriptionBanner() {
  try {
    return <BannerInner />
  } catch (e) {
    console.error('[SubscriptionBanner] Error:', e)
    return null
  }
}
