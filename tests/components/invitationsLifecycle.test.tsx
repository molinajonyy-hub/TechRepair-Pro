// ─────────────────────────────────────────────────────────────────────────────
// P0-P2 — Ciclo de vida de invitaciones, lado cliente.
//
// Contraparte de tests/sql/p0p2_business_invitations.test.sql. Allá se verifica
// el contrato del servidor; acá, que el frontend lo consuma bien y que no
// reaparezcan los defectos que este lote cierra:
//
//   A. crear   -> RPC canónica, SIN business_id, error crudo NUNCA a la UI
//   B. aceptar -> sólo viaja el token
//   C. cancelar-> `cancel_business_invitation`, jamás `.update({status:'revoked'})`
//   D. errores semánticos -> mensajes de UI, no SQLSTATE
//   E. /accept-invite sin sesión -> conserva el token en el redirect a login
//   F. /accept-invite con sesión -> acepta, refresca el perfil, va al dashboard
//   G. camino de invitación -> NUNCA llama a provision_my_business
//   H. estructura del repo -> no queda 'revoked' ni la firma de 3 argumentos
//
// El borde mockeado es `src/lib/supabase`. Servicios y componentes corren de
// verdad, incluido el AuthProvider real.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'a'.repeat(64)

const estado = vi.hoisted(() => ({
  rpc: {} as Record<string, () => { data: unknown; error: { code?: string; message?: string } | null }>,
  llamadas: [] as { nombre: string; args: Record<string, unknown> }[],
  sessionUser: null as { id: string; email: string; email_confirmed_at: string | null } | null,
  /** Se cuenta para probar que el perfil se refresca DESPUÉS de aceptar. */
  perfilesLeidos: 0,
  updates: [] as { tabla: string; valores: Record<string, unknown> }[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: estado.sessionUser ? { user: estado.sessionUser } : null },
        error: null,
      }),
      getUser: async () => ({ data: { user: estado.sessionUser }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
    rpc: async (nombre: string, args: Record<string, unknown> = {}) => {
      estado.llamadas.push({ nombre, args })
      if (nombre === 'get_my_profile') {
        estado.perfilesLeidos += 1
        return {
          data: {
            id: USER_ID, business_id: BIZ_ID, role: 'tech', is_active: true,
            full_name: 'Invitado', email: 'invitado@invalid.test',
            phone: null, permissions: null,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          },
          error: null,
        }
      }
      const handler = estado.rpc[nombre]
      return handler ? handler() : { data: null, error: null }
    },
    from: (tabla: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: async () => ({ data: [], error: null }),
        update: (valores: Record<string, unknown>) => {
          estado.updates.push({ tabla, valores })
          return { eq: async () => ({ data: null, error: null }) }
        },
      }
      return chain
    },
  },
}))

import {
  createInvitation, acceptInvitation, cancelInvitation, InvitationError,
} from '../../src/services/invitationsService'
import {
  stashInviteToken, peekInviteToken, takeInviteToken, clearInviteToken, acceptInviteePath,
} from '../../src/lib/pendingInvite'
import { AcceptInvite } from '../../src/pages/AcceptInvite'
import { AuthProvider } from '../../src/contexts/AuthContext'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

const invitacionFalsa = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  business_id: BIZ_ID,
  email: 'invitado@invalid.test',
  role: 'tech',
  token: TOKEN,
  status: 'pending',
  expires_at: '2099-01-01T00:00:00Z',
  created_at: '2026-08-24T00:00:00Z',
  ...over,
})

