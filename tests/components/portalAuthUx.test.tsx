// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — portal mayorista: Auth del SERVICIO (src/portal/services/portalService.ts).
//
// El borde mockeado es `src/lib/supabase`; el servicio corre de verdad.
//   P1  correo sin confirmar → motivo y copy propios (antes: «contraseña incorrecta»)
//   P2  credenciales inválidas → copy distinto
//   P3  rate limit / P4 red
//   P5  el login NO loguea PII (email, auth user id, estado del mayorista)
//   P6  guard estático: el servicio no tiene console.* ni loguea el email
//   P7  reenvío por la API oficial, callback canónico, 429 y error
//   P8  alta: errores cerrados (weak_password, 429, ya registrado, desconocido)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { COMPROMISED_PASSWORD_MESSAGE } from '../../src/lib/passwordPolicy'

const EMAIL = 'mayorista-qa@example.test'
const AUTH_ID = '99999999-9999-4999-8999-999999999999'
const BIZ = '77777777-7777-4777-8777-777777777777'

const estado = vi.hoisted(() => ({
  signInError: null as unknown,
  customer: null as unknown,
  queryError: null as unknown,
  signUpError: null as unknown,
  resendError: null as unknown,
  resendThrows: false,
  resendArgs: [] as unknown[],
  llamadas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const builder = () => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.update = () => { estado.llamadas.push('update'); return b }
    b.insert = () => b
    b.maybeSingle = async () => ({ data: estado.customer, error: estado.queryError })
    b.single = async () => ({ data: null, error: { message: 'insert falló' } })
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
    return b
  }
  return {
    supabase: {
      auth: {
        signInWithPassword: async () => {
          estado.llamadas.push('signInWithPassword')
          return estado.signInError
            ? { data: { user: null, session: null }, error: estado.signInError }
            : { data: { user: { id: AUTH_ID }, session: {} }, error: null }
        },
        signOut: async () => { estado.llamadas.push('signOut'); return { error: null } },
        signUp: async () => {
          estado.llamadas.push('signUp')
          return estado.signUpError
            ? { data: { user: null, session: null }, error: estado.signUpError }
            : { data: { user: { id: AUTH_ID }, session: null }, error: null }
        },
        resend: async (args: unknown) => {
          estado.resendArgs.push(args)
          if (estado.resendThrows) throw new TypeError('Failed to fetch')
          return { data: {}, error: estado.resendError }
        },
        getSession: async () => ({ data: { session: null }, error: null }),
      },
      from: () => builder(),
      rpc: async () => ({ data: null, error: null }),
    },
  }
})

import {
  loginCustomer,
  registerCustomer,
  resendWholesaleConfirmation,
  PORTAL_LOGIN_ERROR_MESSAGE,
} from '../../src/portal/services/portalService'

const api = (status: number, code: string | undefined, message: string) => ({ name: 'AuthApiError', status, code, message })

const entradaRegistro = {
  businessId: BIZ, portalSlug: 'clic', name: 'Cliente QA', businessName: '', email: EMAIL,
  password: 'segura-123', whatsapp: '', province: '', city: '',
}

beforeEach(() => {
  estado.signInError = null
  estado.customer = { id: 'wc-1', approved: true, suspended: false }
  estado.queryError = null
  estado.signUpError = null
  estado.resendError = null
  estado.resendThrows = false
  estado.resendArgs = []
  estado.llamadas = []
})

