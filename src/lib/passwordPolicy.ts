// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — Política de contraseña canónica.
//
// Única fuente de los límites y de sus mensajes. Antes había tres reglas:
// recovery exigía 8 y ≤ 72 bytes, el registro principal y el del portal
// mayorista aceptaban 6 y no miraban bytes. Todo alta o cambio de contraseña
// pasa ahora por acá.
//
// La autoridad sigue siendo GoTrue (largo mínimo configurado en Supabase,
// Leaked Password Protection). Esta validación es la del formulario: tiene que
// ser IGUAL O MÁS estricta que el servidor para que nadie vea un error crudo.
//   · Mínimo: se cuenta en caracteres (code points). GoTrue cuenta BYTES, y
//     cada code point ocupa ≥ 1 byte, así que «≥ 8 caracteres» implica
//     «≥ 8 bytes»: nunca pasamos algo que el servidor rechace por corto.
//   · Máximo: 72 BYTES UTF-8, el límite de bcrypt. Más largo se trunca en
//     silencio del lado del servidor; acá se rechaza.
//
// Sin requisitos de símbolos ni mayúsculas (decisión de beta).
// ─────────────────────────────────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 8
/** Límite de bcrypt en GoTrue: más de 72 bytes se trunca en silencio. */
export const PASSWORD_MAX_BYTES = 72

/** Placeholder de los campos de contraseña nueva. */
export const PASSWORD_PLACEHOLDER = `Mínimo ${PASSWORD_MIN_LENGTH} caracteres`

export type PasswordPolicyIssue = 'too_short' | 'blank' | 'too_long'

export const PASSWORD_POLICY_MESSAGE: Record<PasswordPolicyIssue, string> = {
  too_short: `Usá al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  blank: 'La contraseña no puede ser sólo espacios.',
  // El límite es de 72 BYTES UTF-8 (bcrypt), no de caracteres: el copy no da un número.
  too_long: 'Usá una contraseña más corta.',
}

export const PASSWORD_CONFIRM_MESSAGE = {
  missing: 'Repetí la contraseña.',
  mismatch: 'Las contraseñas no coinciden.',
} as const

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length
}

/** `null` si la contraseña cumple la política. Pura. */
export function checkPasswordPolicy(password: string): PasswordPolicyIssue | null {
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) return 'too_short'
  if (password.trim().length === 0) return 'blank'
  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) return 'too_long'
  return null
}

export interface PasswordFieldErrors {
  password?: string
  confirm?: string
}

/** Contraseña nueva + confirmación. Devuelve `{}` si todo está bien. */
export function validatePasswordPair(password: string, confirm: string): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {}
  const issue = checkPasswordPolicy(password)
  if (issue) errors.password = PASSWORD_POLICY_MESSAGE[issue]
  if (!confirm) errors.confirm = PASSWORD_CONFIRM_MESSAGE.missing
  else if (confirm !== password) errors.confirm = PASSWORD_CONFIRM_MESSAGE.mismatch
  return errors
}

// ── Contraseña rechazada por el servidor (Leaked Password Protection) ────────
//
// GoTrue responde `weak_password` (supabase-js lo convierte en
// `AuthWeakPasswordError`, con `reasons`): `pwned` cuando la contraseña está en
// filtraciones conocidas (HIBP), `length` o `characters` cuando no cumple el
// largo o los requisitos configurados. El texto del servidor nunca se muestra.

export const COMPROMISED_PASSWORD_MESSAGE =
  'Esta contraseña no es segura. Elegí otra que no hayas usado en otros servicios.'

interface WeakPasswordLike {
  code?: unknown
  name?: unknown
  reasons?: unknown
}

export function isWeakPasswordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as WeakPasswordLike
  return e.code === 'weak_password' || e.name === 'AuthWeakPasswordError'
}

/** Mensaje propio para un `weak_password`, según los motivos que informa GoTrue. */
export function weakPasswordMessage(error: unknown): string {
  const reasons = Array.isArray((error as WeakPasswordLike | null)?.reasons)
    ? ((error as WeakPasswordLike).reasons as unknown[]).filter((r): r is string => typeof r === 'string')
    : []
  if (reasons.includes('pwned')) return COMPROMISED_PASSWORD_MESSAGE
  if (reasons.includes('length')) return 'Usá una contraseña más larga.'
  if (reasons.includes('characters')) return 'Combiná letras, números y símbolos.'
  // Sin motivos (versiones viejas de GoTrue): lo más probable es la filtración.
  return COMPROMISED_PASSWORD_MESSAGE
}
