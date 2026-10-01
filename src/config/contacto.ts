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
 */
export const CONTACTO_SOPORTE = 'techrepairpro.soporte@gmail.com'

// ─── BETA-1 · Canal de ayuda del producto ────────────────────────────────────
//
// La casilla de arriba es el contacto LEGAL (política, Store, plantillas de
// Auth). No es un canal de soporte atendido, así que la Ayuda de la app no la
// presenta como primera opción: durante la beta el canal monitoreado es
// WhatsApp.
//
// El número sale de `VITE_CONTACT_WHATSAPP`, la misma variable que publica el
// pie de la landing, para que el producto y la landing no puedan decir números
// distintos. Este archivo es el ÚNICO lugar de la app que la convierte en un
// enlace de ayuda: los componentes piden `canalSoporte()` y no arman URLs.

/**
 * Deja el número en el formato que `wa.me` exige: sólo dígitos, con código de
 * país y sin `+`. PURA. Devuelve `null` si no parece un teléfono internacional
 * (10 a 15 dígitos, E.164): un link roto es peor que no ofrecer el canal.
 */
export function normalizarWhatsApp(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null
  const digitos = valor.replace(/\D/g, '')
  return digitos.length >= 10 && digitos.length <= 15 ? digitos : null
}

/** Número de WhatsApp de soporte ya normalizado, o `null` si no está configurado. */
export function whatsappSoporte(): string | null {
  // `?.` a propósito: este módulo también se carga bajo `node --test`
  // (authErrors), donde `import.meta.env` no existe.
  return normalizarWhatsApp(import.meta.env?.VITE_CONTACT_WHATSAPP)
}

export const MENSAJE_SOPORTE_DEFAULT = 'Hola, necesito ayuda con TechRepair Pro.'

export interface CanalSoporte {
  tipo: 'whatsapp' | 'email'
  /** Destino listo para un `href`. */
  url: string
  /** Texto del CTA. */
  etiqueta: string
}

/**
 * Canal de ayuda vigente. WhatsApp cuando está configurado; si no, cae al
 * correo para que la pantalla nunca quede sin salida. El mensaje se precarga
 * sólo en WhatsApp y no lleva datos del usuario ni del negocio.
 */
export function canalSoporte(mensaje: string = MENSAJE_SOPORTE_DEFAULT): CanalSoporte {
  const numero = whatsappSoporte()
  if (numero) {
    return {
      tipo: 'whatsapp',
      url: `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`,
      etiqueta: 'Hablar por WhatsApp',
    }
  }
  return { tipo: 'email', url: `mailto:${CONTACTO_SOPORTE}`, etiqueta: 'Escribir por correo' }
}
