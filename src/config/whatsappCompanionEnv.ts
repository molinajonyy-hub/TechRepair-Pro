/**
 * Configuración del TechRepair WhatsApp Companion.
 *
 * ÚNICO lugar del frontend que lee las variables de entorno del Companion. La
 * validación vive acá, junto a la lectura, para que no haya un segundo criterio
 * dando vueltas: si un valor no pasa por estas funciones, no se usa.
 *
 * FAIL-CLOSED en las dos: ante una variable ausente o mal formada devuelven
 * `null`, y el frontend se comporta como si el Companion no estuviera. Nunca
 * "casi": mandarle mensajes a un ID roto es la forma silenciosa de "no anda".
 */

/** Un extension ID de Chrome son 32 caracteres en [a-p] (base16 remapeada). */
const EXTENSION_ID_VALIDO = /^[a-p]{32}$/

/**
 * Normaliza y valida un extension ID. PURA, para poder testearla de verdad.
 *
 * NO se hardcodea el ID del unpacked de desarrollo en ningún lado: ése cambia
 * según la carpeta y no es el de producción.
 */
export function normalizarExtensionId(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null
  const id = valor.trim()
  return EXTENSION_ID_VALIDO.test(id) ? id : null
}

/**
 * Normaliza la URL de instalación. Sólo `https`: un `http://` o un
 * `javascript:` metido en una variable de entorno no puede terminar en un
 * `href` de la aplicación.
 */
export function normalizarInstallUrl(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string' || valor.trim() === '') return null
  try {
    const u = new URL(valor.trim())
    return u.protocol === 'https:' ? u.toString() : null
  } catch { return null }
}

/** `import.meta.env` no existe fuera de Vite (node:test), de ahí el opcional. */
function env(): Record<string, string | undefined> {
  return (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
}

/** ID de la extensión publicada, o `null` si no está configurada. */
export function extensionIdConfigurado(): string | null {
  return normalizarExtensionId(env().VITE_WHATSAPP_COMPANION_EXTENSION_ID)
}

/**
 * URL de instalación. Mientras la extensión no esté publicada esta variable
 * queda vacía y la UI NO ofrece instalar: no se inventa una URL de Web Store
 * que todavía no existe.
 */
export function installUrlConfigurada(): string | null {
  return normalizarInstallUrl(env().VITE_WHATSAPP_COMPANION_INSTALL_URL)
}
