// ─────────────────────────────────────────────────────────────────────────────
// P0-P4 + P0-P5 — Routing/recovery y onboarding como configuración.
//
// Contraparte de tests/sql/p0p5_business_onboarding.test.sql (contrato del
// servidor). Acá se mide el comportamiento del cliente:
//
//   A. HIDRATACIÓN — ningún redirect antes de que auth Y profile terminen
//   B. owner con negocio  -> dashboard, sin provisioning
//   C. invitado (tech)    -> dashboard, NO al onboarding de owner
//   D. sin negocio real   -> recovery con alta explícita
//   E. AUTH_ERROR         -> reintentar, NUNCA ofrecer crear un tenant
//   F. onboarding         -> precarga, persiste por RPC, no avanza si falla
//   G. logo               -> contrato canónico, path por tenant
//   H. estructura         -> cero UPDATE directo a businesses desde el cliente
//
// El borde mockeado es `src/lib/supabase`. AuthProvider y las páginas corren
// de verdad.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const BIZ_ID = '22222222-2222-4222-8222-222222222222'

type FakeUser = { id: string; email: string; email_confirmed_at: string | null }

const estado = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; email_confirmed_at: string | null } | null,
  llamadas: [] as { nombre: string; args: Record<string, unknown> }[],
  /** Respuestas por nombre de RPC. */
  rpc: {} as Record<string, () => { data: unknown; error: { code?: string; message?: string } | null }>,
  /** Retrasa `get_my_profile` para poder observar la ventana de hidratación. */
  perfilPendiente: null as null | (() => void),
  updates: [] as { tabla: string; valores: Record<string, unknown> }[],
  uploads: [] as { bucket: string; path: string }[],
  uploadError: null as { message: string } | null,
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
      signOut: async () => { estado.sessionUser = null; return { error: null } },
    },
    rpc: async (nombre: string, args: Record<string, unknown> = {}) => {
      estado.llamadas.push({ nombre, args })
      if (nombre === 'get_my_profile' && estado.perfilPendiente) {
        await new Promise<void>(resolve => { estado.perfilPendiente = resolve })
      }
      const handler = estado.rpc[nombre]
      return handler ? handler() : { data: null, error: null }
    },
    from: (tabla: string) => {
      const chain: Record<string, unknown> = {
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
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          estado.uploads.push({ bucket, path })
          return { error: estado.uploadError }
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  },
}))

import { AuthProvider } from '../../src/contexts/AuthContext'
import { ProtectedRoute } from '../../src/components/auth/ProtectedRoute'
import { NoBusiness } from '../../src/pages/NoBusiness'
import { Onboarding } from '../../src/pages/Onboarding'

const here = dirname(fileURLToPath(import.meta.url))
const leer = (rel: string) => readFileSync(join(here, '../../', rel), 'utf8')

/** Quita comentarios: los chequeos estructurales buscan CÓDIGO, no prosa. */
const leerCodigo = (rel: string) =>
  leer(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '')

const confirmado = (): FakeUser => ({ id: USER_ID, email: 'owner@invalid.test', email_confirmed_at: '2026-08-25T10:00:00Z' })

