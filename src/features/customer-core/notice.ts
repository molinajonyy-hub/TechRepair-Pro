/**
 * CLIENTES-UX-1B — contacto alternativo para avisos.
 *
 * Una persona a la que se puede avisar en lugar del cliente (quien retira el
 * equipo, un familiar). El teléfono principal sigue siendo del cliente.
 * NO es `contact_person`: ese es el contacto MAYORISTA.
 *
 * Las reglas acompañan a los CHECK de la migración 20261015180000:
 *   · nombre y teléfono van juntos (los dos o ninguno);
 *   · nombre de hasta 120 caracteres;
 *   · teléfono con dígitos, espacios, +, guiones o paréntesis, 8 a 15 dígitos;
 * y además, como el número es para WhatsApp, tiene que poder normalizarse
 * igual que en el preview (`normalizeWhatsAppPhone`): un celular argentino
 * completo, o un internacional con `+`.
 */
import { normalizeWhatsAppPhone } from '../../services/whatsappFormat'

export const NOTICE_NAME_MAX = 120
const PHONE_CHARS = /^\+?[0-9 ()-]+$/

export interface NoticeContactErrors {
  noticeName?: string
  noticePhone?: string
}

/** Espacios de más fuera: lo que se guarda es lo que se ve. */
export const cleanNoticeText = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim()

const digitsOf = (value: string) => value.replace(/\D/g, '')

export function noticePhoneError(raw: string): string | undefined {
  const phone = cleanNoticeText(raw)
  if (!phone) return undefined
  const digits = digitsOf(phone)
  if (!PHONE_CHARS.test(phone) || phone.length > 32 || digits.length < 8 || digits.length > 15 || !normalizeWhatsAppPhone(phone).valid) {
    return 'Ingresá un teléfono válido para WhatsApp: con característica (ej. 351 123-4567) o internacional con +.'
  }
  return undefined
}

export function validateNoticeContact(
  name: string,
  phone: string,
  principalPhone = ''
): NoticeContactErrors {
  const errors: NoticeContactErrors = {}
  const cleanName = cleanNoticeText(name)
  const cleanPhone = cleanNoticeText(phone)
  if (!cleanName && !cleanPhone) return errors

  if (!cleanName) errors.noticeName = 'Indicá a quién corresponde el teléfono para avisos.'
  else if (cleanName.length > NOTICE_NAME_MAX) errors.noticeName = `El nombre puede tener hasta ${NOTICE_NAME_MAX} caracteres.`

  if (!cleanPhone) {
    errors.noticePhone = 'Cargá el teléfono para avisos, o borrá el nombre.'
  } else {
    const formatError = noticePhoneError(cleanPhone)
    if (formatError) errors.noticePhone = formatError
    else if (principalPhone && normalizeWhatsAppPhone(principalPhone).valid
      && normalizeWhatsAppPhone(principalPhone).normalized === normalizeWhatsAppPhone(cleanPhone).normalized) {
      errors.noticePhone = 'Es el mismo teléfono principal del cliente.'
    }
  }
  return errors
}
