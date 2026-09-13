/**
 * ARCA Self-Service Phase 2A — contrato de pantallas del asistente de configuración inicial.
 *
 * La ÚNICA autoridad del paso es el read model canónico de Phase 1
 * (`get_arca_selfservice_status`, validado por `parseArcaSelfServiceStatus`). Este módulo
 * traduce ese estado a la pantalla que corresponde mostrar; no lee tablas, no llama al
 * backend y no guarda progreso propio. Si el usuario recarga, el asistente vuelve a
 * derivar la pantalla desde el servidor.
 *
 * Módulo puro (sin React ni Supabase) para testearlo aislado. La UI final es Phase 2B.
 */
import type { ArcaSelfServiceStatus } from './arcaStatus'

export const ARCA_SETUP_SCREENS = [
  /** 1. Datos fiscales + "Generar solicitud" (un solo envío: prepare). */
  'datos_fiscales',
  /** 2–3. Descargar el archivo de solicitud y presentarlo en ARCA; luego subir el certificado. */
  'presentar_en_arca',
  /** 5. Verificar la conexión con ARCA (verify: comprueba y activa). */
  'verificar_conexion',
  /** Verificado pero la activación no terminó: reintentar (verify reanuda sin volver a ARCA). */
  'finalizar_activacion',
  /** 6. Listo. */
  'listo',
  /** El plan no incluye ARCA. */
  'no_disponible',
  /** Hay una credencial activa o una renovación: fuera del alcance del asistente inicial. */
  'fuera_de_alcance',
  /** El usuario no puede gestionar ARCA: solo lectura. */
  'solo_lectura',
] as const

export type ArcaSetupScreen = typeof ARCA_SETUP_SCREENS[number]

export interface ArcaSetupWizardView {
  screen: ArcaSetupScreen
  /** Número visible del paso (1..6) o null si la pantalla no es un paso del asistente. */
  stepNumber: number | null
  /** Acciones permitidas en esta pantalla (el servidor las vuelve a validar). */
  actions: ReadonlyArray<'prepare' | 'csr' | 'certificate' | 'verify' | 'cancel'>
}

export const ARCA_SETUP_STEP_LABELS: Readonly<Record<number, string>> = {
  1: 'Datos fiscales',
  2: 'Generar solicitud',
  3: 'Presentarla en ARCA',
  4: 'Cargar certificado',
  5: 'Verificar conexión',
  6: 'Listo',
}

/**
 * Deriva la pantalla del asistente a partir del estado canónico. Fail-closed: cualquier
 * combinación no prevista termina en `fuera_de_alcance`, nunca en una acción de escritura.
 */
export function deriveArcaSetupWizard(status: ArcaSelfServiceStatus | null): ArcaSetupWizardView {
  const view = (screen: ArcaSetupScreen, stepNumber: number | null, actions: ArcaSetupWizardView['actions'] = []) =>
    ({ screen, stepNumber, actions })

  if (!status) return view('fuera_de_alcance', null)
  if (!status.available) return view('no_disponible', null)

  const { setup } = status

  // Configurado y sin configuración en curso: listo (o renovación, que no es de este asistente).
  if (status.configured && setup.state !== 'in_progress') return view('listo', 6)

  if (!status.can_manage) return view('solo_lectura', null)

  if (setup.state === 'in_progress') {
    if (setup.kind !== 'initial') return view('fuera_de_alcance', null)
    switch (setup.step) {
      case 'certificate':
        return view('presentar_en_arca', 3, ['csr', 'certificate', 'cancel'])
      case 'verification':
        return view('verificar_conexion', 5, ['csr', 'certificate', 'verify', 'cancel'])
      case 'activation':
        return view('finalizar_activacion', 5, ['verify', 'cancel'])
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
