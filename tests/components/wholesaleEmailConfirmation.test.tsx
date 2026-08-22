// ─────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION P0 — portal mayorista PRIVADO frente a Confirm Email
//
// El portal es privado de Clic/el owner. Estos tests cubren la adaptación
// mínima para que el alta sobreviva a la confirmación de correo, y sobre todo
// que NO se haya ampliado la superficie:
//
//   O.  sin sesión NO se intenta el INSERT en wholesale_customers
//   P.  con sesión confirmada, el alta se completa UNA sola vez
//   +   el business_id nunca sale del cliente: se resuelve por slug
//   +   una metadata de otro portal no da de alta en éste
//   +   sin confirmar tampoco se escribe
//
// El borde mockeado es `src/lib/supabase`: se registra CADA operación sobre
// `wholesale_customers` para poder afirmar «no se intentó escribir».
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

const AUTH_ID = '44444444-4444-4444-8444-444444444444'
const BIZ_CLIC = '55555555-5555-4555-8555-555555555555'
const BIZ_OTRO = '66666666-6666-4666-8666-666666666666'

const estado = vi.hoisted(() => ({
  /** Sesión devuelta por getSession(). */
  session: null as null | { user: { id: string; email: string; email_confirmed_at: string | null; user_metadata: Record<string, unknown> } },
  /** Sesión devuelta por signUp(). `null` = Confirm Email ON. */
  signUpSession: null as unknown,
  signUpUser: null as null | { id: string },
  signUpError: null as null | { message: string },
  /** Metadata efectivamente enviada al signUp. */
  signUpOptions: null as unknown,
  /** Filas existentes de wholesale_customers, por (auth_user_id, business_id). */
  filas: [] as Array<Record<string, unknown>>,
  /** Toda operación contra wholesale_customers, en orden. */
  ops: [] as string[],
  insertError: null as null | { message: string },
}))

vi.mock('../../src/lib/supabase', () => {
  const tabla = (nombre: string) => ({
    select: () => tabla(nombre),
    eq: () => tabla(nombre),
    maybeSingle: async () => {
      estado.ops.push(`select:${nombre}`)
      return { data: estado.filas[0] ?? null, error: null }
    },
    insert: (fila: Record<string, unknown>) => {
      estado.ops.push(`insert:${nombre}`)
      return {
        select: () => ({
          single: async () => {
            if (estado.insertError) return { data: null, error: estado.insertError }
            const creada = { id: 'wc-1', ...fila }
            estado.filas.push(creada)
            return { data: creada, error: null }
          },
        }),
      }
    },
  })

  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: estado.session }, error: null }),
        signUp: async (args: Record<string, unknown>) => {
          estado.ops.push('signUp')
          estado.signUpOptions = args.options
          if (estado.signUpError) return { data: { user: null, session: null }, error: estado.signUpError }
          return {
            data: { user: estado.signUpUser, session: estado.signUpSession },
            error: null,
          }
        },
      },
      from: (nombre: string) => tabla(nombre),
    },
  }
})

const { registerCustomer, completePendingWholesaleRegistration, getCustomerByAuthId } =
  await import('../../src/portal/services/portalService')

const META_OK = {
  portal_slug: 'clic',
  name: 'Juan García',
  business_name: 'Tech Accesorios',
  whatsapp: '5491112345678',
  province: 'CABA',
  city: 'CABA',
  instagram: 'tu_negocio',
}

const sesionCon = (confirmado: boolean, metadata: Record<string, unknown> = { wholesale_registration: META_OK }) => ({
  user: {
    id: AUTH_ID,
    email: 'mayorista@invalid.test',
    email_confirmed_at: confirmado ? '2026-08-23T10:00:00Z' : null,
    user_metadata: metadata,
  },
})

const entradaRegistro = {
  businessId: BIZ_CLIC,
  portalSlug: 'clic',
  name: 'Juan García',
  businessName: 'Tech Accesorios',
  email: 'mayorista@invalid.test',
  password: 'secreto123',
  whatsapp: '+54 9 11 1234-5678',
  province: 'CABA',
  city: 'CABA',
  instagram: '@tu_negocio',
}

beforeEach(() => {
  estado.session = null
  estado.signUpSession = null
  estado.signUpUser = { id: AUTH_ID }
  estado.signUpError = null
  estado.signUpOptions = null
  estado.filas = []
  estado.ops = []
  estado.insertError = null
})

