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
import { normalizeWhatsAppPhone } from './whatsappFormat.ts'

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

export type AperturaHandoff =
  | { abierto: true }
  | { abierto: false; error: string }

/**
 * Abre el handoff reutilizando la pestaña con nombre estable.
 *
 * No se pasa `noopener`: con él el navegador ignora el nombre de ventana y
 * abre una pestaña nueva cada vez. El destino es un dominio fijo y conocido
 * (wa.me), y nunca se le entrega una referencia útil a la página de origen.
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
  return { abierto: true }
}
