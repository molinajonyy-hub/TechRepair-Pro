import { useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, FileCheck2, FileWarning, Loader2, UploadCloud } from 'lucide-react'
import { AppButton } from '../../../ui'
import { formatCuit, type ArcaSelfServiceStatus } from '../../../lib/arcaStatus'
import { buildArcaSetupGuide } from '../../../lib/arcaSetupGuide'
import { ARCA_CERTIFICATE_ACCEPT, ARCA_CERTIFICATE_FILE_COPY } from '../../../lib/arcaCertificateFile'
import type { ArcaCertificateUpload } from '../../../hooks/useArcaSetupActions'
import type { ArcaSetupErrorView } from '../../../lib/arcaSetupErrors'
import { ArcaSetupErrorNotice } from './ArcaSetupNotices'

const AMBIENTE_LABEL = { produccion: 'Producción', homologacion: 'Homologación' } as const

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="arca-setup-copy">
      <span className="arca-setup-copy__label">{label}</span>
      <code className="arca-setup-copy__value" data-testid="arca-setup-copy-value">{value}</code>
      <button type="button" className="btn btn-ghost btn-sm arca-setup-copy__button" onClick={copy} aria-label={`Copiar ${label.toLowerCase()}`}>
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        <span aria-live="polite">{copied ? 'Copiado' : 'Copiar'}</span>
      </button>
    </div>
  )
}

/** Resumen de la identidad fiscal de la configuración en curso (sale del estado del servidor). */
export function ArcaSetupIdentity({ status }: { status: ArcaSelfServiceStatus }) {
  return (
    <dl className="arca-setup-identity" data-testid="arca-setup-identity">
      <div><dt>CUIT</dt><dd>{formatCuit(status.cuit)}</dd></div>
      <div><dt>Ambiente</dt><dd>{status.environment ? AMBIENTE_LABEL[status.environment] : '—'}</dd></div>
      <div><dt>Punto de venta</dt><dd>{status.punto_venta ?? '—'}</dd></div>
      <div><dt>Nombre del equipo</dt><dd className="arca-setup-identity__mono">{status.alias ?? '—'}</dd></div>
    </dl>
  )
}