beforeEach(() => {
  estado.rpc = {}
  estado.llamadas = []
  estado.sessionUser = null
  estado.perfilesLeidos = 0
  estado.updates = []
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · crear invitación', () => {
  it('llama a la RPC canónica SIN business_id ni datos privilegiados', async () => {
    estado.rpc['create_business_invitation'] = () => ({ data: invitacionFalsa(), error: null })
    await createInvitation('  Invitado@Invalid.TEST ', 'tech')

    expect(estado.llamadas).toHaveLength(1)
    const { nombre, args } = estado.llamadas[0]
    expect(nombre).toBe('create_business_invitation')

    // La firma de 3 argumentos fue retirada: mandar business_id volvería a
    // tratar como autorización un dato que escribe el cliente.
    expect(Object.keys(args).sort()).toEqual(['p_email', 'p_role'])
    for (const prohibido of ['p_business_id', 'business_id', 'p_user_id', 'user_id', 'p_token']) {
      expect(args).not.toHaveProperty(prohibido)
    }
  })

  it('EL P0: `gen_random_bytes` jamás llega a la UI', async () => {
    // Reproduce exactamente lo que devolvía producción.
    estado.rpc['create_business_invitation'] = () => ({
      data: null,
      error: { code: '42883', message: 'function gen_random_bytes(integer) does not exist' },
    })

    await expect(createInvitation('x@invalid.test', 'tech')).rejects.toThrow()
    try {
      await createInvitation('x@invalid.test', 'tech')
    } catch (err) {
      const mensaje = (err as Error).message
      expect(mensaje).not.toContain('gen_random_bytes')
      expect(mensaje).not.toContain('42883')
      expect(mensaje).toBe('No se pudo completar la operación. Intentá nuevamente.')
    }
  })

  it('pending duplicada -> mensaje entendible, no un 23505', async () => {
    estado.rpc['create_business_invitation'] = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "business_invitations_one_pending_per_email"' },
    })
    try {
      await createInvitation('x@invalid.test', 'tech')
      throw new Error('debió fallar')
    } catch (err) {
      expect(err).toBeInstanceOf(InvitationError)
      expect((err as Error).message).not.toContain('duplicate key')
      expect((err as Error).message).not.toContain('constraint')
    }
  })

  it('rol inválido y sin permisos -> mensajes propios', async () => {
    estado.rpc['create_business_invitation'] = () => ({
      data: null, error: { code: 'TRIVR', message: 'INVALID_ROLE' },
    })
    await expect(createInvitation('x@invalid.test', 'owner'))
      .rejects.toMatchObject({ code: 'INVALID_ROLE' })

    estado.rpc['create_business_invitation'] = () => ({
      data: null, error: { code: '42501', message: 'FORBIDDEN' },
    })
    await expect(createInvitation('x@invalid.test', 'tech'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'No tenés permisos para gestionar invitaciones.' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · aceptar invitación', () => {
  it('el ÚNICO dato que viaja es el token', async () => {
    estado.rpc['accept_business_invitation'] = () => ({
      data: { business_id: BIZ_ID, role: 'tech', created: true, status: 'ACCEPTED' }, error: null,
    })
    await acceptInvitation(`  ${TOKEN}  `)

    const { nombre, args } = estado.llamadas[0]
    expect(nombre).toBe('accept_business_invitation')
    expect(Object.keys(args)).toEqual(['p_token'])
    expect(args.p_token).toBe(TOKEN)   // trim aplicado
    for (const prohibido of ['p_user_id', 'p_email', 'p_business_id', 'p_role', 'email', 'role']) {
      expect(args).not.toHaveProperty(prohibido)
    }
  })

  it('idempotente: ALREADY_MEMBER es éxito, no error', async () => {
    estado.rpc['accept_business_invitation'] = () => ({
      data: { business_id: BIZ_ID, role: 'tech', created: false, status: 'ALREADY_MEMBER' }, error: null,
    })
    const res = await acceptInvitation(TOKEN)
    expect(res.status).toBe('ALREADY_MEMBER')
    expect(res.created).toBe(false)
  })

  it('tolera el contrato viejo (uuid suelto) de la ventana de rollout', async () => {
    estado.rpc['accept_business_invitation'] = () => ({ data: USER_ID, error: null })
    const res = await acceptInvitation(TOKEN)
    expect(res.status).toBe('ACCEPTED')
    expect(res.businessId).toBeNull()
  })

  it('D · cada rechazo del servidor tiene su mensaje de UI', async () => {
    const casos: [string, string, string][] = [
      ['TRIEM', 'INVITATION_EMAIL_MISMATCH', 'INVITATION_EMAIL_MISMATCH'],
      ['TRIAM', 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS', 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS'],
      ['TRIEX', 'INVITATION_EXPIRED', 'INVITATION_EXPIRED'],
      ['TRICA', 'INVITATION_CANCELLED', 'INVITATION_CANCELLED'],
      ['TRINF', 'INVITATION_NOT_FOUND', 'INVITATION_NOT_FOUND'],
    ]
    for (const [sqlstate, mensajeServidor, codigoEsperado] of casos) {
      estado.rpc['accept_business_invitation'] = () => ({
        data: null, error: { code: sqlstate, message: mensajeServidor },
      })
      try {
        await acceptInvitation(TOKEN)
        throw new Error(`${codigoEsperado} debió fallar`)
      } catch (err) {
        expect(err).toBeInstanceOf(InvitationError)
        expect((err as InvitationError).code).toBe(codigoEsperado)
        // El texto es para una persona, no un volcado del servidor.
        expect((err as Error).message).not.toContain(mensajeServidor)
        expect((err as Error).message.length).toBeGreaterThan(20)
      }
    }
  })

  it('detecta el rechazo también SIN SQLSTATE (sólo por mensaje)', async () => {
    // PostgREST no siempre propaga el `code`; la detección mira los dos campos.
    estado.rpc['accept_business_invitation'] = () => ({
      data: null, error: { message: 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS' },
    })
    await expect(acceptInvitation(TOKEN))
      .rejects.toMatchObject({ code: 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · cancelar invitación', () => {
  it('usa la RPC y NUNCA escribe `revoked` en la tabla', async () => {
    estado.rpc['cancel_business_invitation'] = () => ({
      data: invitacionFalsa({ status: 'cancelled' }), error: null,
    })
    const res = await cancelInvitation('33333333-3333-4333-8333-333333333333')

    expect(res.status).toBe('cancelled')
    expect(estado.llamadas[0].nombre).toBe('cancel_business_invitation')
    // El bug anterior: `.update({ status: 'revoked' })` directo sobre la tabla.
    // No hay ningún UPDATE, y menos con un status fuera del CHECK.
    expect(estado.updates).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('preservación del token', () => {
  it('guarda, lee y consume una sola vez', () => {
    stashInviteToken(`  ${TOKEN} `)
    expect(peekInviteToken()).toBe(TOKEN)
    expect(takeInviteToken()).toBe(TOKEN)
    expect(peekInviteToken()).toBeNull()
  })

  it('vence: un token viejo no se recupera', () => {
    window.localStorage.setItem('trp_pending_invite', JSON.stringify({
      token: TOKEN, ts: Date.now() - 31 * 60 * 1000,
    }))
    expect(peekInviteToken()).toBeNull()
    expect(window.localStorage.getItem('trp_pending_invite')).toBeNull()
  })

  it('descarta un valor corrupto sin explotar', () => {
    window.localStorage.setItem('trp_pending_invite', 'no-es-json')
    expect(peekInviteToken()).toBeNull()
  })

  it('la ruta de aceptación codifica el token', () => {
    expect(acceptInviteePath('ab c&d')).toBe('/accept-invite?token=ab%20c%26d')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
function Sonda() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname + location.search}</span>
}

function montar(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/login" element={<div data-testid="login">LOGIN</div>} />
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const rutaActual = () => screen.getByTestId('ruta').textContent

describe('E · /accept-invite sin sesión', () => {
  it('manda a login CONSERVANDO el token en el redirect', async () => {
    estado.sessionUser = null
    montar(`/accept-invite?token=${TOKEN}`)

    await waitFor(() => expect(screen.getByTestId('login')).toBeTruthy())

    const ruta = rutaActual() ?? ''
    expect(ruta.startsWith('/login')).toBe(true)
    // El destino viaja en `?redirectTo=`, que es el mecanismo que ya usa la app
    // (Login y AuthCallback lo leen y lo normalizan con sanitizeInternalPath).
    const redirectTo = new URLSearchParams(ruta.split('?')[1]).get('redirectTo')
    expect(redirectTo).toBe(`/accept-invite?token=${TOKEN}`)

    // Y además queda guardado, porque el enlace de confirmación de correo se
    // abre en OTRA pestaña y sessionStorage no se comparte entre pestañas.
    expect(peekInviteToken()).toBe(TOKEN)

    // No se intentó aceptar sin sesión.
    expect(estado.llamadas.some(l => l.nombre === 'accept_business_invitation')).toBe(false)
  })
})

describe('F · /accept-invite con sesión', () => {
  it('acepta, refresca el perfil y entra al dashboard', async () => {
    estado.sessionUser = { id: USER_ID, email: 'invitado@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' }
    estado.rpc['accept_business_invitation'] = () => ({
      data: { business_id: BIZ_ID, role: 'tech', created: true, status: 'ACCEPTED' }, error: null,
    })

    montar(`/accept-invite?token=${TOKEN}`)

    await waitFor(() => {
      expect(estado.llamadas.some(l => l.nombre === 'accept_business_invitation')).toBe(true)
    })
    await waitFor(() => expect(screen.getByText(/Invitación aceptada/i)).toBeTruthy())

    // El perfil se releyó DESPUÉS de aceptar: sin esto AuthContext seguiría sin
    // negocio y el guard rebotaría al usuario apenas navegue.
    const idxAccept = estado.llamadas.findIndex(l => l.nombre === 'accept_business_invitation')
    const idxPerfilPost = estado.llamadas.findIndex((l, i) => i > idxAccept && l.nombre === 'get_my_profile')
    expect(idxPerfilPost).toBeGreaterThan(idxAccept)

    // El token guardado se consumió.
    expect(peekInviteToken()).toBeNull()

    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy(), { timeout: 4000 })
  })

  it('acepta una sola vez aunque el componente re-renderice', async () => {
    estado.sessionUser = { id: USER_ID, email: 'invitado@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' }
    estado.rpc['accept_business_invitation'] = () => ({
      data: { business_id: BIZ_ID, role: 'tech', created: true, status: 'ACCEPTED' }, error: null,
    })

    montar(`/accept-invite?token=${TOKEN}`)
    await waitFor(() => expect(screen.getByText(/Invitación aceptada/i)).toBeTruthy())

    expect(estado.llamadas.filter(l => l.nombre === 'accept_business_invitation')).toHaveLength(1)
  })

  it('email mismatch: mensaje claro y cero efectos', async () => {
    estado.sessionUser = { id: USER_ID, email: 'otro@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' }
    estado.rpc['accept_business_invitation'] = () => ({
      data: null, error: { code: 'TRIEM', message: 'INVITATION_EMAIL_MISMATCH' },
    })

    montar(`/accept-invite?token=${TOKEN}`)

    await waitFor(() => expect(screen.getByText(/otra dirección de correo/i)).toBeTruthy())
    expect(screen.queryByText(/INVITATION_EMAIL_MISMATCH/)).toBeNull()
    expect(screen.queryByTestId('dashboard')).toBeNull()
    // Rechazo definitivo: el token no queda dando vueltas.
    expect(peekInviteToken()).toBeNull()
  })

  it('miembro de otro negocio: fail closed con mensaje propio', async () => {
    estado.sessionUser = { id: USER_ID, email: 'invitado@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' }
    estado.rpc['accept_business_invitation'] = () => ({
      data: null, error: { code: 'TRIAM', message: 'ALREADY_MEMBER_OF_ANOTHER_BUSINESS' },
    })

    montar(`/accept-invite?token=${TOKEN}`)

    await waitFor(() => expect(screen.getByText(/ya pertenece a otro negocio/i)).toBeTruthy())
    expect(screen.queryByTestId('dashboard')).toBeNull()
  })

  it('G · el camino de invitación NUNCA llama a provision_my_business', async () => {
    estado.sessionUser = { id: USER_ID, email: 'invitado@invalid.test', email_confirmed_at: '2026-08-24T00:00:00Z' }
    estado.rpc['accept_business_invitation'] = () => ({
      data: { business_id: BIZ_ID, role: 'tech', created: true, status: 'ACCEPTED' }, error: null,
    })

    montar(`/accept-invite?token=${TOKEN}`)
    await waitFor(() => expect(screen.getByText(/Invitación aceptada/i)).toBeTruthy())

    // Es la invariante central: un invitado no crea un tenant propio.
    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Lee un archivo SIN comentarios.
 *
 * Los chequeos estructurales buscan CÓDIGO. Sobre el texto crudo se disparan con
 * su propia documentación: estos archivos explican a propósito qué bug cerraron
 * y citan `provision_my_business`, `status: 'revoked'` y la firma vieja. Ya pasó
 * exactamente lo mismo con la postcondición P3 de la migración.
 */
const leerCodigo = (rel: string) =>
  leer(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // bloques  /* ... */
    .replace(/^\s*\/\/.*$/gm, '')       // líneas    // ...
    .replace(/^\s*\*.*$/gm, '')         // cuerpo de un JSDoc

const ARCHIVOS = [
  'src/services/usersService.ts',
  'src/services/invitationsService.ts',
  'src/pages/UsersManagement.tsx',
]

describe('H · estructura del repo', () => {
  it('AcceptInvite no llama a provision_my_business', () => {
    const src = leerCodigo('src/pages/AcceptInvite.tsx')
    expect(src).not.toContain('provisionMyBusiness')
    expect(src).not.toContain('provision_my_business')
  })

  it('no queda ningún `revoked` como estado de invitación', () => {
    for (const archivo of ARCHIVOS) {
      expect(leerCodigo(archivo)).not.toMatch(/status:\s*'revoked'/)
    }
  })

  it('la RPC de creación tiene UN solo caller y no le manda business_id', () => {
    // invitationsService es el único que puede nombrarla.
    const servicio = leerCodigo('src/services/invitationsService.ts')
    const llamada = servicio.match(/rpc\(\s*'create_business_invitation'[\s\S]{0,220}?\}\)/)
    expect(llamada).not.toBeNull()
    // Se acota a ESTA llamada: `check_user_limit_before_invite` recibe
    // `p_business_id` de forma legítima y sigue existiendo — es una consulta de
    // plan, de sólo lectura, no una decisión de autorización.
    expect(llamada?.[0]).not.toContain('p_business_id')

    for (const archivo of ['src/services/usersService.ts', 'src/pages/UsersManagement.tsx']) {
      expect(leerCodigo(archivo)).not.toContain('create_business_invitation')
      expect(leerCodigo(archivo)).not.toContain('accept_business_invitation')
    }
  })

  it('las escrituras de invitaciones pasan SÓLO por RPC', () => {
    // `authenticated` no tiene INSERT/UPDATE/DELETE sobre business_invitations:
    // un `.update()` o `.insert()` directo no puede funcionar, y si alguien lo
    // reintrodujera fallaría en runtime en vez de en un test.
    const servicio = leer('src/services/invitationsService.ts')
    expect(servicio).not.toMatch(/from\('business_invitations'\)[\s\S]{0,120}\.(update|insert|delete)\(/)
  })
})
