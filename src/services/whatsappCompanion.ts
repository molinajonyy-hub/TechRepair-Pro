/**
 * whatsappCompanion — cliente del TechRepair Companion.
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
 * TRES ESTADOS, NO DOS. La extensión puede estar instalada y aun así no tener
 * acceso a WhatsApp Web: Chrome permite dejar el acceso al sitio en «Al hacer
 * clic». Ese caso necesita un mensaje propio —se arregla en dos clics— y
 * confundirlo con «no instalada» mandaría a la persona a instalar algo que ya
 * tiene.
 *
 * FAIL-CLOSED: sin extension ID configurado, o con uno que no tiene la forma de
 * un ID de Chrome, este módulo se declara ausente y no manda nada.
 */
import { normalizeWhatsAppPhone } from './whatsappFormat.ts'
import { extensionIdConfigurado, installUrlConfigurada } from '../config/whatsappCompanionEnv.ts'

/** Tipos de mensaje del contrato. Tienen que coincidir con el service worker. */
export const COMPANION_TIPO_APERTURA = 'OPEN_WHATSAPP_WEB' as const
export const COMPANION_TIPO_PING = 'PING' as const

/**
 * Presupuestos de tiempo, elegidos por MEDICIÓN y no por intuición.
 *
 * Lo medido en Chromium real, con la extensión cargada:
 *   · extensión AUSENTE      → `lastError` en ~1 ms. No espera el timeout.
 *   · PING con worker recién arrancado (cold) → 78 ms.
 *   · PING con worker caliente → 1-2 ms.
 *
 * O sea que el timeout NO es el mecanismo por el que se detecta una ausencia:
 * eso lo resuelve `lastError`, instantáneo. El timeout sólo cubre el caso de un
 * service worker MV3 que Chrome terminó por inactividad y tiene que despertar,
 * que es un camino que NO se pudo reproducir bajo automatización (el worker
 * sobrevivió 40 s de inactividad con el navegador instrumentado). Por eso el
 * presupuesto lleva holgura sobre los 78 ms medidos, y por eso hay UN reintento.
 *
 * El valor anterior era 1200 ms sin reintento: alcanzaba de sobra para todo lo
 * medido, pero un solo tropiezo hacía que la persona viera «no está instalada»
 * teniendo la extensión. Ese error es caro y silencioso.
 */
export const TIMEOUT_DESCUBRIMIENTO_MS = 2500
export const REINTENTOS_DESCUBRIMIENTO = 1

/** La apertura tiene un clic detrás: puede esperar más, y encima navega pestañas. */
export const TIMEOUT_APERTURA_MS = 5000

export type MotivoAusencia =
  /** No hay `VITE_WHATSAPP_COMPANION_EXTENSION_ID`, o no tiene forma de ID. */
  | 'sin_configurar'
  /** El navegador no expone `chrome.runtime.sendMessage` (Firefox, Safari…). */
  | 'sin_navegador'
  /** Chrome contestó `lastError`: no hay nadie con ese ID. Es concluyente. */
  | 'sin_extension'

/**
 * Estado del Companion.
 *
 * `indeterminado` NO es lo mismo que `ausente`: significa que no contestó a
 * tiempo, que es distinto de que no esté. La UI lo trata con optimismo y deja
 * que el OPEN —que tiene un clic real detrás— sea la autoridad final.
 */
export type EstadoCompanion =
  | { estado: 'disponible'; version: string }
  | { estado: 'sin_acceso'; version: string }
  | { estado: 'ausente'; motivo: MotivoAusencia }
  | { estado: 'indeterminado' }

export type AperturaCompanion =
  | { ok: true; accion: 'reused' | 'created' }
  | { ok: false; code: string; estado: EstadoCompanion['estado'] }

/**
 * Resultado del transporte. Distingue las tres cosas que hay que distinguir:
 * contestó, no existe, o no llegó a tiempo. Colapsarlas en `null` era lo que
 * hacía imposible tratar distinto una ausencia real de una demora.
 */
export type ResultadoTransporte =
  | { tipo: 'respuesta'; datos: unknown }
  | { tipo: 'sin_extension' }
  | { tipo: 'timeout' }

/**
 * Transporte inyectable. Los tests inyectan el suyo.
 *
 * El comportamiento real de la extensión —adoptar, reutilizar y crear pestañas—
 * NO se testea con mocks: lo cubre `tools/whatsapp-companion/probe.mjs` en un
 * Chromium de verdad, cargando el ZIP que se publica.
 */
export type EnviarAlCompanion = (
  extensionId: string,
  mensaje: unknown,
  timeoutMs: number,
) => Promise<ResultadoTransporte>

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
 * `chrome.runtime.lastError` SE LEE siempre dentro del callback: si no se lee,
 * Chrome escribe "Unchecked runtime.lastError" en la consola de cada usuario
 * que no tenga la extensión. Ése es el ruido que el contrato pide no generar.
 *
 * Y además se USA: su presencia es la señal concluyente de que no hay nadie con
 * ese ID, que es lo que permite responder al instante en vez de esperar.
 */
const enviarPorChrome: EnviarAlCompanion = (extensionId, mensaje, timeoutMs) =>
  new Promise((resolve) => {
    const runtime = runtimeDelNavegador()
    if (!runtime?.sendMessage) { resolve({ tipo: 'timeout' }); return }

    let resuelto = false
    const terminar = (r: ResultadoTransporte) => {
      if (resuelto) return
      resuelto = true
      resolve(r)
    }
    const reloj = setTimeout(() => terminar({ tipo: 'timeout' }), timeoutMs)

    try {
      runtime.sendMessage(extensionId, mensaje, (respuesta) => {
        const error = runtime.lastError   // leerlo es lo que silencia la consola
        clearTimeout(reloj)
        if (error) { terminar({ tipo: 'sin_extension' }); return }
        terminar({ tipo: 'respuesta', datos: respuesta ?? null })
      })
    } catch {
      clearTimeout(reloj)
      terminar({ tipo: 'sin_extension' })
    }
  })

