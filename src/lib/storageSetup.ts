import { supabase } from './supabase'
import { logger } from './logger'

/**
 * P0-P5 — Subida del logo del negocio. Contrato ÚNICO: lo usan el onboarding y
 * las tres pantallas de Configuración. No hay un segundo camino de Storage.
 *
 * ── EL BUG QUE CIERRA ────────────────────────────────────────────────────────
 * En producción, subir el logo fallaba con «new row violates row-level security
 * policy». La causa NO estaba acá: las tres policies de escritura sobre
 * `business-assets` hacían
 *
 *     auth.uid() IN (SELECT profiles.user_id FROM profiles
 *                     WHERE COALESCE(profiles.user_id, profiles.id) = auth.uid())
 *
 * o sea, filtraban con COALESCE pero PROYECTABAN la columna cruda `user_id`.
 * `provision_my_business` crea el perfil con `id = auth.uid()` y `user_id` NULL,
 * así que la subconsulta devolvía NULL y `auth.uid() IN (NULL)` es NULL, no
 * true. MEDIDO: 11 de 18 perfiles productivos tienen `user_id IS NULL`.
 *
 * ── POR QUÉ CAMBIA EL PATH ───────────────────────────────────────────────────
 * Antes: `business-logos/<businessId>_logo.ext` — el id iba en el NOMBRE del
 * archivo, donde ninguna policy puede leerlo. Como el path lo arma el cliente,
 * la única defensa posible era «¿tenés algún perfil?», que es ciega al tenant:
 * un usuario del negocio A podía pisar el logo del B cambiando el nombre.
 *
 * Ahora: `business-logos/<businessId>/logo-<ts>.ext` — el id es una CARPETA, que
 * `storage.foldername()` sí lee, así que la policy compara contra
 * `current_user_business_id()` derivado del JWT. El path del cliente dejó de ser
 * autorización: es sólo una propuesta que el servidor valida.
 *
 * El timestamp evita que un logo nuevo quede tapado por la caché del CDN, que
 * era el efecto secundario de reusar siempre el mismo nombre con `upsert`.
 */

const BUCKET = 'business-assets'
const CARPETA = 'business-logos'

/** Extensiones aceptadas. El nombre del archivo del usuario NO se usa tal cual. */
const EXT_POR_MIME: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/webp': 'webp',
}

export const LOGO_MAX_BYTES = 5 * 1024 * 1024

/** Tipos de error que el llamador puede querer distinguir. */
export type LogoUploadCode = 'TOO_LARGE' | 'BAD_FORMAT' | 'FORBIDDEN' | 'UNKNOWN'

export class LogoUploadError extends Error {
  readonly code: LogoUploadCode
  constructor(code: LogoUploadCode, mensaje: string) {
    super(mensaje)
    this.name = 'LogoUploadError'
    this.code = code
  }
}

/**
 * Sube el logo y devuelve su URL pública.
 *
 * NO persiste nada: guardar la URL es responsabilidad de quien llama
 * (`businessSetupService` en el onboarding). Separarlo es a propósito — mezclar
 * subida y persistencia fue parte de por qué el wizard viejo perdía el logo en
 * silencio cuando una de las dos fallaba.
 */
export async function uploadBusinessLogo(file: File, businessId: string): Promise<string> {
  if (!businessId) {
    // Sin negocio no hay carpeta válida, y el servidor rechazaría igual. Se
    // corta acá para dar un error entendible en vez de un 403 de Storage.
    throw new LogoUploadError('FORBIDDEN', 'Todavía no hay un negocio al que asociar el logo.')
  }

  if (file.size > LOGO_MAX_BYTES) {
    throw new LogoUploadError('TOO_LARGE', 'La imagen supera los 5 MB.')
  }

  const ext = EXT_POR_MIME[file.type]
  if (!ext) {
    throw new LogoUploadError('BAD_FORMAT', 'Formato no soportado. Usá PNG, JPG o WebP.')
  }

  // El id como CARPETA: es lo que la policy puede validar server-side.
  const filePath = `${CARPETA}/${businessId}/logo-${Date.now()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, file, { upsert: true, contentType: file.type })

  if (uploadError) {
    logger.error('AUTH', 'No se pudo subir el logo del negocio', uploadError)

    // La policy devuelve el mensaje de RLS. Se traduce a algo accionable en vez
    // de mostrar «new row violates row-level security policy», que fue
    // literalmente lo que vio el usuario en producción.
    const crudo = (uploadError.message || '').toLowerCase()
    if (crudo.includes('row-level security') || crudo.includes('unauthorized') || crudo.includes('403')) {
      throw new LogoUploadError(
        'FORBIDDEN',
        'No tenés permisos para cambiar el logo de este negocio.',
      )
    }
    throw new LogoUploadError('UNKNOWN', 'No se pudo subir el logo. Intentá nuevamente.')
  }

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(filePath)
  return publicUrl
}
