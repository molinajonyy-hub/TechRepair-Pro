/**
 * ORDERS-V2-0.1 — capacidad de escaneo, medida y no asumida.
 *
 * ROOT CAUSE del bug de producción: `BarcodeScannerDialog` abría con
 *
 *     if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia)
 *         → "Este navegador no ofrece escaneo"
 *
 * `BarcodeDetector` es la Barcode Detection API, y su soporte real es angosto:
 * Chrome Android y Chrome en macOS/ChromeOS. NO existe en WebKit (Safari iOS,
 * y por lo tanto tampoco en Chrome iOS, que es WebKit), ni en Firefox, ni en
 * Chrome para Windows/Linux.
 *
 * Medido en el navegador de producción del owner (Chrome 152 / Windows, HTTPS):
 *
 *     { hasBarcodeDetector: false, hasGetUserMedia: true }
 *
 * Es decir: la cámara estaba disponible y el diálogo se rendía igual, porque
 * la única compuerta era la API que falta. Por eso fallaba en el celular
 * (Safari) y en el escritorio (Windows) a la vez.
 *
 * Este módulo separa tres cosas que antes estaban colapsadas en un `if`:
 *   1. ¿hay contexto seguro y API de cámara?  → sin eso no hay escaneo posible
 *   2. ¿hay una cámara conectada?             → distinto de "permiso denegado"
 *   3. ¿con qué motor se decodifica?          → nativo si está, ZXing si no
 *
 * ZXing se carga con `import()` dinámico: sólo baja al dispositivo que
 * realmente lo necesita, y no entra al bundle de quien tiene la API nativa.
 */

/** Formatos que aparecen en cajas y etiquetas de equipos. */
const FORMATS = ['code_128', 'code_39', 'qr_code', 'ean_13', 'data_matrix'] as const

export type ScannerEngineKind = 'native' | 'fallback'

export type ScannerCapability =
  | { kind: ScannerEngineKind }
  | { kind: 'unsupported'; reason: 'insecure-context' | 'no-media-api' }

/**
 * Por qué no se pudo abrir la cámara. Antes todo esto caía en un solo
 * `catch` con un mensaje único, así que "no diste permiso" y "esta máquina
 * no tiene cámara" se veían igual y ninguno de los dos se podía accionar.
 */
export type CameraFailure = 'denied' | 'not-found' | 'in-use' | 'unknown'

interface NativeDetectorResult { rawValue?: string }
interface NativeDetector { detect(source: CanvasImageSource): Promise<NativeDetectorResult[]> }
type NativeDetectorConstructor = new (options?: { formats?: readonly string[] }) => NativeDetector

function nativeDetectorConstructor(): NativeDetectorConstructor | undefined {
  return (globalThis as unknown as { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector
}

/**
 * `isSecureContext` se chequea explícitamente: `getUserMedia` existe en el
 * objeto pero rechaza siempre fuera de HTTPS, y ese fallo llegaba como
 * "revisá el permiso", que manda al usuario a buscar un permiso inexistente.
 */
export function detectScannerCapability(): ScannerCapability {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { kind: 'unsupported', reason: 'insecure-context' }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { kind: 'unsupported', reason: 'no-media-api' }
  }
  return { kind: nativeDetectorConstructor() ? 'native' : 'fallback' }
}

/**
 * Antes de pedir permiso: ¿hay siquiera una cámara? Sin permiso concedido los
 * `label` vienen vacíos, pero el `kind` está, que es lo único que se necesita.
 * Ante cualquier duda devuelve `true` para no bloquear un equipo que sí puede
 * escanear.
 */
export async function hasVideoInput(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) return true
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.some(device => device.kind === 'videoinput')
  } catch {
    return true
  }
}

export function classifyCameraError(cause: unknown): CameraFailure {
  const name = (cause as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not-found'
  // El equipo tiene cámara pero otra app la tomó (típico en escritorio).
  if (name === 'NotReadableError' || name === 'AbortError') return 'in-use'
  return 'unknown'
}

/** Cámara trasera cuando existe; `ideal` para no fallar en equipos sin ella. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
}

/** Corta el stream Y suelta el elemento: si no, la cámara queda encendida. */
export function releaseStream(stream: MediaStream | null, video: HTMLVideoElement | null): void {
  stream?.getTracks().forEach(track => track.stop())
  if (video) {
    try { video.pause() } catch { /* el elemento puede estar desmontado */ }
    video.srcObject = null
  }
}

export interface ScanEngine {
  /** Un intento sobre el frame actual. `null` = todavía no hay código. */
  decode(video: HTMLVideoElement): Promise<string | null>
  dispose(): void
}

function createNativeEngine(Constructor: NativeDetectorConstructor): ScanEngine {
  const detector = new Constructor({ formats: FORMATS })
  return {
    async decode(video) {
      const results = await detector.detect(video)
      return results[0]?.rawValue?.trim() || null
    },
    dispose() { /* la API nativa no retiene nada */ },
  }
}

/**
 * ZXing decodifica sobre un canvas propio, no sobre el `<video>`, así que se
 * copia el frame. El canvas se reutiliza entre intentos para no reasignar
 * memoria a 30 fps en un teléfono.
 */
async function createFallbackEngine(): Promise<ScanEngine> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ])

  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE,
    BarcodeFormat.EAN_13, BarcodeFormat.DATA_MATRIX,
  ])
  const reader = new BrowserMultiFormatReader(hints)

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })

  return {
    async decode(video) {
      if (!context || !video.videoWidth) return null
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      try {
        // Lanza NotFoundException en cada frame sin código: es el camino
        // normal, no un error que haya que reportar.
        return reader.decodeFromCanvas(canvas)?.getText()?.trim() || null
      } catch {
        return null
      }
    },
    dispose() {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export async function createScanEngine(kind: ScannerEngineKind): Promise<ScanEngine> {
  const Constructor = nativeDetectorConstructor()
  if (kind === 'native' && Constructor) return createNativeEngine(Constructor)
  return createFallbackEngine()
}

/**
 * ZXing sobre canvas es caro. A 30 fps satura un teléfono de gama baja y el
 * video se traba, que se percibe como "el scanner no anda". El motor nativo
 * no necesita freno.
 */
export const DECODE_INTERVAL_MS: Record<ScannerEngineKind, number> = {
  native: 0,
  fallback: 220,
}