describe('O. registro mayorista sin sesión', () => {
  it('NO intenta el INSERT cuando signUp no devuelve sesión', async () => {
    // Con Confirm Email ON, ese INSERT saldría como `anon` y la policy
    // `wc_own_insert` lo rechazaría con 42501: un error de permisos por un
    // flujo que en realidad funcionó.
    estado.signUpSession = null

    const res = await registerCustomer(entradaRegistro)

    expect(res.status).toBe('pending_confirmation')
    expect(estado.ops).toContain('signUp')
    expect(estado.ops).not.toContain('insert:wholesale_customers')
  })

  it('manda emailRedirectTo y la metadata namespaced', async () => {
    estado.signUpSession = null

    await registerCustomer(entradaRegistro)

    const opts = estado.signUpOptions as { emailRedirectTo?: string; data?: Record<string, unknown> }
    expect(opts.emailRedirectTo).toMatch(/\/auth\/callback$/)

    const meta = opts.data?.wholesale_registration as Record<string, unknown>
    expect(meta.portal_slug).toBe('clic')
    expect(meta.name).toBe('Juan García')
    // El WhatsApp y el Instagram viajan ya normalizados.
    expect(meta.whatsapp).toBe('5491112345678')
    expect(meta.instagram).toBe('tu_negocio')
  })

  it('NUNCA manda un business_id en la metadata', async () => {
    // Es la garantía de que el cliente no puede elegir tenant: sólo nombra un
    // slug, y el business_id lo resuelve el portal server-side.
    estado.signUpSession = null

    await registerCustomer(entradaRegistro)

    const opts = estado.signUpOptions as { data?: Record<string, unknown> }
    const serializado = JSON.stringify(opts.data)
    expect(serializado).not.toContain(BIZ_CLIC)
    expect(serializado).not.toContain('business_id')
  })

  it('NO pisa las claves que lee handle_new_user', async () => {
    // `full_name`, `role` y `business_name` en el nivel superior cambiarían el
    // provisioning del negocio. Todo va adentro de `wholesale_registration`.
    estado.signUpSession = null

    await registerCustomer(entradaRegistro)

    const data = (estado.signUpOptions as { data?: Record<string, unknown> }).data ?? {}
    expect(Object.keys(data)).toEqual(['wholesale_registration'])
    expect(data.full_name).toBeUndefined()
    expect(data.role).toBeUndefined()
    expect(data.business_name).toBeUndefined()
  })

  it('con sesión (Confirm Email OFF) mantiene el comportamiento de hoy', async () => {
    // El estado ACTUAL de producción. No debe cambiar hasta que el owner
    // active el switch.
    estado.signUpSession = { user: { id: AUTH_ID } }

    const res = await registerCustomer(entradaRegistro)

    expect(res.status).toBe('created')
    expect(estado.ops).toContain('insert:wholesale_customers')
  })
})

describe('P. alta completada tras confirmar', () => {
  it('con sesión confirmada, completa el alta contra el business del slug', async () => {
    estado.session = sesionCon(true)

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).not.toBeNull()
    expect(estado.ops).toContain('insert:wholesale_customers')
    // business_id = el resuelto por el portal, no el de la metadata.
    expect(estado.filas[0].business_id).toBe(BIZ_CLIC)
    expect(estado.filas[0].auth_user_id).toBe(AUTH_ID)
    expect(estado.filas[0].name).toBe('Juan García')
  })

  it('se completa UNA sola vez: en el segundo intento ya existe la fila', async () => {
    estado.session = sesionCon(true)

    await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')
    const inserciones1 = estado.ops.filter(o => o === 'insert:wholesale_customers').length

    // Segunda pasada: el flujo real pregunta primero por la fila existente.
    const yaExiste = await getCustomerByAuthId(BIZ_CLIC)
    expect(yaExiste).not.toBeNull()

    expect(inserciones1).toBe(1)
  })

  it('un duplicado concurrente no rompe ni se reporta como fallo', async () => {
    estado.session = sesionCon(true)
    estado.insertError = { message: 'duplicate key value violates unique constraint' }

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).toBeNull()
  })

  it('sin sesión no se escribe nada', async () => {
    estado.session = null

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).toBeNull()
    expect(estado.ops).not.toContain('insert:wholesale_customers')
  })

  it('con sesión pero SIN confirmar tampoco se escribe', async () => {
    estado.session = sesionCon(false)

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).toBeNull()
    expect(estado.ops).not.toContain('insert:wholesale_customers')
  })

  it('una metadata de OTRO portal no da de alta en éste', async () => {
    // El vector: el usuario edita su metadata para nombrar otro slug y así
    // colarse en otro tenant. El slug tiene que coincidir con el portal que se
    // está mirando; si no, no se escribe.
    estado.session = sesionCon(true, {
      wholesale_registration: { ...META_OK, portal_slug: 'otro-negocio' },
    })

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).toBeNull()
    expect(estado.ops).not.toContain('insert:wholesale_customers')
  })

  it('un business_id inyectado en la metadata se IGNORA', async () => {
    estado.session = sesionCon(true, {
      wholesale_registration: { ...META_OK, business_id: BIZ_OTRO },
    })

    await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    // Se usó el del portal, no el inyectado.
    expect(estado.filas[0].business_id).toBe(BIZ_CLIC)
    expect(estado.filas[0].business_id).not.toBe(BIZ_OTRO)
  })

  it('sin metadata de registro no se inventa un alta', async () => {
    estado.session = sesionCon(true, {})

    const customer = await completePendingWholesaleRegistration(BIZ_CLIC, 'clic')

    expect(customer).toBeNull()
    expect(estado.ops).not.toContain('insert:wholesale_customers')
  })
})
