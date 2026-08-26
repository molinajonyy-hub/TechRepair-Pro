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

export function accessSecretForRpc(draft: IntakeDraft): string | null {
  if (draft.accessMode === 'pattern') return draft.pattern.length ? JSON.stringify(draft.pattern) : null
  if (draft.accessMode === 'pin' || draft.accessMode === 'password') return draft.accessSecret || null
  return null
}

export function intakePayload(draft: IntakeDraft) {
  return {
    customer_id: draft.customerId,
    device: { ...draft.device, serial: draft.device.serial.trim(), imei: normalizeImei(draft.device.imei) },
    condition: { general: draft.condition.general, physical: draft.condition.physical, powers_on: draft.condition.powersOn },
    checklist: draft.checklist, access_mode: draft.accessMode,
    problem: draft.problem.trim(), observations: draft.observations.trim(),
    assigned_profile_id: draft.assignedProfileId || null, priority: draft.priority,
    budget: { amount: parseLocalizedAmount(draft.budgetAmount)?.toString() ?? '', currency: draft.budgetCurrency },
  }
}