const perfil = (over: Record<string, unknown> = {}) => ({
  id: USER_ID, business_id: BIZ_ID, role: 'owner', is_active: true,
  full_name: 'Owner', email: 'owner@invalid.test',
  phone: null, permissions: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

const setup = (over: Record<string, unknown> = {}) => ({
  business_id: BIZ_ID, name: 'Mi Negocio', rubro: null, ciudad: null,
  whatsapp: null, logo_url: null, cuit: null, condicion_fiscal: null,
  onboarding_completed: false, onboarding_completed_at: null,
  role: 'owner', can_edit: true,
  ...over,
})

beforeEach(() => {
  estado.sessionUser = null
  estado.llamadas = []
  estado.rpc = {}
  estado.perfilPendiente = null
  estado.updates = []
  estado.uploads = []
  estado.uploadError = null
  window.localStorage.clear()
  window.sessionStorage.clear()
})

function Sonda() {
  const location = useLocation()
  return <span data-testid="ruta">{location.pathname}</span>
}

function montar(ruta: string) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <AuthProvider>
        <Sonda />
        <Routes>
          <Route path="/login" element={<div data-testid="login">LOGIN</div>} />
          <Route path="/verificar-email" element={<div data-testid="verificar">VERIFICAR</div>} />
          <Route path="/no-business" element={<NoBusiness />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div data-testid="dashboard">DASHBOARD</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const ruta = () => screen.getByTestId('ruta').textContent

// ═══════════════════════════════════════════════════════════════════════════
describe('A · hidratación', () => {
  it('NO redirige mientras el perfil está en vuelo', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil(), error: null })
    // Deja `get_my_profile` colgado para observar la ventana.
    estado.perfilPendiente = () => {}

    montar('/dashboard')

    // Ventana en la que el bug viejo mandaba a /no-business: `profile` es null
    // pero eso NO significa «no tiene negocio».
    await new Promise(r => setTimeout(r, 50))
    expect(ruta()).toBe('/dashboard')
    expect(screen.queryByTestId('dashboard')).toBeNull()   // sigue el loader

    // Se libera la carga y recién ahí entra.
    estado.perfilPendiente?.()
    estado.perfilPendiente = null
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
  })

  it('un owner con negocio nunca pasa por /no-business', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil(), error: null })

    const rutas: string[] = []
    const { rerender } = montar('/dashboard')
    rutas.push(ruta()!)
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())
    rerender(<div />)

    expect(rutas).not.toContain('/no-business')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('B/C · recuperación tras login', () => {
  it('B · owner con negocio entra al dashboard y NO provisiona', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil(), error: null })

    montar('/dashboard')
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())

    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)
  })

  it('C · un invitado (tech) va al dashboard, no al onboarding de owner', async () => {
    estado.sessionUser = confirmado()
    // `onboarding_completed` del negocio es false, pero eso pertenece a la
    // CONFIGURACIÓN del negocio, no al lifecycle de cada miembro.
    estado.rpc['get_my_profile'] = () => ({ data: perfil({ role: 'tech' }), error: null })

    montar('/dashboard')
    await waitFor(() => expect(screen.getByTestId('dashboard')).toBeTruthy())

    expect(ruta()).toBe('/dashboard')
    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)
  })

  it('C2 · si un tech llega igual al onboarding, se le explica en vez de romper', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil({ role: 'tech' }), error: null })
    estado.rpc['get_my_business_onboarding'] = () => ({ data: setup({ role: 'tech', can_edit: false }), error: null })

    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-ir-dashboard')).toBeTruthy())
    expect(estado.llamadas.some(l => l.nombre === 'update_my_business_onboarding')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('D/E · recovery', () => {
  it('D · sin perfil real: ofrece el alta EXPLÍCITA y no provisiona sola', async () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: null, error: null })
    estado.rpc['link_profile_to_auth_user'] = () => ({ data: null, error: null })

    montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-create')).toBeTruthy())

    // Montar la pantalla NO crea nada: hace falta un click.
    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)

    estado.rpc['provision_my_business'] = () => ({ data: { business_id: BIZ_ID, created: true }, error: null })
    fireEvent.change(screen.getByTestId('no-business-name'), { target: { value: 'Taller Nuevo' } })
    fireEvent.click(screen.getByTestId('no-business-crear'))

    await waitFor(() => {
      expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(true)
    })
    const llamada = estado.llamadas.find(l => l.nombre === 'provision_my_business')!
    expect(Object.keys(llamada.args)).toEqual(['p_business_name'])
  })

  it('E · AUTH_ERROR ofrece reintentar y NUNCA crear un tenant', async () => {
    estado.sessionUser = confirmado()
    // Falla la carga del perfil: NO sabemos si tiene negocio.
    //
    // El mensaje NO puede ser uno de los transitorios reconocidos ("failed to
    // fetch", "timeout", "auth-token"...): esos se reintentan 4 veces con
    // backoff y el estado tardaría segundos en estabilizarse. Acá interesa el
    // estado FINAL, así que se usa un fallo que no se reintenta.
    estado.rpc['get_my_profile'] = () => ({ data: null, error: { message: 'boom' } })

    montar('/no-business')
    await waitFor(() => expect(screen.getByTestId('no-business-error')).toBeTruthy())

    // La distinción que evita fabricar tenants duplicados a partir de un corte
    // de red: acá no hay formulario de alta.
    expect(screen.queryByTestId('no-business-crear')).toBeNull()
    expect(screen.getByTestId('no-business-reintentar')).toBeTruthy()
    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('F · onboarding como configuración', () => {
  const conNegocio = () => {
    estado.sessionUser = confirmado()
    estado.rpc['get_my_profile'] = () => ({ data: perfil(), error: null })
  }

  it('precarga desde la DB (reanudación)', async () => {
    conNegocio()
    estado.rpc['get_my_business_onboarding'] = () => ({
      data: setup({ name: 'Tecno', rubro: 'celulares', logo_url: 'https://cdn.test/x.png', ciudad: 'Córdoba' }),
      error: null,
    })

    montar('/onboarding')
    // Con nombre, rubro y logo ya cargados, retoma en el primer paso pendiente
    // —contacto, porque falta el WhatsApp— y con lo ya guardado precargado: no
    // vuelve al principio ni pierde nada.
    await waitFor(() => expect(screen.getByTestId('onboarding-ciudad')).toBeTruthy())
    expect((screen.getByTestId('onboarding-ciudad') as HTMLInputElement).value).toBe('Córdoba')
  })

  it('el paso 1 persiste por RPC y NO por update directo', async () => {
    conNegocio()
    estado.rpc['get_my_business_onboarding'] = () => ({ data: setup(), error: null })
    estado.rpc['update_my_business_onboarding'] = () => ({
      data: setup({ name: 'Tecno', rubro: 'redes' }), error: null,
    })

    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeTruthy())

    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))

    await waitFor(() => {
      expect(estado.llamadas.some(l => l.nombre === 'update_my_business_onboarding')).toBe(true)
    })

    const args = estado.llamadas.find(l => l.nombre === 'update_my_business_onboarding')!.args
    expect(args.p_name).toBe('Tecno')
    expect(args.p_rubro).toBe('redes')
    // El tenant NO viaja: lo deriva el servidor.
    expect(args).not.toHaveProperty('p_business_id')
    // Y cero escrituras directas a businesses.
    expect(estado.updates.filter(u => u.tabla === 'businesses')).toHaveLength(0)
  })

  it('si la persistencia falla NO avanza de paso', async () => {
    conNegocio()
    estado.rpc['get_my_business_onboarding'] = () => ({ data: setup(), error: null })
    estado.rpc['update_my_business_onboarding'] = () => ({
      data: null, error: { code: '42501', message: 'FORBIDDEN' },
    })

    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeTruthy())

    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))

    await waitFor(() => expect(screen.getByTestId('onboarding-error')).toBeTruthy())
    // El bug viejo: avanzaba igual y el dato se perdía. Ahora sigue en el paso 1.
    expect(screen.getByTestId('onboarding-business-name')).toBeTruthy()
    // Y el mensaje es de producto, no un SQLSTATE.
    expect(screen.getByTestId('onboarding-error').textContent).not.toContain('42501')
    expect(screen.getByTestId('onboarding-error').textContent).not.toContain('FORBIDDEN')
  })

  it('completar valida contra lo persistido y refresca el perfil', async () => {
    conNegocio()
    estado.rpc['get_my_business_onboarding'] = () => ({
      data: setup({ name: 'Tecno', rubro: 'redes', logo_url: 'https://cdn.test/x.png', ciudad: 'Córdoba' }),
      error: null,
    })
    estado.rpc['update_my_business_onboarding'] = () => ({
      data: setup({ name: 'Tecno', rubro: 'redes', onboarding_completed: true }), error: null,
    })

    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-ciudad')).toBeTruthy())

    fireEvent.click(screen.getByTestId('onboarding-step3-submit'))
    await waitFor(() => expect(screen.getByTestId('onboarding-cuit')).toBeTruthy())
    fireEvent.click(screen.getByTestId('onboarding-step4-submit'))
    await waitFor(() => expect(screen.getByTestId('onboarding-step5-submit')).toBeTruthy())
    fireEvent.click(screen.getByTestId('onboarding-step5-submit'))
    await waitFor(() => expect(screen.getByTestId('onboarding-finish')).toBeTruthy())

    const antes = estado.llamadas.filter(l => l.nombre === 'get_my_profile').length
    fireEvent.click(screen.getByTestId('onboarding-finish'))

    await waitFor(() => {
      const completar = estado.llamadas.filter(
        l => l.nombre === 'update_my_business_onboarding' && l.args.p_complete === true)
      expect(completar.length).toBe(1)
    })
    // El nombre del negocio cambió: sin refrescar, el shell mostraría el viejo.
    await waitFor(() => {
      expect(estado.llamadas.filter(l => l.nombre === 'get_my_profile').length).toBeGreaterThan(antes)
    })
  })

  it('el onboarding NUNCA provisiona un tenant', async () => {
    conNegocio()
    estado.rpc['get_my_business_onboarding'] = () => ({ data: setup(), error: null })
    estado.rpc['update_my_business_onboarding'] = () => ({ data: setup({ rubro: 'redes' }), error: null })

    montar('/onboarding')
    await waitFor(() => expect(screen.getByTestId('onboarding-business-name')).toBeTruthy())
    fireEvent.change(screen.getByTestId('onboarding-business-name'), { target: { value: 'Tecno' } })
    fireEvent.click(screen.getByTestId('onboarding-rubro-redes'))
    fireEvent.click(screen.getByTestId('onboarding-step1-submit'))

    await waitFor(() => expect(estado.llamadas.some(l => l.nombre === 'update_my_business_onboarding')).toBe(true))
    expect(estado.llamadas.some(l => l.nombre === 'provision_my_business')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('G · logo', () => {
  it('sube al path por tenant y persiste la URL por la RPC', async () => {
    const { uploadBusinessLogo } = await import('../../src/lib/storageSetup')
    const file = new File(['x'], 'mi logo.png', { type: 'image/png' })

    const url = await uploadBusinessLogo(file, BIZ_ID)

    expect(estado.uploads).toHaveLength(1)
    const { bucket, path } = estado.uploads[0]
    expect(bucket).toBe('business-assets')
    // El business_id es una CARPETA, no parte del nombre: es lo único que la
    // policy de Storage puede validar server-side.
    expect(path.startsWith(`business-logos/${BIZ_ID}/`)).toBe(true)
    // El nombre que eligió el usuario no se usa tal cual.
    expect(path).not.toContain('mi logo')
    expect(url).toContain(`business-logos/${BIZ_ID}/`)
  })

  it('un fallo de RLS se traduce a un mensaje de producto', async () => {
    const { uploadBusinessLogo, LogoUploadError } = await import('../../src/lib/storageSetup')
    estado.uploadError = { message: 'new row violates row-level security policy' }

    const file = new File(['x'], 'l.png', { type: 'image/png' })
    await expect(uploadBusinessLogo(file, BIZ_ID)).rejects.toBeInstanceOf(LogoUploadError)

    try {
      await uploadBusinessLogo(file, BIZ_ID)
    } catch (e) {
      // Es literalmente lo que vio el usuario en producción.
      expect((e as Error).message).not.toContain('row-level security')
      expect((e as Error).message).toContain('permisos')
    }
  })

  it('rechaza formato y tamaño antes de tocar la red', async () => {
    const { uploadBusinessLogo } = await import('../../src/lib/storageSetup')

    await expect(uploadBusinessLogo(new File(['x'], 'a.gif', { type: 'image/gif' }), BIZ_ID))
      .rejects.toMatchObject({ code: 'BAD_FORMAT' })

    const gordo = new File([new Uint8Array(6 * 1024 * 1024)], 'a.png', { type: 'image/png' })
    await expect(uploadBusinessLogo(gordo, BIZ_ID)).rejects.toMatchObject({ code: 'TOO_LARGE' })

    expect(estado.uploads).toHaveLength(0)
  })

  it('sin negocio no se sube nada', async () => {
    const { uploadBusinessLogo } = await import('../../src/lib/storageSetup')
    await expect(uploadBusinessLogo(new File(['x'], 'a.png', { type: 'image/png' }), ''))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(estado.uploads).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('H · estructura', () => {
  const PANTALLAS = [
    'src/pages/Onboarding.tsx',
    'src/pages/NoBusiness.tsx',
    'src/pages/Settings.tsx',
    'src/components/settings/OrderPrintSettings.tsx',
    'src/components/settings/ComprobantePrintSettings.tsx',
  ]

  it('ningún cliente escribe directo sobre businesses', () => {
    // `authenticated` no tiene GRANT de UPDATE: un `.update()` acá sería un
    // 42501 silencioso, que es exactamente el bug que cierra P0-P5.
    for (const archivo of PANTALLAS) {
      const codigo = leerCodigo(archivo)
      expect(codigo, `${archivo} escribe directo sobre businesses`)
        .not.toMatch(/from\(\s*['"]businesses['"]\s*\)[\s\S]{0,160}\.(update|insert|delete)\(/)
    }
  })

  it('el logo se persiste por la RPC canónica, no por update de settings', () => {
    for (const archivo of PANTALLAS) {
      const codigo = leerCodigo(archivo)
      expect(codigo, `${archivo} persiste el logo con un update directo`)
        .not.toMatch(/from\(\s*['"]business_settings['"]\s*\)[\s\S]{0,120}\.update\([\s\S]{0,80}logo_url/)
    }
  })

  it('el onboarding no puede crear tenants', () => {
    const codigo = leerCodigo('src/pages/Onboarding.tsx')
    expect(codigo).not.toContain('provisionMyBusiness')
    expect(codigo).not.toContain('provision_my_business')
  })

  it('sólo storageSetup habla con el bucket de assets', () => {
    for (const archivo of PANTALLAS) {
      expect(leerCodigo(archivo), `${archivo} usa storage directo`)
        .not.toContain('business-assets')
    }
    expect(leerCodigo('src/lib/storageSetup.ts')).toContain('business-assets')
  })

  it('ProtectedRoute decide sólo por authState', () => {
    const codigo = leerCodigo('src/components/auth/ProtectedRoute.tsx')
    expect(codigo).toContain('authState')
    // La ambigüedad vieja: decidir routing mirando `profileLoading` y `profile`
    // por separado dejaba una ventana en la que «cargando» y «no hay» eran
    // indistinguibles.
    expect(codigo).not.toMatch(/profileLoading\s*&&/)
    expect(codigo).not.toMatch(/!hasBusinessAccess/)
  })
})
