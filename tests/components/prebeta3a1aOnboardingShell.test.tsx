// ─────────────────────────────────────────────────────────────────────────────
// PRE-BETA-3A-1a · Onboarding de configuración + shell post-login compartido.
//
//   A. modelo      → 4 pasos de configuración + un estado final que no es paso,
//                    todo derivado de ONBOARDING_STEPS
//   B. trial       → el onboarding ya no vende el trial
//   C. checklist   → «Primeros pasos» vive sólo en el Dashboard
//   D. final       → éxito + el MISMO flujo de finalización
//   E. shell       → Onboarding, NoBusiness y VerifyEmail usan AuthFlowShell
//   F. routing     → los guards y el provisioning no cambiaron
//   G. signupIntent→ el plan de la landing sobrevive al onboarding
//   H. rubro       → sigue obligatorio: el servidor lo exige para completar
//
// El borde mockeado es `src/lib/supabase` (y `track`, para leer la conversión).
// AuthProvider, los guards y las páginas corren de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '22222222-2222-4222-8222-222222222222'

type FakeUser = { id: string; email: string; email_confirmed_at: string | null }
type Respuesta = { data: unknown; error: { code?: string; message?: string } | null }

const estado = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; email_confirmed_at: string | null } | null,
  llamadas: [] as { nombre: string; args: Record<string, unknown> }[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: { code?: string; message?: string } | null }>,
  perfilPendiente: null as null | (() => void),
  /** Deja colgada `update_my_business_onboarding` para observar el «guardando». */
  guardadoPendiente: null as null | (() => void),
  /** Error que devuelve Storage al subir el logo. */
  uploadError: null as null | { message: string },
}))

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/lib/analytics', () => ({ track: trackMock }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: estado.sessionUser ? { user: estado.sessionUser } : null },
        error: null,
      }),
      getUser: async () => ({ data: { user: estado.sessionUser }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => { estado.sessionUser = null; return { error: null } },
    },
    rpc: async (nombre: string, args: Record<string, unknown> = {}) => {
      estado.llamadas.push({ nombre, args })
      if (nombre === 'get_my_profile' && estado.perfilPendiente) {
        await new Promise<void>(resolve => { estado.perfilPendiente = resolve })
      }
      if (nombre === 'update_my_business_onboarding' && estado.guardadoPendiente) {
        await new Promise<void>(resolve => { estado.guardadoPendiente = resolve })
      }
      const handler = estado.rpc[nombre]
      return handler ? handler(args) : { data: null, error: null }
    },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: async () => ({ data: [], error: null }),
        update: () => ({ eq: async () => ({ data: null, error: null }) }),
      }
      return chain
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: estado.uploadError }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  },
}))

import { AuthProvider } from '../../src/contexts/AuthContext'
import { ProtectedRoute } from '../../src/components/auth/ProtectedRoute'
import { RequireEmailConfirmed } from '../../src/components/auth/RequireEmailConfirmed'
import { NoBusiness } from '../../src/pages/NoBusiness'
import { Onboarding } from '../../src/pages/Onboarding'
import { VerifyEmail } from '../../src/pages/VerifyEmail'
import { AuthFlowShell } from '../../src/components/auth/AuthFlowShell'
import { FIRST_STEPS } from '../../src/components/onboarding/FirstStepsChecklist'
import { stashInviteToken } from '../../src/lib/pendingInvite'
import * as signupIntent from '../../src/lib/signupIntent'
import {
  ONBOARDING_STEPS, ONBOARDING_STEP_COUNT, ONBOARDING_DONE, onboardingStepAt, onboardingProgressLabel,
  nextOnboardingPosition, previousOnboardingPosition, canGoBackFrom, resumeOnboardingPosition, isOnboardingDone,
} from '../../src/lib/onboardingSteps'
import type { BusinessSetup } from '../../src/services/businessSetupService'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

