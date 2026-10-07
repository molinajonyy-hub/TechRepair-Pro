/**
 * Contacto público de TechRepair Pro.
 *
 * Vive en el código y no en una variable de entorno a propósito: la política de
 * privacidad es un documento legal y su casilla de contacto no puede
 * desaparecer porque alguien no configuró una env en el deploy. El pie de la
 * landing sí puede seguir leyendo el entorno para poder pisarlo sin tocar
 * código, pero cae acá cuando no está seteado.
 *
 * Es también el email del publisher de la extensión en el Chrome Web Store, que
 * lo exige verificado y lo muestra públicamente en la ficha. Los tres usos —la
 * política, el pie, y la ficha del Store— tienen que decir lo mismo.
 *
 * BETA-UX-1A — NO es un canal de soporte. El owner confirmó (2026-10-05) que
 * esta casilla no se atiende como soporte: es el contacto institucional/legal.
 * El nombre de la constante es histórico. Ninguna pantalla de producto la
 * ofrece como ayuda, `canalSoporte()` ya no cae acá cuando falta el WhatsApp, y
 * tampoco va en los correos de Auth: el guard de las plantillas la lee sólo
 * para detectar que reaparezca.
 */
export const CONTACTO_SOPORTE = 'techrepairpro.soporte@gmail.com'

// ─── Canal de ayuda del producto (BETA-1 · BETA-UX-1A) ───────────────────────
//
// Durante la beta el único canal de soporte atendido es WhatsApp.
//
// El número sale de `VITE_CONTACT_WHATSAPP`. Este archivo es el ÚNICO lugar de
// la app que lo lee y lo convierte en un enlace: la Ayuda, la pantalla global de
// error, el muro de fin de prueba, las pantallas previas al negocio y el pie de
// la landing piden `canalSoporte()` y no arman URLs ni conocen el teléfono.
//
// La variable se valida con una regla ESTRICTA (celular argentino). Un valor
// que no la cumple no produce un enlace: en producción se publicó `+594…` (una
// transposición de `+549`) y la regla anterior, «10 a 15 dígitos», lo dejó
// pasar. El build productivo además falla antes de publicar (ver
// `scripts/guards/support-contact.mjs`).
//
// Única excepción a «el número sale de la variable»: los correos de Supabase
// Auth (`supabase/templates/*.html`). GoTrue renderiza un HTML estático y no
// puede leer esta variable, así que el número va ESCRITO en las plantillas y en
// `scripts/guards/auth-email-templates.mjs`. Tiene que ser el mismo valor: si
// cambia el número de soporte hay que cambiarlo en los dos lados.

/**
 * Deja un teléfono en el formato que `wa.me` exige: sólo dígitos, con código de
 * país y sin `+`. PURA y GENÉRICA (10 a 15 dígitos, E.164): no decide si el
 * número es el de soporte. Para la configuración productiva usar
 * `validarWhatsAppSoporte`.
 */
export function normalizarWhatsApp(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null
  const digitos = valor.replace(/\D/g, '')
  return digitos.length >= 10 && digitos.length <= 15 ? digitos : null
}

/** Celular argentino para `wa.me`: 54 (país) + 9 (móvil) + 10 dígitos nacionales. */
const WHATSAPP_AR_MOVIL = /^549\d{10}$/

/** Lo único que puede acompañar a los dígitos: separadores de formato legible. */
const SOLO_TELEFONO = /^\+?[\d\s().-]+$/

export type ResultadoWhatsAppSoporte =
  | { ok: true; numero: string }
  | { ok: false; motivo: string }

/**
 * Regla de la configuración productiva de soporte. PURA.
 *
 * El valor canónico es `549XXXXXXXXXX` (13 dígitos). Se tolera el formato
 * legible (`+54 9 3574 404419`): los separadores se descartan y lo que se
 * publica es siempre el número normalizado. Lo que NO se tolera es que los
 * dígitos no sean un celular argentino: `594…`, `54` sin el `9`, un número
 * truncado, vacío o con letras.
 */
