/**
 * ARCA Self-Service Phase 2A — contrato de pantallas del asistente de configuración inicial.
 *
 * La ÚNICA autoridad del paso es el read model canónico de Phase 1
 * (`get_arca_selfservice_status`, validado por `parseArcaSelfServiceStatus`). Este módulo
 * traduce ese estado a la pantalla que corresponde mostrar; no lee tablas, no llama al
 * backend y no guarda progreso propio. Si el usuario recarga, el asistente vuelve a
 * derivar la pantalla desde el servidor.
 *
 * Espera de verificación (`setup.verification_hold`): la decide y la hace cumplir la base. La
 * pantalla sólo la explica y deja de ofrecer "Verificar"; `retryNotBefore` sirve para volver a
 * pedir el estado, nunca como permiso: el servidor rechaza cualquier LoginCms anticipado.
 *
 * Módulo puro (sin React ni Supabase) para testearlo aislado. La UI final es Phase 2B.
 */
import type { ArcaSelfServiceStatus, ArcaVerificationHold } from './arcaStatus'

export const ARCA_SETUP_SCREENS = [
  /** 1. Datos fiscales + "Generar solicitud" (un solo envío: prepare). */
  'datos_fiscales',
  /** 2–3. Descargar el archivo de solicitud y presentarlo en ARCA; luego subir el certificado. */
  'presentar_en_arca',
  /** 5. Verificar la conexión con ARCA (verify: comprueba y activa), o esperar si la base lo indica. */
  'verificar_conexion',
  /** Verificado pero la activación no terminó: reintentar (verify reanuda sin volver a ARCA). */
  'finalizar_activacion',
  /** 6. Listo: configurado, conectado y sin acciones pendientes. */
  'listo',
  /** El plan no incluye ARCA. */
  'no_disponible',
  /** Credencial activa con algo pendiente, renovación, o estado no previsto: lo resuelve la tarjeta de Phase 1. */
  'fuera_de_alcance',
  /** El usuario no puede gestionar ARCA: solo lectura. */
  'solo_lectura',
] as const

export type ArcaSetupScreen = typeof ARCA_SETUP_SCREENS[number]
export type ArcaSetupAction = 'prepare' | 'csr' | 'certificate' | 'verify' | 'cancel'

export interface ArcaSetupWizardView {
  screen: ArcaSetupScreen
  /** Número visible del paso (1..6) o null si la pantalla no es un paso del asistente. */
  stepNumber: number | null
  /** Acciones permitidas en esta pantalla (el servidor las vuelve a validar). */
  actions: ReadonlyArray<ArcaSetupAction>
  /** Espera activa decidida por la base (null sin espera). */
  hold: { reason: ArcaVerificationHold; retryNotBefore: string } | null
  /**
   * Cancelar requiere confirmación explícita: ARCA pudo haber emitido un acceso que cancelar acá
   * NO revoca, y volver a configurar el mismo equipo puede requerir esperar hasta ~12 h.
   */
  confirmCancel: boolean
}

export const ARCA_SETUP_STEP_LABELS: Readonly<Record<number, string>> = {
  1: 'Datos fiscales',
  2: 'Generar solicitud',
  3: 'Presentarla en ARCA',
  4: 'Cargar certificado',
  5: 'Verificar conexión',
  6: 'Listo',
}

/** Textos de la espera para Phase 2B (sin WSAA, tickets ni detalles técnicos). */
export const ARCA_SETUP_HOLD_COPY: Readonly<Record<ArcaVerificationHold, string>> = {
  in_progress: 'Estamos verificando la conexión con ARCA. Esto puede tardar unos minutos.',
  result_unknown: 'ARCA puede haber procesado la verificación. Por seguridad vamos a esperar antes de repetirla.',
  ticket_active: 'ARCA ya habilitó un acceso reciente para este equipo. Por seguridad vamos a esperar a que venza antes de volver a verificar.',
  verification_expired: 'La verificación anterior venció antes de terminar la activación. Vamos a esperar a que ARCA la dé por vencida para verificar de nuevo, sin volver a pedir el certificado.',
  cooldown: 'Esperá un momento antes de volver a intentar.',
}

/**
 * Deriva la pantalla del asistente a partir del estado canónico. Fail-closed: cualquier
 * combinación no prevista termina en `fuera_de_alcance`, nunca en una acción de escritura.
 */
