import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Loader2, ScanLine } from 'lucide-react'
import { AppButton, ResponsiveDialog } from '../../ui'
import {
  CAMERA_CONSTRAINTS,
  DECODE_INTERVAL_MS,
  classifyCameraError,
  createScanEngine,
  detectScannerCapability,
  hasVideoInput,
  releaseStream,
  type CameraFailure,
  type ScanEngine,
  type ScannerCapability,
} from './barcodeScanning'

/**
 * ORDERS-V2-0.1 — escaneo de IMEI/serie que funciona fuera de Chrome Android.
 *
 * Ver `barcodeScanning.ts` para el root cause. Acá vive sólo la UI: qué se le
 * muestra al usuario en cada estado y cómo se apaga la cámara.
 *
 * Regla de producto que atraviesa todo el componente: **el ingreso manual
 * nunca deja de estar disponible**. Escanear es un atajo; si falla, el
 * mostrador tiene que poder seguir tipeando el número.
 */

type Phase = 'idle' | 'starting' | 'scanning'

const CAMERA_MESSAGE: Record<CameraFailure, string> = {
  denied: 'No diste permiso de cámara. Habilitalo desde el candado de la barra de direcciones, o escribí el código a mano.',
  'not-found': 'Este dispositivo no tiene cámara disponible. Escribí el código a mano.',
  'in-use': 'Otra aplicación está usando la cámara. Cerrala e intentá de nuevo, o escribí el código a mano.',
  unknown: 'No se pudo iniciar la cámara. Escribí el código a mano.',
}

function unsupportedMessage(capability: ScannerCapability): string {
  if (capability.kind !== 'unsupported') return ''
  return capability.reason === 'insecure-context'
    // Mandar a "revisá el permiso" acá es un callejón: no hay permiso que dar.
    ? 'El escaneo necesita una conexión segura (HTTPS). Escribí el código a mano.'
    : 'Este navegador no permite usar la cámara. Escribí el código a mano.'
}

export interface BarcodeScannerDialogProps {
  open: boolean
  onClose: () => void
  onDetected: (value: string) => void
  /** Etiqueta de lo que se está escaneando, para el encabezado. */
  target?: 'imei' | 'serial' | null
}

export function BarcodeScannerDialog({ open, onClose, onDetected, target = null }: BarcodeScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const engineRef = useRef<ScanEngine | null>(null)
  const frameRef = useRef<number | null>(null)
  const lastDecodeRef = useRef(0)
  /** Una sola entrega por apertura: el rAF sigue vivo un frame más. */
  const deliveredRef = useRef(false)

  const [capability, setCapability] = useState<ScannerCapability | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')

  const stop = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    engineRef.current?.dispose()
    engineRef.current = null
    releaseStream(streamRef.current, videoRef.current)
    streamRef.current = null
    setPhase('idle')
  }, [])

  // La capacidad se mide al abrir, no al montar: el permiso o el dispositivo
  // pueden haber cambiado entre una apertura y la siguiente.
  useEffect(() => {
    if (!open) { stop(); deliveredRef.current = false; setError(''); setCapability(null); return }
    setCapability(detectScannerCapability())
  }, [open, stop])

  // Apagar la cámara al desmontar es obligatorio: sin esto el LED queda
  // encendido y el usuario cree que la app lo está mirando.
  useEffect(() => () => stop(), [stop])

  const start = async () => {
    const current = capability ?? detectScannerCapability()
    if (current.kind === 'unsupported') { setError(unsupportedMessage(current)); return }

    setError('')
    setPhase('starting')

    if (!await hasVideoInput()) {
      setPhase('idle')
      setError(CAMERA_MESSAGE['not-found'])
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
    } catch (cause) {
      setPhase('idle')
      setError(CAMERA_MESSAGE[classifyCameraError(cause)])
      return
    }

    // El diálogo pudo cerrarse mientras se resolvía el permiso.
    if (!videoRef.current) { releaseStream(stream, null); setPhase('idle'); return }

    streamRef.current = stream
    const video = videoRef.current
    video.srcObject = stream

    try {
      await video.play()
      engineRef.current = await createScanEngine(current.kind)
    } catch (cause) {
      stop()
      setError(CAMERA_MESSAGE[classifyCameraError(cause)])
      return
    }

    setPhase('scanning')
    const interval = DECODE_INTERVAL_MS[current.kind]

    const tick = async (now: number) => {
      if (!engineRef.current || !streamRef.current || deliveredRef.current) return
      if (now - lastDecodeRef.current >= interval) {
        lastDecodeRef.current = now
        try {
          const value = await engineRef.current.decode(video)
          if (value && !deliveredRef.current) {
            deliveredRef.current = true
            stop()
            onDetected(value)
            onClose()
            return
          }
        } catch { /* un frame ilegible no es un fallo; el próximo reintenta */ }
      }
      if (!deliveredRef.current) frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
  }

  const unsupported = capability?.kind === 'unsupported'
  const label = target === 'imei' ? 'IMEI' : target === 'serial' ? 'número de serie' : 'identificación'

  return (
    <ResponsiveDialog
      isOpen={open}
      onClose={onClose}
      title={`Escanear ${label}`}
      subtitle="La cámara se usa en vivo; no se guarda ninguna imagen."
      mobilePresentation="fullscreen"
      footer={<AppButton variant="secondary" fullWidth onClick={onClose}>Cerrar</AppButton>}
    >
      <div className="intake-scanner" data-testid="barcode-scanner">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Vista de cámara para escanear"
          data-scanning={phase === 'scanning' ? 'true' : 'false'}
        />

        {phase === 'idle' && !unsupported && (
          <AppButton
            variant="primary"
            size="lg"
            leftIcon={<Camera size={18} />}
            onClick={start}
            data-testid="scanner-start"
          >
            Permitir cámara y escanear
          </AppButton>
        )}

        {phase === 'starting' && (
          <p role="status"><Loader2 className="animate-spin" size={18} /> Pidiendo acceso a la cámara…</p>
        )}

        {phase === 'scanning' && (
          <p role="status" data-testid="scanner-active">
            <ScanLine size={18} /> Apuntá al código de barras o QR…
          </p>
        )}

        {error && <p className="form-error" role="alert" data-testid="scanner-error">{error}</p>}
        {unsupported && (
          <p className="form-error" role="alert" data-testid="scanner-error">{unsupportedMessage(capability)}</p>
        )}

        <p className="form-hint">También podés cerrar y escribir el {label} a mano.</p>
      </div>
    </ResponsiveDialog>
  )
}
