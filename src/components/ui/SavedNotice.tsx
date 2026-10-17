import { CheckCircle2 } from 'lucide-react'

export interface SavedNoticeProps {
  message: string
  testId?: string
}

/**
 * CLIENTES-UX-1A — aviso de guardado exitoso.
 *
 * La región `role="status"` existe siempre (vacía cuando no hay aviso): un
 * lector de pantalla anuncia el texto cuando aparece, cosa que no garantiza
 * una región que se monta junto con su contenido.
 */
export function SavedNotice({ message, testId = 'saved-notice' }: SavedNoticeProps) {
  return (
    <div role="status" aria-live="polite" className="saved-notice-region" data-testid={testId}>
      {message && (
        <p className="alert-inline alert-success saved-notice">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{message}</span>
        </p>
      )}
    </div>
  )
}