export function deriveArcaSetupWizard(status: ArcaSelfServiceStatus | null): ArcaSetupWizardView {
  const view = (screen: ArcaSetupScreen, stepNumber: number | null, actions: ReadonlyArray<ArcaSetupAction> = [],
    hold: ArcaSetupWizardView['hold'] = null, confirmCancel = false): ArcaSetupWizardView =>
    ({ screen, stepNumber, actions, hold, confirmCancel })

  if (!status) return view('fuera_de_alcance', null)
  if (!status.available) return view('no_disponible', null)

  const { setup } = status

  if (status.configured && setup.state !== 'in_progress') {
    // "Listo" sólo con conexión verificada y nada pendiente; lo demás lo muestra la tarjeta de Phase 1.
    return status.status === 'connected' && status.next_action === 'none'
      ? view('listo', 6)
      : view('fuera_de_alcance', null)
  }

  if (!status.can_manage) return view('solo_lectura', null)

  if (setup.state === 'in_progress') {
    if (setup.kind !== 'initial') return view('fuera_de_alcance', null)
    const hold = setup.verification_hold !== null && setup.retry_not_before !== null
      ? { reason: setup.verification_hold, retryNotBefore: setup.retry_not_before }
      : null
    switch (setup.step) {
      case 'certificate':
        // Una espera heredada de una configuración cancelada del mismo equipo no impide subir el certificado.
        return view('presentar_en_arca', 3, ['csr', 'certificate', 'cancel'], hold, hold !== null && hold.reason !== 'cooldown')
      case 'verification':
        if (hold === null) return view('verificar_conexion', 5, ['csr', 'certificate', 'verify', 'cancel'])
        // Un intento en vuelo puede estar por registrarse: ni verificar, ni reemplazar, ni cancelar.
        if (hold.reason === 'in_progress') return view('verificar_conexion', 5, ['csr'], hold)
        return view('verificar_conexion', 5, ['csr', 'certificate', 'cancel'], hold, hold.reason !== 'cooldown')
      case 'activation':
        // Hay un acceso de ARCA verificado y vigente: cancelar lo descarta localmente.
        return view('finalizar_activacion', 5, ['verify', 'cancel'], null, true)
      default:
        return view('fuera_de_alcance', null)
    }
  }

  // Sin credencial y sin configuración en curso: empezar desde los datos fiscales.
  if (!status.configured && setup.state === 'not_started' && status.next_action === 'start_setup') {
    // Un certificado o una clave sueltos (atención) no se pisan desde el asistente inicial.
    if (status.certificate.present || status.credential.active) return view('fuera_de_alcance', null)
    return view('datos_fiscales', 1, ['prepare'])
  }

  return view('fuera_de_alcance', null)
}

// ─── Phase 2B — entrada de la pestaña, esperas y relectura ──────────────────

export type ArcaSetupEntryKind =
  /** Primera lectura en curso. */
  | 'loading'
  /** No se pudo leer el estado: nunca se inventa uno. */
  | 'unreadable'
  /** El plan no incluye ARCA: no se llama al asistente. */
  | 'unavailable'
  /** Sin permiso para configurar: aviso, sin acciones. */
  | 'read_only'
  /** Sin configurar: "Conectar ARCA". */
  | 'start'
  /** Configuración inicial en curso: "Continuar configuración" (con o sin espera). */
  | 'resume'
  /** Conectado y sin pendientes. */
  | 'connected'
  /** Cualquier otro estado (atención, renovación, pendiente): lo explica la tarjeta de Phase 1. */
  | 'status_only'

export interface ArcaSetupEntry {
  kind: ArcaSetupEntryKind
  view: ArcaSetupWizardView | null
  /** Texto del botón principal, null si no hay acción de asistente. */
  cta: string | null
}

export function deriveArcaSetupEntry(
  status: ArcaSelfServiceStatus | null,
  read: { loading: boolean; failed: boolean },
): ArcaSetupEntry {
  if (status === null) {
    return { kind: read.loading && !read.failed ? 'loading' : 'unreadable', view: null, cta: null }
  }
  const view = deriveArcaSetupWizard(status)
  switch (view.screen) {
    case 'no_disponible': return { kind: 'unavailable', view, cta: null }
    case 'solo_lectura': return { kind: 'read_only', view, cta: null }
    case 'datos_fiscales': return { kind: 'start', view, cta: 'Conectar ARCA' }
    case 'presentar_en_arca':
    case 'verificar_conexion':
    case 'finalizar_activacion': return { kind: 'resume', view, cta: 'Continuar configuración' }
    case 'listo': return { kind: 'connected', view, cta: null }
    default: return { kind: 'status_only', view, cta: null }
  }
}

/** Sub-pantalla visual del paso "presentar en ARCA": sólo navegación en memoria, no progreso. */
export type ArcaCertificateStage = 'present' | 'upload'

/** Número visible del paso (1..6) combinando la pantalla del servidor con la sub-pantalla local. */
export function arcaSetupVisibleStep(view: ArcaSetupWizardView, stage: ArcaCertificateStage): number | null {
  if (view.screen === 'presentar_en_arca') return stage === 'upload' ? 4 : 3
  return view.stepNumber
}

export const ARCA_SETUP_TOTAL_STEPS = 6

const AR_TZ = 'America/Argentina/Buenos_Aires'

