import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { AppButton, AppModal } from '../../../ui'
import { formatArcaDate, formatCuit, type ArcaSelfServiceStatus } from '../../../lib/arcaStatus'
import {
  ARCA_SETUP_STEP_LABELS, ARCA_SETUP_TOTAL_STEPS, arcaCancelCopy, arcaSetupVisibleStep, deriveArcaSetupWizard,
  type ArcaCertificateStage,
} from '../../../lib/arcaSetupWizard'
import { fiscalDraftErrors, suggestArcaAlias, formatCuitInput, type ArcaFiscalDraft, type ArcaFiscalField } from '../../../lib/arcaFiscalInput'
import type { UseArcaSetupActionsReturn } from '../../../hooks/useArcaSetupActions'
import { ArcaFiscalStep, type ArcaFiscalStepHandle } from './ArcaFiscalStep'
import { ArcaCertificateUploadStep, ArcaPresentStep, ArcaSetupIdentity } from './ArcaCertificateSteps'
import { ArcaHoldNotice, ArcaSetupErrorNotice, ArcaSetupInfoNotice } from './ArcaSetupNotices'

export interface ArcaSetupWizardDefaults {
  cuit: string
  razonSocial: string
  businessName: string
}

interface ArcaSetupWizardProps {
  isOpen: boolean
  onClose: () => void
  status: ArcaSelfServiceStatus | null
  statusLoading: boolean
  onRefreshStatus: () => void
  actions: UseArcaSetupActionsReturn
  defaults: ArcaSetupWizardDefaults
}

const FIELD_ORDER: ArcaFiscalField[] = ['cuit', 'razon_social', 'ambiente', 'punto_venta', 'alias']
const CERTIFICATE_LABEL: Record<string, string> = {
  healthy: 'Vigente', expiring: 'Vence pronto', urgent: 'Renovación urgente', expired: 'Vencido', unknown: 'No se pudo leer', not_configured: 'Sin certificado',
}

function initialDraft(defaults: ArcaSetupWizardDefaults): ArcaFiscalDraft {
  const cuit = formatCuitInput(defaults.cuit ?? '')
  return {
    cuit,
    razonSocial: (defaults.razonSocial ?? '').slice(0, 200),
    ambiente: '',
    puntoVenta: '',
    alias: suggestArcaAlias(defaults.businessName, defaults.cuit),
  }
}

/**
 * ARCA Self-Service Phase 2B — asistente de configuración inicial.
 *
 * La pantalla SIEMPRE sale de `deriveArcaSetupWizard(status)`. El único estado local es de
 * presentación y vive en memoria: el borrador del formulario, la sub-pantalla de guía/carga y
 * la confirmación de cancelar. Cerrar y volver a abrir (o recargar) retoma desde el servidor.
 */
