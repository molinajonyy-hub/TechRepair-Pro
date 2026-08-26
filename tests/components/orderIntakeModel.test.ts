import { describe, expect, it } from 'vitest'
import { accessSecretForRpc, intakePayload, isValidImei, normalizeImei, parseLocalizedAmount, INITIAL_INTAKE_DRAFT } from '../../src/features/order-intake/model'

describe('MOBILE-2A · modelo de recepción (unit)', () => {
  it('normaliza IMEI y aplica Luhn', () => {
    expect(normalizeImei('49 0154-20-323751-8')).toBe('490154203237518')
    expect(isValidImei('49 0154-20-323751-8')).toBe(true)
    expect(isValidImei('490154203237519')).toBe(false)
    expect(isValidImei('123')).toBe(false)
  })

  it('interpreta importes localizados sin convertir moneda', () => {
    expect(parseLocalizedAmount('100.000,50')).toBe(100000.5)
    expect(parseLocalizedAmount('100,000.50')).toBe(100000.5)
    expect(parseLocalizedAmount('100000,50')).toBe(100000.5)
    expect(parseLocalizedAmount('-1')).toBeNull()
  })

  it('mantiene PIN y patrón fuera del payload idempotente', () => {
    const pin = { ...INITIAL_INTAKE_DRAFT, accessMode: 'pin' as const, accessSecret: '4826' }
    expect(JSON.stringify(intakePayload(pin))).not.toContain('4826')
    expect(accessSecretForRpc(pin)).toBe('4826')
    const pattern = { ...INITIAL_INTAKE_DRAFT, accessMode: 'pattern' as const, pattern: [1,5,9] }
    expect(accessSecretForRpc(pattern)).toBe('[1,5,9]')
    expect(JSON.stringify(intakePayload(pattern))).not.toContain('[1,5,9]')
  })
})
