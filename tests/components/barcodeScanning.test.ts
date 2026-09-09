// ─────────────────────────────────────────────────────────────────────────────
// ORDERS-V2-0.1 — el scanner no puede depender de BarcodeDetector.
//
// ROOT CAUSE del bug de producción: la única compuerta era
// `!window.BarcodeDetector`. Esa API no existe en WebKit (Safari iOS y, por
// lo tanto, Chrome iOS), ni en Firefox, ni en Chrome para Windows/Linux.
//
// Medido en el navegador del owner (Chrome 152 / Windows, HTTPS):
//   { hasBarcodeDetector: false, hasGetUserMedia: true }
// La cámara estaba disponible y la app decía "este navegador no ofrece
// escaneo" igual.
//
// Estos tests fijan que la decisión ahora se toma con tres señales separadas
// y que la ausencia de la API nativa degrada a ZXing en vez de rendirse.
// ─────────────────────────────────────────────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAMERA_CONSTRAINTS,
  DECODE_INTERVAL_MS,
  classifyCameraError,
  detectScannerCapability,
  probeVideoInput,
  releaseStream,
} from '../../src/features/order-intake/barcodeScanning'

const original = {
  mediaDevices: navigator.mediaDevices,
  secureContext: window.isSecureContext,
  detector: (globalThis as Record<string, unknown>).BarcodeDetector,
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true })
}
function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true })
}
function setBarcodeDetector(value: unknown) {
  if (value === undefined) delete (globalThis as Record<string, unknown>).BarcodeDetector
  else (globalThis as Record<string, unknown>).BarcodeDetector = value
}

beforeEach(() => {
  setSecureContext(true)
  setMediaDevices({ getUserMedia: vi.fn(), enumerateDevices: vi.fn() })
  setBarcodeDetector(undefined)
})

afterEach(() => {
  setMediaDevices(original.mediaDevices)
  setSecureContext(original.secureContext)
  setBarcodeDetector(original.detector)
})

describe('ORDERS-V2-0.1 · detección de capacidad', () => {
  it('SIN BarcodeDetector pero CON cámara elige el motor de respaldo', () => {
    // Éste es exactamente el navegador del owner. Antes devolvía
    // "no disponible"; ahora escanea.
    expect(detectScannerCapability()).toEqual({ kind: 'fallback' })
  })

  it('CON BarcodeDetector usa el motor nativo', () => {
    setBarcodeDetector(class { detect() { return Promise.resolve([]) } })
    expect(detectScannerCapability()).toEqual({ kind: 'native' })
  })

  it('sin API de cámara no hay escaneo posible, y lo dice como tal', () => {
    setMediaDevices(undefined)
    expect(detectScannerCapability()).toEqual({ kind: 'unsupported', reason: 'no-media-api' })
  })

  it('fuera de HTTPS distingue el contexto inseguro del permiso', () => {
    // `getUserMedia` existe igual pero siempre rechaza. Mandar al usuario a
    // "revisá el permiso" acá es un callejón sin salida.
    setSecureContext(false)
    expect(detectScannerCapability()).toEqual({ kind: 'unsupported', reason: 'insecure-context' })
  })

  it('el motor nativo no se frena; el de respaldo sí', () => {
    // ZXing sobre canvas a 30 fps traba el video en un teléfono de gama baja,
    // que el usuario lee como "el scanner no anda".
    expect(DECODE_INTERVAL_MS.native).toBe(0)
    expect(DECODE_INTERVAL_MS.fallback).toBeGreaterThan(150)
  })
})

describe('ORDERS-V2-0.1 · causas de fallo de cámara', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'not-found'],
    ['OverconstrainedError', 'not-found'],
    ['NotReadableError', 'in-use'],
    ['AbortError', 'in-use'],
  ] as const)('%s → %s', (name, expected) => {
    expect(classifyCameraError({ name })).toBe(expected)
  })

  it('lo desconocido no se disfraza de permiso denegado', () => {
    expect(classifyCameraError(new Error('boom'))).toBe('unknown')
    expect(classifyCameraError(null)).toBe('unknown')
  })

  /**
   * `probeVideoInput` es diagnóstico, NUNCA una compuerta. Reemplazar
   * `!BarcodeDetector` por `!hasVideoInput()` habría sido el mismo bug con
   * otra API: una comprobación indirecta abortando el intento que sí sabe la
   * verdad. Por eso devuelve tres estados y no un booleano — «no sé» tiene
   * que ser expresable.
   */
  it('afirma la ausencia sólo cuando enumeró dispositivos y ninguno es cámara', () => {
    setMediaDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', label: '' }]),
    })
    return expect(probeVideoInput()).resolves.toBe('absent')
  })

  it('una lista VACÍA es «no sé», no «no hay»', async () => {
    // Sin permiso, varios navegadores devuelven la lista vacía aunque la
    // cámara exista. Leer eso como ausencia es justamente el error.
    setMediaDevices({ getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) })
    expect(await probeVideoInput()).toBe('unknown')
  })

  it('sin la API, o si falla, tampoco afirma nada', async () => {
    setMediaDevices({ getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockRejectedValue(new Error('x')) })
    expect(await probeVideoInput()).toBe('unknown')

    setMediaDevices({ getUserMedia: vi.fn() })
    expect(await probeVideoInput()).toBe('unknown')
  })

  it('reconoce la cámara cuando el navegador la lista', async () => {
    setMediaDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'videoinput', label: '' }]),
    })
    expect(await probeVideoInput()).toBe('present')
  })
})

describe('ORDERS-V2-0.1 · apagado de la cámara', () => {
  it('corta cada track Y suelta el elemento de video', () => {
    // Cortar los tracks sin limpiar `srcObject` deja el LED encendido en
    // algunos navegadores: el usuario cree que la app lo sigue mirando.
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream
    const video = { pause: vi.fn(), srcObject: stream } as unknown as HTMLVideoElement

    releaseStream(stream, video)

    expect(stop).toHaveBeenCalledTimes(2)
    expect(video.srcObject).toBeNull()
    expect(video.pause).toHaveBeenCalled()
  })

  it('no explota si el elemento ya se desmontó', () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    expect(() => releaseStream(stream, null)).not.toThrow()
    expect(() => releaseStream(null, null)).not.toThrow()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('pide la cámara trasera sin exigirla', () => {
    // `exact` fallaría en cualquier equipo sin cámara trasera (toda notebook).
    const video = CAMERA_CONSTRAINTS.video as MediaTrackConstraints
    expect(video.facingMode).toEqual({ ideal: 'environment' })
    expect(CAMERA_CONSTRAINTS.audio).toBe(false)
  })
})
