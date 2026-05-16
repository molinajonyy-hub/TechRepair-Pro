/**
 * sounds — sistema de sonido premium de TechRepair Pro.
 *
 * 100% Web Audio API — sin archivos de audio externos, sin latencia de carga.
 * Sonidos ultra-cortos, minimalistas y no intrusivos.
 * Volumen configurable. Mute global persistido en localStorage.
 *
 * Uso:
 *   import { soundSystem } from '../lib/sounds'
 *   soundSystem.play('scan_success')
 *   soundSystem.toggle()
 *
 * Reemplaza el playBeep() local en ComprobanteProModal.
 */

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type SoundEvent =
  | 'scan_success'      // escaneo de producto exitoso
  | 'scan_error'        // código no encontrado
  | 'payment_success'   // cobro completado
  | 'payment_fail'      // error al cobrar
  | 'stock_warning'     // stock bajo / última unidad
  | 'notification'      // notificación nueva
  | 'order_completed'   // orden completada
  | 'add_item'          // agregar ítem al carrito
  | 'remove_item'       // quitar ítem del carrito
  | 'toast_info'        // toast informativo
  | 'modal_open'        // modal / overlay abierto
  | 'success_general'   // acción exitosa genérica

interface Tone {
  freq:    number
  type:    OscillatorType
  vol:     number
  dur:     number     // duración total (s)
  attack:  number     // rampa up (s)
}

interface SoundConfig {
  tones: Tone[]        // permite acordes y secuencias
  gap?:  number        // silencio entre tonos (s)
}

// ─── Definiciones de sonido ───────────────────────────────────────────────────

const S: Record<SoundEvent, SoundConfig> = {
  scan_success: {
    tones: [{ freq: 880, type: 'sine',     vol: 0.10, dur: 0.06, attack: 0.002 }],
  },
  scan_error: {
    tones: [{ freq: 260, type: 'sawtooth', vol: 0.07, dur: 0.16, attack: 0.003 }],
  },
  payment_success: {
    tones: [
      { freq: 523, type: 'sine', vol: 0.10, dur: 0.12, attack: 0.002 },
      { freq: 784, type: 'sine', vol: 0.09, dur: 0.20, attack: 0.002 },
    ],
    gap: 0.08,
  },
  payment_fail: {
    tones: [
      { freq: 330, type: 'triangle', vol: 0.08, dur: 0.10, attack: 0.003 },
      { freq: 220, type: 'triangle', vol: 0.07, dur: 0.16, attack: 0.003 },
    ],
    gap: 0.06,
  },
  stock_warning: {
    tones: [
      { freq: 440, type: 'triangle', vol: 0.07, dur: 0.08, attack: 0.002 },
      { freq: 440, type: 'triangle', vol: 0.07, dur: 0.08, attack: 0.002 },
    ],
    gap: 0.06,
  },
  notification: {
    tones: [
      { freq: 660, type: 'sine', vol: 0.08, dur: 0.07, attack: 0.001 },
      { freq: 880, type: 'sine', vol: 0.07, dur: 0.07, attack: 0.001 },
    ],
    gap: 0.05,
  },
  order_completed: {
    tones: [
      { freq: 523, type: 'sine', vol: 0.10, dur: 0.10, attack: 0.002 },
      { freq: 659, type: 'sine', vol: 0.10, dur: 0.12, attack: 0.002 },
      { freq: 784, type: 'sine', vol: 0.10, dur: 0.20, attack: 0.002 },
    ],
    gap: 0.06,
  },
  add_item: {
    tones: [{ freq: 740, type: 'sine', vol: 0.06, dur: 0.04, attack: 0.001 }],
  },
  remove_item: {
    tones: [{ freq: 400, type: 'sine', vol: 0.05, dur: 0.05, attack: 0.001 }],
  },
  toast_info: {
    tones: [{ freq: 700, type: 'sine', vol: 0.06, dur: 0.06, attack: 0.001 }],
  },
  modal_open: {
    tones: [{ freq: 600, type: 'sine', vol: 0.04, dur: 0.05, attack: 0.001 }],
  },
  success_general: {
    tones: [
      { freq: 587, type: 'sine', vol: 0.09, dur: 0.08, attack: 0.002 },
      { freq: 880, type: 'sine', vol: 0.08, dur: 0.12, attack: 0.002 },
    ],
    gap: 0.07,
  },
}

// ─── Audio Context (lazy, compartido) ────────────────────────────────────────

let _ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    if (!_ctx || _ctx.state === 'closed') {
      _ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    return _ctx
  } catch {
    return null
  }
}

function playTone(ctx: AudioContext, tone: Tone, startAt: number, masterVol: number) {
  const vol = tone.vol * masterVol
  if (vol <= 0) return

  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = tone.type
  osc.frequency.value = tone.freq

  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(vol, startAt + tone.attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.dur)

  osc.start(startAt)
  osc.stop(startAt + tone.dur + 0.01)
}

// ─── Storage keys ────────────────────────────────────────────────────────────

const KEY_ENABLED = 'pos_sounds_enabled'
const KEY_VOLUME  = 'pos_sounds_volume'

// ─── API pública ──────────────────────────────────────────────────────────────

export const soundSystem = {

  isEnabled(): boolean {
    try { return localStorage.getItem(KEY_ENABLED) !== '0' } catch { return true }
  },

  setEnabled(enabled: boolean): void {
    try { localStorage.setItem(KEY_ENABLED, enabled ? '1' : '0') } catch {}
  },

  getVolume(): number {
    try {
      const v = parseFloat(localStorage.getItem(KEY_VOLUME) ?? '1')
      return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
    } catch { return 1 }
  },

  setVolume(v: number): void {
    try { localStorage.setItem(KEY_VOLUME, String(Math.max(0, Math.min(1, v)))) } catch {}
  },

  play(event: SoundEvent): void {
    if (!this.isEnabled()) return

    const ctx = getCtx()
    if (!ctx) return

    const cfg = S[event]
    const vol = this.getVolume()
    const gap = cfg.gap ?? 0

    const doPlay = () => {
      let cursor = ctx.currentTime + 0.003  // tiny lead-in
      for (const tone of cfg.tones) {
        playTone(ctx, tone, cursor, vol)
        cursor += tone.dur + gap
      }
    }

    if (ctx.state === 'suspended') {
      ctx.resume().then(doPlay).catch(() => {})
    } else {
      doPlay()
    }
  },

  /**
   * Toggle mute/unmute. Reproduce una nota corta si se activa.
   * @returns nuevo estado (true = activo)
   */
  toggle(): boolean {
    const next = !this.isEnabled()
    this.setEnabled(next)
    if (next) {
      // Breve confirmación de que el sonido está activo
      setTimeout(() => this.play('notification'), 50)
    }
    return next
  },

  /**
   * Pre-calienta el AudioContext después de la primera interacción del usuario.
   * Llamar en un click handler para evitar el bloqueo de autoplay.
   */
  warmup(): void {
    const ctx = getCtx()
    if (ctx?.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
  },
}
