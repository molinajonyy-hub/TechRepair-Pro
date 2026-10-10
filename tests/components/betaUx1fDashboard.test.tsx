// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-1F — Inicio como centro operativo del taller.
//
//   DASHBOARD = operación.   FINANZAS = dinero.
//
// Antes Inicio mezclaba operación con finanzas: Ganancia Real, Cobrado en caja,
// Caja neta, una franja de caja, la tarjeta del dólar, seis accesos rápidos y
// tres pestañas (órdenes, comprobantes, movimientos de caja). Y pedía los datos
// financieros para TODOS los actores, también para quien no podía verlos.
//
// Acá se monta el Dashboard REAL con sus hooks reales (`usePermissions`,
// `useOperationalDashboardStats`, `CajaProvider`, `taskService`,
// `useFirstSteps`). El único borde simulado es `src/lib/supabase`, y registra
// cada tabla y cada RPC: así «no consulta finanzas» se mide sobre lo que
// realmente sale, no sobre lo que el código dice.
//
// jsdom no aplica `index.css`: la geometría, los 44 px y el contraste pintado
// viven en `tests/e2e/m7/dashboard-day-one.spec.ts`. Lo que sí se fija acá del
// CSS es su contrato (qué se ve en cada ancho, sólo tokens) y la aritmética
// WCAG de los pares de color que eligió el lote.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BIZ = '22222222-2222-4222-8222-222222222222'
const USER = '11111111-1111-4111-8111-111111111111'

interface FakeOrder {
  id: string
  status: string
  created_at: string
  customer: { name: string | null } | null
  device: { brand: string | null; model: string | null } | null
}
interface FakeTask {
  id: string; title: string; description: null; status: string; priority: string
  due_date: string | null; assigned_to: string; user_id: string
  started_at: null; completed_at: null; created_at: string
}
type Filtro = [op: string, columna: string, valor: unknown]

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  permissions: null as unknown,
  navigate: vi.fn(),
  orders: [] as FakeOrder[],
  ordersError: null as unknown,
  tasks: [] as FakeTask[],
  cajaAbierta: true,
  firstSteps: null as Record<string, boolean> | null,
  /**
   * Plan del negocio. `confirmado: false` es «la lectura terminó sin datos»;
   * `loading: true`, «todavía se está leyendo». En los dos casos el hook real
   * resuelve como un trial optimista, y el simulado hace lo mismo.
   */
  plan: { id: 'pro' as 'basico' | 'pro' | 'full', loading: false, confirmado: true },
  /** Cada `from(tabla)` del test en curso. */
  tablas: [] as string[],
  rpcs: [] as string[],
  /**
   * Lo mismo, pero de TODO el archivo: no se reinicia entre tests. Un hook con
   * caché de módulo consulta sólo la primera vez que se monta; el test que mira
   * la red puede no ser ese primer montaje, y sin esto no vería la consulta.
   */
  historial: { tablas: [] as string[], rpcs: [] as string[] },
  consultas: [] as { tabla: string; head: boolean; filtros: Filtro[] }[],
  dollar: {
    refreshDollarRate: null as unknown as ReturnType<typeof vi.fn>,
    refreshInventoryDollarPrices: null as unknown as ReturnType<typeof vi.fn>,
    clearDollarCache: null as unknown as ReturnType<typeof vi.fn>,
  },
}))

// ─── Supabase simulado: responde y REGISTRA ─────────────────────────────────
// La tabla se anota en el `from()`, no al resolver: una consulta que use un
// operador que este simulador no conoce (`neq`, `lte`, `in`…) igual queda
// registrada. Sin eso el contrato de red tenía un agujero: la consulta nueva
// explotaba antes de resolverse y no dejaba rastro. Por lo mismo la cadena
// acepta cualquier método desconocido en vez de fallar.
vi.mock('../../src/lib/supabase', () => {
  const from = (tabla: string) => {
    h.tablas.push(tabla)
    h.historial.tablas.push(tabla)
    const filtros: Filtro[] = []
    let head = false
    let limite = 0
    let escritura: 'update' | 'insert' | null = null

    const resolver = () => {
      h.consultas.push({ tabla, head, filtros })
      if (escritura) return { data: tabla === 'tasks' ? [{ ...h.tasks[0], status: 'completed' }] : [], error: null }

      if (tabla === 'orders') {
        if (h.ordersError) return { data: null, count: null, error: h.ordersError }
        let filas = h.orders
        for (const [op, columna, valor] of filtros) {
          if (op === 'eq' && columna === 'status') filas = filas.filter(o => o.status === valor)
          if (op === 'gte' && columna === 'created_at') filas = filas.filter(o => new Date(o.created_at) >= new Date(String(valor)))
        }
        if (head) return { data: null, count: filas.length, error: null }
        const ordenadas = [...filas].sort((a, b) => b.created_at.localeCompare(a.created_at))
        return { data: limite ? ordenadas.slice(0, limite) : ordenadas, error: null }
      }
      if (tabla === 'tasks') {
        const soloActivas = filtros.some(([op, columna]) => op === 'not' && columna === 'status')
        return { data: soloActivas ? h.tasks.filter(t => t.status !== 'completed' && t.status !== 'cancelled') : h.tasks, error: null }
      }
      return { data: [], error: null }
    }

    const c: Record<string, unknown> = {
      select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) head = true; return c },
      update: () => { escritura = 'update'; return c },
      insert: () => { escritura = 'insert'; return c },
      eq: (columna: string, valor: unknown) => { filtros.push(['eq', columna, valor]); return c },
      gte: (columna: string, valor: unknown) => { filtros.push(['gte', columna, valor]); return c },
      not: (columna: string, _op: string, valor: unknown) => { filtros.push(['not', columna, valor]); return c },
      or: (valor: string) => { filtros.push(['or', '', valor]); return c },
      order: () => c,
      limit: (n: number) => { limite = n; return c },
      maybeSingle: async () => {
        if (tabla === 'cajas') {
          return {
            data: h.cajaAbierta
              ? { id: 'caja-1', business_id: BIZ, opened_at: '2026-10-09T12:20:00Z', opened_by: USER, status: 'abierta' }
              : null,
            error: null,
          }
        }
        return { data: null, error: null }
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(res, rej),
    }
    // Cualquier otro operador de PostgREST: se acepta y se sigue encadenando.
    const cadena: Record<string, unknown> = new Proxy(c, {
      get: (objetivo, metodo) => {
        if (metodo in objetivo || typeof metodo !== 'string') return objetivo[metodo as string]
        return (columna: string, valor: unknown) => { filtros.push([metodo, columna, valor]); return cadena }
      },
    })
    for (const metodo of ['select', 'update', 'insert', 'eq', 'gte', 'not', 'or', 'order', 'limit'] as const) {
      const propio = c[metodo] as (...args: unknown[]) => unknown
      c[metodo] = (...args: unknown[]) => { propio(...args); return cadena }
    }
    return cadena
  }

  const rpc = (nombre: string) => {
    h.rpcs.push(nombre)
    h.historial.rpcs.push(nombre)
    const valor = nombre === 'get_my_first_steps'
      ? { data: h.firstSteps, error: null }
      : { data: null, error: null }
    return {
      single: async () => valor,
      then: (res: (v: unknown) => unknown) => Promise.resolve(valor).then(res),
    }
  }

  return { supabase: { from, rpc } }
})

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    businessId: BIZ,
    user: { id: USER },
    role: h.role,
    isOwner: h.role === 'owner',
    profile: { permissions: h.permissions },
    isAuthenticated: true,
    hasBusinessAccess: true,
    loading: false,
    profileLoading: false,
  }),
}))

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}))

// La cotización es un servicio de red: se simula el servicio, no el estado
// compartido (`useDollarRate`), que es parte de lo que se prueba.
vi.mock('../../src/services/dollarRateService', async (orig) => {
  const real = await orig<typeof import('../../src/services/dollarRateService')>()
  h.dollar.refreshDollarRate = vi.fn()
  h.dollar.refreshInventoryDollarPrices = vi.fn()
  h.dollar.clearDollarCache = vi.fn()
  return {
    ...real,
    refreshDollarRate: h.dollar.refreshDollarRate,
    refreshInventoryDollarPrices: h.dollar.refreshInventoryDollarPrices,
    clearDollarCache: h.dollar.clearDollarCache,
  }
})

// El plan es un dato del servidor: se simula el hook que lo lee, pero quién
// tiene qué feature lo resuelve el código REAL (`resolveEntitlement` sobre la
// tabla de planes), incluido el trial optimista cuando todavía no hay datos.
vi.mock('../../src/hooks/useSubscription', async () => {
  const { resolveEntitlement } = await import('../../src/lib/entitlements')
  return {
    useSubscription: () => {
      const conDatos = !h.plan.loading && h.plan.confirmado
      const resuelto = resolveEntitlement(conDatos
        ? { subscription_status: 'active', subscription_plan: h.plan.id }
        : {})
      return {
        loading: h.plan.loading,
        subscription: conDatos ? { subscription_status: 'active', subscription_plan: h.plan.id } : null,
        currentPlan: resuelto.currentPlan,
        planFeatures: resuelto.planFeatures,
        hasFeature: resuelto.hasFeature,
      }
    },
  }
})
// Vecinos del guard de `/tasks`, que se monta de verdad para comparar.
vi.mock('../../src/hooks/useSystemOwner', () => ({ useSystemOwner: () => ({ isSystemOwner: false, loading: false }) }))
vi.mock('../../src/components/subscription/UpgradeRequired', () => ({ UpgradeRequired: () => null }))

// Vecinos de `TopHeader` que no son parte del lote.
vi.mock('../../src/contexts/SystemStatusContext', () => ({
  useSystemStatus: () => ({ status: 'online', triggerRefresh: vi.fn() }),
}))
vi.mock('../../src/components/layout/NotificationsDropdown', () => ({ NotificationsDropdown: () => null }))
vi.mock('../../src/components/ui/ThemeToggle', () => ({ ThemeToggle: () => null }))

import { Dashboard } from '../../src/pages/Dashboard'
import { TopHeader } from '../../src/components/layout/TopHeader'
import { CajaProvider } from '../../src/contexts/CajaContext'
import { DollarRateBadge } from '../../src/components/ui/DollarRateBadge'
import { DashboardTasks } from '../../src/components/tasks/DashboardTasks'
import { invalidateOperationalDashboardStats, RECENT_ORDERS_LIMIT } from '../../src/hooks/useOperationalDashboardStats'
import { resetDollarRateStore } from '../../src/hooks/useDollarRate'
import { TASKS_ACCESS_GATE } from '../../src/hooks/useTasksAccess'
import { isNavigationItemAuthorized, type NavigationAccess } from '../../src/hooks/useNavigationAccess'
import { effectivePermissions } from '../../src/hooks/usePermissions'
import { resolveEntitlement } from '../../src/lib/entitlements'
import { ALL_PERMISSIONS } from '../../src/config/permissions'
import { PLAN_FEATURES } from '../../src/config/planFeatures'
import { ProtectedRouteByPermission } from '../../src/components/auth/ProtectedRouteByPermission'
import { ProtectedRouteByFeature } from '../../src/components/auth/ProtectedRouteByFeature'
import { taskService, isTaskDueToday } from '../../src/services/taskService'
import { isDueTodayTask } from '../../src/components/tasks/taskGrouping'
import { STATUS_CONFIG } from '../../src/types/orderStatus'

