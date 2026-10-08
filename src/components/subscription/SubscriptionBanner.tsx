/**
 * SubscriptionBanner
 *
 * Aviso persistente sobre el contenido, según el estado de la suscripción:
 * - trial: sólo cuando quedan 5 días o menos
 * - past_due: pago vencido, con los días de gracia
 * - período por vencer (≤ 3 días) de una suscripción que cobra
 *
 * PRE-BETA-3A-0 — sólo lo ve quien tiene la capacidad `subscription`. El estado
 * del plan y sus CTA (Ver planes / Regularizar / Gestionar) son del dueño: a un
 * técnico o cajero invitado le ofrecían una pantalla que después no podía usar.
 * Filtro por capacidad efectiva, nunca por nombre de rol.
 *
 * BETA-1 — el aviso de «método de pago» sólo aparece si hay una suscripción
 * paga: un acceso otorgado a mano (SaaS Admin) también tiene
 * `current_period_end` y no tiene ningún método de pago que revisar.
 *
 * BETA-UX-1C — el aviso de trial aparecía los 14 días, en todas las páginas, y
 * volvía con cada recarga. Ahora:
 *   · trial: del día 14 al 6 no hay aviso;
 *   · cerrar lo oculta por el día (ver `lib/subscriptionBannerDismissal`);
 *   · colores por token (clases `.sub-banner` de index.css), legibles en los
 *     dos temas; cierre de 44×44.
 */
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Clock, CreditCard, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useSubscription } from '../../hooks/useSubscription'
import { usePermissions } from '../../hooks/usePermissions'
import { hasPaidSubscription } from '../../lib/subscriptionWall'
import {
  browserDismissalStorage,
  dismissForToday,
  isDismissedToday,
  type SubscriptionBannerKind,
} from '../../lib/subscriptionBannerDismissal'

const CLOSE_LABEL = 'Cerrar aviso de suscripción'

/** El aviso de trial aparece cuando quedan estos días o menos. */
export const TRIAL_BANNER_MAX_DAYS = 5

interface BannerView {
  kind: SubscriptionBannerKind
  tone: 'info' | 'warning' | 'accent'
  icon: ReactNode
  strong: string
  rest: string
  cta: string
  to: string
}

function BannerInner() {
  const { subscription, isTrial, isPastDue, daysUntilTrialEnd, daysUntilGraceEnd, daysUntilPeriodEnd, isActive, loading } = useSubscription()
  const { can } = usePermissions()
  const { businessId } = useAuth()
  const navigate = useNavigate()
  // Cierres de esta pantalla: cubre los avisos que no recuerdan el cierre y el
  // caso en que el navegador no deja guardar.
  const [closedHere, setClosedHere] = useState<SubscriptionBannerKind[]>([])

  if (!can('subscription')) return null
  if (loading) return null

  const trialEndingSoon = isTrial && daysUntilTrialEnd !== null
    && daysUntilTrialEnd <= TRIAL_BANNER_MAX_DAYS && daysUntilTrialEnd >= 0
  // Period ending soon (≤ 3 days) — sólo para una suscripción que cobra.
  const periodEndingSoon = isActive && hasPaidSubscription(subscription)
    && daysUntilPeriodEnd !== null && daysUntilPeriodEnd <= 3 && daysUntilPeriodEnd >= 0

  let view: BannerView | null = null

  if (isPastDue) {
    view = {
      kind: 'past_due',
      tone: 'warning',
      icon: <AlertTriangle size={16} />,
      strong: 'Pago vencido.',
      rest: daysUntilGraceEnd !== null && daysUntilGraceEnd > 0
        ? `Tenés ${daysUntilGraceEnd} día${daysUntilGraceEnd !== 1 ? 's' : ''} de gracia para regularizar.`
        : 'El período de gracia venció. El sistema se suspenderá pronto.',
      cta: 'Regularizar',
      to: '/subscription',
    }
  } else if (trialEndingSoon) {
    view = {
      kind: 'trial',
      tone: 'info',
      icon: <Clock size={16} />,
      // `0` = la fecha de fin ya pasó y el negocio todavía figura en prueba.
      strong: daysUntilTrialEnd === 0
        ? 'Tu período de prueba ha vencido.'
        : `Tu período de prueba vence en ${daysUntilTrialEnd} día${daysUntilTrialEnd !== 1 ? 's' : ''}.`,
      rest: 'Elegí un plan para continuar sin interrupciones.',
      cta: 'Ver planes',
      to: '/subscription/plans',
    }
  } else if (periodEndingSoon) {
    view = {
      kind: 'period_ending',
      tone: 'accent',
      icon: <CreditCard size={16} />,
      strong: `Tu suscripción vence en ${daysUntilPeriodEnd} día${daysUntilPeriodEnd !== 1 ? 's' : ''}.`,
      rest: 'Verificá que tu método de pago esté actualizado.',
      cta: 'Gestionar',
      to: '/subscription',
    }
  }

  if (!view) return null
  const { kind, tone, icon, strong, rest, cta, to } = view
  if (closedHere.includes(kind)) return null
  if (isDismissedToday(browserDismissalStorage(), businessId, kind)) return null

  const close = () => {
    dismissForToday(browserDismissalStorage(), businessId, kind)
    setClosedHere(prev => (prev.includes(kind) ? prev : [...prev, kind]))
  }

  return (
    <div className={`sub-banner sub-tone-${tone}`} data-testid="subscription-banner" data-banner-kind={kind}>
      <span className="sub-banner__icon" aria-hidden="true">{icon}</span>
      <p className="sub-banner__text">
        <strong>{strong}</strong> {rest}
      </p>
      <button type="button" className="sub-banner__cta" onClick={() => navigate(to)}>
        {cta}
      </button>
      <button type="button" className="sub-banner__close" onClick={close} aria-label={CLOSE_LABEL}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

export function SubscriptionBanner() {
  try {
    return <BannerInner />
  } catch (e) {
    console.error('[SubscriptionBanner] Error:', e)
    return null
  }
}
