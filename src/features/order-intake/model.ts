export type AccessMode = 'none' | 'pin' | 'pattern' | 'password' | 'not_provided' | 'not_verifiable'
export type CheckResult = 'ok' | 'fail' | 'not_tested' | 'not_applicable'
export type Currency = 'ARS' | 'USD'

export interface IntakeDraft {
  customerId: string
  device: { type: 'smartphone' | 'tablet' | 'laptop' | 'smartwatch' | 'other'; brand: string; model: string; serial: string; imei: string }
  condition: { general: string; physical: string[]; powersOn: 'yes' | 'no' | 'not_verified' }
  checklist: Record<string, CheckResult>
  accessMode: AccessMode
  accessSecret: string
  pattern: number[]
  problem: string
  observations: string
  assignedProfileId: string
  priority: 'medium' | 'high' | 'urgent'
  budgetAmount: string
  budgetCurrency: Currency
}
export const INITIAL_INTAKE_DRAFT: IntakeDraft = {
  customerId: '',
  device: { type: 'smartphone', brand: '', model: '', serial: '', imei: '' },
  condition: { general: 'Bueno', physical: [], powersOn: 'not_verified' },
  checklist: {}, accessMode: 'not_provided', accessSecret: '', pattern: [],
  problem: '', observations: '', assignedProfileId: '', priority: 'medium',
  budgetAmount: '', budgetCurrency: 'ARS',
}

export function normalizeImei(value: string): string { return value.replace(/[\s-]/g, '') }

export function isValidImei(value: string): boolean {
  const digits = normalizeImei(value)
  if (!/^\d{15}$/.test(digits)) return false
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index])
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9 }
    sum += digit
  }
  return sum % 10 === 0
}

/** Acepta 100000,50 / 100.000,50 / 100,000.50 sin convertir moneda. */
export function parseLocalizedAmount(value: string): number | null {
  const clean = value.trim().replace(/\s/g, '')
  if (!clean) return null
  const comma = clean.lastIndexOf(',')
  const dot = clean.lastIndexOf('.')
  let normalized = clean
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'
    normalized = clean.replace(decimal === ',' ? /\./g : /,/g, '').replace(decimal, '.')
  } else if (comma >= 0) {
    normalized = /^-?\d{1,3}(,\d{3})+$/.test(clean) ? clean.replace(/,/g, '') : clean.replace(',', '.')
  } else if (dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(clean)) {
    normalized = clean.replace(/\./g, '')
  }
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

// ─── Acceso del equipo ───────────────────────────────────────────────────────
//
// BETA-UX-2 — el acceso NUNCA bloquea la recepción.
//
// Contrato del servidor (`private.mobile2a_legacy_from_access`, aplicado por
// `create_order_intake` y `set_order_device_access_secret`): un patrón es un
// JSON de 2 a 9 puntos DISTINTOS entre 0 y 8, fila por fila. Es el formato del
// frontend anterior (`pattern:0-4-8`) y el de los patrones migrados a Vault.
// La grilla le numera los puntos 1–9 a la persona; hasta este lote se mandaban
// así, y cualquier patrón que usara el punto 9 (la esquina inferior derecha)
// hacía fallar TODA la creación con `INVALID_ACCESS_PATTERN`. La conversión
// vive acá, en el borde con la RPC, y en ningún otro lado.

/** Mínimo que acepta el servidor para guardar un patrón. */
export const PATTERN_MIN_POINTS = 2
/** Android admite PIN de hasta 16 dígitos; con el tope anterior (12) se truncaba en silencio. */
export const PIN_MAX_DIGITS = 16
/** Debajo de esto se sugiere revisar con el cliente, sin bloquear. */
const TYPICAL_MIN_LENGTH = 4

/** Grilla (1–9) → contrato del servidor (0–8). */
export function patternToCanonical(points: number[]): number[] { return points.map(point => point - 1) }
/** Contrato del servidor (0–8) → grilla (1–9). */
export function patternFromCanonical(points: number[]): number[] { return points.map(point => point + 1) }

/**
 * Lee un patrón revelado de Vault y lo devuelve en la numeración de la grilla.
 * `null` si no es un patrón del contrato (texto legacy, JSON roto).
 */
export function parseRevealedPattern(value: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every(point => Number.isInteger(point) && point >= 0 && point <= 8)) return null
    return patternFromCanonical(parsed as number[])
  } catch { return null }
}

/** ¿El acceso elegido tiene un valor que el servidor puede guardar? */
export function hasStorableAccess(draft: Pick<IntakeDraft, 'accessMode' | 'accessSecret' | 'pattern'>): boolean {
  switch (draft.accessMode) {
    case 'pattern': return draft.pattern.length >= PATTERN_MIN_POINTS
    case 'pin': return draft.accessSecret.length > 0
    case 'password': return draft.accessSecret.trim().length > 0
    default: return true
  }
}

