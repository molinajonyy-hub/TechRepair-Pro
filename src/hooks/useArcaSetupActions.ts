import { useCallback, useRef, useState } from 'react'
import { arcaSetupService, newArcaSetupIdempotencyKey, type ArcaSetupFiscalData, type ArcaSetupResult } from '../services/arcaSetupService'
import { describeArcaSetupError, type ArcaSetupErrorView } from '../lib/arcaSetupErrors'
import { readArcaCertificateFile, type ArcaCertificateFileRejection } from '../lib/arcaCertificateFile'
import { cuitDigits, type ArcaFiscalDraft } from '../lib/arcaFiscalInput'
import { logger } from '../lib/logger'

/**
 * ARCA Self-Service Phase 2B — acciones del asistente.
 *
 *   · Una sola acción a la vez (candado síncrono): un doble clic nunca manda dos pedidos.
 *   · Claves de idempotencia SÓLO en memoria: `prepare` reusa la clave mientras los datos no
 *     cambien (reintento de red); `verify` usa una clave por configuración. Cancelar las descarta.
 *   · Después de CADA acción, éxito o falla, se relee el estado canónico: la pantalla nunca
 *     avanza por la respuesta de la acción.
 *   · El archivo para ARCA se pide al servidor en cada descarga (sirve días después).
 *   · El certificado se clasifica localmente; un archivo con clave nunca sale del navegador.
 */
export type ArcaSetupBusyAction = 'prepare' | 'download' | 'certificate' | 'verify' | 'cancel'

export interface ArcaSetupActionError {
  action: ArcaSetupBusyAction
  view: ArcaSetupErrorView
}

export interface ArcaCertificateUpload {
  fileName: string
  state: 'validating' | 'accepted' | 'rejected'
  /** Rechazo local (el archivo no se envió). */
  localRejection?: ArcaCertificateFileRejection
}

export interface UseArcaSetupActionsReturn {
  busy: ArcaSetupBusyAction | null
  error: ArcaSetupActionError | null
  certificateUpload: ArcaCertificateUpload | null
  clearError: () => void
  prepare: (draft: ArcaFiscalDraft) => Promise<ArcaSetupResult | null>
  downloadRequestFile: () => Promise<boolean>
  attachCertificate: (file: File) => Promise<boolean>
  verify: (setupStartedAt: string | null) => Promise<ArcaSetupResult | null>
  cancel: () => Promise<ArcaSetupResult | null>
  resetCertificateUpload: () => void
}

function draftToFiscal(draft: ArcaFiscalDraft): ArcaSetupFiscalData {
  return {
    cuit: cuitDigits(draft.cuit),
    razon_social: draft.razonSocial.trim(),
    ambiente: draft.ambiente === 'produccion' ? 'produccion' : 'homologacion',
    punto_venta: Number(draft.puntoVenta.trim()),
    alias: draft.alias.trim(),
  }
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function saveTextFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function useArcaSetupActions(refreshStatus: () => Promise<unknown>): UseArcaSetupActionsReturn {
  const [busy, setBusy] = useState<ArcaSetupBusyAction | null>(null)
  const [error, setError] = useState<ArcaSetupActionError | null>(null)
  const [certificateUpload, setCertificateUpload] = useState<ArcaCertificateUpload | null>(null)
  const lock = useRef(false)
  const prepareKey = useRef<{ payload: string; key: string } | null>(null)
  const verifyKey = useRef<{ setup: string; key: string } | null>(null)

  const run = useCallback(async <T,>(action: ArcaSetupBusyAction, body: () => Promise<T>): Promise<T | null> => {
    if (lock.current) return null
    lock.current = true
    setBusy(action)
    setError(null)
    try {
      return await body()
    } catch (err) {
      logger.error('GENERAL', `Asistente ARCA: la acción ${action} falló`, err)
      setError({ action, view: describeArcaSetupError(null) })
      return null
    } finally {
      // El estado canónico decide la pantalla siguiente, también después de un error.
      try { await refreshStatus() } catch { /* el hook de estado ya lo registra */ }
      lock.current = false
      setBusy(null)
    }
  }, [refreshStatus])

  const report = useCallback((action: ArcaSetupBusyAction, result: ArcaSetupResult): ArcaSetupResult => {
    if (!result.ok) setError({ action, view: describeArcaSetupError(result.state) })
    return result
  }, [])

  const prepare = useCallback((draft: ArcaFiscalDraft) => run('prepare', async () => {
    const fiscal = draftToFiscal(draft)
    const payload = JSON.stringify(fiscal)
    if (prepareKey.current?.payload !== payload) prepareKey.current = { payload, key: newArcaSetupIdempotencyKey() }
    const result = report('prepare', await arcaSetupService.prepare(fiscal, prepareKey.current.key))
    // Una clave consumida o en conflicto no se vuelve a usar.
    if (!result.ok && (result.state === 'IDEMPOTENCY_KEY_CONSUMED' || result.state === 'IDEMPOTENCY_CONFLICT')) prepareKey.current = null
    return result
  }), [run, report])

  const downloadRequestFile = useCallback(async () => {
    const ok = await run('download', async () => {
      const result = report('download', await arcaSetupService.getRequestFile())
      if (!result.ok || !result.csr) {
        if (result.ok) setError({ action: 'download', view: describeArcaSetupError(null) })
        return false
      }
      saveTextFile(result.csr.filename, `${result.csr.pem}\n`, 'application/pkcs10')
      return true
    })
    return ok === true
  }, [run, report])

  const attachCertificate = useCallback(async (file: File) => {
    if (lock.current) return false
    setCertificateUpload({ fileName: file.name, state: 'validating' })
    const ok = await run('certificate', async () => {
      const bytes = await readFileBytes(file)
      const local = readArcaCertificateFile({ name: file.name, size: file.size, bytes })
      if (!local.ok) {
        setCertificateUpload({ fileName: file.name, state: 'rejected', localRejection: local.reason })
        return false
      }
      const result = report('certificate', local.kind === 'pem'
        ? await arcaSetupService.attachCertificatePem(local.pem)
        : await arcaSetupService.attachCertificateDerBase64(local.derBase64))
      setCertificateUpload({ fileName: file.name, state: result.ok ? 'accepted' : 'rejected' })
      return result.ok
    })
    if (ok === null) setCertificateUpload((current) => current && current.state === 'validating' ? { ...current, state: 'rejected' } : current)
    return ok === true
  }, [run, report])

  const verify = useCallback((setupStartedAt: string | null) => run('verify', async () => {
    const setup = setupStartedAt ?? 'current'
    if (verifyKey.current?.setup !== setup) verifyKey.current = { setup, key: newArcaSetupIdempotencyKey() }
    const result = report('verify', await arcaSetupService.verifyAndActivate(verifyKey.current.key))
    if (!result.ok && (result.state === 'IDEMPOTENCY_KEY_CONSUMED' || result.state === 'IDEMPOTENCY_CONFLICT')) verifyKey.current = null
    return result
  }), [run, report])

  const cancel = useCallback(() => run('cancel', async () => {
    const result = report('cancel', await arcaSetupService.cancel())
    if (result.ok) {
      prepareKey.current = null
      verifyKey.current = null
      setCertificateUpload(null)
    }
    return result
  }), [run, report])

  return {
    busy,
    error,
    certificateUpload,
    clearError: useCallback(() => setError(null), []),
    prepare,
    downloadRequestFile,
    attachCertificate,
    verify,
    cancel,
    resetCertificateUpload: useCallback(() => setCertificateUpload(null), []),
  }
}