/** Quita comentarios: los chequeos estructurales buscan CÓDIGO, no prosa. */
const leerCodigo = (rel: string) =>
  leer(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

const confirmado = (): FakeUser => ({ id: USER_ID, email: 'owner@invalid.test', email_confirmed_at: '2026-09-30T10:00:00Z' })
const sinConfirmar = (): FakeUser => ({ id: USER_ID, email: 'owner@invalid.test', email_confirmed_at: null })

const perfil = (over: Record<string, unknown> = {}) => ({
  id: USER_ID, business_id: BIZ_ID, role: 'owner', is_active: true,
  full_name: 'Owner', email: 'owner@invalid.test',
  phone: null, permissions: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

const fila = (over: Record<string, unknown> = {}) => ({
  business_id: BIZ_ID, name: 'Mi Negocio', rubro: null, ciudad: null,
  whatsapp: null, logo_url: null, cuit: null, condicion_fiscal: null,
  onboarding_completed: false, onboarding_completed_at: null,
  role: 'owner', can_edit: true,
  ...over,
})

const COMPLETA = { name: 'Tecno', rubro: 'redes', logo_url: 'https://cdn.test/x.png', ciudad: 'Córdoba', whatsapp: '3510000000', cuit: '20123456789', condicion_fiscal: 'monotributo' }

beforeEach(() => {
  estado.sessionUser = null
  estado.llamadas = []
  estado.rpc = {}
  estado.perfilPendiente = null
  estado.guardadoPendiente = null
  estado.uploadError = null
  trackMock.mockReset()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

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
          <Route path="/verificar-email" element={<VerifyEmail />} />
          <Route path="/accept-invite" element={<div data-testid="accept-invite">ACEPTAR</div>} />
          <Route path="/no-business" element={<RequireEmailConfirmed><NoBusiness /></RequireEmailConfirmed>} />
          <Route path="/onboarding" element={<RequireEmailConfirmed><Onboarding /></RequireEmailConfirmed>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').textContent
const texto = () => document.body.textContent ?? ''
const llamadasA = (nombre: string) => estado.llamadas.filter(l => l.nombre === nombre)
const etiquetaProgreso = () => screen.getByTestId('onboarding-progress-label').textContent

/** Owner con negocio. `over` es la fila de onboarding PERSISTIDA. */
function ownerConNegocio(over: Record<string, unknown> = {}) {
  estado.sessionUser = confirmado()
  estado.rpc['get_my_profile'] = () => ({ data: perfil(), error: null })
  estado.rpc['get_my_business_onboarding'] = () => ({ data: fila(over), error: null })
  estado.rpc['update_my_business_onboarding'] = args => ({
    data: fila({ ...COMPLETA, onboarding_completed: args.p_complete === true }), error: null,
  })
}

/** Recorre los cuatro pasos desde el primero y deja la pantalla final. */
async function recorrerLosCuatroPasos() {
  await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
  expect(etiquetaProgreso()).toBe('Paso 1 de 4')
  fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
  fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
  fireEvent.click(screen.getByTestId('onboarding-step1-submit'))

  await waitFor(() => expect(screen.getByTestId('onboarding-logo-skip')).toBeInTheDocument())
  expect(etiquetaProgreso()).toBe('Paso 2 de 4')
  fireEvent.click(screen.getByTestId('onboarding-logo-skip'))

  await waitFor(() => expect(screen.getByTestId('onboarding-whatsapp')).toBeInTheDocument())
  expect(etiquetaProgreso()).toBe('Paso 3 de 4')
  fireEvent.click(screen.getByTestId('onboarding-step3-submit'))

  await waitFor(() => expect(screen.getByTestId('onboarding-cuit')).toBeInTheDocument())
  expect(etiquetaProgreso()).toBe('Paso 4 de 4')
  fireEvent.click(screen.getByTestId('onboarding-step4-submit'))

  await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())
}

const setupDe = (over: Partial<BusinessSetup> = {}): BusinessSetup => ({
  businessId: BIZ_ID, name: '', rubro: null, ciudad: null, whatsapp: null, logoUrl: null,
  cuit: null, condicionFiscal: null, onboardingCompleted: false, role: 'owner', canEdit: true,
  ...over,
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A · modelo del onboarding: una sola definición', () => {
  it('son CUATRO pasos de configuración, en este orden', () => {
    expect(ONBOARDING_STEP_COUNT).toBe(4)
    expect(ONBOARDING_STEPS.map(s => s.id)).toEqual(['negocio', 'identidad', 'contacto', 'fiscal'])
    expect(ONBOARDING_STEPS.map(s => s.label)).toEqual(['Tu negocio', 'Identidad', 'Contacto', 'Datos fiscales'])
  })

  it('el final es una posición, no un paso', () => {
    expect(ONBOARDING_DONE).toBe(ONBOARDING_STEP_COUNT + 1)
    expect(onboardingStepAt(ONBOARDING_DONE)).toBeNull()
    expect(isOnboardingDone(ONBOARDING_DONE)).toBe(true)
    expect(isOnboardingDone(ONBOARDING_STEP_COUNT)).toBe(false)
  })

  it('el progreso: paso 1 = 1/4, paso 4 = 4/4 y el final nunca es «Paso 5 de 4»', () => {
    expect(onboardingProgressLabel(1)).toBe('Paso 1 de 4')
    expect(onboardingProgressLabel(4)).toBe('Paso 4 de 4')
    expect(onboardingProgressLabel(ONBOARDING_DONE)).toBe('Configuración completa')
    expect(onboardingProgressLabel(ONBOARDING_DONE)).not.toMatch(/Paso/)
  })

  it('la navegación sale de la definición: siguiente, atrás y dónde retomar', () => {
    expect(nextOnboardingPosition(ONBOARDING_STEP_COUNT)).toBe(ONBOARDING_DONE)
    expect(nextOnboardingPosition(ONBOARDING_DONE)).toBe(ONBOARDING_DONE)
    expect([1, 2, 3, 4, 5].map(canGoBackFrom)).toEqual([false, true, true, true, false])
    expect(previousOnboardingPosition(2)).toBe(1)
    expect(previousOnboardingPosition(1)).toBe(1)

    expect(resumeOnboardingPosition(setupDe())).toBe(1)
    expect(resumeOnboardingPosition(setupDe({ name: 'Mi Negocio', rubro: 'redes' }))).toBe(1)
    expect(resumeOnboardingPosition(setupDe({ name: 'Tecno', rubro: 'redes' }))).toBe(2)
    expect(resumeOnboardingPosition(setupDe({ name: 'Tecno', rubro: 'redes', logoUrl: 'x' }))).toBe(3)
    expect(resumeOnboardingPosition(setupDe({ name: 'Tecno', rubro: 'redes', logoUrl: 'x', ciudad: 'C', whatsapp: '1' }))).toBe(4)
    expect(resumeOnboardingPosition(setupDe({
      name: 'Tecno', rubro: 'redes', logoUrl: 'x', ciudad: 'C', whatsapp: '1', cuit: '20123456789', condicionFiscal: 'monotributo',
    }))).toBe(ONBOARDING_DONE)
  })

  it('Onboarding.tsx no tiene contadores propios: todo viene de onboardingSteps', () => {
    const src = leerCodigo('src/pages/Onboarding.tsx')
    expect(src).not.toMatch(/TOTAL_STEPS/)
    expect(src).not.toMatch(/Paso \$\{/)
    expect(src).not.toMatch(/Array\.from\(\{\s*length/)
    expect(src).toContain('ONBOARDING_STEP_COUNT')
    expect(src).toContain('onboardingProgressLabel(step)')
    expect(src).toContain('resumeOnboardingPosition(actual)')
  })

  it('renderizado: 4 segmentos, «Paso X de 4» en cada paso y el final con los 4 completos', async () => {
    ownerConNegocio()
    montar('/onboarding')
    await recorrerLosCuatroPasos()

    const barra = screen.getByTestId('onboarding-progress')
    expect(barra.getAttribute('data-total')).toBe('4')
    const segmentos = barra.querySelectorAll('[data-state]')
    expect(segmentos).toHaveLength(4)
    expect([...segmentos].every(s => s.getAttribute('data-state') === 'done')).toBe(true)
    expect(etiquetaProgreso()).toBe('Configuración completa')
    expect(texto()).not.toMatch(/Paso 5/)
  })

  it('«Omitir» sólo en los pasos opcionales; «Atrás» desde el segundo', async () => {
    ownerConNegocio()
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    expect(ONBOARDING_STEPS[0].optional).toBe(false)
    expect(screen.queryByRole('button', { name: 'Omitir' })).toBeNull()
    expect(screen.queryByTestId('onboarding-back')).toBeNull()

    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))
    await waitFor(() => expect(screen.getByTestId('onboarding-logo-skip')).toBeInTheDocument())
    expect(ONBOARDING_STEPS.slice(1).every(s => s.optional)).toBe(true)
    expect(screen.getByTestId('onboarding-back')).toBeInTheDocument()
  })

  it('«Atrás» no persiste nada y no pierde lo escrito', async () => {
    ownerConNegocio({ name: 'Tecno', rubro: 'redes', logo_url: 'https://cdn.test/x.png' })
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-whatsapp')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('onboarding-whatsapp'), { target: { value: '3511111111' } })

    const antes = estado.llamadas.length
    fireEvent.click(screen.getByTestId('onboarding-back'))
    await waitFor(() => expect(screen.getByTestId('onboarding-logo-skip')).toBeInTheDocument())
    expect(etiquetaProgreso()).toBe('Paso 2 de 4')
    expect(estado.llamadas.length).toBe(antes)

    fireEvent.click(screen.getByTestId('onboarding-logo-skip'))
    await waitFor(() => expect(screen.getByTestId('onboarding-whatsapp')).toBeInTheDocument())
    expect((screen.getByTestId('onboarding-whatsapp') as HTMLInputElement).value).toBe('3511111111')
  })

  it('fallo del logo → «Quitar logo» → «Continuar»: Contacto llega sin el error del logo', async () => {
    // jsdom no implementa createObjectURL; la vista previa del logo lo usa.
    const original = URL.createObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:vista-previa')
    try {
      ownerConNegocio({ name: 'Tecno', rubro: 'redes' })
      estado.uploadError = { message: 'new row violates row-level security policy' }
      montar('/onboarding')
      await waitFor(() => expect(screen.getByTestId('onboarding-logo-input')).toBeInTheDocument())

      fireEvent.change(screen.getByTestId('onboarding-logo-input'), {
        target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] },
      })
      fireEvent.click(screen.getByTestId('onboarding-step2-submit'))
      await waitFor(() => expect(screen.getByTestId('onboarding-error')).toBeInTheDocument())
      expect(etiquetaProgreso()).toBe('Paso 2 de 4')

      fireEvent.click(screen.getByRole('button', { name: 'Quitar logo' }))
      expect(screen.queryByTestId('onboarding-error')).toBeNull()

      fireEvent.click(screen.getByTestId('onboarding-step2-submit'))
      await waitFor(() => expect(screen.getByTestId('onboarding-whatsapp')).toBeInTheDocument())
      expect(etiquetaProgreso()).toBe('Paso 3 de 4')
      expect(screen.queryByTestId('onboarding-error')).toBeNull()
      // Sin logo no hay nada que persistir: avanzar no llama al servidor.
      expect(llamadasA('update_my_business_onboarding')).toHaveLength(0)
    } finally {
      URL.createObjectURL = original
    }
  })

  it('mientras guarda: sin doble submit y sin «Atrás»/«Omitir» que lo pisen', async () => {
    ownerConNegocio({ name: 'Tecno', rubro: 'redes', logo_url: 'https://cdn.test/x.png' })
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-whatsapp')).toBeInTheDocument())

    estado.guardadoPendiente = () => {}
    fireEvent.click(screen.getByTestId('onboarding-step3-submit'))
    await waitFor(() => expect(screen.getByTestId('onboarding-step3-submit')).toBeDisabled())
    fireEvent.click(screen.getByTestId('onboarding-step3-submit'))
    expect(screen.getByTestId('onboarding-back')).toBeDisabled()
    expect(screen.getByTestId('onboarding-step3-skip')).toBeDisabled()
    expect(llamadasA('update_my_business_onboarding')).toHaveLength(1)

    estado.guardadoPendiente?.()
    estado.guardadoPendiente = null
    await waitFor(() => expect(screen.getByTestId('onboarding-cuit')).toBeInTheDocument())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B · el onboarding no vende el trial', () => {
  const PROHIBIDO = [/Trial Pro/i, /14 días/i, /Incluido en tu trial/i, /Elegiste el plan/i, /Suscripci[oó]n/i, /\bplan(es)?\b/i]

  it('ningún paso ni el final muestran trial, plan, precio o suscripción', async () => {
    ownerConNegocio()
    signupIntent.rememberSignupPlan('pro')
    montar('/onboarding')

    const vistos: string[] = []
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    vistos.push(texto())
    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))
    for (const [espera, avanzar] of [
      ['onboarding-logo-skip', 'onboarding-logo-skip'],
      ['onboarding-whatsapp', 'onboarding-step3-submit'],
      ['onboarding-cuit', 'onboarding-step4-submit'],
    ] as const) {
      await waitFor(() => expect(screen.getByTestId(espera)).toBeInTheDocument())
      vistos.push(texto())
      fireEvent.click(screen.getByTestId(avanzar))
    }
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())
    vistos.push(texto())

    expect(vistos).toHaveLength(5)
    for (const t of vistos) for (const re of PROHIBIDO) expect(t).not.toMatch(re)
    expect(screen.queryByRole('button', { name: /plan|suscrip/i })).toBeNull()
  })

  it('el código del onboarding ya no tiene el paso ni la lista del trial', () => {
    const src = leer('src/pages/Onboarding.tsx')
    expect(src).not.toContain('TRIAL_FEATURES_LIST')
    expect(src).not.toContain('handleStep5')
    expect(src).not.toContain('onboarding-step5-submit')
    expect(src).not.toMatch(/Trial Pro|14 días|Incluido en tu trial|Elegiste el plan/)
    expect(leerCodigo('src/pages/Onboarding.tsx')).not.toMatch(/\bPLANS\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C · «Primeros pasos» vive sólo en el Dashboard', () => {
  it('Onboarding no define ni monta un checklist propio', () => {
    const src = leerCodigo('src/pages/Onboarding.tsx')
    expect(src).not.toContain('CHECKLIST_INITIAL')
    expect(src).not.toMatch(/FirstStepsChecklist|SetupChecklist/)
  })

  it('el final no repite las tareas ni dibuja otro «Primeros pasos»', async () => {
    ownerConNegocio(COMPLETA)
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())

    expect(screen.queryByTestId('setup-checklist')).toBeNull()
    expect(screen.queryByText('Primeros pasos')).toBeNull()
    for (const tarea of [
      'Crear tu primera orden de reparación', 'Agregar productos al inventario', 'Registrar tu primer cliente',
      'Hacer tu primer cobro', 'Configurar métodos de pago', ...FIRST_STEPS.map(s => s.label),
    ]) {
      expect(texto()).not.toContain(tarea)
    }
  })

  it('la fuente de «Primeros pasos» sigue siendo FIRST_STEPS (derivada del servidor)', () => {
    expect(FIRST_STEPS.map(s => s.id)).toEqual(['customer', 'order', 'inventory', 'cobro', 'logo'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D · pantalla final', () => {
  it('muestra el éxito y el CTA ejecuta la MISMA finalización: complete → refresh → /dashboard', async () => {
    ownerConNegocio(COMPLETA)
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())

    const tarjeta = screen.getByTestId('onboarding-done')
    expect(tarjeta).toHaveTextContent('Todo listo')
    expect(tarjeta).toHaveTextContent('Tu negocio ya está configurado.')
    expect(tarjeta).toHaveTextContent('Desde Inicio vas a poder completar tus primeros pasos y empezar a trabajar.')
    expect(screen.getByTestId('onboarding-finish')).toHaveTextContent('Ir al inicio')

    const perfilesAntes = llamadasA('get_my_profile').length
    fireEvent.click(screen.getByTestId('onboarding-finish'))

    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    const completar = llamadasA('update_my_business_onboarding').filter(l => l.args.p_complete === true)
    expect(completar).toHaveLength(1)
    expect(llamadasA('get_my_profile').length).toBeGreaterThan(perfilesAntes)
    expect(llamadasA('provision_my_business')).toHaveLength(0)
  })

  it('si el servidor dice ONBOARDING_INCOMPLETE vuelve al paso 1 con el error, sin navegar', async () => {
    ownerConNegocio(COMPLETA)
    estado.rpc['update_my_business_onboarding'] = () => ({ data: null, error: { code: 'TRONB', message: 'ONBOARDING_INCOMPLETE: rubro' } })
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('onboarding-finish'))

    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    expect(screen.getByTestId('onboarding-error')).toHaveTextContent('completá el nombre y el rubro')
    expect(etiquetaProgreso()).toBe('Paso 1 de 4')
    expect(ruta()).toBe('/onboarding')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('E · shell compartido', () => {
  const enShell = (el: HTMLElement) => el.closest('[data-auth-flow-shell]') !== null

  it('AuthFlowShell es presentacional: no conoce auth, datos ni negocio', () => {
    const src = leerCodigo('src/components/auth/AuthFlowShell.tsx')
    expect(src).not.toMatch(/supabase|AuthContext|useAuth|usePermissions|services\/|businessId|provision|onboarding|profileErrorKind|authState/i)
  })

  it('las tres pantallas componen el MISMO shell y ya no tienen marco propio', () => {
    for (const rel of ['src/pages/Onboarding.tsx', 'src/pages/NoBusiness.tsx', 'src/pages/VerifyEmail.tsx']) {
      const src = leerCodigo(rel)
      expect(src, rel).toMatch(/from '\.\.\/components\/auth\/AuthFlowShell'/)
      expect(src, rel).toContain('<AuthFlowShell')
      expect(src, rel).not.toMatch(/background:\s*'var\(--auth-bg\)'/)
      expect(src, rel).not.toMatch(/minHeight:\s*'100dvh'/)
    }
  })

  it('el shell pinta marca, progreso, «Atrás» y encabezado sólo con lo que recibe', () => {
    const volver = vi.fn()
    render(
      <AuthFlowShell
        testId="pagina" cardTestId="tarjeta" eyebrow="Ojo" title="Título" description="Descripción"
        progress={{ total: 3, current: 2, label: 'Paso 2 de 3', testId: 'prog' }}
        back={{ label: 'Atrás', onClick: volver, testId: 'volver' }}
      >
        <p>contenido</p>
      </AuthFlowShell>,
    )
    expect(screen.getByRole('img', { name: 'TechRepair Pro' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Título' })).toBeInTheDocument()
    expect(screen.getByTestId('prog-label')).toHaveTextContent('Paso 2 de 3')
    expect([...screen.getByTestId('prog').querySelectorAll('[data-state]')].map(s => s.getAttribute('data-state')))
      .toEqual(['done', 'current', 'pending'])
    fireEvent.click(screen.getByTestId('volver'))
    expect(volver).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('tarjeta')).toHaveTextContent('contenido')
    expect(enShell(screen.getByTestId('tarjeta'))).toBe(true)
  })

  it('Onboarding: carga, pasos y final dentro del shell', async () => {
    ownerConNegocio()
    estado.perfilPendiente = () => {}
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-loading')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('onboarding-loading'))).toBe(true)
    estado.perfilPendiente?.()
    estado.perfilPendiente = null

    await waitFor(() => expect(screen.getByTestId('onboarding-step-negocio')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('onboarding-step-negocio'))).toBe(true)
  })

  it('NoBusiness: loading, inactive, invitation, error y create siguen existiendo, dentro del shell', async () => {
    // loading
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: null, error: null })
    estado.perfilPendiente = () => {}
    const a = montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-loading')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('no-business-loading'))).toBe(true)
    estado.perfilPendiente?.()
    estado.perfilPendiente = null
    // create
    await waitFor(() => expect(screen.getByTestId('no-business-create')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('no-business-create'))).toBe(true)
    expect(screen.getByLabelText('Nombre del negocio')).toBe(screen.getByTestId('no-business-name'))
    a.unmount()

    // invitation
    stashInviteToken('tok-invitacion-sintetica')
    const b = montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-invitation')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('no-business-invitation'))).toBe(true)
    b.unmount()
    window.localStorage.clear()
    window.sessionStorage.clear()

    // error
    estado.rpc['get_my_profile'] = () => ({ data: null, error: { message: 'boom' } })
    const c = montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-reintentar')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('no-business-reintentar'))).toBe(true)
    expect(screen.queryByTestId('no-business-crear')).toBeNull()
    c.unmount()

    // inactive
    estado.rpc['get_my_profile'] = () => ({ data: [perfil({ is_active: false, role: 'tech', user_id: USER_ID })], error: null })
    montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-inactive')).toBeInTheDocument())
    expect(enShell(screen.getByTestId('no-business-inactive'))).toBe(true)
    expect(screen.getByTestId('no-business-inactive')).toHaveTextContent('Tu acceso a este negocio está desactivado')
  })

  it('VerifyEmail: la página es el shell y conserva sus testids', async () => {
    estado.sessionUser = sinConfirmar()
    montar('/verificar-email')
    await waitFor(() => expect(screen.getByTestId('verify-email-page')).toBeInTheDocument())
    expect(screen.getByTestId('verify-email-page')).toHaveAttribute('data-auth-flow-shell')
    for (const id of ['verify-email-estado', 'verify-email-address', 'verify-email-ya-confirme', 'verify-email-reenviar', 'verify-email-salir']) {
      expect(screen.getByTestId(id), id).toBeInTheDocument()
    }
    expect(screen.getByTestId('verify-email-reenviar')).not.toBeDisabled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('F · routing/auth: nada cambió', () => {
  it('usuario confirmado sin negocio sigue en /no-business', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: null, error: null })
    montar('/dashboard')
    await waitFor(() => expect(ruta()).toBe('/no-business'))
    await waitFor(() => expect(screen.getByTestId('no-business-create')).toBeInTheDocument())
    expect(llamadasA('provision_my_business')).toHaveLength(0)
  })

  it('un invitado acepta su invitación y NO crea un negocio', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: null, error: null })
    stashInviteToken('tok-invitacion-sintetica')
    montar('/no-business')
    fireEvent.click(await screen.findByTestId('no-business-aceptar-invitacion'))
    await waitFor(() => expect(ruta()).toBe('/accept-invite'))
    expect(llamadasA('provision_my_business')).toHaveLength(0)
  })

  it('un owner sin negocio lo crea con un click explícito y sigue al onboarding', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: null, error: null })
    estado.rpc['provision_my_business'] = () => ({ data: { business_id: BIZ_ID, created: true }, error: null })
    montar('/no-business')
    fireEvent.change(await screen.findByTestId('no-business-name'), { target: { value: 'Taller Nuevo' } })
    expect(llamadasA('provision_my_business')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('no-business-crear'))
    await waitFor(() => expect(ruta()).toBe('/onboarding'))
    expect(llamadasA('provision_my_business')).toHaveLength(1)
    expect(llamadasA('provision_my_business')[0].args).toEqual({ p_business_name: 'Taller Nuevo' })
  })

  it('email sin confirmar: /onboarding y /no-business siguen yendo a /verificar-email', async () => {
    for (const destino of ['/onboarding', '/no-business']) {
      estado.sessionUser = sinConfirmar()
      const vista = montar(destino)
      await waitFor(() => expect(ruta()).toBe('/verificar-email'))
      expect(screen.getByTestId('verify-email-page')).toBeInTheDocument()
      vista.unmount()
    }
    expect(llamadasA('get_my_profile')).toHaveLength(0)
  })

  it('con el perfil en vuelo no redirige antes de tiempo', async () => {
    ownerConNegocio()
    estado.perfilPendiente = () => {}
    montar('/onboarding')
    await new Promise(r => setTimeout(r, 60))
    expect(ruta()).toBe('/onboarding')
    expect(screen.getByTestId('onboarding-loading')).toBeInTheDocument()
    estado.perfilPendiente?.()
    estado.perfilPendiente = null
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    expect(ruta()).toBe('/onboarding')
  })

  it('un técnico que llega al onboarding recibe la explicación, no el wizard', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil({ role: 'tech' }), error: null })
    estado.rpc['get_my_business_onboarding'] = () => ({ data: fila({ role: 'tech', can_edit: false, name: 'Taller X' }), error: null })
    montar('/onboarding')
    fireEvent.click(await screen.findByTestId('onboarding-ir-dashboard'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    expect(llamadasA('update_my_business_onboarding')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('G · signupIntent: el plan de la landing sobrevive al onboarding', () => {
  it('el contrato de src/lib/signupIntent.ts no cambió', () => {
    expect(signupIntent.TRIAL_DESTINATION).toBe('/onboarding')
    expect(signupIntent.signupPath('pro')).toBe('/login?modo=registro&redirectTo=%2Fonboarding%3Fplan%3Dpro')
    expect(signupIntent.initialLoginMode('?modo=registro')).toBe('register')
    for (const fn of ['isValidPlan', 'planFromInternalPath', 'rememberSignupPlan', 'readSignupPlan', 'clearSignupPlan'] as const) {
      expect(typeof signupIntent[fn]).toBe('function')
    }
  })

  it('recorrer los 4 pasos conserva el plan hasta la conversión (sin mostrarlo)', async () => {
    ownerConNegocio()
    signupIntent.rememberSignupPlan('pro')
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    // Se guarda para sobrevivir un refresh a mitad del wizard.
    expect(window.sessionStorage.getItem('trp_origin_plan')).toBe('pro')

    await recorrerLosCuatroPasos()
    expect(window.sessionStorage.getItem('trp_origin_plan')).toBe('pro')
    expect(texto()).not.toMatch(/\bplan\b/i)

    fireEvent.click(screen.getByTestId('onboarding-finish'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    expect(trackMock).toHaveBeenCalledWith('signup_completed', expect.objectContaining({ plan: 'pro', source: 'onboarding' }))
  })

  it('un refresh a mitad del onboarding no pierde el plan', async () => {
    ownerConNegocio()
    signupIntent.rememberSignupPlan('full')
    const primera = montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    primera.unmount()
    // La marca entre pestañas ya se consumió; lo que queda es la de la sesión.
    expect(signupIntent.readSignupPlan()).toBeNull()

    ownerConNegocio(COMPLETA)
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('onboarding-finish'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    expect(trackMock).toHaveBeenCalledWith('signup_completed', expect.objectContaining({ plan: 'full' }))
  })

  it('sin plan elegido la conversión se registra con plan null (igual que antes)', async () => {
    ownerConNegocio(COMPLETA)
    montar('/onboarding')
    fireEvent.click(await screen.findByTestId('onboarding-finish'))
    await waitFor(() => expect(ruta()).toBe('/dashboard'))
    expect(trackMock).toHaveBeenCalledWith('signup_completed', expect.objectContaining({ plan: null }))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('H · rubro: sigue obligatorio porque el servidor lo exige', () => {
  it('el contrato vigente del servidor no completa el onboarding sin rubro', () => {
    // La ÚLTIMA migración que define update_my_business_profile es la que manda
    // (update_my_business_onboarding delega en ella).
    const dir = join(here, '../../supabase/migrations')
    const definiciones = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
      .filter(f => readFileSync(join(dir, f), 'utf8').includes('CREATE OR REPLACE FUNCTION public.update_my_business_profile('))
    expect(definiciones.length).toBeGreaterThan(0)
    const sql = readFileSync(join(dir, definiciones[definiciones.length - 1]), 'utf8')
    const cuerpo = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.update_my_business_profile('))
    expect(cuerpo).toMatch(/b\.rubro IS NOT NULL[\s\S]{0,200}array_append\(v_faltan, 'rubro'\)/)
    expect(cuerpo).toMatch(/ONBOARDING_INCOMPLETE/)
  })

  it('el frontend no deja avanzar sin rubro y no llama al servidor', async () => {
    ownerConNegocio()
    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))
    expect(await screen.findByTestId('onboarding-error')).toHaveTextContent('Seleccioná el rubro de tu negocio')
    expect(llamadasA('update_my_business_onboarding')).toHaveLength(0)
    expect(ONBOARDING_STEPS.find(s => s.id === 'negocio')!.optional).toBe(false)
  })

  it('las opciones de rubro exponen su estado seleccionado (no sólo color)', async () => {
    ownerConNegocio()
    montar('/onboarding')
    const redes = await screen.findByTestId('onboarding-rubro-redes')
    expect(redes).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(redes)
    expect(redes).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('onboarding-rubro-celulares')).toHaveAttribute('aria-pressed', 'false')
  })
})
