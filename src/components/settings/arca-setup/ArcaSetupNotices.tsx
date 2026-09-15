import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Info } from 'lucide-react'
import type { ArcaVerificationHold } from '../../../lib/arcaStatus'
import { ARCA_SETUP_HOLD_COPY, arcaHoldCountdown } from '../../../lib/arcaSetupWizard'
import type { ArcaSetupErrorView } from '../../../lib/arcaSetupErrors'

/**
 * Espera decidida por la base. Nunca ofrece "Verificar": la cuenta regresiva es sólo
 * informativa y, al terminar, la pantalla relee el estado (lo hace el hook de estado).
 */
export function ArcaHoldNotice({ reason, retryNotBefore }: { reason: ArcaVerificationHold; retryNotBefore: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const countdown = arcaHoldCountdown(retryNotBefore, now)
  const inFlight = reason === 'in_progress'

  return (
    <section className="arca-setup-notice arca-setup-notice--warning" data-testid="arca-setup-hold" data-hold-reason={reason} aria-labelledby="arca-setup-hold-title">
      <Clock size={18} aria-hidden className="arca-setup-notice__icon" />
      <div>
        <p id="arca-setup-hold-title" className="arca-setup-notice__title">
          {inFlight ? 'Verificación en curso' : 'Hay que esperar antes de volver a verificar'}
        </p>
        <p className="arca-setup-notice__text">{ARCA_SETUP_HOLD_COPY[reason]}</p>
        {!inFlight && (
          <p className="arca-setup-notice__meta" data-testid="arca-setup-hold-countdown" aria-live="off">
            {countdown.remainingSeconds > 5
              ? <>Vas a poder volver a verificar en <strong>{countdown.remainingLabel}</strong> (a las {countdown.untilLabel}).</>
              : 'Estamos confirmando con el servidor si ya podés volver a verificar…'}
          </p>
        )}
        <p className="arca-setup-notice__meta">La pantalla se actualiza sola. Podés cerrar esta ventana y volver más tarde.</p>
      </div>
    </section>
  )
}

export function ArcaSetupErrorNotice({ error, testId = 'arca-setup-error' }: { error: ArcaSetupErrorView; testId?: string }) {
  const Icon = error.tone === 'info' ? Info : AlertTriangle
  return (
    <div className={`arca-setup-notice arca-setup-notice--${error.tone}`} role="alert" data-testid={testId} data-error-code={error.code} data-error-category={error.category}>
      <Icon size={18} aria-hidden className="arca-setup-notice__icon" />
      <div>
        <p className="arca-setup-notice__title">{error.title}</p>
        <p className="arca-setup-notice__text">{error.message}</p>
        <p className="arca-setup-notice__meta">{error.action}</p>
      </div>
    </div>
  )
}

export function ArcaSetupInfoNotice({ title, children, tone = 'info', testId }: {
  title: string
  children?: React.ReactNode
  tone?: 'info' | 'success' | 'warning'
  testId?: string
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : Info
  return (
    <div className={`arca-setup-notice arca-setup-notice--${tone}`} data-testid={testId}>
      <Icon size={18} aria-hidden className="arca-setup-notice__icon" />
      <div>
        <p className="arca-setup-notice__title">{title}</p>
        {children && <div className="arca-setup-notice__text">{children}</div>}
      </div>
    </div>
  )
}
