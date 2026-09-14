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