/**
 * El modo que viaja al servidor. Un PIN, contraseña o patrón sin valor
 * guardable no frena la orden: se registra como «No lo proporcionó» (es lo que
 * pasó) y el acceso se puede cargar después desde el detalle de la orden.
 */
export function effectiveAccessMode(draft: Pick<IntakeDraft, 'accessMode' | 'accessSecret' | 'pattern'>): AccessMode {
  return hasStorableAccess(draft) ? draft.accessMode : 'not_provided'
}

export interface AccessNotice { level: 'warning' | 'info'; message: string }

/** Ayuda contextual del paso de acceso. Nunca es un error que frene «Continuar». */
export function accessNotice(draft: Pick<IntakeDraft, 'accessMode' | 'accessSecret' | 'pattern'>): AccessNotice | null {
  const later = 'Podés seguir: la orden queda como «No lo proporcionó» y el acceso se carga después desde la orden.'
  if (!hasStorableAccess(draft)) {
    if (draft.accessMode === 'pattern') return { level: 'warning', message: `Marcá al menos ${PATTERN_MIN_POINTS} puntos para guardar el patrón. ${later}` }
    if (draft.accessMode === 'pin') return { level: 'warning', message: `Todavía no cargaste el PIN. ${later}` }
    if (draft.accessMode === 'password') return { level: 'warning', message: `Todavía no cargaste la contraseña. ${later}` }
  }
  if (draft.accessMode === 'pattern' && draft.pattern.length < TYPICAL_MIN_LENGTH)
    return { level: 'info', message: 'Los patrones de Android usan al menos 4 puntos. Revisalo con el cliente; se guarda igual.' }
  if (draft.accessMode === 'pin' && draft.accessSecret.length < TYPICAL_MIN_LENGTH)
    return { level: 'info', message: 'Un PIN suele tener entre 4 y 16 dígitos. Revisalo con el cliente; se guarda igual.' }
  return null
}

export function accessSecretForRpc(draft: IntakeDraft): string | null {
  const mode = effectiveAccessMode(draft)
  if (mode === 'pattern') return JSON.stringify(patternToCanonical(draft.pattern))
  if (mode === 'pin' || mode === 'password') return draft.accessSecret || null
  return null
}

// ─── Errores del servidor ────────────────────────────────────────────────────
// `create_order_intake` responde con códigos (`INVALID_IMEI`…). La pantalla
// mostraba el código crudo; acá se traduce lo que la persona puede resolver.
const INTAKE_ERROR_MESSAGES: Record<string, string> = {
  INVALID_ACCESS_PATTERN: 'El patrón no se pudo guardar. Volvé a dibujarlo o elegí «No lo proporcionó» y cargalo después desde la orden.',
  INVALID_ACCESS_SECRET: 'El acceso del equipo no se pudo guardar. Revisalo o elegí «No lo proporcionó».',
  ACCESS_SECRET_REQUIRED: 'Falta el código de acceso del equipo. Cargalo o elegí «No lo proporcionó».',
  INVALID_IMEI: 'El IMEI no es válido: tiene que tener 15 dígitos y un dígito verificador. Corregilo o dejalo vacío.',
  DEVICE_AND_PROBLEM_REQUIRED: 'Faltan la marca, el modelo o el problema informado.',
  INVALID_CUSTOMER: 'El cliente elegido ya no está disponible. Elegí otro o crealo de nuevo.',
  INVALID_ASSIGNEE: 'El técnico elegido ya no está activo. Elegí otro o dejá la orden sin asignar.',
  INVALID_BUDGET: 'El presupuesto no es válido.',
  INVALID_CURRENCY: 'La moneda del presupuesto no es válida.',
  FORBIDDEN_ORDERS_CREATE: 'No tenés permiso para registrar recepciones.',
  ACTIVE_PROFILE_REQUIRED: 'Tu usuario no tiene un perfil activo en el negocio.',
  IDEMPOTENCY_KEY_REUSED: 'Esta recepción ya se envió con otros datos. Recargá la página y volvé a cargarla.',
}

export function intakeErrorMessage(raw: string): string {
  const code = Object.keys(INTAKE_ERROR_MESSAGES).find(key => raw.includes(key))
  return code ? INTAKE_ERROR_MESSAGES[code] : raw
}

export function intakePayload(draft: IntakeDraft) {
  return {
    customer_id: draft.customerId,
    device: { ...draft.device, serial: draft.device.serial.trim(), imei: normalizeImei(draft.device.imei) },
    condition: { general: draft.condition.general, physical: draft.condition.physical, powers_on: draft.condition.powersOn },
    checklist: draft.checklist, access_mode: effectiveAccessMode(draft),
    problem: draft.problem.trim(), observations: draft.observations.trim(),
    assigned_profile_id: draft.assignedProfileId || null, priority: draft.priority,
    budget: { amount: parseLocalizedAmount(draft.budgetAmount)?.toString() ?? '', currency: draft.budgetCurrency },
  }
}
