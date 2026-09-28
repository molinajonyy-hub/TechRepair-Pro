// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — intención de alta desde la landing (src/lib/signupIntent.ts).
//
// Vive en vitest (no en `node --test`) porque importa `PLANS` de
// src/types/subscription.ts, que reexporta sin extensión y Node no lo resuelve.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as s from '../../src/lib/signupIntent'
import { sanitizeInternalPath } from '../../src/lib/authRedirect'

beforeEach(() => {
  window.localStorage.clear()
})

describe('PRE-BETA-2D · signupIntent', () => {
  it('S1. ?modo= abre la pestaña correcta; valores desconocidos caen en login', () => {
    expect(s.initialLoginMode('?modo=registro')).toBe('register')
    expect(s.initialLoginMode('?modo=recuperar')).toBe('forgot')
    expect(s.initialLoginMode('')).toBe('login')
    expect(s.initialLoginMode('?modo=admin')).toBe('login')
    expect(s.initialLoginMode('?modo=constructor')).toBe('login')
    expect(s.initialLoginMode('?modo=__proto__')).toBe('login')
  })

  it('S2. el CTA de prueba abre el registro con /onboarding como destino', () => {
    expect(s.signupPath()).toBe('/login?modo=registro&redirectTo=%2Fonboarding')
    expect(s.signupPath('pro')).toBe('/login?modo=registro&redirectTo=%2Fonboarding%3Fplan%3Dpro')
    // Un plan que no existe no viaja.
    expect(s.signupPath('gratis-para-siempre' as never)).toBe('/login?modo=registro&redirectTo=%2Fonboarding')
  })

  it('S3. el destino sobrevive al saneado del Login (no es un open redirect)', () => {
    const redirectTo = new URLSearchParams(s.signupPath('full').split('?')[1]).get('redirectTo')
    expect(sanitizeInternalPath(redirectTo, '/dashboard')).toBe('/onboarding?plan=full')
    expect(s.planFromInternalPath('/onboarding?plan=full')).toBe('full')
    expect(s.planFromInternalPath('/onboarding?plan=nope')).toBeNull()
    expect(s.planFromInternalPath('/onboarding')).toBeNull()
  })

  it('S4. el plan cruza pestañas con vencimiento y sólo si es válido', () => {
    const t0 = 1_800_000_000_000
    s.rememberSignupPlan('pro', t0)
    expect(s.readSignupPlan(t0 + 60_000)).toBe('pro')
    expect(s.readSignupPlan(t0 + 25 * 60 * 60 * 1000)).toBeNull()
    s.clearSignupPlan()
    expect(s.readSignupPlan(t0)).toBeNull()

    window.localStorage.setItem('trp_signup_plan', JSON.stringify({ plan: 'inventado', at: t0 }))
    expect(s.readSignupPlan(t0)).toBeNull()
    window.localStorage.setItem('trp_signup_plan', '{roto')
    expect(s.readSignupPlan(t0)).toBeNull()
  })

  it('S5. sin storage (modo privado estricto) no rompe', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(() => s.rememberSignupPlan('pro')).not.toThrow()
    expect(s.readSignupPlan()).toBeNull()
    expect(() => s.clearSignupPlan()).not.toThrow()
  })
})