/** Pasos 2–3 — descargar el archivo para ARCA y presentarlo. */
export function ArcaPresentStep({ status, downloading, canDownload, onDownload, downloadError }: {
  status: ArcaSelfServiceStatus
  downloading: boolean
  canDownload: boolean
  onDownload: () => void
  downloadError: ArcaSetupErrorView | null
}) {
  const guide = buildArcaSetupGuide({
    ambiente: status.environment,
    alias: status.alias,
    cuitLabel: formatCuit(status.cuit),
    filename: null,
  })

  return (
    <div className="arca-setup-stack" data-testid="arca-setup-present">
      <p className="arca-setup-lead">
        TechRepair Pro generó un archivo de solicitud con la clave segura del negocio, que queda guardada en el servidor.
        Descargalo y presentalo en ARCA para que te entregue el certificado.
      </p>

      <ArcaSetupIdentity status={status} />

      <div className="arca-setup-download">
        <AppButton
          variant="primary"
          leftIcon={<Download size={16} aria-hidden />}
          loading={downloading}
          disabled={!canDownload}
          onClick={onDownload}
          data-testid="arca-setup-download"
        >
          {downloading ? 'Preparando archivo…' : 'Descargar archivo para ARCA'}
        </AppButton>
        <p className="form-hint">Podés volver a descargarlo cuando quieras mientras la configuración siga en curso.</p>
      </div>
      {downloadError && <ArcaSetupErrorNotice error={downloadError} testId="arca-setup-download-error" />}

      <section className="arca-setup-guide" aria-labelledby="arca-setup-guide-title" data-testid="arca-setup-guide" data-ambiente={status.environment ?? ''}>
        <h3 id="arca-setup-guide-title" className="arca-setup-guide__title">Qué hacer en ARCA</h3>
        <p className="arca-setup-guide__intro">{guide.intro}</p>
        <ol className="arca-setup-guide__steps">
          {guide.steps.map((step) => (
            <li key={step.key} data-testid={`arca-setup-guide-${step.key}`}>
              <p className="arca-setup-guide__step-title">{step.title}</p>
              <p className="arca-setup-guide__step-detail">{step.detail}</p>
              {step.copyValue && <CopyValue label={step.copyValue.label} value={step.copyValue.value} />}
            </li>
          ))}
        </ol>
        <p className="arca-setup-guide__warning">{guide.warning}</p>
        <div className="arca-setup-guide__links">
          {guide.links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="arca-setup-link">
              {link.label} <ExternalLink size={13} aria-hidden />
              <span className="sr-only"> (se abre en otra pestaña)</span>
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}

/** Paso 4 — subir el certificado. Arrastrar y soltar o elegir el archivo. */
export function ArcaCertificateUploadStep({ upload, busy, serverError, onFile, disabled }: {
  upload: ArcaCertificateUpload | null
  busy: boolean
  serverError: ArcaSetupErrorView | null
  onFile: (file: File) => void
  disabled: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const localCopy = upload?.localRejection ? ARCA_CERTIFICATE_FILE_COPY[upload.localRejection] : null
  const state = busy ? 'validating' : upload?.state ?? 'idle'

  const pick = (files: FileList | null) => {
    const file = files?.[0]
    if (file && !disabled) onFile(file)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="arca-setup-stack" data-testid="arca-setup-upload">
      <p className="arca-setup-lead">
        Subí el certificado que te entregó ARCA (archivo <strong>.crt</strong>). Es un archivo público: no contiene la clave.
      </p>

      <div
        className={`arca-setup-dropzone${dragging ? ' is-dragging' : ''}${state === 'rejected' ? ' is-rejected' : ''}${state === 'accepted' ? ' is-accepted' : ''}`}
        data-testid="arca-setup-dropzone"
        data-upload-state={state}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files) }}
      >
        {state === 'validating'
          ? <Loader2 size={28} aria-hidden className="animate-spin" />
          : state === 'accepted' ? <FileCheck2 size={28} aria-hidden /> : state === 'rejected' ? <FileWarning size={28} aria-hidden /> : <UploadCloud size={28} aria-hidden />}
        <p className="arca-setup-dropzone__title" aria-live="polite" data-testid="arca-setup-upload-status">
          {state === 'validating' && `Validando ${upload?.fileName ?? 'el certificado'}…`}
          {state === 'accepted' && `Certificado válido: ${upload?.fileName ?? ''}`}
          {state === 'rejected' && `No se pudo usar ${upload?.fileName ?? 'el archivo'}`}
          {state === 'idle' && 'Arrastrá el certificado acá'}
        </p>
        <input
          ref={inputRef}
          id="arca-setup-certificate-input"
          data-testid="arca-setup-certificate-input"
          type="file"
          accept={ARCA_CERTIFICATE_ACCEPT}
          className="sr-only"
          onChange={(e) => pick(e.target.files)}
          disabled={disabled}
          aria-describedby="arca-setup-certificate-hint"
        />
        <AppButton variant="secondary" onClick={() => inputRef.current?.click()} disabled={disabled} data-testid="arca-setup-certificate-pick">
          {state === 'idle' ? 'Elegir archivo' : 'Elegir otro archivo'}
        </AppButton>
        <p id="arca-setup-certificate-hint" className="form-hint">Formatos admitidos: .crt, .cer, .pem o .der.</p>
      </div>

      {localCopy && (
        <ArcaSetupErrorNotice
          testId="arca-setup-certificate-error"
          error={{ code: upload?.localRejection ?? 'CERTIFICATE_INVALID', category: 'certificate', tone: 'danger', retry: 'after_fix', title: localCopy.title, message: localCopy.message, action: 'Elegí el archivo correcto.' }}
        />
      )}
      {!localCopy && serverError && <ArcaSetupErrorNotice error={serverError} testId="arca-setup-certificate-error" />}
    </div>
  )
}
