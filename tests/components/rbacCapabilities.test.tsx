// ─────────────────────────────────────────────────────────────────────────────
// P0-P6 — RBAC de superficie: sidebar, dashboard y rutas.
//
// Contraparte de tests/sql/p0p6_capability_rbac.test.sql (contrato del
// servidor). Allá se prueba que el dato NO SALE de la base; acá, que la
// interfaz no lo ofrece ni lo pide.
//
// El incidente que disparó el lote: un técnico invitado vio en su sidebar
// Mayorista, Mi Guita, Suscripciones, Leads y la sección SAAS ADMIN, y en su
// dashboard Ganancia Real, Cobrado en caja y Caja neta.
//
// El borde mockeado es `src/lib/supabase`. Los componentes y los hooks de
// permisos corren de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '22222222-2222-4222-8222-222222222222'

const estado = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; email_confirmed_at: string | null } | null,
  perfil: null as Record<string, unknown> | null,
  systemAdmin: false,
  /** Tablas consultadas: es como se mide que un dato NO se pidió. */
  tablasLeidas: [] as string[],
  rpcs: [] as string[],
}))

vi.mock('../../src/lib/supabase', () => {
  const chain = (tabla: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => { estado.tablasLeidas.push(tabla); return c },
      eq: () => c,
      gte: () => c,
      lte: () => c,
      gt: () => c,
      in: () => c,
      order: () => c,
      limit: () => c,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null }),
    }
    return c
  }
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: estado.sessionUser ? { user: estado.sessionUser } : null }, error: null,
        }),
        getUser: async () => ({ data: { user: estado.sessionUser }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => ({ error: null }),
      },
      rpc: async (nombre: string) => {
        estado.rpcs.push(nombre)
        if (nombre === 'get_my_profile') return { data: estado.perfil, error: null }
        return { data: null, error: null }
      },
      from: (tabla: string) => {
        if (tabla === 'system_admins') {
          const c: Record<string, unknown> = {
            select: () => c, eq: () => c,
            maybeSingle: async () => ({
              data: estado.systemAdmin ? { user_id: USER_ID, is_active: true } : null, error: null,
            }),
          }
          return c
        }
        return chain(tabla)
      },
    },
  }
})