describe('PRE-BETA-2D · portal — login', () => {
  it('P1. correo sin confirmar → motivo propio, NO «contraseña incorrecta»', async () => {
    estado.signInError = api(400, 'email_not_confirmed', 'Email not confirmed')
    const r = await loginCustomer(EMAIL, 'segura-123', BIZ)
    expect(r.reason).toBe('email_not_confirmed')
    expect(r.error).toBe('Tu correo todavía no está confirmado. Revisá el email que te enviamos.')
    expect(r.customer).toBeNull()
  })

  it('P2. credenciales inválidas → copy distinto del de sin confirmar', async () => {
    estado.signInError = api(400, 'invalid_credentials', 'Invalid login credentials')
    const r = await loginCustomer(EMAIL, 'mala-123', BIZ)
    expect(r.reason).toBe('invalid_credentials')
    expect(r.error).toBe('Email o contraseña incorrectos')
    expect(r.error).not.toBe(PORTAL_LOGIN_ERROR_MESSAGE.email_not_confirmed)
  })

  it('P3/P4. rate limit y red, sin texto de GoTrue', async () => {
    estado.signInError = api(429, 'over_request_rate_limit', 'Request rate limit reached')
    const a = await loginCustomer(EMAIL, 'x', BIZ)
    expect(a.reason).toBe('rate_limited')
    expect(a.error).not.toMatch(/rate limit/i)

    estado.signInError = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }
    const b = await loginCustomer(EMAIL, 'x', BIZ)
    expect(b.reason).toBe('network')
    expect(b.error).toMatch(/conexión/)
  })

  it('P5. ningún camino del login loguea el email, el auth user id ni el estado del mayorista', async () => {
    const espias = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    // éxito
    await loginCustomer(EMAIL, 'segura-123', BIZ)
    // fallas
    estado.signInError = api(400, 'email_not_confirmed', 'Email not confirmed')
    await loginCustomer(EMAIL, 'segura-123', BIZ)
    estado.signInError = null
    estado.queryError = { message: 'boom', code: 'XX000' }
    await loginCustomer(EMAIL, 'segura-123', BIZ)
    estado.queryError = null
    estado.customer = null
    await loginCustomer(EMAIL, 'segura-123', BIZ)
    estado.customer = { id: 'wc-1', approved: true, suspended: true }
    await loginCustomer(EMAIL, 'segura-123', BIZ)

    const impreso = espias.flatMap(s => s.mock.calls).map(args => JSON.stringify(args)).join('\n')
    expect(impreso).not.toContain(EMAIL)
    expect(impreso).not.toContain(AUTH_ID)
    expect(impreso).not.toMatch(/approved|suspended|loginCustomer/)
  })

  it('P6. guard estático: portalService no usa console.* ni pasa el email/ids a un log', () => {
    const src = readFileSync('src/portal/services/portalService.ts', 'utf8')
    const codigo = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(codigo).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\s*\(/)
    for (const m of codigo.matchAll(/logger\.\w+\(([^)]*)\)/g)) {
      expect(m[1]).not.toMatch(/\bemail\b|authUserId|user\.id|auth_user_id/)
    }
  })
})

describe('PRE-BETA-2D · portal — reenvío de confirmación', () => {
  it('P7. usa la API oficial con el callback canónico; 429 / error / red', async () => {
    expect(await resendWholesaleConfirmation(EMAIL)).toBe('sent')
    const args = estado.resendArgs[0] as { type: string; email: string; options: { emailRedirectTo: string } }
    expect(args.type).toBe('signup')
    expect(args.email).toBe(EMAIL)
    expect(args.options.emailRedirectTo).toMatch(/\/auth\/callback$/)

    estado.resendError = api(429, 'over_email_send_rate_limit', 'For security purposes, you can only request this after 60 seconds.')
    expect(await resendWholesaleConfirmation(EMAIL)).toBe('rate_limited')
    estado.resendError = api(500, 'unexpected_failure', 'Error sending confirmation email')
    expect(await resendWholesaleConfirmation(EMAIL)).toBe('error')
    estado.resendError = null
    estado.resendThrows = true
    expect(await resendWholesaleConfirmation(EMAIL)).toBe('error')
  })
})

describe('PRE-BETA-2D · portal — alta', () => {
  it('P8. errores cerrados: weak_password, 429, ya registrado, desconocido', async () => {
    const casos: Array<[unknown, RegExp | string]> = [
      [{ name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, reasons: ['pwned'], message: 'Password is known to be weak' }, COMPROMISED_PASSWORD_MESSAGE],
      [api(429, 'over_email_send_rate_limit', 'Email rate limit exceeded'), 'Hiciste varios intentos seguidos. Esperá unos minutos y volvé a probar.'],
      [api(422, 'user_already_exists', 'User already registered'), 'Este email ya está registrado. Intentá iniciar sesión.'],
      [api(500, 'unexpected_failure', 'Error sending confirmation email'), /contactá al negocio/],
      [api(500, 'unexpected_failure', 'Database error saving new user'), 'No pudimos crear la cuenta. Intentá nuevamente en unos minutos.'],
    ]
    for (const [err, esperado] of casos) {
      estado.signUpError = err
      const r = await registerCustomer(entradaRegistro)
      expect(r.status).toBe('error')
      const msg = r.status === 'error' ? r.error : ''
      if (typeof esperado === 'string') expect(msg).toBe(esperado)
      else expect(msg).toMatch(esperado)
      expect(msg).not.toMatch(/known to be weak|rate limit exceeded|already registered|Error sending|Database error/i)
    }
  })
})
