// ─────────────────────────────────────────────────────────────────────────────
// P0-P1 — Autoridad canónica de provisioning, lado cliente.
//
// Contraparte de tests/sql/canonical_owner_provisioning.test.sql. Allá se
// verifica el contrato del servidor; acá, que el frontend lo consuma bien y que
// no reaparezcan los caminos que este lote cierra:
//
//   A. la RPC se llama con el nombre canónico y SIN datos privilegiados
//   B. respuesta normal -> {ok, businessId, created}
//   C. INVITATION_PENDING por SQLSTATE  -> estado explícito, no excepción
//   D. INVITATION_PENDING por mensaje   -> mismo estado (doble detección)
//   E. EMAIL_NOT_CONFIRMED              -> estado explícito
//   F. un error REAL no se traga        -> propaga
//   G. respuesta sin forma              -> propaga (contrato roto ≠ reintento)
//   H. estructura: un solo creador de tenants, mayorista fuera, sin metadata
//      como autoridad y sin ramas por proveedor
//
// El borde mockeado es `src/lib/supabase`. El servicio corre de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const estado = vi.hoisted(() => ({
  data: null as unknown,
  error: null as { code?: string; message?: string } | null,
  llamadas: [] as { nombre: string; args: Record<string, unknown> }[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      estado.llamadas.push({ nombre, args })
      return { data: estado.data, error: estado.error }
    },
  },
}))

import { provisionMyBusiness } from '../../src/services/provisioningService'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

const BIZ = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  estado.data = null
  estado.error = null
  estado.llamadas = []
})

describe('provisionMyBusiness — contrato de llamada', () => {
  it('A · llama a `provision_my_business` sin ningún dato privilegiado', async () => {
    estado.data = { business_id: BIZ, created: true }
    await provisionMyBusiness('Taller Del Centro')

    expect(estado.llamadas).toHaveLength(1)
    const { nombre, args } = estado.llamadas[0]
    expect(nombre).toBe('provision_my_business')

    // El ÚNICO parámetro admisible es el nombre a mostrar. Todo lo demás lo
    // deriva el servidor de auth.uid(); mandarlo desde el cliente sería
    // exactamente el patrón que este lote elimina.
    expect(Object.keys(args)).toEqual(['p_business_name'])
    expect(args.p_business_name).toBe('Taller Del Centro')

    for (const prohibido of [
      'p_user_email', 'p_user_id', 'user_id', 'profile_id',
      'owner_user_id', 'business_id', 'role', 'email',
    ]) {
      expect(args).not.toHaveProperty(prohibido)
    }
  })

  it('A2 · un nombre vacío viaja como null, no como cadena en blanco', async () => {
    estado.data = { business_id: BIZ, created: true }
    await provisionMyBusiness('   ')
    expect(estado.llamadas[0].args.p_business_name).toBeNull()

    await provisionMyBusiness()
    expect(estado.llamadas[1].args.p_business_name).toBeNull()
  })

  it('B · devuelve el negocio y distingue alta de idempotencia', async () => {
    estado.data = { business_id: BIZ, created: true }
    await expect(provisionMyBusiness('X')).resolves.toEqual({
      status: 'ok', businessId: BIZ, created: true,
    })

    estado.data = { business_id: BIZ, created: false }
    await expect(provisionMyBusiness('X')).resolves.toEqual({
      status: 'ok', businessId: BIZ, created: false,
    })
  })
})

describe('provisionMyBusiness — rechazos semánticos', () => {
  it('C · INVITATION_PENDING por SQLSTATE propio', async () => {
    estado.error = { code: 'TRINV', message: 'algo que no menciona el motivo' }
    await expect(provisionMyBusiness('X')).resolves.toEqual({ status: 'invitation_pending' })
  })

  it('D · INVITATION_PENDING por mensaje, sin code', async () => {
    estado.error = { message: 'ERROR: INVITATION_PENDING' }
    await expect(provisionMyBusiness('X')).resolves.toEqual({ status: 'invitation_pending' })
  })

  it('E · EMAIL_NOT_CONFIRMED es un estado, no una excepción', async () => {
    estado.error = { code: '42501', message: 'EMAIL_NOT_CONFIRMED' }
    await expect(provisionMyBusiness('X')).resolves.toEqual({ status: 'email_not_confirmed' })
  })
})

