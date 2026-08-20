/**
 * whatsappCompanion — cliente del TechRepair WhatsApp Companion.
 *
 * El Companion es una extensión de Chrome (MV3) que administra UNA pestaña de
 * WhatsApp Web. Vive en `tools/whatsapp-companion/`, se publica aparte, y este
 * módulo es lo ÚNICO que TechRepair usa para hablarle.
 *
 * ┌── POR QUÉ HACE FALTA UNA EXTENSIÓN ───────────────────────────────────────┐
 * │ MEDIDO en Chromium real. `web.whatsapp.com` manda                         │
 * │ `Cross-Origin-Opener-Policy: same-origin`, así que al navegar un popup    │
 * │ hacia allá el `WindowProxy` queda severed y `closed` pasa a `true` con la │
 * │ pestaña ABIERTA. Fallan las tres vías: referencia con opener anulado, con │
 * │ opener conservado, y target por nombre. La PWA tampoco sirve: su único    │
 * │ `launchQueue.setConsumer` parsea CALL LINKS, así que descarta el deep     │
 * │ link `/send?phone=&text=`.                                                │
 * │                                                                           │
 * │ Con el Companion el problema desaparece porque la navegación la ejecuta   │
 * │ Chrome vía Tabs API: no hay `WindowProxy` cross-origin de por medio.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * QUÉ SE LE MANDA: `{ type, phone, text }`. NADA MÁS. Ni la URL, ni
 * `business_id`, ni datos del cliente, ni el id de la plantilla. El destino lo
 * construye la extensión con host y path constantes suyos: si la URL viniera de
 * acá, el Companion sería un open-redirect con permisos de pestaña.
 *
 * FAIL-CLOSED: sin extension ID configurado, o con uno que no tiene la forma de
 * un ID de Chrome, este módulo se declara no disponible y no manda nada.
 */
import { normalizeWhatsAppPhone } from './whatsappFormat.ts'
import { extensionIdConfigurado, installUrlConfigurada } from '../config/whatsappCompanionEnv.ts'

/** Tipos de mensaje del contrato. Tienen que coincidir con el service worker. */
export const COMPANION_TIPO_APERTURA = 'OPEN_WHATSAPP_WEB' as const
export const COMPANION_TIPO_PING = 'PING' as const

/**
 * El descubrimiento no puede colgar la UI. Chrome resuelve el callback en
 * milisegundos —haya extensión o no—, así que este techo sólo cubre el caso
 * patológico de un service worker despertando lento.
 */
export const TIMEOUT_COMPANION_MS = 1200

export type MotivoNoDisponible =
  /** No hay `VITE_WHATSAPP_COMPANION_EXTENSION_ID`, o no tiene forma de ID. */
  | 'sin_configurar'
  /** El navegador no expone `chrome.runtime.sendMessage` (Firefox, Safari…). */
  | 'sin_navegador'
  /** Hay ID y hay API, pero nadie respondió: la extensión no está instalada. */
  | 'sin_respuesta'

export type DisponibilidadCompanion =
  | { disponible: true; version: string }
  | { disponible: false; motivo: MotivoNoDisponible }

export type AperturaCompanion =
  | { ok: true; accion: 'reused' | 'created' }
  | { ok: false; code: string; motivo?: MotivoNoDisponible }

/**
 * Transporte inyectable. Devuelve la respuesta de la extensión, o `null` si no
 * hubo ninguna (no instalada, timeout, error de runtime).
 *
 * Los tests inyectan el suyo. El comportamiento real de la extensión —adoptar,
 * reutilizar y crear pestañas— NO se testea con mocks: lo cubre
 * `tools/whatsapp-companion/probe.mjs` en un Chromium de verdad.
 */
export type EnviarAlCompanion = (extensionId: string, mensaje: unknown) => Promise<unknown | null>

export interface OpcionesCompanion {
  /**
   * Por defecto sale de la configuración. Se puede inyectar para testear las
   * reglas sin depender de `import.meta.env`, que es propio de cada módulo y no
   * se puede sustituir desde afuera.
   */
  extensionId?: string | null
  /** Transporte. Por defecto, `chrome.runtime.sendMessage`. */
  enviar?: EnviarAlCompanion
}

// ─── Configuración ───────────────────────────────────────────────────────────
//
// La lectura y validación del entorno vive en `config/whatsappCompanionEnv`:
// un solo lugar, y se puede sustituir en los tests (a `import.meta.env` de un
// módulo no se le puede escribir desde afuera — Vite lo fija en el build).

/** ID de la extensión publicada, o `null` si no está configurada. */
export function companionExtensionId(): string | null {
  return extensionIdConfigurado()
}

