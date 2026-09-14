import { useCallback, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { AppButton } from '../../../ui'
import type { ArcaSelfServiceStatus } from '../../../lib/arcaStatus'
import { ARCA_SETUP_STEP_LABELS, ARCA_SETUP_TOTAL_STEPS, deriveArcaSetupEntry } from '../../../lib/arcaSetupWizard'
import { useArcaSetupActions } from '../../../hooks/useArcaSetupActions'
import { ArcaHoldNotice } from './ArcaSetupNotices'
import { ArcaSetupWizard, type ArcaSetupWizardDefaults } from './ArcaSetupWizard'

interface ArcaSetupPanelProps {
  status: ArcaSelfServiceStatus | null
  loading: boolean
  failed: boolean
  refresh: () => Promise<unknown>
  defaults: ArcaSetupWizardDefaults
}

/**
 * ARCA Self-Service Phase 2B — entrada al asistente dentro de Configuración → ARCA.
 *
 * Va debajo de `ArcaStatusCard`: la tarjeta explica el estado y este panel ofrece
 * la acción que corresponde según `deriveArcaSetupEntry`. "Actualizar estado" sólo relee el
 * estado canónico: nunca pide un ticket a ARCA.
 *
 * Las acciones viven acá (y no en el modal) para que el candado de "una acción a la vez"
 * sobreviva a cerrar y volver a abrir el asistente.
 */
export function ArcaSetupPanel({ status, loading, failed, refresh, defaults }: ArcaSetupPanelProps) {
  const [open, setOpen] = useState(false)
  const actions = useArcaSetupActions(refresh)
  const entry = deriveArcaSetupEntry(status, { loading, failed })
  const close = useCallback(() => setOpen(false), [])
  const openWizard = useCallback(() => {
    actions.clearError()
    setOpen(true)
    // Abrir también relee: el paso lo decide el servidor, no lo que quedó en pantalla.
    void refresh()
  }, [actions, refresh])

  const stepNumber = entry.view?.stepNumber ?? null
  const hold = entry.view?.hold ?? null
  // Sin plan no hay nada que ofrecer (la tarjeta lo explica) y mientras carga la tarjeta ya muestra el progreso.
  if (!open && (entry.kind === 'unavailable' || entry.kind === 'loading')) return null
  const prominent = entry.kind === 'start' || entry.kind === 'resume'

  return (
    <div className={`arca-setup-entry${prominent ? '' : ' arca-setup-entry--compact'}`} data-testid="arca-setup-entry" data-entry-kind={entry.kind}>
      {entry.kind === 'start' && (
        <div className="arca-setup-entry__body">
          <p className="arca-setup-entry__title">Conectá ARCA en pocos pasos</p>
          <ul className="arca-setup-entry__list">
            <li>Vas a necesitar el CUIT y la Clave Fiscal del negocio.</li>
            <li>La clave segura se genera y se guarda en TechRepair Pro: no tenés que manejar archivos de clave.</li>
            <li>Podés cerrar el asistente y seguir después desde donde quedaste.</li>
          </ul>
        </div>
      )}

      {entry.kind === 'resume' && (
        <div className="arca-setup-entry__body">
          <p className="arca-setup-entry__title" data-testid="arca-setup-entry-step">
            {stepNumber ? `Configuración en curso · Paso ${stepNumber} de ${ARCA_SETUP_TOTAL_STEPS}: ${ARCA_SETUP_STEP_LABELS[stepNumber]}` : 'Configuración en curso'}
          </p>
          {hold && <ArcaHoldNotice reason={hold.reason} retryNotBefore={hold.retryNotBefore} />}
        </div>
      )}

      <div className="arca-setup-entry__actions">
        {entry.cta && (
          <AppButton
            variant="primary"
            rightIcon={<ArrowRight size={16} aria-hidden />}
            onClick={openWizard}
            data-testid={entry.kind === 'start' ? 'arca-setup-start' : 'arca-setup-continue'}
          >
            {entry.cta}
          </AppButton>
        )}
        {entry.kind !== 'loading' && (
          <AppButton
            variant="secondary"
            leftIcon={<RefreshCw size={16} aria-hidden />}
            onClick={() => { void refresh() }}
            loading={loading && status !== null}
            disabled={loading}
            data-testid="arca-refresh-status"
          >
            {entry.kind === 'unreadable' ? 'Reintentar' : 'Actualizar estado'}
          </AppButton>
        )}
      </div>

      {open && (
        <ArcaSetupWizard
          isOpen={open}
          onClose={close}
          status={status}
          statusLoading={loading}
          onRefreshStatus={() => { void refresh() }}
          actions={actions}
          defaults={defaults}
        />
      )}
    </div>
  )
}