export function ArcaSetupWizard({ isOpen, onClose, status, statusLoading, onRefreshStatus, actions, defaults }: ArcaSetupWizardProps) {
  const view = useMemo(() => deriveArcaSetupWizard(status), [status])
  const [draft, setDraft] = useState<ArcaFiscalDraft>(() => initialDraft(defaults))
  const [touched, setTouched] = useState<Partial<Record<ArcaFiscalField, boolean>>>({})
  const [submitted, setSubmitted] = useState(false)
  const [stage, setStage] = useState<ArcaCertificateStage>('present')
  const [replacingCertificate, setReplacingCertificate] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const fiscalRef = useRef<ArcaFiscalStepHandle>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const { busy, error } = actions

  // Una pantalla nueva descarta la navegación local de la anterior.
  useEffect(() => {
    setConfirmingCancel(false)
    setReplacingCertificate(false)
    if (view.screen !== 'presentar_en_arca') setStage('present')
    if (view.screen === 'datos_fiscales') { setSubmitted(false); setTouched({}) }
  }, [view.screen])

  // Foco al título del paso cuando cambia (el primer foco al abrir lo pone el modal).
  const focusKey = `${view.screen}:${stage}:${confirmingCancel}:${replacingCertificate}`
  const firstFocus = useRef(true)
  useEffect(() => {
    if (!isOpen) { firstFocus.current = true; return }
    if (firstFocus.current) { firstFocus.current = false; return }
    headingRef.current?.focus()
  }, [focusKey, isOpen])

  const localErrors = fiscalDraftErrors(draft)
  const serverField = error?.action === 'prepare' ? error.view.field : undefined
  const fieldErrors: Partial<Record<ArcaFiscalField, string>> = {}
  for (const field of FIELD_ORDER) {
    if ((submitted || touched[field]) && localErrors[field]) fieldErrors[field] = localErrors[field]
  }
  if (serverField && serverField !== 'certificate' && !fieldErrors[serverField]) fieldErrors[serverField] = error?.view.message

  const visibleStep = busy === 'prepare' ? 2 : status ? arcaSetupVisibleStep(view, stage) : null
  const stepForProgress = view.screen === 'verificar_conexion' && replacingCertificate ? 4 : visibleStep
  const actionError = (action: string) => (error && error.action === action ? error.view : null)
  const anyBusy = busy !== null
  const cancelCopy = arcaCancelCopy(view)
  const canCancel = view.actions.includes('cancel')

  const submitPrepare = async () => {
    setSubmitted(true)
    const first = FIELD_ORDER.find((field) => localErrors[field])
    if (first) { fiscalRef.current?.focusField(first); return }
    await actions.prepare(draft)
  }

  const confirmCancel = async () => {
    const result = await actions.cancel()
    if (result?.ok) {
      setDraft(initialDraft(defaults))
      setConfirmingCancel(false)
    }
  }

  // ─── Contenido por pantalla ───────────────────────────────────────────────
  let heading = 'Conectar ARCA'
  let body: React.ReactNode = null
  let footer: React.ReactNode = null

  const closeButton = (label = 'Cerrar') => (
    <AppButton variant="secondary" onClick={onClose} data-testid="arca-setup-close">{label}</AppButton>
  )
  const cancelButton = canCancel && (
    <AppButton variant="danger" onClick={() => setConfirmingCancel(true)} disabled={anyBusy} data-testid="arca-setup-cancel">
      Cancelar configuración
    </AppButton>
  )

  if (!status) {
    heading = statusLoading ? 'Leyendo el estado…' : 'No pudimos leer el estado'
    body = statusLoading
      ? <p className="arca-setup-lead" role="status"><Loader2 size={16} className="animate-spin" aria-hidden /> Leyendo el estado de ARCA…</p>
      : <ArcaSetupInfoNotice tone="warning" title="No pudimos leer el estado de ARCA" testId="arca-setup-unreadable">No se muestra ningún paso hasta poder leerlo. No se perdió nada de lo que hiciste.</ArcaSetupInfoNotice>
    footer = <>{closeButton()}{!statusLoading && <AppButton variant="primary" leftIcon={<RefreshCw size={16} aria-hidden />} onClick={onRefreshStatus}>Reintentar</AppButton>}</>
  } else if (confirmingCancel && canCancel) {
    heading = cancelCopy.title
    body = (
      <div className="arca-setup-stack" data-testid="arca-setup-cancel-confirm" data-strong={cancelCopy.strong}>
        <ArcaSetupInfoNotice tone="warning" title={cancelCopy.strong ? 'Leé esto antes de cancelar' : 'Vas a empezar de nuevo'}>{cancelCopy.message}</ArcaSetupInfoNotice>
        {view.hold && <ArcaHoldNotice reason={view.hold.reason} retryNotBefore={view.hold.retryNotBefore} />}
        {actionError('cancel') && <ArcaSetupErrorNotice error={actionError('cancel')!} />}
      </div>
    )
    footer = (
      <>
        <AppButton variant="secondary" onClick={() => setConfirmingCancel(false)} disabled={anyBusy} data-testid="arca-setup-cancel-back">Volver</AppButton>
        <AppButton variant="red" onClick={confirmCancel} loading={busy === 'cancel'} disabled={anyBusy && busy !== 'cancel'} data-testid="arca-setup-cancel-confirm-button">{cancelCopy.confirmLabel}</AppButton>
      </>
    )
  } else {
    switch (view.screen) {
      case 'datos_fiscales':
        heading = busy === 'prepare' ? 'Generando el archivo para ARCA' : 'Datos fiscales'
        body = (
          <div className="arca-setup-stack">
            <p className="arca-setup-lead">Completá los datos con los que vas a facturar. En el próximo paso generamos el archivo que tenés que presentar en ARCA.</p>
            <ArcaFiscalStep
              ref={fiscalRef}
              draft={draft}
              errors={fieldErrors}
              disabled={anyBusy}
              onChange={setDraft}
              onBlurField={(field) => setTouched((t) => ({ ...t, [field]: true }))}
            />
            {busy === 'prepare' && (
              <p className="arca-setup-progress-note" role="status" data-testid="arca-setup-preparing">
                <Loader2 size={16} className="animate-spin" aria-hidden /> Generando la clave segura y el archivo para ARCA…
              </p>
            )}
            {actionError('prepare') && <ArcaSetupErrorNotice error={actionError('prepare')!} />}
          </div>
        )
        footer = (
          <>
            {closeButton('Cancelar')}
            <AppButton variant="primary" onClick={submitPrepare} loading={busy === 'prepare'} disabled={anyBusy && busy !== 'prepare'} data-testid="arca-setup-prepare">
              {busy === 'prepare' ? 'Generando…' : 'Generar archivo para ARCA'}
            </AppButton>
          </>
        )
        break

      case 'presentar_en_arca':
        if (stage === 'present') {
          heading = 'Presentá el archivo en ARCA'
          body = (
            <div className="arca-setup-stack">
              {view.hold && <ArcaHoldNotice reason={view.hold.reason} retryNotBefore={view.hold.retryNotBefore} />}
              <ArcaPresentStep
                status={status}
                downloading={busy === 'download'}
                canDownload={view.actions.includes('csr') && !anyBusy}
                onDownload={() => { void actions.downloadRequestFile() }}
                downloadError={actionError('download')}
              />
            </div>
          )
          footer = (
            <>
              {cancelButton}
              <AppButton variant="primary" onClick={() => setStage('upload')} disabled={anyBusy} data-testid="arca-setup-have-certificate">Ya tengo el certificado</AppButton>
            </>
          )
        } else {
          heading = 'Subí el certificado'
          body = (
            <div className="arca-setup-stack">
              {view.hold && <ArcaHoldNotice reason={view.hold.reason} retryNotBefore={view.hold.retryNotBefore} />}
              <ArcaCertificateUploadStep
                upload={actions.certificateUpload}
                busy={busy === 'certificate'}
                serverError={actionError('certificate')}
                onFile={(file) => { void actions.attachCertificate(file) }}
                disabled={!view.actions.includes('certificate') || anyBusy}
              />
            </div>
          )
          footer = (
            <>
              {cancelButton}
              <AppButton variant="secondary" onClick={() => setStage('present')} disabled={anyBusy} data-testid="arca-setup-back-to-guide">Volver a la guía</AppButton>
            </>
          )
        }
        break

      case 'verificar_conexion': {
        const hold = view.hold
        if (replacingCertificate && view.actions.includes('certificate')) {
          heading = 'Cambiar el certificado'
          body = (
            <div className="arca-setup-stack">
              {hold && <ArcaHoldNotice reason={hold.reason} retryNotBefore={hold.retryNotBefore} />}
              <ArcaCertificateUploadStep
                upload={actions.certificateUpload}
                busy={busy === 'certificate'}
                serverError={actionError('certificate')}
                onFile={(file) => { void actions.attachCertificate(file).then((ok) => { if (ok) setReplacingCertificate(false) }) }}
                disabled={anyBusy}
              />
            </div>
          )
          footer = <AppButton variant="secondary" onClick={() => { actions.resetCertificateUpload(); setReplacingCertificate(false) }} disabled={anyBusy} data-testid="arca-setup-keep-certificate">Volver</AppButton>
          break
        }
        heading = hold ? 'Esperando para verificar' : busy === 'verify' ? 'Verificando conexión con ARCA…' : 'Verificar la conexión'
        body = (
          <div className="arca-setup-stack" data-testid="arca-setup-verify-step">
            <p className="arca-setup-lead">
              Comprobamos con ARCA que el certificado y la autorización de facturación electrónica funcionan. No se emite ningún comprobante.
            </p>
            <ArcaSetupIdentity status={status} />
            {hold && <ArcaHoldNotice reason={hold.reason} retryNotBefore={hold.retryNotBefore} />}
            {busy === 'verify' && (
              <p className="arca-setup-progress-note" role="status" data-testid="arca-setup-verifying">
                <Loader2 size={16} className="animate-spin" aria-hidden /> Verificando conexión con ARCA… Puede tardar hasta un minuto y medio.
              </p>
            )}
            {/* Con la espera ya en pantalla, el aviso de la acción repetiría lo mismo: manda la espera del servidor. */}
            {actionError('verify') && !(hold && actionError('verify')!.retry === 'after_hold') && <ArcaSetupErrorNotice error={actionError('verify')!} />}
            <div className="arca-setup-inline-actions">
              {view.actions.includes('certificate') && (
                <AppButton variant="ghost" size="sm" onClick={() => { actions.resetCertificateUpload(); setReplacingCertificate(true) }} disabled={anyBusy} data-testid="arca-setup-replace-certificate">
                  Cambiar certificado
                </AppButton>
              )}
              {view.actions.includes('csr') && (
                <AppButton variant="ghost" size="sm" onClick={() => { void actions.downloadRequestFile() }} loading={busy === 'download'} disabled={anyBusy && busy !== 'download'} data-testid="arca-setup-download">
                  Descargar archivo para ARCA
                </AppButton>
              )}
            </div>
            {actionError('download') && <ArcaSetupErrorNotice error={actionError('download')!} testId="arca-setup-download-error" />}
          </div>
        )
        footer = (
          <>
            {cancelButton || closeButton()}
            {view.actions.includes('verify') && (
              <AppButton variant="primary" onClick={() => { void actions.verify(status.setup.started_at) }} loading={busy === 'verify'} disabled={anyBusy && busy !== 'verify'} data-testid="arca-setup-verify">
                {busy === 'verify' ? 'Verificando…' : 'Verificar conexión'}
              </AppButton>
            )}
          </>
        )
        break
      }

      case 'finalizar_activacion':
        heading = busy === 'verify' ? 'Terminando la activación…' : 'Falta terminar la activación'
        body = (
          <div className="arca-setup-stack" data-testid="arca-setup-activation-step">
            <ArcaSetupInfoNotice tone="success" title="ARCA aceptó la conexión">
              Falta terminar de activarla en TechRepair Pro. Este paso no vuelve a consultar a ARCA.
            </ArcaSetupInfoNotice>
            <ArcaSetupIdentity status={status} />
            {busy === 'verify' && (
              <p className="arca-setup-progress-note" role="status"><Loader2 size={16} className="animate-spin" aria-hidden /> Terminando la activación…</p>
            )}
            {actionError('verify') && <ArcaSetupErrorNotice error={actionError('verify')!} />}
          </div>
        )
        footer = (
          <>
            {cancelButton}
            <AppButton variant="primary" onClick={() => { void actions.verify(status.setup.started_at) }} loading={busy === 'verify'} disabled={anyBusy && busy !== 'verify'} data-testid="arca-setup-activate">
              Terminar activación
            </AppButton>
          </>
        )
        break

      case 'listo':
        heading = 'ARCA quedó conectado'
        body = (
          <div className="arca-setup-stack" data-testid="arca-setup-done">
            {/* Phase 2B verifica la conexión (WSAA) y la activa; NO emite ni pide CAE. No prometer más que eso. */}
            <ArcaSetupInfoNotice tone="success" title="Conexión configurada" testId="arca-setup-done-message">
              La conexión con ARCA quedó configurada correctamente. TechRepair Pro usará esta conexión cuando emitas comprobantes electrónicos.
            </ArcaSetupInfoNotice>
            <dl className="arca-setup-identity" data-testid="arca-setup-done-summary">
              <div><dt>CUIT</dt><dd>{formatCuit(status.cuit)}</dd></div>
              <div><dt>Razón social</dt><dd>{status.razon_social ?? '—'}</dd></div>
              <div><dt>Ambiente</dt><dd>{status.environment === 'produccion' ? 'Producción' : status.environment === 'homologacion' ? 'Homologación' : '—'}</dd></div>
              <div><dt>Punto de venta</dt><dd>{status.punto_venta ?? '—'}</dd></div>
              <div><dt>Certificado</dt><dd>{CERTIFICATE_LABEL[status.certificate.renewal_state] ?? '—'} · vence {formatArcaDate(status.certificate.expires_at)}</dd></div>
              <div><dt>Conexión</dt><dd>Conectada{status.connection.last_verified_at ? ` · ${formatArcaDate(status.connection.last_verified_at)}` : ''}</dd></div>
            </dl>
          </div>
        )
        footer = <AppButton variant="primary" onClick={onClose} data-testid="arca-setup-finish">Listo</AppButton>
        break

      case 'no_disponible':
        heading = 'Tu plan no incluye ARCA'
        body = <ArcaSetupInfoNotice title="La facturación electrónica no está incluida en tu plan" testId="arca-setup-unavailable">Revisá los planes disponibles para activarla.</ArcaSetupInfoNotice>
        footer = closeButton()
        break

      case 'solo_lectura':
        heading = 'Sólo lectura'
        body = <ArcaSetupInfoNotice title="No tenés permiso para configurar ARCA" testId="arca-setup-readonly">Pedile al dueño o a un administrador con permiso de configuración avanzada que lo haga.</ArcaSetupInfoNotice>
        footer = closeButton()
        break

      default:
        heading = 'El estado de ARCA cambió'
        body = <ArcaSetupInfoNotice tone="warning" title="Este asistente ya no aplica" testId="arca-setup-out-of-scope">Revisá el estado de la integración en la pantalla de ARCA.</ArcaSetupInfoNotice>
        footer = closeButton()
    }
  }

  const stepLabel = stepForProgress ? ARCA_SETUP_STEP_LABELS[stepForProgress] : null

  return (
    <AppModal
      isOpen={isOpen}
      onClose={onClose}
      title="Conectar ARCA"
      subtitle={stepForProgress && stepLabel ? `Paso ${stepForProgress} de ${ARCA_SETUP_TOTAL_STEPS} · ${stepLabel}` : undefined}
      icon={<ShieldCheck size={18} aria-hidden />}
      size="lg"
      mobilePresentation="fullscreen"
      closeOnBackdrop={false}
      footer={<div className="arca-setup-footer">{footer}</div>}
    >
      <div className="arca-setup" data-testid="arca-setup-wizard" data-screen={status ? view.screen : 'unreadable'} data-step={stepForProgress ?? ''} data-stage={stage}>
        {stepForProgress !== null && (
          <div
            className="intake-progress"
            role="progressbar"
            aria-label="Progreso de la configuración"
            aria-valuemin={1}
            aria-valuemax={ARCA_SETUP_TOTAL_STEPS}
            aria-valuenow={stepForProgress}
          >
            <span style={{ width: `${(stepForProgress / ARCA_SETUP_TOTAL_STEPS) * 100}%` }} />
          </div>
        )}
        <h3 ref={headingRef} tabIndex={-1} className="arca-setup-heading" data-testid="arca-setup-heading">{heading}</h3>
        {body}
      </div>
    </AppModal>
  )
}
