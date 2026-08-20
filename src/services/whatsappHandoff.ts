/**
 * whatsappHandoff — apertura ESTÁNDAR de WhatsApp (W1).
 *
 * DESACOPLADO DEL TRANSPORTE OFICIAL A PROPÓSITO. Este módulo no importa
 * Supabase, no invoca Edge Functions, no conoce `whatsapp-send` ni ningún
 * `access_token` / `phone_number_id` de Meta. El guard
 * `scripts/guards/whatsapp-w1-standard.mjs` lo verifica en CI.
 *
 * ┌── POR QUÉ NO SE REUTILIZA UNA PESTAÑA DE WHATSAPP WEB ────────────────────┐
 * │ MEDIDO en Chromium real, no supuesto. `https://web.whatsapp.com/` responde│
 * │                                                                           │
 * │     Cross-Origin-Opener-Policy: same-origin                               │
 * │     Cross-Origin-Embedder-Policy: require-corp                            │
 * │                                                                           │
 * │ Con COOP `same-origin`, navegar un popup cross-origin hacia WhatsApp      │
 * │ provoca un browsing-context-group switch: el `WindowProxy` que conservaba  │
 * │ el opener queda SEVERED y `ref.closed` pasa a `true` AUNQUE LA PESTAÑA     │
 * │ SIGA ABIERTA. Medición desde techrepairpro.app:                           │
 * │                                                                           │
 * │     about:blank            → closed: false                                │
 * │     tras `opener = null`   → closed: false                                │
 * │     tras cargar WhatsApp   → closed: TRUE   ← sin que nadie la cerrara     │
 * │                                                                           │
 * │ Se probaron las tres vías y las tres fallan contra WhatsApp: referencia    │
 * │ con opener anulado, referencia con opener conservado, y target por nombre  │
 * │ (`window.name` además se resetea al navegar cross-origin). Los mismos      │
 * │ escenarios contra un destino SIN COOP sí reutilizan, así que la lógica     │
 * │ era correcta y COOP es la única variable.                                  │
 * │                                                                           │
 * │ Corolario aparte: `ref.opener = null` TAMBIÉN renuncia al permiso de       │
 * │ navegar esa pestaña después (`SecurityError: does not have permission to   │
 * │ navigate the target frame`). El patrón estaba roto por dos motivos.        │
 * │                                                                           │
 * │ ⇒ Reutilizar la pestaña de WhatsApp Web NO es alcanzable. No agregar       │
 * │   window.name tricks, polling, opener hacks, iframes ni enumeración de     │
 * │   pestañas: ninguno cambia lo de arriba.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * CÓMO SE EVITA ENTONCES ACUMULAR PESTAÑAS:
 *  · Desktop · app  → protocolo `whatsapp://`. No abre ninguna pestaña.
 *  · Desktop · web  → navega la MISMA pestaña de TechRepair. Back vuelve.
 *  · Móvil          → `wa.me`, que el sistema entrega a la app nativa.
 *
 * LO QUE TECHREPAIR PUEDE SABER: que preparó el mensaje y que el usuario
 * inició el handoff. NADA MÁS. No hay evidencia de `sent`, `delivered` ni
 * `read`, así que este módulo no expone esos estados.
 */
import { normalizeWhatsAppPhone, isMobileDevice, buildWhatsAppDesktopUrl } from './whatsappFormat.ts'

/**
 * Único resultado que este flujo puede registrar honestamente, y que además ya
 * pertenece al vocabulario que acepta el CHECK de `whatsapp_logs.send_result`
 * (`opened | copied | failed | skipped | sent_api`).
 *
 * SEMÁNTICA: significa **handoff iniciado**, no "el mensaje se abrió y menos
 * aún se envió". En el camino de la app de escritorio ni siquiera se puede
 * saber si la app existe. Se conserva el nombre `opened` porque es el valor
 * histórico de esa columna y renombrarlo exigiría una migración que no aporta.
 */
export const EVENTO_APERTURA = 'opened' as const

export type ResultadoHandoff =
  | { ok: true;  url: string; telefono: string }
  | { ok: false; error: string }

const ERROR_POPUP =
  'El navegador bloqueó la ventana. Permití las ventanas emergentes para este sitio o copiá el mensaje.'

/** Valida teléfono y mensaje una sola vez para las tres variantes de URL. */
function validar(phone: string | null | undefined, message: string) {
  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) return { error: telefono.error ?? 'Número de teléfono inválido' }
  if (!message.trim()) return { error: 'El mensaje está vacío' }
  return { telefono: telefono.normalized }
}

/**
 * `wa.me` — MÓVIL. Es el que el sistema operativo entrega a la app nativa.
 * FAIL-CLOSED: sin teléfono resoluble no devuelve URL, así que es imposible
 * abrir un link roto (`https://wa.me/?text=…`, que no lleva a ningún contacto).
 */