// ─── Descubrimiento ──────────────────────────────────────────────────────────

/** Interpreta la respuesta del PING. `=== true`, nunca truthy. */
function leerPing(datos: unknown): EstadoCompanion | null {
  const r = datos as { ok?: unknown; version?: unknown; hostAccess?: unknown } | null
  if (r?.ok !== true) return null
  const version = typeof r.version === 'string' ? r.version : 'desconocida'
  // `hostAccess === false` es el caso nuevo. Si la extensión es vieja y no lo
  // informa, se asume que sí lo tiene: es el comportamiento previo, y el OPEN
  // va a devolver HOST_ACCESS_REQUIRED si no fuera cierto.
  return r.hostAccess === false
    ? { estado: 'sin_acceso', version }
    : { estado: 'disponible', version }
}

/**
 * ¿Está el Companion, y puede trabajar?
 *
 * Esto NO es una heurística de "app instalada" (esas no existen y las que se
 * parecen dan falsos negativos): es comunicación con una extensión conocida.
 *
 * Un timeout NO se reporta como ausencia. Se reintenta una vez y, si tampoco,
 * se devuelve `indeterminado`: no se pudo saber. Decir «no está instalada»
 * porque un service worker tardó en despertar es un error caro.
 */
export async function consultarCompanion(
  opciones: OpcionesCompanion = {},
): Promise<EstadoCompanion> {
  const { extensionId = extensionIdConfigurado(), enviar = enviarPorChrome } = opciones
  if (!extensionId) return { estado: 'ausente', motivo: 'sin_configurar' }
  if (enviar === enviarPorChrome && !runtimeDelNavegador()) {
    return { estado: 'ausente', motivo: 'sin_navegador' }
  }

  for (let intento = 0; intento <= REINTENTOS_DESCUBRIMIENTO; intento++) {
    const r = await enviar(extensionId, { type: COMPANION_TIPO_PING }, TIMEOUT_DESCUBRIMIENTO_MS)

    // Concluyente: no hay nadie con ese ID. No tiene sentido reintentar.
    if (r.tipo === 'sin_extension') return { estado: 'ausente', motivo: 'sin_extension' }

    if (r.tipo === 'respuesta') {
      const estado = leerPing(r.datos)
      // Contestó algo que no es el contrato: no es la extensión que esperamos.
      return estado ?? { estado: 'ausente', motivo: 'sin_extension' }
    }
    // timeout → se reintenta mientras queden intentos
  }

  return { estado: 'indeterminado' }
}

// ─── Apertura ────────────────────────────────────────────────────────────────

/**
 * Le pide al Companion que abra el chat con el mensaje ya preparado.
 *
 * El teléfono se normaliza acá con el helper canónico del proyecto y viaja en
 * dígitos: la extensión lo revalida contra `/^[0-9]{8,15}$/` y rechaza
 * cualquier cosa que se le parezca a una URL o a un esquema.
 *
 * ESTA LLAMADA ES LA AUTORIDAD FINAL. Tiene un clic real detrás, así que su
 * resultado manda sobre lo que haya dicho el descubrimiento: si el PING dio un
 * falso negativo por demora y esto responde `ok`, el Companion está operativo.
 * Por eso el error devuelve además el `estado` que corresponde, para que la UI
 * se corrija sola en vez de quedar pegada a una conclusión vieja.
 */
export async function abrirEnCompanion(
  phone: string | null | undefined,
  message: string,
  opciones: OpcionesCompanion = {},
): Promise<AperturaCompanion> {
  const { extensionId = extensionIdConfigurado(), enviar = enviarPorChrome } = opciones
  if (!extensionId) return { ok: false, code: 'NO_CONFIGURADO', estado: 'ausente' }

  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) return { ok: false, code: 'BAD_PHONE', estado: 'disponible' }
  if (!message.trim()) return { ok: false, code: 'BAD_TEXT', estado: 'disponible' }

  // EXACTAMENTE tres claves. Ni `url`, ni `business_id`, ni datos del cliente.
  const payload = {
    type: COMPANION_TIPO_APERTURA,
    phone: telefono.normalized,
    text: message,
  }

  const r = await enviar(extensionId, payload, TIMEOUT_APERTURA_MS)

  if (r.tipo === 'sin_extension') return { ok: false, code: 'SIN_RESPUESTA', estado: 'ausente' }
  if (r.tipo === 'timeout') return { ok: false, code: 'TIMEOUT', estado: 'indeterminado' }

  const datos = r.datos as { ok?: unknown; action?: unknown; code?: unknown } | null
  if (datos?.ok !== true) {
    const code = typeof datos?.code === 'string' ? datos.code : 'ERROR'
    // El único error que cambia lo que la UI tiene que ofrecer: la extensión
    // está, pero Chrome le retiró el acceso al sitio. Se resuelve en dos clics
    // y no tiene nada que ver con instalarla de nuevo.
    return { ok: false, code, estado: code === 'HOST_ACCESS_REQUIRED' ? 'sin_acceso' : 'disponible' }
  }

  return { ok: true, accion: datos.action === 'created' ? 'created' : 'reused' }
}