describe('provisionMyBusiness — los errores reales no se tragan', () => {
  it('F · un fallo de red/DB se propaga', async () => {
    estado.error = { code: '57014', message: 'canceling statement due to statement timeout' }
    await expect(provisionMyBusiness('X')).rejects.toThrow(/statement timeout/)
  })

  it('F2 · un 42501 que NO es el de correo sin confirmar también se propaga', async () => {
    // Si se tragara todo 42501, un problema de permisos se vería como
    // "confirmá tu correo" y mandaría a diagnosticar al lugar equivocado.
    estado.error = { code: '42501', message: 'permission denied for function provision_my_business' }
    await expect(provisionMyBusiness('X')).rejects.toThrow(/permission denied/)
  })

  it('G · una respuesta sin forma es un contrato roto, no un reintento', async () => {
    estado.data = { created: true }
    await expect(provisionMyBusiness('X')).rejects.toThrow(/no devolvió el negocio/)
  })
})

describe('H · estructura: una sola autoridad creadora', () => {
  const provisioning = leer('src/services/provisioningService.ts')
  const onboarding   = leer('src/pages/Onboarding.tsx')
  const noBusiness   = leer('src/pages/NoBusiness.tsx')
  const portal       = leer('src/portal/services/portalService.ts')
  const authContext  = leer('src/contexts/AuthContext.tsx')

  it('el mayorista NO provisiona un tenant SaaS', () => {
    // La propiedad medida en el discovery: 2 de 2 clientes mayoristas tenían su
    // propio tenant. `registerCustomer` puede seguir creando el auth user, pero
    // nunca el negocio.
    expect(portal).not.toMatch(/provision_my_business/)
    expect(portal).not.toMatch(/provisionMyBusiness/)
    expect(portal).not.toMatch(/bootstrap_owner_profile/)
  })

  it('los únicos llamadores son los puntos owner del flujo SaaS', () => {
    expect(onboarding).toMatch(/provisionMyBusiness\(/)
    expect(noBusiness).toMatch(/provisionMyBusiness\(/)
  })

  it('ningún llamador quedó apuntando a bootstrap_owner_profile', () => {
    // En la fase B esa RPC deja de ser ejecutable por `authenticated`: un
    // llamador olvidado se convertiría en un 42501 en producción.
    //
    // Se mide la INVOCACIÓN, no la palabra: los comentarios de estas dos
    // pantallas explican de dónde vienen y esa historia tiene que poder
    // escribirse sin romper el test.
    const invocacion = /rpc\(\s*['"]bootstrap_owner_profile['"]/
    for (const [nombre, src] of [['Onboarding', onboarding], ['NoBusiness', noBusiness]] as const) {
      expect(src, `${nombre} todavía invoca bootstrap_owner_profile`).not.toMatch(invocacion)
    }
  })

  it('sólo el servicio canónico invoca la RPC', () => {
    expect(provisioning).toMatch(/rpc\(\s*'provision_my_business'/)
    for (const [nombre, src] of [['Onboarding', onboarding], ['NoBusiness', noBusiness]] as const) {
      expect(src, `${nombre} debe pasar por el servicio, no por rpc() directo`)
        .not.toMatch(/rpc\(\s*'provision_my_business'/)
    }
  })

  it('la metadata del cliente no es autoridad para el rol', () => {
    // El defecto medido: `raw_user_meta_data->>'role'` definía el rol, y un
    // valor fuera del CHECK abortaba la transacción de confirmación.
    for (const src of [provisioning, onboarding, noBusiness]) {
      expect(src).not.toMatch(/user_metadata[\s\S]{0,40}\brole\b/)
      expect(src).not.toMatch(/raw_user_meta_data/)
    }
    // El signup tampoco manda un rol: sólo el nombre a mostrar.
    const signUp = authContext.slice(authContext.indexOf('const signUp'), authContext.indexOf('const signInWithGoogle'))
    expect(signUp).not.toMatch(/\brole\s*:/)
    expect(signUp).not.toMatch(/account_type/)
  })

  it('Google y email convergen: no hay ninguna rama por proveedor', () => {
    // La señal canónica es `email_confirmed_at`, que el servidor lee solo.
    // Una rama `provider === 'google'` en el camino de provisioning sería una
    // segunda autoridad encubierta.
    for (const src of [provisioning, onboarding, noBusiness]) {
      expect(src).not.toMatch(/provider\s*===?\s*['"]google['"]/)
      expect(src).not.toMatch(/isGoogle|esGoogle/)
    }
  })
})
