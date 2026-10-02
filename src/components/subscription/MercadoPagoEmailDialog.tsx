/**
 * MercadoPagoEmailDialog — fallback de Planes.
 *
 * Aparece SÓLO cuando el servidor respondió que Mercado Pago no pudo iniciar la
 * suscripción con el email del login. Pide un único dato: el email de la cuenta
 * de Mercado Pago de quien va a pagar.
 *
 * Ese email es un parámetro que Mercado Pago exige para crear la suscripción.
 * No identifica al negocio, no otorga acceso y no se guarda en el navegador:
 * vive en el estado de la pantalla y se pierde al recargar.
 */
import { useEffect, useRef, useState } from 'react'
import { AppButton, AppInput, AppModal } from '../../ui'

// Validación de forma, para avisar de un error de tipeo antes de ir al servidor.
// La regla que vale es la del servidor; si es una cuenta real lo decide Mercado Pago.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/

export function payerEmailProblem(value: string): string | null {
  const email = value.trim()
  if (email === '') return 'Ingresá el email de tu cuenta de Mercado Pago.'
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return 'Revisá el email: no tiene un formato válido.'
  return null
}

export interface MercadoPagoEmailDialogProps {
  /** Nombre del plan que se está contratando (para el contexto del diálogo). */
  planName: string
  /** El email que el usuario ya intentó y no funcionó, si hubo alguno. */
  attemptedEmail?: string
  submitting: boolean
  /** Por qué no funcionó `attemptedEmail` (motivo del servidor). */
  error?: string
  onSubmit: (email: string) => void
  onClose: () => void
}

export function MercadoPagoEmailDialog({
  planName, attemptedEmail = '', submitting, error, onSubmit, onClose,
}: MercadoPagoEmailDialogProps) {
  const [email, setEmail] = useState(attemptedEmail)
  const [localError, setLocalError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // `AppModal` enfoca «Cerrar» al abrir. Este diálogo tiene un solo campo: el
  // foco va ahí. El rAF corre después del de la primitiva (los efectos del hijo
  // se registran antes que los del padre).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    const problem = payerEmailProblem(email)
    setLocalError(problem ?? '')
    if (!problem) onSubmit(email.trim())
  }

  // El motivo del servidor habla del email que se intentó: deja de mostrarse en
  // cuanto el usuario lo cambia. El error local (formato) es sobre lo que está
  // escrito ahora y tiene prioridad.
  const serverError = error && email.trim() === attemptedEmail ? error : ''
  const shownError = localError || serverError

  return (
    <AppModal
      isOpen
      onClose={onClose}
      title="Necesitamos un dato de Mercado Pago"
      subtitle={`Plan ${planName}`}
      size="sm"
      mobilePresentation="sheet"
      footer={
        <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end', width: '100%' }}>
          <AppButton variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</AppButton>
          <AppButton variant="indigo" type="submit" form="mp-payer-email-form" loading={submitting}>
            Continuar con Mercado Pago
          </AppButton>
        </div>
      }
    >
      <form id="mp-payer-email-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
          Mercado Pago no pudo iniciar la suscripción con el email de tu cuenta de TechRepair Pro.
          Ingresá el email asociado a tu cuenta de Mercado Pago.
        </p>
        <AppInput
          ref={inputRef}
          id="mp-payer-email"
          data-testid="mp-payer-email-input"
          label="Email de tu cuenta de Mercado Pago"
          semantic="email"
          name="mp_payer_email"
          value={email}
          onChange={e => { setEmail(e.target.value); if (localError) setLocalError('') }}
          placeholder="nombre@ejemplo.com"
          maxLength={254}
          autoCapitalize="none"
          spellCheck={false}
          disabled={submitting}
          error={shownError || undefined}
          hint="Lo usamos únicamente para iniciar tu suscripción en Mercado Pago. Puede ser distinto al de tu cuenta de TechRepair Pro."
        />
      </form>
    </AppModal>
  )
}