export function validarWhatsAppSoporte(valor: string | null | undefined): ResultadoWhatsAppSoporte {
  if (typeof valor !== 'string' || valor.trim() === '') {
    return { ok: false, motivo: 'está vacío' }
  }
  const limpio = valor.trim()
  if (!SOLO_TELEFONO.test(limpio)) {
    return { ok: false, motivo: 'tiene caracteres que no son de un teléfono' }
  }
  const digitos = limpio.replace(/\D/g, '')
  if (WHATSAPP_AR_MOVIL.test(digitos)) return { ok: true, numero: digitos }

  if (digitos.startsWith('594')) {
    return { ok: false, motivo: 'empieza con 594 (Guayana Francesa): parece una transposición de 549' }
  }
  if (digitos.startsWith('54') && digitos[2] !== '9') {
    return { ok: false, motivo: 'le falta el 9 de celular después del 54' }
  }
  if (!digitos.startsWith('549')) {
    return { ok: false, motivo: 'no empieza con 549 (Argentina, celular)' }
  }
  return { ok: false, motivo: `tiene ${digitos.length} dígitos y se esperan 13 (54 + 9 + 10)` }
}

/** Número de WhatsApp de soporte ya normalizado, o `null` si falta o es inválido. */
export function whatsappSoporte(): string | null {
  // `?.` a propósito: este módulo también se carga fuera de Vite (el guard de
  // build y `node --test`), donde `import.meta.env` no existe.
  const resultado = validarWhatsAppSoporte(import.meta.env?.VITE_CONTACT_WHATSAPP)
  return resultado.ok ? resultado.numero : null
}

/**
 * Mensajes precargados, uno por superficie. Conjunto CERRADO y de texto fijo:
 * `canalSoporte` sólo acepta una de estas claves, así que ningún componente
 * puede interpolar el email del usuario, el nombre del negocio ni un id en la
 * URL de WhatsApp.
 */
export const MENSAJES_SOPORTE = {
  general: 'Hola, necesito ayuda con TechRepair Pro.',
  error: 'Hola, TechRepair Pro me muestra un error y no puedo continuar.',
  accesoDesactivado: 'Hola, mi acceso a TechRepair Pro figura desactivado y soy titular del negocio.',
  negocioNoCarga: 'Hola, TechRepair Pro no puede cargar mi negocio.',
  correoNoLlega: 'Hola, no me llega el correo de confirmación de TechRepair Pro.',
  recuperarContrasena: 'Hola, no me llega el correo para restablecer mi contraseña de TechRepair Pro.',
  landing: 'Hola, quiero hacer una consulta sobre TechRepair Pro.',
} as const

export type MotivoSoporte = keyof typeof MENSAJES_SOPORTE

export const MENSAJE_SOPORTE_DEFAULT = MENSAJES_SOPORTE.general

export interface CanalSoporteWhatsApp {
  tipo: 'whatsapp'
  /** Destino listo para un `href`. */
  url: string
  /** Texto del CTA. */
  etiqueta: string
}

export interface CanalSoporteNoDisponible {
  tipo: 'no_disponible'
  url: null
  /** Texto que se muestra en lugar del CTA. */
  etiqueta: string
}

export type CanalSoporte = CanalSoporteWhatsApp | CanalSoporteNoDisponible

/**
 * Canal de ayuda vigente.
 *
 * WhatsApp cuando la variable es un celular argentino válido. Si falta o es
 * inválida (desarrollo, o un error de configuración que el guard de build no
 * haya visto) el canal queda `no_disponible`: la pantalla lo dice o no ofrece
 * el enlace, pero NUNCA deriva a la casilla institucional, que nadie atiende
 * como soporte.
 */
export function canalSoporte(motivo: MotivoSoporte = 'general'): CanalSoporte {
  const numero = whatsappSoporte()
  if (!numero) {
    return {
      tipo: 'no_disponible',
      url: null,
      etiqueta: 'La ayuda por WhatsApp no está disponible en este momento.',
    }
  }
  return {
    tipo: 'whatsapp',
    url: `https://wa.me/${numero}?text=${encodeURIComponent(MENSAJES_SOPORTE[motivo])}`,
    etiqueta: 'Hablar por WhatsApp',
  }
}