export interface ArcaHoldCountdown {
  /** Segundos que faltan (0 si ya pasó). Sólo presentación. */
  remainingSeconds: number
  /** "12 h 5 min", "3 min", "45 s" o "unos segundos". */
  remainingLabel: string
  /** Hora local de Argentina en la que termina la espera ("21:35", o "15/09 21:35" si no es hoy). */
  untilLabel: string
}

/**
 * Cuenta regresiva de presentación. NUNCA habilita una acción: cuando llega a cero la pantalla
 * vuelve a leer el estado y es la base la que decide si la espera terminó.
 */
export function arcaHoldCountdown(retryNotBefore: string, nowMs: number): ArcaHoldCountdown {
  const target = Date.parse(retryNotBefore)
  const remainingSeconds = Number.isNaN(target) ? 0 : Math.max(0, Math.ceil((target - nowMs) / 1000))
  let remainingLabel: string
  if (remainingSeconds <= 5) remainingLabel = 'unos segundos'
  else if (remainingSeconds < 60) remainingLabel = `${remainingSeconds} s`
  else {
    const totalMinutes = Math.ceil(remainingSeconds / 60)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    remainingLabel = hours === 0 ? `${minutes} min` : minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
  }
  let untilLabel = '—'
  if (!Number.isNaN(target)) {
    // formatToParts + relleno explícito: algunos ICU ignoran '2-digit' en el mes para es-AR.
    const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('es-AR', {
      timeZone: AR_TZ, day: 'numeric', month: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value.padStart(2, '0')]))
    const t = parts(target)
    const n = parts(nowMs)
    const time = `${t.hour}:${t.minute}`
    untilLabel = t.day === n.day && t.month === n.month ? time : `${t.day}/${t.month} ${time}`
  }
  return { remainingSeconds, remainingLabel, untilLabel }
}

/** Mientras hay un intento en vuelo, la espera se revisa seguido (otro dispositivo pudo iniciarlo). */
export const ARCA_IN_PROGRESS_POLL_MS = 10_000
/** Margen después de `retry_not_before` para no releer justo antes de que la base la libere. */
export const ARCA_HOLD_REFRESH_GRACE_MS = 2_000
/** Tope de un temporizador: una espera de horas se relee cada tanto (lectura barata, sin ARCA). */
export const ARCA_HOLD_REFRESH_MAX_MS = 15 * 60_000

/**
 * Cuándo volver a leer el estado por una espera. null = no hay espera (la relectura queda a cargo
 * de foco/visibilidad/red/mutaciones). Nunca devuelve menos de 1 s.
 */
export function nextArcaStatusRefreshMs(status: ArcaSelfServiceStatus | null, nowMs: number): number | null {
  const hold = status?.setup.verification_hold ?? null
  const retryNotBefore = status?.setup.retry_not_before ?? null
  if (hold === null || retryNotBefore === null) return null
  if (hold === 'in_progress') return ARCA_IN_PROGRESS_POLL_MS
  const target = Date.parse(retryNotBefore)
  if (Number.isNaN(target)) return ARCA_IN_PROGRESS_POLL_MS
  return Math.min(ARCA_HOLD_REFRESH_MAX_MS, Math.max(1_000, target - nowMs + ARCA_HOLD_REFRESH_GRACE_MS))
}

export interface ArcaCancelCopy {
  title: string
  message: string
  confirmLabel: string
  /** true → tono de advertencia fuerte. */
  strong: boolean
}

/**
 * Texto de la confirmación de cancelar. Honesto: cancelar NO revoca nada en ARCA y no levanta
 * una espera; volver a empezar con el mismo equipo la hereda.
 */
export function arcaCancelCopy(view: ArcaSetupWizardView): ArcaCancelCopy {
  if (view.screen === 'finalizar_activacion') {
    return {
      strong: true, title: '¿Descartar la conexión verificada?', confirmLabel: 'Sí, descartar',
      message: 'ARCA ya habilitó el acceso para este equipo. Si cancelás, se descarta la verificación y TechRepair Pro no queda conectado. '
        + 'Cancelar no revoca nada en ARCA: volver a configurar este mismo equipo puede requerir esperar varias horas.',
    }
  }
  if (view.confirmCancel) {
    return {
      strong: true, title: '¿Cancelar la configuración?', confirmLabel: 'Sí, cancelar',
      message: 'Cancelar no revoca nada en ARCA y no termina la espera actual: si volvés a configurar este mismo equipo, '
        + 'la espera se mantiene. El archivo y el certificado de esta configuración se descartan.',
    }
  }
  return {
    strong: false, title: '¿Cancelar la configuración?', confirmLabel: 'Sí, cancelar',
    message: 'Se descartan el archivo para ARCA y el certificado de esta configuración. Para volver a conectar vas a tener que empezar de nuevo y presentar un archivo nuevo en ARCA.',
  }
}
