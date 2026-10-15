import { describe, expect, it } from 'vitest'
import {
  accessNotice, accessSecretForRpc, effectiveAccessMode, intakeErrorMessage, intakePayload, isValidImei,
  normalizeImei, parseLocalizedAmount, patternFromCanonical, patternToCanonical, readStoredPattern,
  serializePattern, INITIAL_INTAKE_DRAFT, PIN_MAX_DIGITS,
} from '../../src/features/order-intake/model'

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
    expect(accessSecretForRpc(pattern)).toBe('["0","4","8"]')
    for (const forma of ['["0","4","8"]', '[0,4,8]', '[1,5,9]']) expect(JSON.stringify(intakePayload(pattern))).not.toContain(forma)
  })
})

/**
 * BETA-UX-2 — el patrón no bloquea la orden.
 *
 * Réplica de la regla del servidor (`private.mobile2a_legacy_from_access`,
 * supabase/migrations/20260903120000_mobile2a_order_intake.sql): JSON de 2 a 9
 * puntos distintos, cada uno `^[0-8]$`. Hasta este lote la grilla mandaba 1–9 y
 * un patrón con el punto 9 hacía fallar TODA la creación.
 */
function servidorAcepta(secret: string | null): boolean {
  if (secret === null) return false
  const points: unknown = JSON.parse(secret)
  return Array.isArray(points) && points.length >= 2 && points.length <= 9
    && points.every(point => /^[0-8]$/.test(String(point)))
    && new Set(points.map(String)).size === points.length
}

describe('BETA-UX-2 · patrón: la grilla (1–9) habla el contrato del servidor (0–8)', () => {
  const conPatron = (pattern: number[]) => ({ ...INITIAL_INTAKE_DRAFT, accessMode: 'pattern' as const, pattern })

  it('todo patrón dibujable de 2+ puntos es aceptado por el servidor, incluido el punto 9', () => {
    // Las 9 esquinas/bordes como último punto, y el patrón completo.
    for (let last = 1; last <= 9; last += 1) {
      const first = last === 1 ? 2 : 1
      expect(servidorAcepta(accessSecretForRpc(conPatron([first, last]))), `patrón ${first}-${last}`).toBe(true)
    }
    expect(servidorAcepta(accessSecretForRpc(conPatron([1, 2, 3, 4, 5, 6, 7, 8, 9])))).toBe(true)
  })

  it('el formato anterior (1–9 crudo) es justamente el que el servidor rechazaba', () => {
    expect(servidorAcepta(JSON.stringify([1, 5, 9]))).toBe(false)
    expect(servidorAcepta(JSON.stringify(patternToCanonical([1, 5, 9])))).toBe(true)
  })

  it('ida y vuelta: lo que se guarda hoy se lee exacto, en la numeración de la grilla', () => {
    expect(patternFromCanonical(patternToCanonical([3, 5, 7, 9]))).toEqual([3, 5, 7, 9])
    // Formato actual: arreglo de STRINGS del contrato 0–8 (el tipo es la marca).
    expect(serializePattern([1, 5, 9])).toBe('["0","4","8"]')
    expect(servidorAcepta(serializePattern([1, 5, 9]))).toBe(true)
    expect(readStoredPattern(serializePattern([3, 5, 7, 9]))).toEqual({ kind: 'exact', points: [3, 5, 7, 9], source: 'current' })
  })
})

/**
 * BETA-UX-2 · hotfix — patrones guardados ANTES del formato actual.
 *
 * Dos poblaciones, las dos como arreglo de NÚMEROS: las migradas del frontend
 * viejo (`pattern:0-1-2` → `[0,1,2]`, contrato 0–8) y las del wizard de
 * MOBILE-2A (grilla 1–9 cruda). Un 0 sólo puede venir de 0–8 y un 9 sólo de
 * 1–9; sin ninguno de los dos, la misma lista significa dos patrones distintos
 * y NO se dibuja.
 */
