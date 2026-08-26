import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import { AppButton, ResponsiveDialog } from '../../ui'

type DetectorResult = { rawValue?: string }
type Detector = { detect(source: CanvasImageSource): Promise<DetectorResult[]> }
type DetectorConstructor = new (options?: { formats?: string[] }) => Detector

export function BarcodeScannerDialog({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (value: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState('')

  const stop = () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null; frameRef.current = null; setStarted(false)
  }
  useEffect(() => () => stop(), [])
  useEffect(() => { if (!open) stop() }, [open])

  const start = async () => {
    setError('')
    const BarcodeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
    if (!BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
      setError('Este navegador no ofrece escaneo. Podés ingresar el código manualmente.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      streamRef.current = stream
      if (!videoRef.current) return
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setStarted(true)
      const detector = new BarcodeDetector({ formats: ['code_128','code_39','qr_code','ean_13'] })
      const scan = async () => {
        if (!videoRef.current || !streamRef.current) return
        try {
          const results = await detector.detect(videoRef.current)
          const value = results[0]?.rawValue?.trim()
          if (value) { stop(); onDetected(value); onClose(); return }
        } catch { /* el siguiente frame vuelve a intentar; nunca registra la imagen */ }
        frameRef.current = requestAnimationFrame(scan)
      }
      frameRef.current = requestAnimationFrame(scan)
    } catch {
      stop(); setError('No se pudo usar la cámara. Revisá el permiso o ingresá el código manualmente.')
    }
  }

  return <ResponsiveDialog isOpen={open} onClose={onClose} title="Escanear identificación" subtitle="La cámara se usa en vivo; no se guarda ninguna imagen." mobilePresentation="fullscreen"
    footer={<AppButton variant="secondary" fullWidth onClick={onClose}>Cerrar</AppButton>}>
    <div className="intake-scanner">
      <video ref={videoRef} muted playsInline aria-label="Vista de cámara para escanear" />
      {!started && <AppButton variant="primary" size="lg" leftIcon={<Camera size={18}/>} onClick={start}>Permitir cámara y escanear</AppButton>}
      {started && <p><Loader2 className="animate-spin" size={18}/> Buscando código…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="form-hint">También podés cerrar y escribir IMEI o número de serie.</p>
    </div>
  </ResponsiveDialog>
}