export function buildWaMeUrl(phone: string | null | undefined, message: string): ResultadoHandoff {
  const v = validar(phone, message)
  if (v.error) return { ok: false, error: v.error }
  return {
    ok: true,
    telefono: v.telefono!,
    // encodeURIComponent UNA sola vez. `message` es texto plano, nunca una URL
    // ya codificada, así que no hay doble encoding: %0A queda %0A, no %250A.
    url: `https://wa.me/${v.telefono}?text=${encodeURIComponent(message)}`,
  }
}

/**
 * WhatsApp Web — DESKTOP. Se apunta directo a `web.whatsapp.com/send` y no a
 * `wa.me`, porque en desktop wa.me redirige a `api.whatsapp.com/send`, la
 * pantalla intermedia ("Abrir aplicación" / "Continuar en WhatsApp Web") que
 * agrega un paso y termina estrenando otra pestaña.
 */
export function buildWebSendUrl(phone: string | null | undefined, message: string): ResultadoHandoff {
  const v = validar(phone, message)
  if (v.error) return { ok: false, error: v.error }
  return {
    ok: true,
    telefono: v.telefono!,
    url: `https://web.whatsapp.com/send?phone=${v.telefono}&text=${encodeURIComponent(message)}`,
  }
}

/**
 * App de escritorio — protocolo `whatsapp://`. No abre ninguna pestaña: el
 * sistema operativo se lo entrega a la app instalada.
 *
 * Se delega en `buildWhatsAppDesktopUrl`, el helper canónico que el proyecto ya
 * tenía; acá sólo se le agrega el fail-closed.
 */
export function buildAppUrl(phone: string | null | undefined, message: string): ResultadoHandoff {
  const v = validar(phone, message)
  if (v.error) return { ok: false, error: v.error }
  return { ok: true, telefono: v.telefono!, url: buildWhatsAppDesktopUrl(phone!, message) }
}

/**
 * URL del camino por defecto de cada plataforma: móvil → `wa.me`,
 * desktop → WhatsApp Web. `esMobile` es inyectable para testear las dos ramas
 * sin tocar el user-agent; por defecto usa `isMobileDevice()`, el mecanismo que
 * el proyecto ya venía usando (no se agrega una detección nueva).
 */
export function buildHandoffUrl(
  phone: string | null | undefined,
  message: string,
  esMobile: boolean = isMobileDevice(),
): ResultadoHandoff {
  return esMobile ? buildWaMeUrl(phone, message) : buildWebSendUrl(phone, message)
}

export type AperturaHandoff =
  | { abierto: true }
  | { abierto: false; error: string }

/**
 * MÓVIL. `wa.me` en una pestaña nueva; el sistema la intercepta y abre la app.
 * `_blank` explícito: no se promete reutilizar nada.
 */
export function abrirWhatsAppMovil(
  url: string,
  open: (url: string, target: string) => Window | null = (u, t) => window.open(u, t),
): AperturaHandoff {
  const win = open(url, '_blank')
  if (!win) return { abierto: false, error: ERROR_POPUP }
  return { abierto: true }
}

/**
 * DESKTOP · app instalada. Navegar a un `whatsapp://` NO cambia de página: el
 * navegador se lo pasa al sistema operativo y TechRepair se queda donde está.
 *
 * NO se intenta detectar si la app existe. Hacerlo requeriría una heurística de
 * foco/timeout que es exactamente el tipo de hack que este flujo evita, y que
 * además daría falsos negativos. Por eso la UI acompaña con la salida: si no
 * pasa nada, usar WhatsApp Web.
 */
export function abrirAppDeEscritorio(
  url: string,
  navegar: (url: string) => void = (u) => { window.location.href = u },
): AperturaHandoff {
  try {
    navegar(url)
    return { abierto: true }
  } catch {
    return { abierto: false, error: 'No se pudo abrir WhatsApp Desktop. Probá con WhatsApp Web.' }
  }
}

/**
 * DESKTOP · WhatsApp Web en la MISMA pestaña.
 *
 * Deliberadamente NO usa `window.open`: cada `open` contra WhatsApp Web crea
 * una pestaña que después es imposible reutilizar (ver el encabezado), así que
 * la única forma determinista de no acumular es navegar la pestaña actual. El
 * Back del navegador devuelve a TechRepair, con la recarga normal de la SPA.
 */
export function irAWhatsAppWeb(
  url: string,
  navegar: (url: string) => void = (u) => { window.location.assign(u) },
): AperturaHandoff {
  try {
    navegar(url)
    return { abierto: true }
  } catch {
    return { abierto: false, error: 'No se pudo abrir WhatsApp Web. Copiá el mensaje e intentá manualmente.' }
  }
}
