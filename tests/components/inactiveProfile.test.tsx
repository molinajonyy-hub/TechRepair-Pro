// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-2D — perfil desactivado (`is_active = false`): estado TERMINAL.
//
// Antes caía en AUTH_ERROR y /no-business decía «puede ser un problema de
// conexión» con un Reintentar que nunca iba a funcionar. Ahora:
//   I1  pantalla propia «Tu acceso a este negocio está desactivado»
//   I2  sin «Crear mi taller», sin Reintentar, sin «aceptar invitación»
//   I3  sin loop: get_my_profile no se vuelve a pedir solo; nunca se provisiona
//   I4  cerrar sesión funciona y lleva a /login
//   I5  el soporte es el canónico (mailto)
//   I6  un fallo TRANSITORIO sigue siendo «reintentar» (no se confunde)
//
// El borde mockeado es `src/lib/supabase`. AuthProvider, ProtectedRoute y
// NoBusiness corren de verdad. La autoridad (RLS, is_active) no se toca.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from '../../src/contexts/AuthContext'
import { ProtectedRoute } from '../../src/components/auth/ProtectedRoute'
import { NoBusiness } from '../../src/pages/NoBusiness'
import { CONTACTO_SOPORTE } from '../../src/config/contacto'
import { stashInviteToken } from '../../src/lib/pendingInvite'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '33333333-3333-4333-8333-333333333333'

const estado = vi.hoisted(() => ({
  profile: null as unknown,
  profileError: null as null | { message: string },
  signedIn: true,
  llamadas: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const session = () => (estado.signedIn
    ? { user: { id: USER_ID, email: 'tecnico@invalid.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }
    : null)
  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: session() }, error: null }),
        getUser: async () => ({ data: { user: session()?.user ?? null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => {
          estado.llamadas.push('signOut')
          estado.signedIn = false
          return { error: null }
        },
      },
      rpc: async (nombre: string) => {
        estado.llamadas.push(nombre)
        if (nombre === 'get_my_profile') return { data: estado.profile, error: estado.profileError }
        return { data: null, error: null }
      },
    },
  }
})

vi.mock('../../src/services/provisioningService', () => ({
  provisionMyBusiness: async () => {
    estado.llamadas.push('provisionMyBusiness')
    return { status: 'created' }
  },
}))

const perfilInactivo = {
  id: USER_ID,
  user_id: USER_ID,
  business_id: BIZ_ID,
  role: 'tech',
  is_active: false,
  full_name: 'Técnico',
  email: 'tecnico@invalid.test',
  permissions: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function Sonda() {
  return <span data-testid="ruta">{useLocation().pathname}</span>
}

function montar(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<div data-testid="login">LOGIN</div>} />
          <Route path="/no-business" element={<NoBusiness />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  estado.profile = [perfilInactivo]
  estado.profileError = null
  estado.signedIn = true
  estado.llamadas = []
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('PRE-BETA-2D · perfil desactivado', () => {
  it('I1+I2. el guard lo manda a /no-business y ve la pantalla terminal, sin crear ni reintentar', async () => {
    montar('/dashboard')
    const pantalla = await screen.findByTestId('no-business-inactive')
    expect(screen.getByTestId('ruta').textContent).toBe('/no-business')
    expect(pantalla.textContent).toContain('Tu acceso a este negocio está desactivado')
    expect(screen.queryByTestId('no-business-crear')).toBeNull()
    expect(screen.queryByTestId('no-business-create')).toBeNull()
    expect(screen.queryByTestId('no-business-reintentar')).toBeNull()
    expect(screen.queryByTestId('no-business-error')).toBeNull()
    expect(document.body.textContent).not.toMatch(/Crear mi taller|Reintentar|problema de conexión/)
  })

  it('I2b. aun con un token de invitación guardado, no ofrece aceptarla', async () => {
    stashInviteToken('tok-invitacion-sintetica')
    montar('/no-business')
    await screen.findByTestId('no-business-inactive')
    expect(screen.queryByTestId('no-business-aceptar-invitacion')).toBeNull()
  })

  it('I3. sin loop: el perfil no se re-pide solo y nunca se provisiona', async () => {
    montar('/no-business')
    await screen.findByTestId('no-business-inactive')
    const pedidos = estado.llamadas.filter(c => c === 'get_my_profile').length
    await new Promise(r => setTimeout(r, 600))
    expect(estado.llamadas.filter(c => c === 'get_my_profile').length).toBe(pedidos)
    expect(estado.llamadas).not.toContain('provisionMyBusiness')
    expect(estado.llamadas).not.toContain('provision_my_business')
  })

  it('I4. cerrar sesión funciona y va a /login', async () => {
    montar('/no-business')
    fireEvent.click(await screen.findByTestId('no-business-inactive-salir'))
    await waitFor(() => expect(screen.getByTestId('ruta').textContent).toBe('/login'))
    expect(estado.llamadas).toContain('signOut')
  })

  it('I5. el soporte visible es el canónico', async () => {
    montar('/no-business')
    const pantalla = await screen.findByTestId('no-business-inactive')
    expect(pantalla.textContent).toContain(CONTACTO_SOPORTE)
    expect(pantalla.querySelector(`a[href="mailto:${CONTACTO_SOPORTE}"]`)).toBeTruthy()
  })

  it('I6. un fallo transitorio sigue ofreciendo reintentar (no es «desactivado»)', async () => {
    estado.profile = null
    estado.profileError = { message: 'permission denied for function get_my_profile' }
    montar('/no-business')
    expect(await screen.findByTestId('no-business-reintentar')).toBeTruthy()
    expect(screen.queryByTestId('no-business-inactive')).toBeNull()
  })
})