import { AuthProvider } from '../../src/contexts/AuthContext'
import { ProtectedRouteByPermission } from '../../src/components/auth/ProtectedRouteByPermission'
import {
  effectivePermissions,
} from '../../src/hooks/usePermissions'
import {
  ROLE_DEFAULT_PERMISSIONS, ALL_PERMISSIONS, CONFIGURABLE_PERMISSIONS,
  NON_CONFIGURABLE_PERMISSIONS,
} from '../../src/config/permissions'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')
const leerCodigo = (rel: string) =>
  leer(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')

const perfil = (role: string, permissions: unknown = null) => ({
  id: USER_ID, business_id: BIZ_ID, role, is_active: true,
  full_name: 'Usuario', email: 'u@invalid.test',
  phone: null, permissions,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

beforeEach(() => {
  estado.sessionUser = { id: USER_ID, email: 'u@invalid.test', email_confirmed_at: '2026-08-26T00:00:00Z' }
  estado.perfil = null
  estado.systemAdmin = false
  estado.tablasLeidas = []
  estado.rpcs = []
  window.localStorage.clear()
  window.sessionStorage.clear()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · defaults por rol (modelo puro)', () => {
  it('tech: sin finanzas, sin costos, sin mayorista, sin Mi Guita', () => {
    const p = effectivePermissions('tech', false, null)
    expect(p.orders).toBe(true)               // tiene que poder trabajar
    expect(p.orders_change_status).toBe(true)
    expect(p.finance).toBe(false)
    expect(p.reports).toBe(false)
    expect(p.inventory_view_costs).toBe(false)
    expect(p.orders_view_financials).toBe(false)
    expect(p.wholesale).toBe(false)
    expect(p.personal_finance).toBe(false)
    expect(p.users).toBe(false)
    expect(p.settings_sensitive).toBe(false)
  })

  it('owner conserva su acceso completo al negocio', () => {
    const p = effectivePermissions('owner', true, null)
    expect(p.finance).toBe(true)
    expect(p.reports).toBe(true)
    expect(p.users).toBe(true)
    expect(p.wholesale).toBe(true)
    expect(p.inventory_view_costs).toBe(true)
  })

  it('Mi Guita está cerrado para los 7 roles, incluido owner', () => {
    for (const rol of Object.keys(ROLE_DEFAULT_PERMISSIONS)) {
      expect(ROLE_DEFAULT_PERMISSIONS[rol].personal_finance, `${rol} tiene Mi Guita`).toBe(false)
    }
  })

  it('un override habilita SÓLO su capacidad, sin escalar', () => {
    const p = effectivePermissions('tech', false, { finance: true })
    expect(p.finance).toBe(true)
    // No infiere otras capacidades desde ésa.
    expect(p.users).toBe(false)
    expect(p.settings_sensitive).toBe(false)
    expect(p.inventory_view_costs).toBe(false)
    expect(p.wholesale).toBe(false)
  })

  it('un payload de overrides roto NO amplía privilegios', () => {
    const p = effectivePermissions('tech', false, { finance: 'si' })
    // `malformed` → DENY_ALL: ni siquiera conserva lo que el rol sí tenía.
    expect(p.finance).toBe(false)
    expect(p.orders).toBe(false)
  })

  it('Mi Guita no es configurable desde la matriz', () => {
    expect(NON_CONFIGURABLE_PERMISSIONS).toContain('personal_finance')
    expect(CONFIGURABLE_PERMISSIONS).not.toContain('personal_finance')
    // Y el resto sí sigue siendo configurable.
    expect(CONFIGURABLE_PERMISSIONS.length).toBe(ALL_PERMISSIONS.length - NON_CONFIGURABLE_PERMISSIONS.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
function Sonda() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname}</span>
}

function montarRuta(permission: Parameters<typeof ProtectedRouteByPermission>[0]['permission'], ruta: string, allowSystemOwner = false) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route element={<ProtectedRouteByPermission permission={permission} allowSystemOwner={allowSystemOwner} />}>
            <Route path={ruta} element={<div data-testid="permitido">PERMITIDO</div>} />
          </Route>
          <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('B · guards de ruta (un sidebar oculto NO es protección)', () => {
  it('tech en /finance → denegado', async () => {
    estado.perfil = perfil('tech')
    montarRuta('finance', '/finance')
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
    expect(screen.queryByTestId('permitido')).toBeNull()
  })

  it('tech en /mayorista → denegado', async () => {
    estado.perfil = perfil('tech')
    montarRuta('wholesale', '/mayorista')
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
  })

  it('tech en /users → denegado', async () => {
    estado.perfil = perfil('tech')
    montarRuta('users', '/users')
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
  })

  it('owner en /finance → permitido (no se rompe la operación legítima)', async () => {
    estado.perfil = perfil('owner')
    montarRuta('finance', '/finance')
    await waitFor(() => expect(screen.getByTestId('permitido')).toBeTruthy())
  })

  it('tech CON override de finance → permitido', async () => {
    estado.perfil = perfil('tech', { finance: true })
    montarRuta('finance', '/finance')
    await waitFor(() => expect(screen.getByTestId('permitido')).toBeTruthy())
  })

  it('NO decide antes de que el perfil termine de cargar', async () => {
    // Sin perfil resuelto el guard tiene que esperar, no negar: negar durante la
    // hidratación rebotaría a un usuario legítimo (misma clase de bug que P0-P4).
    estado.perfil = perfil('owner')
    montarRuta('finance', '/finance')
    // En el primer render no puede haber redirigido todavía.
    expect(screen.queryByTestId('dashboard')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('permitido')).toBeTruthy())
  })

  it('system owner entra a Mi Guita aunque el tenant no le dé la capacidad', async () => {
    // `useSystemOwner` cachea el resultado a nivel de MÓDULO, con el user id
    // como clave. Reusar el mismo id que los tests anteriores devolvería el
    // `false` cacheado y esto fallaría por la caché, no por el contrato.
    const otroId = '99999999-9999-4999-8999-999999999999'
    estado.sessionUser = { id: otroId, email: 'interno@invalid.test', email_confirmed_at: '2026-08-26T00:00:00Z' }
    estado.perfil = { ...perfil('owner'), id: otroId }
    estado.systemAdmin = true
    montarRuta('personal_finance', '/mi-guita', true)
    await waitFor(() => expect(screen.getByTestId('permitido')).toBeTruthy())
  })

  it('un owner NORMAL no entra a Mi Guita', async () => {
    const otroId = '88888888-8888-4888-8888-888888888888'
    estado.sessionUser = { id: otroId, email: 'owner@invalid.test', email_confirmed_at: '2026-08-26T00:00:00Z' }
    estado.perfil = { ...perfil('owner'), id: otroId }
    estado.systemAdmin = false
    montarRuta('personal_finance', '/mi-guita', true)
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · estructura del sidebar', () => {
  const src = leerCodigo('src/components/layout/Sidebar.tsx')
  const navigationGate = leerCodigo('src/hooks/useNavigationAccess.ts')

  it('SaaS Admin depende SÓLO del gate de system owner', () => {
    // El bug: `if (!item.permission || !can(item.permission)) return !item.permission`
    // devolvía true para cualquier item sin `permission`, así que
    // `systemOwnerOnly` NUNCA se evaluaba y la sección se le mostraba a todos.
    expect(src).not.toMatch(/return !item\.permission/)
    // Y el gate se evalúa antes de cualquier return temprano.
    expect(src).toContain('isNavigationItemAuthorized(item, access)')
    expect(navigationGate).toMatch(/item\.systemOwnerOnly && !access\.isSystemOwner\) return false/)
  })

  it('Mayorista exige feature Y capacidad, no sólo el plan', () => {
    expect(navigationGate).toMatch(/access\.wholesale\.canView/)
    expect(navigationGate).toMatch(/access\.mayoristaEnabled/)
    expect(navigationGate).toMatch(/access\.can\('wholesale'\)/)
  })

  it('Mi Guita declara un gate', () => {
    const linea = src.split('\n').find(l => l.includes("path: '/mi-guita'")) ?? ''
    expect(linea).toContain('personal_finance')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · dashboard', () => {
  const src = leerCodigo('src/pages/Dashboard.tsx')

  it('las tarjetas financieras están detrás de la capacidad', () => {
    expect(src).toMatch(/puedeVerFinanzas\s*=\s*can\('finance'\)/)
    expect(src).toMatch(/\{puedeVerFinanzas && \(/)
  })

  it('NO consulta los datos financieros cuando no puede mostrarlos', () => {
    // §6 del contrato: `permission false → no ejecutar la query`, en vez de
    // traer el dato y esconder la tarjeta. Esconderla dejaría la ganancia en la
    // respuesta HTTP, visible en la pestaña Network.
    expect(src).toMatch(/useFinancialDashboard\(puedeVerFinanzas \? businessId : null/)
    expect(src).toMatch(/!puedeVerFinanzas\) \{ setMovimientosCaja\(\[\]\); return \}/)
  })

  it('los accesos rápidos declaran la capacidad que necesitan', () => {
    expect(src).toMatch(/\.filter\(action => can\(action\.need\)\)/)
    expect(src).toMatch(/'Registrar Gasto'[\s\S]{0,220}need: 'finance'/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E · Mi Guita fail-closed', () => {
  const src = leerCodigo('src/components/auth/PersonalProtectedRoute.tsx')

  it('el gate es system_admins, no el plan', () => {
    // Antes el único gate era `hasFeature('personal_finance')`, o sea el PLAN
    // del negocio: cualquier miembro de un Pro/Full entraba.
    expect(src).toMatch(/if \(!isSystemOwner\)/)
    expect(src).toMatch(/Navigate to="\/dashboard"/)
  })

  it('espera la respuesta del servidor antes de decidir', () => {
    expect(src).toMatch(/systemOwnerLoading\) return/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('F · el frontend y la DB describen el MISMO contrato', () => {
  // El helper se redefine aditivamente cuando nace una capacidad nueva; el
  // contrato efectivo es la suma ordenada de la definición base y su override.
  const sql = leer('supabase/migrations/20260826120000_p0p6_capability_rbac.sql')
    + leer('supabase/migrations/20260903120000_mobile2a_order_intake.sql')

  it('el helper server-side conoce todas las capacidades del frontend', () => {
    // Si alguien agrega una capacidad al frontend y se olvida del helper, la
    // RLS la trataría como clave desconocida → false, y el usuario perdería
    // acceso sin explicación. Este test lo caza en CI.
    for (const key of ALL_PERMISSIONS) {
      expect(sql, `current_user_can() no conoce '${key}'`).toContain(`WHEN '${key}' THEN`)
    }
  })

  it('los defaults de tech coinciden en los dos lados', () => {
    // El caso que importa: el rol del incidente.
    const bloque = sql.slice(sql.indexOf('v_default := CASE p_key'))
    // Cada rama va hasta el próximo WHEN/ELSE: las arms de un CASE no llevan
    // `;`, así que buscar uno hacía que el match nunca cerrara.
    const rama = (key: string) =>
      new RegExp(`WHEN '${key}' THEN([\\s\\S]*?)(?=\\n\\s*WHEN '|\\n\\s*ELSE)`).exec(bloque)

    // tech NO aparece en las capacidades sensibles...
    for (const sensible of ['finance', 'reports', 'inventory_view_costs', 'settings', 'users']) {
      const m = rama(sensible)
      expect(m, `falta la rama de ${sensible}`).not.toBeNull()
      expect(m![1], `${sensible} incluye tech en el servidor`).not.toContain("'tech'")
      expect(ROLE_DEFAULT_PERMISSIONS.tech[sensible as keyof typeof ROLE_DEFAULT_PERMISSIONS.tech]).toBe(false)
    }
    // ...y sí en las que necesita para trabajar.
    expect(ROLE_DEFAULT_PERMISSIONS.tech.orders).toBe(true)
    expect(rama('orders')![1]).toContain("'tech'")
  })
})
