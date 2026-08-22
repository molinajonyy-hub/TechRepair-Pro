// ─────────────────────────────────────────────────────────────────────────────
// P0 AUTH — AuthContext: identidad vs reparación
//
// Contraparte de tests/sql/auth_profile_linking.test.sql. Allá se verifica el
// contrato del servidor; acá, que AuthContext lo ORQUESTE bien:
//
//   A. get_my_profile devuelve perfil          -> NO se llama a link
//   B. get devuelve null + link devuelve perfil -> la sesión queda hidratada
//   C. link falla de verdad                     -> NO se reporta como
//                                                  "no existe perfil"
//   D. get null + link null                     -> estado normal sin perfil
//   E. el perfil vinculado conserva permissions
//   F. una sola pasada: ni loop de reintentos ni refetch infinito
//
// El borde mockeado es `src/lib/supabase`. AuthContext corre de verdad: es el
// código bajo prueba.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../../src/contexts/AuthContext'
import { usePermissions } from '../../src/hooks/usePermissions'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE_ID = '22222222-2222-4222-8222-222222222222'
const BIZ_ID = '33333333-3333-4333-8333-333333333333'

const estado = vi.hoisted(() => ({
  getProfile: null as unknown,
  getError: null as { message: string } | null,
  linkProfile: null as unknown,
  linkError: null as { message: string } | null,
  llamadas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: USER_ID } } },
        error: null,
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
    rpc: async (nombre: string) => {
      estado.llamadas.push(nombre)
      if (nombre === 'get_my_profile') {
        return { data: estado.getProfile, error: estado.getError }
      }
      if (nombre === 'link_profile_to_auth_user') {
        return { data: estado.linkProfile, error: estado.linkError }
      }
      return { data: null, error: null }
    },
  },
}))

/** Sonda: expone lo que ve un consumidor real del contexto. */
function Sonda() {
  const { profile, profileError, profileLoading } = useAuth()
  const { can } = usePermissions()
  return (
    <div>
      <span data-testid="cargando">{String(profileLoading)}</span>
      <span data-testid="profile-id">{profile?.id ?? '(sin perfil)'}</span>
      <span data-testid="business-id">{profile?.business_id ?? '(sin negocio)'}</span>
      <span data-testid="error">{profileError ?? '(sin error)'}</span>
      <span data-testid="puede-inventory-costs">{String(can('inventory_view_costs'))}</span>
    </div>
  )
}

const montar = async () => {
  render(
    <AuthProvider>
      <Sonda />
    </AuthProvider>,
  )
  await waitFor(() => {
    expect(screen.getByTestId('cargando')).toHaveTextContent('false')
  })
}

const perfilVinculado = {
  id: PROFILE_ID,
  user_id: USER_ID,
  business_id: BIZ_ID,
  role: 'sales',
  is_active: true,
  full_name: 'Perfil de prueba',
  email: 'test@invalid.test',
  phone: null,
  permissions: { inventory_view_costs: true },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  estado.getProfile = null
  estado.getError = null
  estado.linkProfile = null
  estado.linkError = null
  estado.llamadas = []
  window.localStorage.clear()
})

describe('AuthContext — identidad vs reparación', () => {
  it('A. si get_my_profile devuelve perfil, NO se llama a link', async () => {
    estado.getProfile = [{ ...perfilVinculado, permissions: null, role: 'owner' }]

    await montar()

    expect(screen.getByTestId('profile-id')).toHaveTextContent(PROFILE_ID)
    expect(estado.llamadas).toContain('get_my_profile')
    expect(estado.llamadas).not.toContain('link_profile_to_auth_user')
  })

  it('B. get null + link devuelve perfil -> la sesión queda hidratada', async () => {
    estado.getProfile = []
    estado.linkProfile = [perfilVinculado]

    await montar()

    expect(estado.llamadas).toEqual(['get_my_profile', 'link_profile_to_auth_user'])
    expect(screen.getByTestId('profile-id')).toHaveTextContent(PROFILE_ID)
    expect(screen.getByTestId('business-id')).toHaveTextContent(BIZ_ID)
    expect(screen.getByTestId('error')).toHaveTextContent('(sin error)')
  })

  it('C. un error REAL del link no se reporta como "no existe perfil"', async () => {
    // El caso vivo: más de un huérfano con el mismo email y el servidor falla
    // cerrado (SQLSTATE TRLNK). Antes esto caía en un catch mudo y el usuario
    // veía "No existe un perfil de negocio", que manda a diagnosticar al lugar
    // equivocado.
    estado.getProfile = []
    estado.linkError = { message: 'Hay 2 perfiles huerfanos con ese email; no se vincula ninguno.' }

    await montar()

    const error = screen.getByTestId('error').textContent ?? ''
    expect(error).not.toContain('No existe un perfil de negocio')
    expect(error).toContain('No pudimos vincular')
    // Y no se filtran internals de SQL a la pantalla.
    expect(error).not.toContain('SQLSTATE')
    expect(error).not.toContain('huerfanos')
    expect(screen.getByTestId('profile-id')).toHaveTextContent('(sin perfil)')
  })

  it('D. get null + link null -> estado normal de "sin perfil de negocio"', async () => {
    estado.getProfile = []
    estado.linkProfile = []

    await montar()

    expect(estado.llamadas).toEqual(['get_my_profile', 'link_profile_to_auth_user'])
    expect(screen.getByTestId('error')).toHaveTextContent('No existe un perfil de negocio')
    expect(screen.getByTestId('profile-id')).toHaveTextContent('(sin perfil)')
  })

  it('E. el perfil vinculado conserva permissions y los hidrata', async () => {
    estado.getProfile = []
    estado.linkProfile = [perfilVinculado]

    await montar()

    // sales.inventory_view_costs = false por default; el override lo habilita.
    // Que dé true prueba que el override sobrevivió al camino de reparación.
    expect(screen.getByTestId('puede-inventory-costs')).toHaveTextContent('true')
  })

  it('F. no hay loop: una sola pasada de get + link', async () => {
    estado.getProfile = []
    estado.linkProfile = []

    await montar()
    // Margen para que un eventual reintento se manifieste.
    await new Promise(r => setTimeout(r, 60))

    expect(estado.llamadas.filter(n => n === 'get_my_profile')).toHaveLength(1)
    expect(estado.llamadas.filter(n => n === 'link_profile_to_auth_user')).toHaveLength(1)
  })

  it('F2. un link que falla tampoco se reintenta', async () => {
    estado.getProfile = []
    estado.linkError = { message: 'boom' }

    await montar()
    await new Promise(r => setTimeout(r, 60))

    expect(estado.llamadas.filter(n => n === 'link_profile_to_auth_user')).toHaveLength(1)
  })
})
