/**
 * whatsappHandoff — apertura ESTÁNDAR de WhatsApp (W1).
 *
 * Handoff externo puro: `https://wa.me/<telefono>?text=<mensaje>`.
 *
 * DESACOPLADO DEL TRANSPORTE OFICIAL A PROPÓSITO. Este módulo no importa
 * Supabase, no invoca Edge Functions, no conoce `whatsapp-send` ni ningún
 * `access_token` / `phone_number_id` de Meta. El guard
 * `scripts/guards/whatsapp-w1-standard.mjs` lo verifica en CI.
 *
 * LO QUE TECHREPAIR PUEDE SABER: que preparó el mensaje y que el usuario tocó
 * "Abrir WhatsApp". NADA MÁS. No hay evidencia de `sent`, `delivered` ni
 * `read`, así que este módulo no expone esos estados. Ver `EVENTO_APERTURA`.
 */
// Extensión explícita: este módulo se testea con `node --test`, cuyo resolver
// de ESM no completa extensiones. `allowImportingTsExtensions` ya está activo y
// el repo usa este patrón en otros módulos con cobertura unitaria.
import { normalizeWhatsAppPhone, isMobileDevice } from './whatsappFormat.ts'

/**
 * Nombre de ventana estable. Reabrir el handoff reutiliza la MISMA pestaña en
 * vez de acumular una por mensaje. En móvil el navegador delega igual en la
 * app nativa, así que no hace falta ramificar por user-agent.
 */
export const WHATSAPP_WINDOW_NAME = 'techrepair_whatsapp'

/**
 * Único resultado que este flujo puede registrar honestamente, y que además ya
 * pertenece al vocabulario que acepta el CHECK de `whatsapp_logs.send_result`
 * (`opened | copied | failed | skipped | sent_api`).
 *
 * `prepared` NO se agrega: exigiría ampliar ese CHECK en producción — una
 * migración que W1 no necesita. El evento que importa (el click en "Abrir
 * WhatsApp") es exactamente `opened`.
 */
export const EVENTO_APERTURA = 'opened' as const

export type ResultadoHandoff =
  | { ok: true;  url: string; telefono: string }
  | { ok: false; error: string }

/**
 * Arma la URL wa.me. FAIL-CLOSED: sin un teléfono resoluble no devuelve URL,
 * así que es imposible abrir un link roto (`https://wa.me/?text=…`, que en
 * desktop lleva a un selector de contacto vacío y en móvil no hace nada útil).
 */
export function buildWaMeUrl(
  phone: string | null | undefined,
  message: string,
): ResultadoHandoff {
  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) {
    return { ok: false, error: telefono.error ?? 'Número de teléfono inválido' }
  }
  if (!message.trim()) {
    return { ok: false, error: 'El mensaje está vacío' }
  }
  // encodeURIComponent UNA sola vez. `message` es texto plano, nunca una URL ya
  // codificada, así que no hay doble encoding: %0A queda %0A, no %250A.
  return {
    ok: true,
    telefono: telefono.normalized,
    url: `https://wa.me/${telefono.normalized}?text=${encodeURIComponent(message)}`,
  }
}

/**
 * URL de WhatsApp Web para DESKTOP.
 *
 * POR QUÉ NO wa.me EN DESKTOP: `wa.me` redirige a
 * `api.whatsapp.com/send`, que es una pantalla intermedia ("Chatea en WhatsApp
 * con…", "Abrir aplicación" / "Continuar en WhatsApp Web"). Ese paso extra es
 * el que terminaba abriendo pestañas y sesiones nuevas: el usuario elegía
 * "Continuar en WhatsApp Web" y el navegador estrenaba pestaña, fuera del
 * control del nombre de ventana que fija este módulo.
 *
 * Apuntando directo a `web.whatsapp.com/send` no hay intermediaria, y la
 * navegación ocurre DENTRO de la pestaña `techrepair_whatsapp` ya abierta.
 */
export function buildWebSendUrl(
  phone: string | null | undefined,
  message: string,
): ResultadoHandoff {
  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) {
    return { ok: false, error: telefono.error ?? 'Número de teléfono inválido' }
  }
  if (!message.trim()) {
    return { ok: false, error: 'El mensaje está vacío' }
  }
  return {
    ok: true,
    telefono: telefono.normalized,
    url: `https://web.whatsapp.com/send?phone=${telefono.normalized}&text=${encodeURIComponent(message)}`,
  }
}

/**
 * URL de handoff según la plataforma.
 *
 *  · Desktop → `web.whatsapp.com/send` (sin pantalla intermedia).
 *  · Móvil   → `wa.me` , que es el que deja al sistema abrir la app nativa.
 *              Forzar `web.whatsapp.com` en un teléfono lo mandaría al WhatsApp
 *              Web del navegador móvil, que es peor que la app.
 *
 * `esMobile` es inyectable para poder testear las dos ramas sin tocar el
 * user-agent. Por defecto usa `isMobileDevice()`, el mecanismo que el proyecto
 * ya venía usando — no se agrega una detección nueva.
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
 * Abre el handoff reutilizando la pestaña con nombre estable.
 *
 * No se pasa `noopener`: con él el navegador ignora el nombre de ventana y
 * abre una pestaña nueva cada vez. El destino es un dominio fijo y conocido
 * de WhatsApp, y nunca se le entrega una referencia útil a la página de origen.
 *
 * CONTRATO DE REUTILIZACIÓN (y su límite honesto):
 *  · 1er handoff desde TechRepair → crea la pestaña `techrepair_whatsapp`.
 *  · 2º y siguientes → el navegador encuentra la pestaña por NOMBRE y navega
 *    esa misma, aunque cambien cliente, teléfono y mensaje.
 *  · Si el usuario la cerró → `window.open` la vuelve a crear, sin ruido.
 *
 * Lo que NO se promete: adoptar una pestaña de WhatsApp Web que el usuario haya
 * abierto por su cuenta. El navegador no deja enumerar pestañas ajenas, y sólo
 * responde al nombre de ventana que fijó esta misma app.
 */
export function abrirWhatsApp(
  url: string,
  open: (url: string, target: string) => Window | null = (u, t) => window.open(u, t),
): AperturaHandoff {
  const win = open(url, WHATSAPP_WINDOW_NAME)
  if (!win) {
    return {
      abierto: false,
      error: 'El navegador bloqueó la ventana. Permití las ventanas emergentes para este sitio o copiá el mensaje.',
    }
  }
  // Traer la pestaña reutilizada al frente. Es best-effort: algunos navegadores
  // devuelven una referencia cross-origin donde `focus` no existe o lanza. Que
  // no se pueda enfocar NO invalida la apertura.
  try { win.focus?.() } catch { /* el navegador no permite enfocarla; no importa */ }
  return { abierto: true }
}