/** URL de instalación, o `null` mientras la extensión no esté publicada. */
export function companionInstallUrl(): string | null {
  return installUrlConfigurada()
}

// ─── Transporte real ─────────────────────────────────────────────────────────

interface RuntimeMinimo {
  sendMessage?: (id: string, mensaje: unknown, cb: (respuesta: unknown) => void) => void
  lastError?: { message?: string }
}

function runtimeDelNavegador(): RuntimeMinimo | null {
  const g = globalThis as { chrome?: { runtime?: RuntimeMinimo } }
  const runtime = g.chrome?.runtime
  return runtime && typeof runtime.sendMessage === 'function' ? runtime : null
}

/**
 * Manda el mensaje y resuelve `null` ante cualquier fallo.
 *
 * `chrome.runtime.lastError` SE LEE siempre dentro del callback: si no se lee,
 * Chrome escribe "Unchecked runtime.lastError" en la consola de cada usuario
 * que no tenga la extensión. Ése es el ruido que el contrato pide no generar.
 */
const enviarPorChrome: EnviarAlCompanion = (extensionId, mensaje) =>
  new Promise((resolve) => {
    const runtime = runtimeDelNavegador()
    if (!runtime?.sendMessage) { resolve(null); return }

    let resuelto = false
    const terminar = (valor: unknown | null) => {
      if (resuelto) return
      resuelto = true
      resolve(valor)
    }
    const reloj = setTimeout(() => terminar(null), TIMEOUT_COMPANION_MS)

    try {
      runtime.sendMessage(extensionId, mensaje, (respuesta) => {
        const error = runtime.lastError   // leerlo es lo que silencia la consola
        clearTimeout(reloj)
        terminar(error ? null : respuesta ?? null)
      })
    } catch {
      clearTimeout(reloj)
      terminar(null)
    }
  })

// ─── Descubrimiento ──────────────────────────────────────────────────────────

/**
 * ¿Está el Companion? Se le pregunta directamente por ID.
 *
 * Esto NO es una heurística de "app instalada" (esas no existen y las que se
 * parecen dan falsos negativos): es comunicación con una extensión conocida.
 * Si contesta, está; si no, no está.
 */
export async function consultarCompanion(
  opciones: OpcionesCompanion = {},
): Promise<DisponibilidadCompanion> {
  const { extensionId = extensionIdConfigurado(), enviar = enviarPorChrome } = opciones
  if (!extensionId) return { disponible: false, motivo: 'sin_configurar' }
  if (enviar === enviarPorChrome && !runtimeDelNavegador()) {
    return { disponible: false, motivo: 'sin_navegador' }
  }

  const respuesta = await enviar(extensionId, { type: COMPANION_TIPO_PING })
  const r = respuesta as { ok?: unknown; version?: unknown } | null
  // `=== true`, no truthy: un `ok: 'sí'` de cualquier cosa que conteste no
  // alcanza para dar por instalada una extensión.
  if (r?.ok !== true) return { disponible: false, motivo: 'sin_respuesta' }

  return { disponible: true, version: typeof r.version === 'string' ? r.version : 'desconocida' }
}

// ─── Apertura ────────────────────────────────────────────────────────────────

/**
 * Le pide al Companion que abra el chat con el mensaje ya preparado.
 *
 * El teléfono se normaliza acá con el helper canónico del proyecto y viaja en
 * dígitos: la extensión lo revalida contra `/^[0-9]{8,15}$/` y rechaza
 * cualquier cosa que se le parezca a una URL o a un esquema.
 */
export async function abrirEnCompanion(
  phone: string | null | undefined,
  message: string,
  opciones: OpcionesCompanion = {},
): Promise<AperturaCompanion> {
  const { extensionId = extensionIdConfigurado(), enviar = enviarPorChrome } = opciones
  if (!extensionId) return { ok: false, code: 'NO_CONFIGURADO', motivo: 'sin_configurar' }

  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) return { ok: false, code: 'BAD_PHONE' }
  if (!message.trim()) return { ok: false, code: 'BAD_TEXT' }

  // EXACTAMENTE tres claves. Ni `url`, ni `business_id`, ni datos del cliente.
  const payload = {
    type: COMPANION_TIPO_APERTURA,
    phone: telefono.normalized,
    text: message,
  }

  const respuesta = await enviar(extensionId, payload)
  const r = respuesta as { ok?: unknown; action?: unknown; code?: unknown } | null
  if (!r) return { ok: false, code: 'SIN_RESPUESTA', motivo: 'sin_respuesta' }
  if (r.ok !== true) return { ok: false, code: typeof r.code === 'string' ? r.code : 'ERROR' }

  return { ok: true, accion: r.action === 'created' ? 'created' : 'reused' }
}