const here = dirname(fileURLToPath(import.meta.url))
const raiz = join(here, '../../')
const leer = (rel: string) => readFileSync(join(raiz, rel), 'utf8')
const sinComentarios = (texto: string) =>
  texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const leerCodigo = (rel: string) => sinComentarios(leer(rel))

// ─── Datos ──────────────────────────────────────────────────────────────────

const AHORA = Date.now()
const haceHoras = (n: number) => new Date(AHORA - n * 3600e3).toISOString()
const orden = (n: number, status: string, horas: number, cliente: string | null = `Cliente ${n}`): FakeOrder => ({
  id: `0000000${n.toString(16)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  status,
  created_at: haceHoras(horas),
  customer: cliente ? { name: cliente } : null,
  device: n % 4 === 0 ? null : { brand: 'Samsung', model: `A${n}` },
})

/** 12 órdenes: 9 activas (2 listas, 1 esperando aprobación), 2 completadas, 1 cancelada. */
const ORDENES: FakeOrder[] = [
  orden(1, 'repair', 1),
  orden(2, 'ready_delivery', 2),
  orden(3, 'waiting_approval', 3),
  orden(4, 'diagnosis', 4, null),
  orden(5, 'new', 5),
  orden(6, 'completed', 30),
  orden(7, 'completed', 40),
  orden(8, 'cancelled', 50),
  orden(9, 'ready_delivery', 60),
  orden(10, 'waiting_parts', 70),
  orden(11, 'repair', 80),
  orden(12, 'waiting_payment', 90),
]

const tarea = (n: number, over: Partial<FakeTask> = {}): FakeTask => ({
  id: `task-${n}`, title: `Tarea ${n}`, description: null, status: 'pending', priority: 'medium',
  due_date: null, assigned_to: USER, user_id: USER, started_at: null, completed_at: null,
  created_at: '2026-10-01T10:00:00Z', ...over,
})

const PASOS_COMPLETOS = { has_customer: true, has_order: true, has_inventory: true, has_cobro: true, has_logo: true }
const PASOS_PENDIENTES = { has_customer: false, has_order: false, has_inventory: false, has_cobro: false, has_logo: false }

const COTIZACION = () => ({
  sellPrice: 1556, buyPrice: 1530, source: 'AMBITO_NACIONAL' as const, fetchedAt: new Date(), isStale: false,
})

beforeEach(() => {
  h.role = 'owner'
  h.permissions = null
  h.navigate.mockReset()
  h.orders = ORDENES
  h.ordersError = null
  h.tasks = [tarea(1, { title: 'Llamar a Juan' })]
  h.cajaAbierta = true
  h.firstSteps = PASOS_COMPLETOS
  Object.assign(h.plan, { id: 'pro', loading: false, confirmado: true })
  h.tablas = []
  h.rpcs = []
  h.consultas = []
  h.dollar.refreshDollarRate.mockReset().mockImplementation(async () => COTIZACION())
  h.dollar.refreshInventoryDollarPrices.mockReset().mockResolvedValue({ updated: 0, rate: 1556 })
  h.dollar.clearDollarCache.mockReset()
  invalidateOperationalDashboardStats()
  resetDollarRateStore()
  window.localStorage.clear()
})

afterEach(() => { vi.useRealTimers() })

const montar = () => render(<MemoryRouter><CajaProvider><Dashboard /></CajaProvider></MemoryRouter>)

/** Monta y espera a que Inicio termine de leer órdenes y tareas. */
async function montarListo() {
  const vista = montar()
  await screen.findByTestId('dashboard-today')
  await waitFor(() => expect(screen.queryByTestId('dashboard-tasks-loading')).toBeNull())
  return vista
}

const pagina = () => screen.getByTestId('dashboard-page')
const boton = (nombre: string | RegExp) => screen.queryByRole('button', { name: nombre })

/** Fuentes que Inicio consumía y que no puede volver a pedir. */
const TABLAS_FINANCIERAS = [
  'business_finance_entries', 'v_finance_product_margin', 'v_finance_pnl', 'comprobante_items',
  'comprobante_payments', 'comprobantes', 'financial_movements', 'accounts', 'customers', 'inventory',
]
const RPCS_FINANCIERAS = [
  'get_order_financial_amounts', 'finance_dashboard_summary', 'can_view_cogs', 'can_view_inventory_cost',
]

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · Inicio no muestra dinero', () => {
  it('no existen las tarjetas financieras, ni siquiera para el dueño', async () => {
    await montarListo()
    for (const texto of [/Ganancia Real/i, /Cobrado en caja/i, /Caja neta/i, /Finanzas\s*→/, /margen/i, /Ver dashboard completo/i]) {
      expect(screen.queryByText(texto), `quedó «${texto}» en Inicio`).toBeNull()
    }
    expect(screen.queryByTestId('dash-ganancia-real')).toBeNull()
    expect(screen.queryByTestId('dashboard-kpis')).toBeNull()
  })

  it.each(['owner', 'admin', 'cashier', 'manager', 'sales', 'tech', 'viewer'])(
    '%s: ningún importe, ningún símbolo de moneda',
    async (rol) => {
      h.role = rol
      await montarListo()
      const texto = pagina().textContent ?? ''
      expect(texto, `${rol} ve un símbolo de moneda en Inicio`).not.toMatch(/\$/)
      expect(texto, `${rol} ve un número con forma de importe`).not.toMatch(/\b\d{1,3}\.\d{3}\b/)
      expect(texto).not.toMatch(/ARS|USD/)
    },
  )

  it('no existe la franja de caja ni la tarjeta del dólar en el cuerpo', async () => {
    await montarListo()
    expect(screen.queryByTestId('dash-estado-caja')).toBeNull()
    expect(within(pagina()).queryByText(/Caja (abierta|cerrada)/)).toBeNull()
    expect(within(pagina()).queryByText(/Dólar/i)).toBeNull()
    expect(within(pagina()).queryByTestId('shell-dollar-chip')).toBeNull()
    expect(within(pagina()).queryByTestId('shell-caja-chip')).toBeNull()
  })

  it('no existen los accesos rápidos', async () => {
    await montarListo()
    expect(screen.queryByTestId('dashboard-quick-actions')).toBeNull()
    expect(screen.queryByText('Accesos rápidos')).toBeNull()
    for (const nombre of ['Nuevo Cliente', 'Nuevo Producto', 'Nueva Garantía']) {
      expect(boton(nombre), `quedó el acceso rápido «${nombre}»`).toBeNull()
    }
  })

  it('no existen las pestañas de Comprobantes ni de Movimientos de Caja', async () => {
    await montarListo()
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    for (const texto of [/Movimientos/i, /Comprobantes Recientes/i, /^Comprobantes$/]) {
      expect(screen.queryByText(texto)).toBeNull()
    }
    expect(boton('Imprimir')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · Inicio no CONSULTA finanzas (red)', () => {
  it('dueño con caja abierta: sólo órdenes, tareas, primeros pasos y el estado de la caja', async () => {
    await montarListo()
    await act(async () => { await Promise.resolve() })

    // `cajas` lo lee `CajaProvider` (el estado, sin importes): es la excepción válida.
    expect([...new Set(h.tablas)].sort()).toEqual(['cajas', 'orders', 'tasks'])
    expect([...new Set(h.rpcs)]).toEqual(['get_my_first_steps'])
    for (const tabla of TABLAS_FINANCIERAS) expect(h.tablas, `Inicio consultó ${tabla}`).not.toContain(tabla)
    for (const rpc of RPCS_FINANCIERAS) expect(h.rpcs, `Inicio llamó a ${rpc}`).not.toContain(rpc)
    // Lo único que Inicio conserva del dólar es el reprecio heredado, por el
    // servicio y sobre la lectura compartida: una lectura (acá no hay barra que
    // la haya hecho antes), sin forzar, y un reprecio. Ver el bloque del shell.
    expect(h.dollar.refreshDollarRate).toHaveBeenCalledTimes(1)
    expect(h.dollar.refreshDollarRate).toHaveBeenCalledWith(BIZ, false)
    expect(h.dollar.refreshInventoryDollarPrices).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('técnico: ni siquiera el estado de la caja', async () => {
    h.role = 'tech'
    await montarListo()
    expect([...new Set(h.tablas)].sort()).toEqual(['orders', 'tasks'])
    for (const rpc of RPCS_FINANCIERAS) expect(h.rpcs).not.toContain(rpc)
  })

  it('las órdenes se piden sin columnas de importes y los conteos no bajan filas', async () => {
    await montarListo()
    const deOrdenes = h.consultas.filter(c => c.tabla === 'orders')
    // Seis conteos exactos y una lista: nada más.
    expect(deOrdenes.filter(c => c.head)).toHaveLength(6)
    expect(deOrdenes.filter(c => !c.head)).toHaveLength(1)
    // Todas acotadas al negocio.
    for (const c of deOrdenes) expect(c.filtros).toContainEqual(['eq', 'business_id', BIZ])

    const fuente = leerCodigo('src/hooks/useOperationalDashboardStats.ts')
    const tablas = [...fuente.matchAll(/\.from\('([^']+)'\)/g)].map(m => m[1])
    expect(new Set(tablas)).toEqual(new Set(['orders']))
    expect(fuente).not.toMatch(/\.rpc\(/)
    expect(fuente).not.toMatch(/estimated_total|total_cost|amount_paid|labor_cost|saldo|balance|amount_ars/)
    expect(fuente).not.toMatch(/select\('\*'/)
  })

  it('«Actualizar» vuelve a leer lo que Inicio muestra y sigue sin tocar finanzas', async () => {
    await montarListo()
    const antes = { ordenes: h.tablas.filter(t => t === 'orders').length, tareas: h.tablas.filter(t => t === 'tasks').length, cajas: h.tablas.filter(t => t === 'cajas').length }

    fireEvent.click(screen.getByRole('button', { name: 'Actualizar datos' }))

    await waitFor(() => expect(h.tablas.filter(t => t === 'orders').length).toBe(antes.ordenes + 7))
    await waitFor(() => expect(h.tablas.filter(t => t === 'tasks').length).toBeGreaterThan(antes.tareas))
    await waitFor(() => expect(h.tablas.filter(t => t === 'cajas').length).toBe(antes.cajas + 1))
    for (const tabla of TABLAS_FINANCIERAS) expect(h.tablas).not.toContain(tabla)
    for (const rpc of RPCS_FINANCIERAS) expect(h.rpcs).not.toContain(rpc)
    // Sigue en la misma pantalla: ni navegación ni recarga del navegador.
    expect(h.navigate).not.toHaveBeenCalled()
    expect(leerCodigo('src/pages/Dashboard.tsx')).not.toMatch(/location\.reload|window\.location/)
  })

  it('la fuente de Inicio no importa hooks financieros, ni Supabase, ni el servicio de cotización', () => {
    const fuente = leerCodigo('src/pages/Dashboard.tsx')
    const modulos = [...fuente.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
    for (const prohibido of [
      /useFinancialDashboard/, /hooks\/useDashboardStats$/, /useComprobantes/, /lib\/supabase/,
      /dollarRateService/, /DollarRateBadge/, /financialMetricsService/, /inventoryCostAccess/,
    ]) {
      expect(modulos.filter(m => prohibido.test(m)), `Inicio importa ${prohibido}`).toEqual([])
    }
    expect(fuente).not.toMatch(/fmtARS|toLocaleString|refreshInventoryDollarPrices|realProfit|revenue|ventasHoy|activeTab/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · «Hoy»: tres indicadores operativos', () => {
  it('activas = total − completadas − canceladas; listas y esperando aprobación por su estado canónico', async () => {
    await montarListo()
    const hoy = screen.getByTestId('dashboard-today')
    expect(within(hoy).getAllByRole('link')).toHaveLength(3)
    expect(screen.getByTestId('dashboard-today-active')).toHaveTextContent(/^9Órdenes activas/)
    expect(screen.getByTestId('dashboard-today-ready')).toHaveTextContent(/^2Listas para entregar$/)
    expect(screen.getByTestId('dashboard-today-waiting')).toHaveTextContent(/^1Esperando aprobación$/)

    // Los filtros son las claves del catálogo, no alias legacy.
    const estados = h.consultas.filter(c => c.tabla === 'orders' && c.head)
      .flatMap(c => c.filtros.filter(f => f[0] === 'eq' && f[1] === 'status').map(f => String(f[2])))
    expect(estados.sort()).toEqual(['cancelled', 'completed', 'ready_delivery', 'waiting_approval'])
    for (const estado of estados) expect(Object.keys(STATUS_CONFIG)).toContain(estado)
  })

  it('«nuevas hoy» cuenta desde las 00:00 de Argentina, no desde la medianoche UTC', async () => {
    // 23:30 del 8 en Argentina = 02:30 UTC del 9.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T02:30:00Z'))
    h.orders = [
      // 22:00 AR del 8: es de HOY en Argentina y de «ayer» en UTC.
      { ...orden(1, 'new', 0), created_at: '2026-10-09T01:00:00Z' },
      // 20:00 AR del 7: no es de hoy.
      { ...orden(2, 'new', 0), created_at: '2026-10-07T23:00:00Z' },
    ]
    await montarListo()
    const corte = h.consultas.find(c => c.tabla === 'orders' && c.filtros.some(f => f[0] === 'gte'))
    expect(corte?.filtros.find(f => f[0] === 'gte')).toEqual(['gte', 'created_at', '2026-10-08T00:00:00-03:00'])
    expect(screen.getByTestId('dashboard-today-active')).toHaveTextContent('+1 nueva hoy')
  })

  it('cada indicador lleva a Órdenes; no se inventa un filtro que la pantalla no recibe', async () => {
    await montarListo()
    for (const item of within(screen.getByTestId('dashboard-today')).getAllByRole('link')) {
      expect(item).toHaveAttribute('href', '/orders')
    }
  })

  it('un fallo al leer las órdenes se dice: ni ceros ni lista vacía', async () => {
    h.ordersError = { code: '42501', message: 'permission denied for table orders' }
    montar()
    expect(await screen.findByText(/No pudimos cargar las órdenes/)).toBeInTheDocument()
    // Nada del detalle técnico llega a la pantalla.
    expect(screen.queryByText(/permission denied|42501/)).toBeNull()
    expect(screen.queryByTestId('dashboard-today')).toBeNull()
    expect(screen.queryByTestId('dashboard-recent-orders')).toBeNull()
    expect(screen.queryByText('Todavía no hay órdenes')).toBeNull()
    // El resto de Inicio sigue en pie.
    expect(screen.getByTestId('dashboard-tasks')).toBeInTheDocument()
    expect(boton('Nueva Orden')).toBeInTheDocument()

    h.ordersError = null
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }))
    expect(await screen.findByTestId('dashboard-today')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · acciones del encabezado por capacidad', () => {
  const ACCIONES = ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto'] as const
  const visibles = () => ACCIONES.filter(nombre => boton(nombre))

  it.each([
    ['owner', null, ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']],
    ['admin', null, ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']],
    ['cashier', null, ['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto']],
    // Vende con `comprobantes`, sin `finance`: ni caja ni gasto.
    ['sales', null, ['Nueva Orden', 'Nuevo Comprobante']],
    ['manager', null, ['Nueva Orden', 'Nuevo Comprobante']],
    ['tech', null, ['Nueva Orden']],
    ['viewer', null, []],
    // Capacidad EFECTIVA, no rol: los overrides mandan en los dos sentidos.
    ['tech', { finance: true }, ['Nueva Orden', 'Gestionar Caja', 'Registrar gasto']],
    ['cashier', { finance: false }, ['Nueva Orden', 'Nuevo Comprobante']],
    ['tech', { orders_create: false, comprobantes: true }, ['Nuevo Comprobante']],
  ] as const)('%s %j ve %j', async (rol, overrides, esperadas) => {
    h.role = rol
    h.permissions = overrides
    await montarListo()
    expect(visibles()).toEqual(esperadas)
    // «Actualizar» no depende de ninguna capacidad.
    expect(boton('Actualizar datos')).toBeInTheDocument()
  })

  it('el orden de la fila es el acordado y «Nueva Orden» es la principal', async () => {
    await montarListo()
    const botones = within(screen.getByTestId('dashboard-actions')).getAllByRole('button').map(b => b.textContent || b.getAttribute('aria-label'))
    expect(botones).toEqual(['Nueva Orden', 'Nuevo Comprobante', 'Gestionar Caja', 'Registrar gasto', 'Actualizar datos'])
    const principal = screen.getByRole('button', { name: 'Nueva Orden' })
    // Clases exactas, no substrings: `btn-primary-aa` contiene `btn-primary`.
    expect([...principal.classList]).toEqual(expect.arrayContaining(['btn-primary', 'btn-primary-aa', 'dash-action--primary']))
    expect([...screen.getByRole('button', { name: 'Nuevo Comprobante' }).classList])
      .toEqual(expect.arrayContaining(['btn-fill-indigo', 'btn-indigo-aa']))
    expect([...screen.getByRole('button', { name: 'Gestionar Caja' }).classList]).toContain('btn-secondary')
    // Una sola principal en la fila.
    expect(screen.getByTestId('dashboard-actions').querySelectorAll('.dash-action--primary')).toHaveLength(1)
  })

  it('«Registrar gasto» usa la variante `danger` y dejó de llamarse «Gasto»', async () => {
    await montarListo()
    const gasto = screen.getByRole('button', { name: 'Registrar gasto' })
    // La clase de la variante, exacta: `btn-danger-aa` sola no es la variante.
    expect([...gasto.classList]).toContain('btn-danger')
    expect([...gasto.classList]).toContain('btn-danger-aa')
    expect(boton(/^Gasto$/)).toBeNull()
    fireEvent.click(gasto)
    expect(h.navigate).toHaveBeenCalledWith('/expenses')
  })

  it('cada acción conserva su destino', async () => {
    await montarListo()
    fireEvent.click(screen.getByRole('button', { name: 'Nueva Orden' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/orders/new')
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo Comprobante' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/comprobantes', { state: { openNew: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Gestionar Caja' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/caja')
  })

  it('«Gestionar Caja» no cambia de texto ni muestra un monto según el estado', async () => {
    h.cajaAbierta = false
    await montarListo()
    const caja = screen.getByRole('button', { name: 'Gestionar Caja' })
    expect([...caja.classList]).toContain('btn-secondary')
    expect(boton('Abrir Caja')).toBeNull()
  })

  it('el encabezado dice «Inicio» y «Tu taller hoy»', async () => {
    await montarListo()
    expect(screen.getByRole('heading', { level: 1, name: 'Inicio' })).toBeInTheDocument()
    expect(screen.getByText('Tu taller hoy')).toBeInTheDocument()
    expect(screen.queryByText(/Resumen general del sistema/)).toBeNull()
  })

  it('las capacidades salen de `can(...)`, nunca del nombre del rol', () => {
    const fuente = leerCodigo('src/pages/Dashboard.tsx')
    expect(fuente).not.toMatch(/role\s*===|isOwner|useAuth/)
    expect(fuente).toMatch(/puedeCrearOrden = can\('orders_create'\)/)
    expect(fuente).toMatch(/puedeEmitirComprobante = can\('comprobantes'\)/)
    expect(fuente).toMatch(/puedeRegistrarGasto = can\('finance'\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · Tareas es protagonista', () => {
  const antesQue = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('«Mis tareas» está en Inicio, después de «Hoy» y antes de las órdenes recientes', async () => {
    await montarListo()
    const tareas = screen.getByTestId('dashboard-tasks')
    expect(within(tareas).getByRole('heading', { level: 2, name: 'Mis tareas' })).toBeInTheDocument()
    expect(within(tareas).getByText('Lo que necesita tu atención')).toBeInTheDocument()
    expect(antesQue(screen.getByTestId('dashboard-today'), tareas), 'Tareas quedó arriba de «Hoy»').toBe(true)
    expect(antesQue(tareas, screen.getByTestId('dashboard-recent-orders')), 'Tareas quedó debajo de las órdenes').toBe(true)
  })

  it('«Nueva tarea» abre el formulario real del módulo (openCreate), no un modal propio', async () => {
    await montarListo()
    fireEvent.click(within(screen.getByTestId('dashboard-tasks')).getByRole('button', { name: 'Nueva tarea' }))
    expect(h.navigate).toHaveBeenCalledWith('/tasks', { state: { openCreate: true } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('input, textarea')).toBeNull()
  })

  it('«Ver todas» lleva al módulo', async () => {
    await montarListo()
    expect(screen.getByRole('link', { name: 'Ver todas las tareas' })).toHaveAttribute('href', '/tasks')
  })

  it('lista hasta 5 tareas activas con título, vencimiento y prioridad', async () => {
    h.tasks = [
      ...[1, 2, 3, 4, 5, 6, 7].map(n => tarea(n, { priority: n % 2 ? 'high' : 'low' })),
      tarea(8, { status: 'completed' }),
    ]
    await montarListo()
    const filas = screen.getAllByTestId('dashboard-task')
    expect(filas).toHaveLength(5)
    expect(within(filas[0]).getByText(/Prioridad (alta|media|baja)/)).toBeInTheDocument()
    // El límite se le pide al servicio; no es un recorte visual de una lista mayor.
    expect(leerCodigo('src/components/tasks/DashboardTasks.tsx')).toMatch(/getMyTasks\(businessId, user\.id, DASHBOARD_TASK_LIMIT\)/)
  })

  it('una vencida se reconoce sin depender del color: marca, ícono y la palabra', async () => {
    h.tasks = [tarea(1, { title: 'Vieja', due_date: '2020-01-01' }), tarea(2, { title: 'Sin fecha' })]
    await montarListo()
    const [vieja, sinFecha] = screen.getAllByTestId('dashboard-task')
    expect(vieja).toHaveAttribute('data-overdue', 'true')
    expect(within(vieja).getByText(/^Vencida · /)).toBeInTheDocument()
    expect(vieja.querySelector('.dash-task__due svg')).not.toBeNull()
    expect(sinFecha).toHaveAttribute('data-overdue', 'false')
    expect(within(sinFecha).queryByText(/Vencida/)).toBeNull()
  })

  it('sin tareas el bloque conserva su lugar y dice «Todo al día»', async () => {
    h.tasks = []
    await montarListo()
    const tareas = screen.getByTestId('dashboard-tasks')
    expect(within(tareas).getByText('Todo al día')).toBeInTheDocument()
    expect(within(tareas).getByText('No tenés tareas pendientes.')).toBeInTheDocument()
    // Sigue siendo el bloque entero: encabezado y las dos acciones.
    expect(within(tareas).getByRole('heading', { name: 'Mis tareas' })).toBeInTheDocument()
    expect(within(tareas).getByRole('button', { name: 'Nueva tarea' })).toBeInTheDocument()
    expect(within(tareas).getByRole('link', { name: 'Ver todas las tareas' })).toBeInTheDocument()
    expect(within(tareas).queryByText(/Sin tareas asignadas/)).toBeNull()
  })

  it('no inventa orígenes: ni «CRM», ni leads, ni tipos de tarea', async () => {
    await montarListo()
    expect(screen.getByTestId('dashboard-tasks').textContent).not.toMatch(/CRM|lead|seguimiento|presupuesto/i)
    expect(leerCodigo('src/components/tasks/DashboardTasks.tsx')).not.toMatch(/crm|lead/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Microfix: el bloque de Tareas se ofrecía sin mirar el plan. Un negocio sin la
// feature veía «Nueva tarea» y «Ver todas», y las dos terminaban en la pantalla
// de «mejorá tu plan». Ahora el bloque existe sólo para quien entra a `/tasks`.
// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · Tareas comparte el gate de `/tasks`', () => {
  const TABLAS_DE_TAREAS = ['tasks', 'task_items', 'task_history']
  const pidioTareas = () => h.tablas.filter(t => TABLAS_DE_TAREAS.includes(t))
  const hayBloque = () => screen.queryByTestId('dashboard-tasks') !== null
  const inicio = () => <MemoryRouter><CajaProvider><Dashboard /></CajaProvider></MemoryRouter>

  /** La ruta `/tasks` con sus dos guards REALES, compuestos como en `App.tsx`. */
  function rutaAbierta(): boolean {
    const vista = render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Routes>
          <Route element={<ProtectedRouteByPermission permission="orders" />}>
            <Route element={<ProtectedRouteByFeature feature="tasks" />}>
              <Route path="/tasks" element={<div data-testid="ruta-tareas" />} />
            </Route>
          </Route>
          <Route path="/dashboard" element={<div data-testid="rebote" />} />
        </Routes>
      </MemoryRouter>,
    )
    const abierta = vista.queryByTestId('ruta-tareas') !== null
    vista.unmount()
    return abierta
  }

  /** La decisión del menú (Sidebar, «Más», Ctrl+K) para el mismo actor y plan. */
  function menuAutorizado(rol: string, overrides: unknown): boolean {
    const permisos = effectivePermissions(rol, rol === 'owner', overrides)
    const plan = resolveEntitlement({ subscription_status: 'active', subscription_plan: h.plan.id })
    const acceso = {
      can: (clave: keyof typeof permisos) => permisos[clave] ?? false,
      hasFeature: plan.hasFeature,
      isSystemOwner: false,
      mayoristaEnabled: true,
      portalClic: false,
    } as unknown as NavigationAccess
    return isNavigationItemAuthorized(TASKS_ACCESS_GATE, acceso)
  }

  const CASOS = [
    // A · feature `tasks` + capacidad `orders`
    ['tech', null, 'pro', true],
    ['owner', null, 'full', true],
    // B · feature sin la capacidad
    ['tech', { orders: false }, 'pro', false],
    // C · capacidad sin la feature
    ['tech', null, 'basico', false],
    ['owner', null, 'basico', false],
    // D · ninguna de las dos
    ['tech', { orders: false }, 'basico', false],
  ] as const

  it.each(CASOS)('%s %j en plan %s → bloque de Tareas: %s', async (rol, overrides, plan, esperado) => {
    h.role = rol
    h.permissions = overrides
    h.plan.id = plan
    await montarListo()
    await act(async () => { await Promise.resolve() })

    expect(hayBloque()).toBe(esperado)
    // E · ausente = ni un pedido de tareas. Presente = las pide.
    if (esperado) expect(pidioTareas()).not.toEqual([])
    else expect(pidioTareas(), 'se pidieron tareas sin acceso al módulo').toEqual([])
  })

  it.each(CASOS)('%s %j en plan %s: la misma decisión que la ruta y que el menú', async (rol, overrides, plan, esperado) => {
    h.role = rol
    h.permissions = overrides
    h.plan.id = plan
    expect(rutaAbierta(), 'guards de /tasks').toBe(esperado)
    expect(menuAutorizado(rol, overrides), 'isNavigationItemAuthorized').toBe(esperado)
    await montarListo()
    expect(hayBloque(), 'bloque de Inicio').toBe(esperado)
  })

  it('sin acceso no queda un hueco: después de «Hoy» vienen las órdenes recientes', async () => {
    h.plan.id = 'basico'
    await montarListo()
    expect(hayBloque()).toBe(false)
    // Ni el bloque ni un contenedor vacío en su lugar: encabezado, «Hoy», órdenes.
    const hijos = [...pagina().children]
    expect(hijos).toHaveLength(3)
    expect(hijos[1]).toBe(screen.getByTestId('dashboard-today'))
    expect(hijos[2]).toBe(screen.getByTestId('dashboard-recent-orders'))
    // Y nada que lleve a una pantalla de «mejorá tu plan».
    expect(boton('Nueva tarea')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Ver todas las tareas' })).toBeNull()
    expect(within(pagina()).queryByText('Mis tareas')).toBeNull()
  })

  it('«Actualizar» tampoco pide tareas cuando el bloque no existe', async () => {
    h.plan.id = 'basico'
    await montarListo()
    const ordenesAntes = h.tablas.filter(t => t === 'orders').length
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar datos' }))
    await waitFor(() => expect(h.tablas.filter(t => t === 'orders').length).toBe(ordenesAntes + 7))
    await act(async () => { await Promise.resolve() })
    expect(pidioTareas()).toEqual([])
  })

  it('mientras el plan se está leyendo no se abre a ciegas: ni bloque ni pedido', async () => {
    h.plan.loading = true
    const vista = montar()
    await screen.findByTestId('dashboard-today')
    await act(async () => { await Promise.resolve() })
    // Sin datos el plan se resuelve como un trial (optimista): por eso el
    // bloque no puede guiarse sólo por `hasFeature`.
    expect(resolveEntitlement({}).hasFeature('tasks')).toBe(true)
    expect(hayBloque()).toBe(false)
    expect(pidioTareas()).toEqual([])

    // Llega el plan y lo incluye: aparece, y recién ahí pide.
    h.plan.loading = false
    vista.rerender(inicio())
    expect(await screen.findByTestId('dashboard-tasks')).toBeInTheDocument()
    await waitFor(() => expect(pidioTareas()).not.toEqual([]))
  })

  it('llega el plan y NO incluye Tareas: nunca se pidió nada', async () => {
    h.plan.loading = true
    h.plan.id = 'basico'
    const vista = montar()
    await screen.findByTestId('dashboard-today')
    h.plan.loading = false
    vista.rerender(inicio())
    await act(async () => { await Promise.resolve() })
    expect(hayBloque()).toBe(false)
    expect(pidioTareas()).toEqual([])
  })

  it('si la lectura del plan terminó sin datos, el bloque queda cerrado', async () => {
    h.plan.confirmado = false
    await montarListo()
    expect(hayBloque()).toBe(false)
    expect(pidioTareas()).toEqual([])
  })

  it('no hay capacidad nueva ni nombre de rol: capacidad `orders` + feature `tasks`', () => {
    expect(TASKS_ACCESS_GATE).toEqual({ permission: 'orders', planFeature: 'tasks' })
    expect(ALL_PERMISSIONS).toContain(TASKS_ACCESS_GATE.permission)
    expect(ALL_PERMISSIONS).not.toContain('tasks')
    expect(Object.keys(PLAN_FEATURES.pro)).toContain(TASKS_ACCESS_GATE.planFeature)

    const hook = leerCodigo('src/hooks/useTasksAccess.ts')
    expect(hook).not.toMatch(/role|isOwner|useAuth|supabase/)
    expect(hook).toMatch(/can\(TASKS_ACCESS_GATE\.permission\)/)
    expect(hook).toMatch(/hasFeature\(TASKS_ACCESS_GATE\.planFeature\)/)

    const fuente = leerCodigo('src/pages/Dashboard.tsx')
    expect(fuente).toMatch(/const \{ canAccessTasks \} = useTasksAccess\(\)/)
    expect(fuente).toMatch(/\{canAccessTasks && <DashboardTasks refreshKey=\{tasksRefreshKey\} \/>\}/)
    expect(fuente.match(/<DashboardTasks /g) ?? []).toHaveLength(1)
  })

  it('el contrato de `/tasks` sigue declarado igual en la ruta, el Sidebar y la navegación móvil', () => {
    expect(leerCodigo('src/App.tsx')).toMatch(
      /<Route element=\{<ProtectedRouteByPermission permission="orders" \/>\}>\s*<Route element=\{<ProtectedRouteByFeature feature="tasks" \/>\}>\s*<Route path="\/tasks" element=\{<Tasks \/>\} \/>/,
    )
    expect(leerCodigo('src/components/layout/Sidebar.tsx')).toMatch(/path: '\/tasks',[^\n]*planFeature: 'tasks', permission: 'orders'/)
    expect(leerCodigo('src/config/mobileNavigation.ts')).toMatch(/available: can\('orders'\) && hasFeature\('tasks'\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · resumen de tareas: Vencidas · Para hoy · Pendientes', () => {
  it('`isTaskDueToday` compara el día de calendario, sólo para tareas activas', () => {
    const hoy = '2026-10-08'
    expect(isTaskDueToday({ status: 'pending', due_date: '2026-10-08' }, hoy)).toBe(true)
    expect(isTaskDueToday({ status: 'in_progress', due_date: '2026-10-08' }, hoy)).toBe(true)
    expect(isTaskDueToday({ status: 'completed', due_date: '2026-10-08' }, hoy)).toBe(false)
    expect(isTaskDueToday({ status: 'cancelled', due_date: '2026-10-08' }, hoy)).toBe(false)
    expect(isTaskDueToday({ status: 'pending', due_date: '2026-10-07' }, hoy)).toBe(false)
    expect(isTaskDueToday({ status: 'pending', due_date: '2026-10-09' }, hoy)).toBe(false)
    expect(isTaskDueToday({ status: 'pending', due_date: null }, hoy)).toBe(false)
  })

  it('«para hoy» en Inicio es la misma regla que el grupo «Hoy» del módulo de Tareas', () => {
    const hoy = '2026-10-08'
    for (const status of ['pending', 'in_progress', 'completed', 'cancelled']) {
      for (const due_date of ['2026-10-07', '2026-10-08', '2026-10-09', null]) {
        expect(isTaskDueToday({ status: status as 'pending', due_date }, hoy), `${status} · ${due_date}`)
          .toBe(isDueTodayTask({ status, due_date }, hoy))
      }
    }
  })

  it('`getTaskSummary` cuenta «para hoy» con la fecha de negocio argentina, no con la UTC', async () => {
    // 23:30 del 8 en Argentina; en UTC ya es el 9.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T02:30:00Z'))
    h.tasks = [
      tarea(1, { due_date: '2026-10-08' }),                       // hoy AR
      tarea(2, { due_date: '2026-10-08' }),                       // hoy AR
      tarea(3, { due_date: '2026-10-08', status: 'completed' }),  // hoy, pero cerrada
      tarea(4, { due_date: '2026-10-09' }),                       // «hoy» sólo en UTC: mañana
      tarea(5, { due_date: '2026-10-01' }),                       // vencida
      tarea(6, { due_date: null }),
    ]
    const resumen = await taskService.getTaskSummary(BIZ, USER)
    expect(resumen.dueToday).toBe(2)
    expect(resumen.pending).toBe(5)
    expect(resumen.completed).toBe(1)
    // Y no agregó una consulta: sale de la misma lectura.
    expect(h.tablas.filter(t => t === 'tasks')).toHaveLength(1)
  })

  it('Inicio muestra Vencidas, Para hoy y Pendientes — no «Completadas»', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T15:00:00Z'))
    h.tasks = [
      tarea(1, { due_date: '2026-10-01' }),
      tarea(2, { due_date: '2026-10-02' }),
      tarea(3, { due_date: '2026-10-08' }),
      tarea(4, { due_date: '2026-10-20' }),
      tarea(5, { status: 'completed', due_date: '2026-10-08' }),
    ]
    await montarListo()
    const resumen = screen.getByTestId('dashboard-tasks-summary')
    expect(within(resumen).getAllByRole('link').map(l => l.textContent)).toEqual(['2Vencidas', '1Para hoy', '4Pendientes'])
    expect(within(resumen).queryByText('Completadas')).toBeNull()
    // Vencidas en rojo SÓLO si hay alguna; «Para hoy» con el acento.
    expect(screen.getByTestId('dashboard-tasks-overdue')).toHaveAttribute('data-tone', 'danger')
    expect(screen.getByTestId('dashboard-tasks-today')).toHaveAttribute('data-tone', 'accent')
    expect(screen.getByTestId('dashboard-tasks-pending')).toHaveAttribute('data-tone', 'neutral')
  })

  it('sin vencidas el contador no se pinta de rojo', async () => {
    h.tasks = [tarea(1)]
    await montarListo()
    expect(screen.getByTestId('dashboard-tasks-overdue')).toHaveTextContent('0Vencidas')
    expect(screen.getByTestId('dashboard-tasks-overdue')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('dashboard-tasks-today')).toHaveAttribute('data-tone', 'neutral')
  })

  it('completar una tarea de hoy baja «Para hoy» y «Pendientes» recién cuando el servidor acepta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-08T15:00:00Z'))
    h.tasks = [tarea(1, { title: 'Entregar equipo', due_date: '2026-10-08' })]
    render(<MemoryRouter><DashboardTasks /></MemoryRouter>)
    await screen.findByText('Entregar equipo')
    expect(screen.getByTestId('dashboard-tasks-today')).toHaveTextContent('1Para hoy')

    // El servidor la da por completada: la relectura ya no la trae.
    fireEvent.click(screen.getByTitle('Completar tarea'))
    h.tasks = [{ ...h.tasks[0], status: 'completed' }]

    await waitFor(() => expect(screen.queryByText('Entregar equipo')).toBeNull())
    expect(await screen.findByText('Todo al día')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · órdenes recientes', () => {
  const corto = (o: FakeOrder) => `#${o.id.slice(0, 8).toUpperCase()}`

  it('muestra sólo las cinco últimas, con las columnas acordadas y sin importes', async () => {
    await montarListo()
    const bloque = screen.getByTestId('dashboard-recent-orders')
    expect(within(bloque).getByRole('heading', { name: 'Órdenes recientes' })).toBeInTheDocument()
    expect(RECENT_ORDERS_LIMIT).toBe(5)

    const tabla = screen.getByTestId('dashboard-recent-orders-table')
    expect(within(tabla).getAllByRole('columnheader').map(th => th.textContent)).toEqual(['Orden', 'Cliente', 'Dispositivo', 'Estado', 'Fecha'])
    const filas = screen.getAllByTestId('dashboard-recent-order-row')
    expect(filas).toHaveLength(5)
    // Las más nuevas primero.
    expect(filas.map(f => within(f).getAllByRole('cell')[0].textContent)).toEqual(ORDENES.slice(0, 5).map(corto))
    expect(bloque.textContent).not.toMatch(/\$|Total|Saldo/)
  })

  it('la fila entera abre la orden', async () => {
    await montarListo()
    const fila = screen.getAllByTestId('dashboard-recent-order-row')[1]
    fireEvent.click(within(fila).getAllByRole('cell')[2])
    expect(h.navigate).toHaveBeenCalledWith(`/orders/${ORDENES[1].id}`)
    // …y el número es un enlace real, para el teclado.
    expect(within(fila).getByRole('link', { name: corto(ORDENES[1]) })).toHaveAttribute('href', `/orders/${ORDENES[1].id}`)
  })

  it('no existe el ojo ni ninguna acción por fila', async () => {
    await montarListo()
    const tabla = screen.getByTestId('dashboard-recent-orders-table')
    expect(within(tabla).queryAllByRole('button')).toHaveLength(0)
    expect(boton('Ver orden')).toBeNull()
    expect(screen.getByTestId('dashboard-recent-orders').querySelector('.overflow-menu')).toBeNull()
  })

  it('el estado usa la etiqueta canónica, también para `ready_delivery` y `waiting_approval`', async () => {
    await montarListo()
    const tabla = screen.getByTestId('dashboard-recent-orders-table')
    expect(within(tabla).getByText(STATUS_CONFIG.ready_delivery.label)).toBeInTheDocument()
    expect(within(tabla).getByText(STATUS_CONFIG.waiting_approval.label)).toBeInTheDocument()
    // Nunca la clave cruda.
    expect(tabla.textContent).not.toMatch(/ready_delivery|waiting_approval/)
  })

  it('una orden sin cliente o sin equipo lo dice, sin «null» ni «undefined»', async () => {
    await montarListo()
    const fila = screen.getAllByTestId('dashboard-recent-order-row')[3]
    expect(within(fila).getByText('Sin cliente')).toBeInTheDocument()
    expect(within(fila).getByText('Sin dispositivo')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-recent-orders').textContent).not.toMatch(/null|undefined/)
  })

  it('mobile: las mismas órdenes como tarjetas, y tocar la tarjeta abre el detalle', async () => {
    await montarListo()
    const lista = screen.getByTestId('dashboard-recent-orders-list')
    const tarjetas = within(lista).getAllByTestId('dashboard-recent-order-card')
    expect(tarjetas).toHaveLength(5)
    // #orden + estado · cliente · dispositivo · fecha — y ningún menú.
    expect(tarjetas[0]).toHaveTextContent(corto(ORDENES[0]))
    expect(tarjetas[0]).toHaveTextContent(STATUS_CONFIG.repair.label)
    expect(tarjetas[0]).toHaveTextContent('Cliente 1')
    expect(tarjetas[0]).toHaveTextContent('Samsung A1')
    expect(within(lista).queryAllByRole('button')).toHaveLength(0)

    fireEvent.click(within(tarjetas[2]).getByRole('link'))
    expect(h.navigate).toHaveBeenCalledWith(`/orders/${ORDENES[2].id}`)
    fireEvent.keyDown(within(tarjetas[4]).getByRole('link'), { key: 'Enter' })
    expect(h.navigate).toHaveBeenLastCalledWith(`/orders/${ORDENES[4].id}`)
  })

  it('«Ver todas» lleva a Órdenes', async () => {
    await montarListo()
    expect(screen.getByRole('link', { name: 'Ver todas las órdenes' })).toHaveAttribute('href', '/orders')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · primeros pasos: una sola guía', () => {
  it('negocio nuevo: la guía canónica, sin la bienvenida duplicada', async () => {
    h.orders = []
    h.tasks = []
    h.firstSteps = PASOS_PENDIENTES
    h.cajaAbierta = false
    await montarListo()

    expect(await screen.findAllByTestId('setup-checklist')).toHaveLength(1)
    expect(screen.queryByText(/Bienvenido a TechRepair Pro/)).toBeNull()
    expect(screen.queryByText(/Todo listo para arrancar/)).toBeNull()
    expect(boton(/Crear primera orden/)).toBeNull()

    // El resto dice la verdad de un taller vacío.
    expect(screen.getByTestId('dashboard-today-active')).toHaveTextContent(/^0Órdenes activas$/)
    expect(screen.getByText('Todo al día')).toBeInTheDocument()
    expect(screen.getByText('Todavía no hay órdenes')).toBeInTheDocument()
  })

  it('la guía va después del encabezado y antes del contenido operativo', async () => {
    h.firstSteps = PASOS_PENDIENTES
    await montarListo()
    const guia = await screen.findByTestId('setup-checklist')
    const titulo = screen.getByRole('heading', { level: 1, name: 'Inicio' })
    const sigue = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(sigue(titulo, guia)).toBe(true)
    expect(sigue(guia, screen.getByTestId('dashboard-today'))).toBe(true)
  })

  it('completa: no se dibuja y no deja un hueco', async () => {
    h.firstSteps = PASOS_COMPLETOS
    await montarListo()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('setup-checklist')).toBeNull()
    // Lo que sigue al encabezado es directamente «Hoy».
    const hijos = [...pagina().children]
    expect(hijos[1]).toBe(screen.getByTestId('dashboard-today'))
  })

  it('un técnico no recibe pasos que no puede ejecutar', async () => {
    h.role = 'tech'
    h.firstSteps = PASOS_PENDIENTES
    await montarListo()
    const guia = await screen.findByTestId('setup-checklist')
    expect(within(guia).getAllByRole('button', { name: /Pendiente|Completado/ })).toHaveLength(1)
    expect(within(guia).getByTestId('setup-step-order')).toBeInTheDocument()
    expect(within(guia).queryByTestId('setup-step-cobro')).toBeNull()
  })

  it('Inicio no decide el progreso: no hay estado propio de onboarding', () => {
    const fuente = leerCodigo('src/pages/Dashboard.tsx')
    // Ni un criterio propio de «negocio nuevo», ni una lectura paralela del
    // progreso: la única fuente es el componente canónico.
    expect(fuente).not.toMatch(/hasNoData|localStorage|useFirstSteps|firstStepsService|Bienvenido/)
    expect((fuente.match(/<FirstStepsChecklist \/>/g) ?? [])).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · barra superior: Caja y dólar', () => {
  const montarBarra = () => render(<MemoryRouter><CajaProvider><TopHeader /></CajaProvider></MemoryRouter>)
  const utilidades = () => screen.getByTestId('top-header-utilities')

  it('dueño: «Caja abierta» lleva a /caja y el dólar se ve compacto', async () => {
    montarBarra()
    const caja = await screen.findByTestId('shell-caja-chip')
    expect(caja).toHaveAttribute('data-state', 'open')
    expect(caja.tagName).toBe('A')
    expect(caja).toHaveAttribute('href', '/caja')
    expect(caja).toHaveTextContent(/^Caja abiertadesde \d{2}:\d{2}$/)

    const dolar = await screen.findByTestId('shell-dollar-chip')
    await waitFor(() => expect(dolar).toHaveTextContent('USD$1.556'))
    expect(within(dolar).getByRole('button', { name: 'Actualizar cotización del dólar' })).toBeInTheDocument()
    // Los dos van juntos, a la derecha del buscador.
    expect(utilidades()).toContainElement(caja)
    expect(utilidades()).toContainElement(dolar)
    const buscador = screen.getByTestId('global-search-trigger')
    expect(Boolean(buscador.compareDocumentPosition(utilidades()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('caja cerrada: lo dice, sin hora y sin alarma', async () => {
    h.cajaAbierta = false
    montarBarra()
    const caja = await screen.findByTestId('shell-caja-chip')
    expect(caja).toHaveAttribute('data-state', 'closed')
    expect(caja).toHaveTextContent(/^Caja cerrada$/)
  })

  it('vendedor (comprobantes sin finance): conoce el estado y NO puede gestionar', async () => {
    h.role = 'sales'
    montarBarra()
    const caja = await screen.findByTestId('shell-caja-chip')
    expect(caja).toHaveTextContent(/^Caja abierta/)
    // No es un enlace, no es un botón y no nombra /caja.
    expect(caja.tagName).toBe('SPAN')
    expect(caja).not.toHaveAttribute('href')
    expect(within(utilidades()).queryByRole('link')).toBeNull()
    expect(utilidades().innerHTML).not.toContain('/caja')
  })

  it.each(['tech', 'viewer'])('%s: no ve el chip de caja y tampoco se consulta', async (rol) => {
    h.role = rol
    montarBarra()
    await screen.findByTestId('shell-dollar-chip')
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('shell-caja-chip')).toBeNull()
    expect(h.tablas).not.toContain('cajas')
  })

  it('un técnico con override `finance` sí la ve y la gestiona', async () => {
    h.role = 'tech'
    h.permissions = { finance: true }
    montarBarra()
    expect(await screen.findByTestId('shell-caja-chip')).toHaveAttribute('href', '/caja')
  })

  it.each(['owner', 'sales', 'tech'])('%s: el chip de caja nunca trae un importe', async (rol) => {
    h.role = rol
    montarBarra()
    await screen.findByTestId('shell-dollar-chip')
    const caja = screen.queryByTestId('shell-caja-chip')
    if (caja) expect(caja.textContent).toMatch(/^Caja (abierta|cerrada)(desde \d{2}:\d{2})?$/)
    // El único `$` de la barra es la cotización, que no es dinero del negocio.
    const sinDolar = utilidades().cloneNode(true) as HTMLElement
    sinDolar.querySelector('[data-testid="shell-dollar-chip"]')?.remove()
    expect(sinDolar.textContent).not.toMatch(/\$|\d{1,3}\.\d{3}/)
  })

  it('mientras la lectura de caja no vuelve no se afirma «cerrada»', async () => {
    montarBarra()
    // Antes de la primera respuesta: ni abierta ni cerrada.
    expect(screen.queryByTestId('shell-caja-chip')).toBeNull()
    expect(await screen.findByTestId('shell-caja-chip')).toHaveAttribute('data-state', 'open')
  })

  it('el chip no reescribe la autoridad: la lee de `CajaContext`', () => {
    const chip = leerCodigo('src/components/layout/CajaStatusChip.tsx')
    expect(chip).toMatch(/const \{[^}]*canUseCaja[^}]*canSeeCajaStatus[^}]*\} = useCaja\(\)/)
    expect(chip).not.toMatch(/usePermissions|can\(|useAuth|supabase/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · una sola lectura de la cotización', () => {
  it('la barra de escritorio y la fila de mobile comparten la misma lectura', async () => {
    render(
      <MemoryRouter>
        <CajaProvider>
          <TopHeader />
          <div data-testid="fila-mobile"><DollarRateBadge variant="compact" /></div>
        </CajaProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByTestId('shell-dollar-chip')).toHaveLength(2))
    await waitFor(() => expect(screen.getAllByText('$1.556')).toHaveLength(2))
    expect(h.dollar.refreshDollarRate).toHaveBeenCalledTimes(1)
    expect(h.dollar.refreshDollarRate).toHaveBeenCalledWith(BIZ, false)
  })

  it('el botón del chip fuerza una lectura nueva y la ven todos', async () => {
    render(<MemoryRouter><DollarRateBadge /><DollarRateBadge /></MemoryRouter>)
    await waitFor(() => expect(screen.getAllByText('$1.556')).toHaveLength(2))
    h.dollar.refreshDollarRate.mockImplementation(async () => ({ ...COTIZACION(), sellPrice: 1600 }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Actualizar cotización del dólar' })[0])

    await waitFor(() => expect(screen.getAllByText('$1.600')).toHaveLength(2))
    expect(h.dollar.refreshDollarRate).toHaveBeenCalledTimes(2)
    expect(h.dollar.refreshDollarRate).toHaveBeenLastCalledWith(BIZ, true)
    expect(h.dollar.clearDollarCache).toHaveBeenCalledWith(BIZ)
  })

  it('un valor que no es de ahora se marca con un ícono con nombre, no sólo con un color', async () => {
    h.dollar.refreshDollarRate.mockImplementation(async () => ({ ...COTIZACION(), isStale: true }))
    render(<MemoryRouter><DollarRateBadge /></MemoryRouter>)
    expect(await screen.findByRole('img', { name: 'Usando el último valor guardado' })).toBeInTheDocument()
  })

  it('sin cotización el chip no se dibuja: no hay un valor inventado', async () => {
    h.dollar.refreshDollarRate.mockImplementation(async () => null)
    render(<MemoryRouter><DollarRateBadge /></MemoryRouter>)
    await waitFor(() => expect(h.dollar.refreshDollarRate).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('shell-dollar-chip')).toBeNull())
  })

  it('el chip compacto usa sólo tokens de tema: ningún color fijo en línea', async () => {
    render(<MemoryRouter><DollarRateBadge /></MemoryRouter>)
    const chip = await screen.findByTestId('shell-dollar-chip')
    await screen.findByText('$1.556')
    expect(chip.getAttribute('style')).toBeNull()
    for (const nodo of chip.querySelectorAll<HTMLElement>('span, button')) {
      expect(nodo.getAttribute('style') ?? '', nodo.textContent ?? '').not.toMatch(/color|background/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Microfix: 1F había llevado el reprecio de inventario al shell, y con eso
// navegar por cualquier pantalla (o dejar la aplicación abierta) disparaba
// escrituras de inventario. Son DOS efectos distintos y no se acoplan:
//
//   · mostrar / refrescar la cotización  → el shell, en cualquier pantalla;
//   · repreciar inventario               → sólo Inicio, como antes de 1F.
// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · el shell muestra la cotización; el reprecio de inventario es sólo de Inicio', () => {
  /** Lo que el shell monta en CUALQUIER pantalla: la barra con sus dos chips. */
  const Shell = ({ conInicio = false }: { conInicio?: boolean }) => (
    <MemoryRouter><CajaProvider><TopHeader />{conInicio && <Dashboard />}</CajaProvider></MemoryRouter>
  )
  const lecturas = () => h.dollar.refreshDollarRate
  const reprecios = () => h.dollar.refreshInventoryDollarPrices
  const asentar = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
  const actualizarChip = () => fireEvent.click(screen.getByRole('button', { name: 'Actualizar cotización del dólar' }))
  const cotizar = (sellPrice: number) => h.dollar.refreshDollarRate.mockImplementation(async () => ({ ...COTIZACION(), sellPrice }))

  /** El timer de 15 min del estado compartido, para dispararlo sin esperar. */
  const QUINCE_MINUTOS = 15 * 60_000
  function espiarTimer() {
    const espia = vi.spyOn(globalThis, 'setInterval')
    const registrados = () => espia.mock.calls.filter(([, ms]) => ms === QUINCE_MINUTOS)
    return {
      registrados,
      tick: async () => {
        const [alVencer] = registrados()[0] ?? []
        if (typeof alVencer !== 'function') throw new Error('el estado compartido no registró su timer')
        await act(async () => { (alVencer as () => void)(); await Promise.resolve() })
      },
    }
  }

  /** Archivos de `src` cuyo CÓDIGO (sin comentarios) contiene el patrón. */
  const archivosCon = (patron: RegExp) => {
    const hallados: string[] = []
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(join(raiz, dir))) {
        const rel = `${dir}/${nombre}`
        if (statSync(join(raiz, rel)).isDirectory()) { recorrer(rel); continue }
        if (/\.tsx?$/.test(nombre) && patron.test(leerCodigo(rel))) hallados.push(rel)
      }
    }
    recorrer('src')
    return hallados.sort()
  }

  it('`MainLayout` NO monta la sincronización de inventario: sólo Inicio la monta', () => {
    const layout = leerCodigo('src/layouts/MainLayout.tsx')
    expect(layout).not.toMatch(/useInventoryDollarPriceSync|refreshInventoryDollarPrices/)
    // El hook se monta en un único lugar de toda la aplicación.
    expect(archivosCon(/useInventoryDollarPriceSync\(\)/)).toEqual(['src/hooks/useDollarRate.ts', 'src/pages/Dashboard.tsx'])
    expect(leerCodigo('src/pages/Dashboard.tsx')).toMatch(/\n {2}useInventoryDollarPriceSync\(\)\n/)
    // Y el único que llama a la función del servicio es ese hook.
    expect(archivosCon(/refreshInventoryDollarPrices\(/)).toEqual(['src/hooks/useDollarRate.ts', 'src/services/dollarRateService.ts'])
    // Ni la barra ni sus chips saben de inventario.
    for (const rel of ['src/components/layout/TopHeader.tsx', 'src/components/ui/DollarRateBadge.tsx', 'src/components/layout/CajaStatusChip.tsx']) {
      expect(leerCodigo(rel), rel).not.toMatch(/useInventoryDollarPriceSync|refreshInventoryDollarPrices/)
    }
  })

  it('una pantalla que no es Inicio lee la cotización y no reprecia nada', async () => {
    render(<Shell />)
    await screen.findByText('$1.556')
    await asentar()
    expect(lecturas()).toHaveBeenCalledTimes(1)
    expect(reprecios()).not.toHaveBeenCalled()
  })

  it('actualizar la cotización fuera de Inicio no actualiza productos', async () => {
    render(<Shell />)
    await screen.findByText('$1.556')
    cotizar(1600)
    actualizarChip()
    await screen.findByText('$1.600')
    await asentar()
    expect(lecturas()).toHaveBeenCalledTimes(2)
    expect(reprecios()).not.toHaveBeenCalled()
  })

  it('la lectura periódica del shell no fuerza la fuente y no reprecia', async () => {
    const timer = espiarTimer()
    render(<Shell />)
    await screen.findByText('$1.556')
    await asentar()
    expect(lecturas()).toHaveBeenCalledTimes(1)

    // Pasan 15 y 30 minutos con la aplicación abierta en otra pantalla.
    for (const ciclo of [2, 3]) {
      await timer.tick()
      await asentar()
      expect(lecturas()).toHaveBeenCalledTimes(ciclo)
      // Le pregunta al servicio respetando SU caché: no lo limpia ni lo fuerza.
      expect(lecturas()).toHaveBeenLastCalledWith(BIZ, false)
    }
    expect(h.dollar.clearDollarCache).not.toHaveBeenCalled()
    expect(reprecios()).not.toHaveBeenCalled()
  })

  it('Inicio conserva el reprecio heredado, sobre la lectura del shell y sin un segundo pedido', async () => {
    render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await screen.findByText('$1.556')
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(1))
    expect(reprecios()).toHaveBeenCalledWith(BIZ)
    await asentar()
    // La barra y Inicio están montados a la vez: UNA lectura, UN reprecio.
    expect(lecturas()).toHaveBeenCalledTimes(1)
    expect(lecturas()).toHaveBeenCalledWith(BIZ, false)
    expect(reprecios()).toHaveBeenCalledTimes(1)
  })

  it('con Inicio montado cada lectura nueva se aplica una vez: la del chip, la de «Actualizar» y la periódica', async () => {
    const timer = espiarTimer()
    render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(1))
    // La barra e Inicio consumen la misma lectura: hay UN solo timer.
    expect(timer.registrados()).toHaveLength(1)

    actualizarChip()
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar datos' }))
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(3))
    await timer.tick()
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(4))

    await asentar()
    // Una por lectura: ni más reprecios que lecturas, ni lecturas de más.
    expect(lecturas()).toHaveBeenCalledTimes(4)
    expect(reprecios()).toHaveBeenCalledTimes(4)
  })

  it('volver a Inicio no repite una lectura ya aplicada', async () => {
    const primera = render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(1))
    primera.unmount()

    render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await screen.findByText('$1.556')
    await asentar()
    expect(reprecios()).toHaveBeenCalledTimes(1)
    expect(lecturas()).toHaveBeenCalledTimes(1)
  })

  it('las lecturas hechas en otra pantalla no escriben nada; al entrar a Inicio la vigente se aplica una sola vez', async () => {
    const otra = render(<Shell />)
    await screen.findByText('$1.556')
    cotizar(1600)
    actualizarChip()
    await screen.findByText('$1.600')
    cotizar(1610)
    actualizarChip()
    await screen.findByText('$1.610')
    await asentar()
    expect(lecturas()).toHaveBeenCalledTimes(3)
    expect(reprecios()).not.toHaveBeenCalled()
    otra.unmount()

    render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(1))
    await asentar()
    // Tres lecturas afuera, un solo reprecio adentro, y sin volver a pedirla.
    expect(reprecios()).toHaveBeenCalledTimes(1)
    expect(lecturas()).toHaveBeenCalledTimes(3)
  })

  it('al salir de Inicio el reprecio se detiene aunque la cotización siga cambiando', async () => {
    const vista = render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await waitFor(() => expect(reprecios()).toHaveBeenCalledTimes(1))

    // Misma sesión, otra pantalla: la barra sigue, Inicio no.
    vista.rerender(<Shell />)
    await waitFor(() => expect(screen.queryByTestId('dashboard-page')).toBeNull())
    cotizar(1600)
    actualizarChip()
    await screen.findByText('$1.600')
    await asentar()
    expect(reprecios()).toHaveBeenCalledTimes(1)
  })

  it('sin cotización no se toca ningún precio, tampoco en Inicio', async () => {
    h.dollar.refreshDollarRate.mockImplementation(async () => null)
    render(<Shell conInicio />)
    await screen.findByTestId('dashboard-today')
    await waitFor(() => expect(lecturas()).toHaveBeenCalled())
    await asentar()
    expect(reprecios()).not.toHaveBeenCalled()
  })

  it('refrescar la cotización y repreciar inventario no están acoplados en el estado compartido', () => {
    const fuente = leerCodigo('src/hooks/useDollarRate.ts')
    const corte = fuente.indexOf('export function useInventoryDollarPriceSync')
    expect(corte).toBeGreaterThan(0)
    // Todo lo que lee y reparte la cotización —incluido el timer— no nombra al
    // inventario: la única referencia está dentro del hook que monta Inicio.
    expect(fuente.slice(0, corte)).not.toMatch(/refreshInventoryDollarPrices\(|inventorySync\s*=\s*\{/)
    expect(fuente.slice(corte)).toMatch(/refreshInventoryDollarPrices\(businessId\)/)
    // El timer sólo vuelve a leer, y sin forzar.
    const timer = /setInterval\(\(\) => \{([\s\S]*?)\}, REFRESH_INTERVAL_MS\)/.exec(fuente)?.[1] ?? ''
    expect(timer.trim()).toBe('if (snapshot.businessId) void load(snapshot.businessId, false)')
  })

  it('la fórmula del servicio no se tocó', () => {
    const servicio = leer('src/services/dollarRateService.ts')
    expect(servicio).toContain('const newPrice = Math.round(p.price_usd * rate);')
    expect(servicio).toContain(".eq('linked_to_dolar', true)")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · shell mobile', () => {
  const layout = leerCodigo('src/layouts/MainLayout.tsx')

  it('la fila de utilidades lleva los mismos dos chips y aparece sólo en Inicio', () => {
    const fila = layout.slice(layout.indexOf('function MobileUtilityBar'), layout.indexOf('const isHomePath'))
    expect(fila).toContain('<CajaStatusChip />')
    expect(fila).toContain('<DollarRateBadge variant="compact" />')
    expect(layout).toMatch(/isHomePath = \(pathname: string\) => pathname === '\/' \|\| pathname === '\/dashboard'/)
    expect(layout).toMatch(/\{businessId && isHomePath\(pathname\) && <MobileUtilityBar \/>\}/)
  })

  it('`TopHeader` usa la variante compacta y no la tarjeta', () => {
    const barra = leerCodigo('src/components/layout/TopHeader.tsx')
    expect(barra).toContain('<DollarRateBadge variant="compact" />')
    expect(barra).not.toMatch(/variant="full"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CSS: contrato responsive y aritmética WCAG. jsdom no pinta; lo pintado se mide
// en el E2E. Acá se fija lo que hace que esa medida no pueda volver a caerse.
// ═══════════════════════════════════════════════════════════════════════════
const css = leer('src/index.css')
const TITULO = 'BETA-UX-1F — Inicio como centro operativo'
/** Desde el comentario que abre el bloque hasta el que abre el siguiente. */
const aperturaDe = (titulo: string) => css.lastIndexOf('/*', css.indexOf(titulo))
const bloque = sinComentarios(css.slice(aperturaDe(TITULO), aperturaDe('BETA-UX-1E — etiqueta')))

/** Cuerpo de la regla `selector { … }` a nivel raíz del bloque. */
function regla(selector: string, texto = bloque): string | null {
  const i = texto.indexOf(`\n${selector} {`)
  return i < 0 ? null : texto.slice(texto.indexOf('{', i) + 1, texto.indexOf('}', i))
}
/** Contenido de `@media (max-width: Npx) { … }` dentro del bloque. */
function media(ancho: number): string {
  const i = bloque.indexOf(`@media (max-width: ${ancho}px)`)
  if (i < 0) return ''
  return bloque.slice(i, bloque.indexOf('\n}\n', i))
}

describe('BETA-UX-1F · CSS: contrato responsive', () => {
  it('el bloque existe y va antes de los de 1E, 1D y 1C (sus contratos recortan por título)', () => {
    const en = (t: string) => css.indexOf(t)
    expect(en(TITULO)).toBeGreaterThan(0)
    expect(en(TITULO)).toBeLessThan(en('BETA-UX-1E — etiqueta'))
    expect(en('BETA-UX-1E — etiqueta')).toBeLessThan(en('BETA-UX-1D — la orden en el celular'))
    expect(en('BETA-UX-1D — la orden en el celular')).toBeLessThan(en('BETA-UX-1C — Mi Suscripción por estado'))
  })

  it('sólo tokens de tema: ningún color fijo', () => {
    expect(bloque.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([])
    expect(bloque.match(/rgba?\(/g) ?? []).toEqual([])
  })

  it('no usa los textos que no llegan a AA sobre la página ni sobre un hover', () => {
    expect(bloque).not.toMatch(/--text-tertiary|--text-subtle|--text-muted|--text-disabled/)
  })

  it('responsive por CSS: sólo `max-width`, y la fuente no mide el viewport', () => {
    const consultas = [...bloque.matchAll(/@media\s*\(([^)]+)\)/g)].map(m => m[1].trim())
    expect(consultas.length).toBeGreaterThan(0)
    for (const q of consultas) expect(q).toMatch(/^max-width: \d+px$/)
    for (const rel of ['src/pages/Dashboard.tsx', 'src/components/tasks/DashboardTasks.tsx', 'src/components/layout/CajaStatusChip.tsx', 'src/components/layout/TopHeader.tsx']) {
      expect(leerCodigo(rel), rel).not.toMatch(/innerWidth|matchMedia|useMediaQuery/)
    }
  })

  it('órdenes recientes: tabla desde 768px, tarjetas por debajo', () => {
    expect(regla('.dash-orders__mobile')).toMatch(/display:\s*none/)
    const movil = media(767)
    expect(movil).toMatch(/\.dash-orders__desktop \{ display: none; \}/)
    expect(movil).toMatch(/\.dash-orders__mobile \{ display: block; \}/)
  })

  it('la fila de utilidades existe sólo en el shell mobile (<1024)', () => {
    expect(regla('.mobile-utility-bar')).toMatch(/display:\s*none/)
    const i = bloque.indexOf('@media (max-width: 1023px)')
    const shell = bloque.slice(i, bloque.indexOf('\n}\n', i))
    expect(shell).toMatch(/\.mobile-utility-bar \{\s*display: flex;/)
    // Área táctil de 44px para lo que se toca.
    expect(shell).toMatch(/\.mobile-utility-bar \.shell-chip \{\s*min-height: 44px;/)
    expect(shell).toMatch(/\.mobile-utility-bar \.shell-chip__refresh \{ width: 44px; height: 44px; \}/)
  })

  it('mobile: la principal ocupa el ancho y todo lo tocable mide 44px', () => {
    const movil = media(767)
    expect(movil).toMatch(/\.dash-action--primary \{ flex: 1 1 100%; min-height: 48px; \}/)
    expect(movil).toMatch(/\.dash-action \{ min-height: 44px; \}/)
    // Las secundarias comparten alto: con `center` (la regla de escritorio) el
    // rótulo que entra en una línea quedaba más bajo que el vecino en dos. Lo
    // encontró el E2E en CI, con las fuentes de Linux.
    expect(regla('.dash-actions')).toMatch(/align-items: center/)
    expect(movil).toMatch(/\.dash-actions \{ justify-content: stretch; align-items: stretch; \}/)
    // «Hoy» sigue siendo una fila de tres: no se redefine la grilla a 4 ni a 1.
    expect(movil).not.toMatch(/\.dash-today \{[^}]*grid-template-columns/)
    expect(regla('.dash-today')).toMatch(/grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  })

  it('la caja en la barra es un chip: no hay una franja de ancho completo', () => {
    const chip = regla('.shell-chip') ?? ''
    expect(chip).toMatch(/display: inline-flex/)
    expect(chip).not.toMatch(/width: 100%|display: (block|flex);/)
    expect(regla('.top-header__utilities')).toMatch(/flex-shrink: 0/)
  })
})

// ─── Aritmética WCAG ────────────────────────────────────────────────────────
const AA = 4.5
type RGB = [number, number, number]
const hex = (v: string): RGB => {
  const n = v.replace('#', '')
  return [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16)) as RGB
}
const luminancia = ([r, g, b]: RGB) => {
  const [R, G, B] = [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
const contraste = (a: RGB, b: RGB) => {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x)
  return (alto + 0.05) / (bajo + 0.05)
}
/** `rgba(r, g, b, a)` compuesto sobre un fondo opaco. */
const sobre = (rgba: string, fondo: RGB): RGB => {
  const [r, g, b, a] = (rgba.match(/[\d.]+/g) ?? []).map(Number)
  return [r, g, b].map((c, i) => c * a + fondo[i] * (1 - a)) as RGB
}

const limpio = sinComentarios(css)
const OSCURO = limpio.slice(0, limpio.indexOf('[data-theme="light"] {'))
const CLARO = limpio.slice(limpio.indexOf('[data-theme="light"] {'), limpio.indexOf('*, *::before, *::after { box-sizing'))
const token = (tema: string, nombre: string) => {
  const m = new RegExp(`${nombre}:\\s*([^;]+);`).exec(tema)
  if (!m) throw new Error(`token ${nombre} no definido`)
  return m[1].trim()
}
/** Los tokens de paleta viven en `:root` y valen en los dos temas. */
const paleta = (nombre: string) => hex(token(OSCURO, nombre))
const BLANCO = hex('#ffffff')

describe('BETA-UX-1F · CSS: los pares de color elegidos llegan a 4,5:1', () => {
  const TEMAS = [['oscuro', OSCURO], ['claro', CLARO]] as const

  it('`.btn-indigo-aa`: blanco sobre índigo plano, en reposo y en hover', () => {
    expect(regla('.btn-fill-indigo.btn-indigo-aa')).toMatch(/color: var\(--text-on-accent\);\s*background: var\(--indigo-600\);/)
    expect(regla('.btn-fill-indigo.btn-indigo-aa:hover:not(:disabled)')).toMatch(/color: var\(--text-on-accent\);\s*background: var\(--indigo-700\);/)
    expect(contraste(BLANCO, paleta('--indigo-600'))).toBeGreaterThanOrEqual(AA)
    expect(contraste(BLANCO, paleta('--indigo-700'))).toBeGreaterThanOrEqual(AA)
    // Por qué existe: el extremo del gradiente de `.btn-fill-indigo` no llega.
    expect(contraste(BLANCO, hex('#6366f1'))).toBeLessThan(AA)
  })

  it.each(TEMAS)('`.btn-danger-aa` (%s): el rojo de «Registrar gasto» se lee en reposo y en hover', (_tema, vars) => {
    expect(regla('.btn-danger.btn-danger-aa')).toMatch(/color: var\(--order-badge-pending-fg\)/)
    expect(regla('.btn-danger.btn-danger-aa:hover:not(:disabled)')).toMatch(/color: var\(--order-badge-pending-fg\)/)
    const pagina = hex(token(vars, '--bg-primary'))
    const texto = hex(token(vars, '--order-badge-pending-fg'))
    expect(contraste(texto, sobre(token(vars, '--error-subtle'), pagina))).toBeGreaterThanOrEqual(AA)
    expect(contraste(texto, sobre(token(vars, '--error-light'), pagina))).toBeGreaterThanOrEqual(AA)
  })

  it('por qué no alcanza `.btn-danger` a secas: `--error` en claro queda bajo 4,5', () => {
    const pagina = hex(token(CLARO, '--bg-primary'))
    expect(contraste(hex(token(CLARO, '--error')), sobre(token(CLARO, '--error-subtle'), pagina))).toBeLessThan(AA)
    // La regla global no se tocó.
    expect(limpio).toMatch(/\n\.btn-danger \{\s*color: var\(--error\);\s*background: var\(--error-subtle\);/)
  })

  it.each(TEMAS)('acento y peligro sobre la tarjeta (%s), también con hover', (tema, vars) => {
    const tarjeta = hex(token(vars, '--bg-card-solid'))
    const hover = sobre(token(vars, '--bg-hover'), tarjeta)
    const acento = paleta(tema === 'claro' ? '--indigo-600' : '--indigo-400')
    const peligro = hex(token(vars, '--order-badge-pending-fg'))
    for (const fondo of [tarjeta, hover]) {
      expect(contraste(acento, fondo)).toBeGreaterThanOrEqual(AA)
      expect(contraste(peligro, fondo)).toBeGreaterThanOrEqual(AA)
      expect(contraste(hex(token(vars, '--text-secondary')), fondo)).toBeGreaterThanOrEqual(AA)
    }
  })

  it('el acento cambia de tono por tema y el peligro reusa un token existente', () => {
    expect(regla('.dash-page,\n.dash-tasks')).toMatch(/--dash-accent-fg: var\(--indigo-400\);\s*--dash-danger-fg: var\(--order-badge-pending-fg\);/)
    expect(bloque).toMatch(/\[data-theme="light"\] \.dash-page,\s*\[data-theme="light"\] \.dash-tasks \{ --dash-accent-fg: var\(--indigo-600\); \}/)
    // El tono del otro tema NO llegaría.
    expect(contraste(paleta('--indigo-400'), hex(token(CLARO, '--bg-card-solid')))).toBeLessThan(AA)
    expect(contraste(hex(token(OSCURO, '--accent-primary')), hex(token(OSCURO, '--bg-card-solid')))).toBeLessThan(AA)
  })

  it.each(TEMAS)('el texto secundario se lee sobre la página (%s); el terciario no siempre', (tema, vars) => {
    const pagina = hex(token(vars, '--bg-primary'))
    expect(contraste(hex(token(vars, '--text-secondary')), pagina)).toBeGreaterThanOrEqual(AA)
    if (tema === 'claro') expect(contraste(hex(token(vars, '--text-tertiary')), pagina)).toBeLessThan(AA)
    expect(contraste(hex(token(vars, '--text-subtle')), pagina)).toBeLessThan(AA)
  })

  it('el subtítulo de Inicio no usa `--text-subtle`', () => {
    expect(regla('.dash-page .page-subtitle')).toMatch(/color: var\(--text-secondary\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Va ÚLTIMO a propósito. Mira lo que pidieron TODOS los montajes del archivo
// —Inicio con siete roles, la barra superior, el shell—, incluido el primero de
// cada módulo, que es el único en el que un hook con caché consulta de verdad.
// ═══════════════════════════════════════════════════════════════════════════
describe('BETA-UX-1F · contrato de red de todo el archivo', () => {
  it('ningún montaje de Inicio ni de la barra superior pidió una fuente financiera', () => {
    const tablas = [...new Set(h.historial.tablas)].sort()
    const rpcs = [...new Set(h.historial.rpcs)].sort()
    for (const tabla of TABLAS_FINANCIERAS) expect(tablas, `algún montaje consultó ${tabla}`).not.toContain(tabla)
    for (const rpc of RPCS_FINANCIERAS) expect(rpcs, `algún montaje llamó a ${rpc}`).not.toContain(rpc)
    // Y la lista completa es corta y conocida: lo que no esté acá es una fuente nueva.
    expect(tablas).toEqual(['cajas', 'orders', 'task_history', 'task_items', 'tasks'])
    expect(rpcs).toEqual(['get_my_first_steps'])
  })
})