describe('BETA-UX-2 · hotfix · lectura de un patrón guardado', () => {
  it('formato anterior con un 0 → contrato 0–8, exacto', () => {
    expect(readStoredPattern('[0,1,2]')).toEqual({ kind: 'exact', points: [1, 2, 3], source: 'legacy_zero_based' })
  })

  it('formato anterior con un 9 → grilla 1–9, exacto', () => {
    expect(readStoredPattern('[1,5,9]')).toEqual({ kind: 'exact', points: [1, 5, 9], source: 'legacy_one_based' })
  })

  it('formato anterior sin 0 ni 9 → ambiguo: no se puede dibujar con certeza', () => {
    for (const valor of ['[1,2,5,8]', '[3,5,7]', '[1, 4]']) expect(readStoredPattern(valor)).toEqual({ kind: 'ambiguous' })
  })

  it('lo que no es un patrón del contrato no se lee', () => {
    for (const valor of ['1-5-9', 'no-json', '[]', '[4]', '[0,9]', '[1,1,2]', '["0",1]', '["9","1"]', '{"0":1}', '[0.5,2]'])
      expect(readStoredPattern(valor), valor).toEqual({ kind: 'unreadable' })
  })
})

describe('BETA-UX-2 · patrón: acceso que no bloquea', () => {
  const conPatron = (pattern: number[]) => ({ ...INITIAL_INTAKE_DRAFT, accessMode: 'pattern' as const, pattern })

  it('un patrón de 0 o 1 punto NO frena la orden: viaja como «No lo proporcionó», sin secreto', () => {
    for (const pattern of [[], [5]]) {
      const draft = conPatron(pattern)
      expect(effectiveAccessMode(draft)).toBe('not_provided')
      expect(accessSecretForRpc(draft)).toBeNull()
      expect(intakePayload(draft).access_mode).toBe('not_provided')
      expect(accessNotice(draft)).toMatchObject({ level: 'warning' })
    }
  })

  it('2–3 puntos se guardan igual, con una ayuda (no un error)', () => {
    const draft = conPatron([1, 2, 3])
    expect(effectiveAccessMode(draft)).toBe('pattern')
    expect(accessNotice(draft)).toMatchObject({ level: 'info' })
    expect(accessNotice(conPatron([1, 2, 3, 6]))).toBeNull()
  })

  it('PIN y contraseña vacíos tampoco frenan: quedan «No lo proporcionó»', () => {
    const pin = { ...INITIAL_INTAKE_DRAFT, accessMode: 'pin' as const, accessSecret: '' }
    const password = { ...INITIAL_INTAKE_DRAFT, accessMode: 'password' as const, accessSecret: '   ' }
    for (const draft of [pin, password]) {
      expect(effectiveAccessMode(draft)).toBe('not_provided')
      expect(accessSecretForRpc(draft)).toBeNull()
      expect(accessNotice(draft)).toMatchObject({ level: 'warning' })
    }
    // Un PIN corto se guarda y sólo se sugiere revisarlo.
    const corto = { ...pin, accessSecret: '12' }
    expect(accessSecretForRpc(corto)).toBe('12')
    expect(accessNotice(corto)).toMatchObject({ level: 'info' })
  })

  it('el PIN admite hasta 16 dígitos (el tope de 12 truncaba en silencio)', () => {
    expect(PIN_MAX_DIGITS).toBe(16)
  })

  it('el payload respeta la regla de secreto del servidor en todos los modos', () => {
    // `create_order_intake`: con pin/pattern/password exige secreto; con el
    // resto, `p_access_secret` tiene que ser NULL (UNEXPECTED_ACCESS_SECRET).
    const casos = [
      { ...INITIAL_INTAKE_DRAFT, accessMode: 'none' as const },
      { ...INITIAL_INTAKE_DRAFT, accessMode: 'not_verifiable' as const },
      { ...INITIAL_INTAKE_DRAFT, accessMode: 'pin' as const, accessSecret: '' },
      { ...INITIAL_INTAKE_DRAFT, accessMode: 'pin' as const, accessSecret: '4826' },
      conPatron([]), conPatron([7, 8, 9]),
    ]
    for (const draft of casos) {
      const mode = intakePayload(draft).access_mode
      const secret = accessSecretForRpc(draft)
      if (['pin', 'pattern', 'password'].includes(mode)) expect(secret, mode).toBeTruthy()
      else expect(secret, mode).toBeNull()
    }
  })

  it('los códigos del servidor se traducen; lo desconocido pasa tal cual', () => {
    expect(intakeErrorMessage('INVALID_ACCESS_PATTERN')).toMatch(/patrón no se pudo guardar/)
    expect(intakeErrorMessage('INVALID_IMEI')).toMatch(/IMEI no es válido/)
    expect(intakeErrorMessage('algo raro')).toBe('algo raro')
  })
})
