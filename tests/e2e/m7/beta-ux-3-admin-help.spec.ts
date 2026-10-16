// ============================================================================
// BETA-UX-3 — Administración más simple + Centro de ayuda, medido en el navegador.
//
//   npx playwright test --project=m7-local --grep @beta-ux-3
//
// Antes (docs/beta-ux-3): Administración tenía seis entradas — Usuarios,
// Configuración, Moneda, Suscripción, Tutoriales, Ayuda —, tres de ellas eran
// pantallas de configuración sueltas y dos eran ayuda. Ahora: «Configuración»
// (con Usuarios, Moneda y Suscripción adentro, en su MISMA ruta) y «Centro de
// ayuda» (Soporte + Tutoriales).
//
// Los tests de componentes (`tests/components/betaUx3AdminHelp.test.tsx`) fijan
// el contrato: quién ve qué, guards, rutas, catálogo. Acá se mide lo que sólo
// existe con el CSS servido y la base real — la navegación de punta a punta,
// los enlaces viejos, los objetivos táctiles, el desborde, el foco y el
// contraste pintado — y dos empleados REALES (usuario propio + perfil en el
// negocio E2E, login por la pantalla): un técnico con los permisos de su rol y
// uno con el override `users` (la única forma de ver Configuración sin ser
// owner/admin).
// ============================================================================
import { test, expect } from './fixtures'
import type { Browser, Locator, Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { AA_SMALL_TEXT, applyTheme, contrastOf } from '../helpers/contrast'
import { ejecutarSQL } from '../setup/sqlLocal.ts'
import { borrarPerfilActor, sembrarPerfilActor } from '../setup/seedDashboardFixture.ts'

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const NARROW = { width: 320, height: 640 }
const TOUCH_TARGET = 44
/** Ruido float32 de la transformación de entrada del drawer. */
const TOUCH_EPSILON = 0.01

/** Lo que el menú (lateral o «Más») ofrece en Administración, en orden. */
async function itemsDeAdministracion(nav: Locator): Promise<string[]> {
  return nav.evaluate(el => {
    const seccion = [...el.children].find(s => s.firstElementChild?.textContent?.trim() === 'Administración')
    return seccion ? [...seccion.querySelectorAll('a')].map(a => a.textContent?.trim() ?? '') : []
  })
}

const navLateral = (page: Page) => page.getByRole('navigation', { name: 'Navegación lateral' })
const listaConfiguracion = (page: Page) => page.getByTestId('settings-nav')
const seccion = (page: Page, nombre: string) => listaConfiguracion(page).getByRole('button', { name: nombre, exact: true })

const desborde = (page: Page) => page.evaluate(() => {
  const exceso = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0)
  return Math.max(exceso(document.documentElement), exceso(document.querySelector('.main-content')))
})

async function esperarConfiguracion(page: Page) {
  await expect(listaConfiguracion(page)).toBeAttached({ timeout: 20_000 })
}

/**
 * Este spec no deja huella en el negocio E2E, que es COMPARTIDO.
 *
 * Moneda, al abrirse en un negocio sin fila en `business_settings`, crea los
 * ajustes por defecto (`upsert_business_settings` con `auto_update_rate:
 * false`). Con esa fila la cotización deja de pedirse a la fuente y sale sólo
 * de la base: los specs que corren después y esperan el chip del dólar
 * (`dashboard-day-one`) se quedaban sin él (CI run 38917968505, 8 rojos). Acá
 * se mide la navegación hasta Moneda, no lo que Moneda guarda: esa escritura se
 * responde en el navegador con la misma fila que devolvería el servidor, sin
 * tocar la base. El comportamiento de Moneda no cambia.
 */
async function sinEscribirAjustesDeMoneda(page: Page) {
  await page.route(/\/rest\/v1\/rpc\/upsert_business_settings(\?|$)/, async route => {
    const p = (route.request().postDataJSON() ?? {}) as Record<string, unknown>
    await route.fulfill({
      json: [{
        business_id: p.p_business_id,
        default_currency: p.p_default_currency ?? 'ARS',
        show_usd_price: p.p_show_usd_price ?? false,
        auto_update_rate: p.p_auto_update_rate ?? false,
        rate_api_url: p.p_rate_api_url ?? null,
        rate_update_frequency_hours: p.p_rate_update_frequency_hours ?? 24,
        dolar_source: p.p_dolar_source ?? 'nacional',
      }],
    })
  })
}

test.beforeEach(async ({ page }) => {
  await sinEscribirAjustesDeMoneda(page)
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-3 Administración · escritorio', () => {
  test.use({ viewport: DESKTOP })

  test('el menú tiene sólo «Configuración» y «Centro de ayuda»', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(navLateral(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => itemsDeAdministracion(navLateral(page)), { timeout: 20_000 }).toEqual(['Configuración', 'Centro de ayuda'])
    for (const viejo of ['Usuarios', 'Moneda', 'Suscripción', 'Tutoriales', 'Ayuda']) {
      await expect(navLateral(page).getByRole('link', { name: viejo, exact: true }), viejo).toHaveCount(0)
    }
  })

  test('Configuración agrupa Usuarios, Moneda y Suscripción, cada una en su ruta de siempre', async ({ page }) => {
    await page.goto('/dashboard')
    await navLateral(page).getByRole('link', { name: 'Configuración', exact: true }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await esperarConfiguracion(page)
    await expect(listaConfiguracion(page).locator('.settings-nav__group-label')).toHaveText(['Negocio', 'Equipo', 'Facturación', 'Cobros', 'Documentos y mensajes', 'TechRepair Pro'])
    await expect(listaConfiguracion(page).getByRole('button')).toHaveCount(13)

    const destinos: Array<[string, RegExp, Locator]> = [
      ['Usuarios y permisos', /\/users$/, page.getByRole('heading', { level: 2, name: 'Usuarios del Negocio' })],
      ['Plan y suscripción', /\/subscription$/, page.getByTestId('subscription-status-card')],
      ['Moneda y cotización', /\/currency-settings$/, page.getByRole('heading', { level: 2, name: 'Configuración de Moneda' })],
    ]
    for (const [nombre, url, contenido] of destinos) {
      await seccion(page, nombre).click()
      await expect(page).toHaveURL(url)
      await expect(page.getByTestId('settings-content').locator(contenido)).toBeVisible({ timeout: 20_000 })
      await expect(seccion(page, nombre)).toHaveAttribute('aria-current', 'page')
      // Un solo h1 en la pantalla: «Configuración». La pantalla es su sección.
      await expect(page.locator('.main-layout-inner h1')).toHaveText(['Configuración'])
      // El menú lateral sigue marcando Configuración.
      await expect(navLateral(page).getByRole('link', { name: 'Configuración', exact: true })).toHaveAttribute('aria-current', 'page')
      expect(await desborde(page), `${nombre} sin scroll horizontal`).toBeLessThanOrEqual(1)
    }

    // Y de vuelta a una sección de `?tab=`.
    await seccion(page, 'Cobros y pagos').click()
    await expect(page).toHaveURL(/\/settings\?tab=pagos$/)
    await expect(page.getByTestId('settings-content')).toContainText('Cobros y Pagos', { timeout: 20_000 })
  })

  test('la lista entera entra en 1440×900, aunque la sección elegida sea la última', async ({ page }) => {
    await page.goto('/subscription')
    await esperarConfiguracion(page)
    const ultima = seccion(page, 'Plan y suscripción')
    await expect(ultima).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
    const caja = await ultima.boundingBox()
    expect(caja && caja.y + caja.height, 'la sección elegida queda a la vista sin scrollear').toBeLessThanOrEqual(DESKTOP.height)
  })

  for (const tema of ['light', 'dark'] as const) {
    test(`contraste del Centro de ayuda · ${tema}`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.goto('/ayuda')
      await expect(page.getByTestId('help-tutorials')).toBeVisible({ timeout: 20_000 })
      const textos: Array<[string, Locator]> = [
        ['subtítulo de sección', page.locator('.help-panel__lead').first()],
        ['texto de soporte', page.locator('.help-panel__text')],
        ['descripción de tutorial', page.locator('.help-item__description').first()],
        ['duración y nivel', page.locator('.help-item__meta').first()],
      ]
      for (const [nombre, texto] of textos) {
        const medida = await contrastOf(texto)
        expect(medida.ratio, `${nombre} ${tema}: ${medida.foreground} / ${medida.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
      // Foco visible con teclado en la fila del tutorial.
      await page.getByTestId('help-tutorial-arca').focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      expect(await page.getByTestId('help-tutorial-arca').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-3 Enlaces históricos', () => {
  test.use({ viewport: DESKTOP })

  const DIRECTOS: Array<[string, string, (page: Page) => Locator]> = [
    ['/users', 'Usuarios y permisos', page => page.getByTestId('invite-open')],
    ['/currency-settings', 'Moneda y cotización', page => page.getByRole('heading', { name: 'Configuración de Moneda' })],
    ['/subscription', 'Plan y suscripción', page => page.getByTestId('subscription-status-card')],
    ['/settings?tab=arca', 'Integración ARCA', page => page.getByTestId('arca-status-card').or(page.getByTestId('arca-status-error'))],
  ]
  for (const [ruta, nombre, contenido] of DIRECTOS) {
    test(`${ruta} abre directo su sección`, async ({ page }) => {
      await page.goto(ruta)
      await expect(contenido(page)).toBeVisible({ timeout: 30_000 })
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(ruta)
      await expect(seccion(page, nombre)).toHaveAttribute('aria-current', 'page')
    })
  }

  test('/subscription/plans sigue siendo el flujo de pago, fuera del marco', async ({ page }) => {
    await page.goto('/subscription/plans')
    await expect(page.locator('.main-layout-inner h1, .main-layout-inner .page-hdr-title').first()).toBeVisible({ timeout: 30_000 })
    await expect(listaConfiguracion(page)).toHaveCount(0)
  })

  test('/tutorials lleva a los tutoriales del Centro de ayuda', async ({ page }) => {
    await page.goto('/tutorials')
    await expect(page).toHaveURL(/\/ayuda#tutoriales$/)
    await expect(page.getByTestId('help-tutorials')).toBeInViewport({ timeout: 20_000 })
    await expect(page.getByRole('heading', { level: 1, name: 'Centro de ayuda' })).toBeVisible()
  })

  test('/ayuda: Soporte con el canal de siempre y Tutoriales que abren la guía', async ({ page }) => {
    await page.goto('/ayuda')
    const soporte = page.getByTestId('help-support')
    await expect(soporte).toBeVisible({ timeout: 20_000 })
    // El canal depende del entorno: el CTA de WhatsApp o el aviso de no disponible, nunca un correo.
    await expect(soporte.getByTestId('support-contact-cta').or(soporte.getByTestId('support-contact-unavailable'))).toBeVisible()
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0)

    const fila = page.getByTestId('help-tutorial-arca')
    expect((await fila.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET)
    await fila.click()
    await expect(page).toHaveURL(/\/ayuda\/tutoriales\/arca$/)
    await expect(page.getByText('¿Qué es ARCA?')).toBeVisible()
    await expect(navLateral(page).getByRole('link', { name: 'Centro de ayuda', exact: true })).toHaveAttribute('aria-current', 'page')
    await page.getByTestId('tutorial-back').click()
    await expect(page).toHaveURL(/\/ayuda$/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
test.describe('@beta-ux-3 Celular', () => {
  test.use({ viewport: MOBILE })

  test('«Más» → Configuración (lista) → Usuarios (sección, con foco) → «‹ Secciones»', async ({ page }) => {
    await page.goto('/dashboard')
    // El «Más» de la barra inferior (el del encabezado es el respaldo).
    await page.locator('.mobile-bottom-nav').getByRole('button', { name: 'Abrir más módulos' }).click()
    const drawer = page.locator('#mobile-more-drawer')
    await expect(drawer).toBeVisible()
    await expect.poll(() => itemsDeAdministracion(drawer.getByRole('navigation'))).toEqual(['Configuración', 'Centro de ayuda'])
    for (const nombre of ['Configuración', 'Centro de ayuda']) {
      const alto = (await drawer.getByRole('link', { name: nombre, exact: true }).boundingBox())?.height ?? 0
      expect(alto + TOUCH_EPSILON, `${nombre} táctil`).toBeGreaterThanOrEqual(TOUCH_TARGET)
    }

    await drawer.getByRole('link', { name: 'Configuración', exact: true }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(listaConfiguracion(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('settings-content')).toBeHidden()
    const altos = await listaConfiguracion(page).getByRole('button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height))
    expect(altos).toHaveLength(13)
    for (const alto of altos) expect(alto, 'fila táctil').toBeGreaterThanOrEqual(TOUCH_TARGET)

    await seccion(page, 'Usuarios y permisos').click()
    await expect(page).toHaveURL(/\/users$/)
    await expect(listaConfiguracion(page)).toBeHidden()
    await expect(page.getByTestId('settings-content')).toBeVisible()
    await expect(page.getByTestId('settings-content')).toBeFocused()
    await expect(page.getByTestId('invite-open')).toBeVisible({ timeout: 20_000 })
    expect(await desborde(page), 'Usuarios sin scroll horizontal de página').toBeLessThanOrEqual(1)

    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(listaConfiguracion(page)).toBeVisible()
  })

  for (const viewport of [MOBILE, NARROW]) {
    test(`Centro de ayuda a ${viewport.width}px: apilado, sin desborde, Soporte primero`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto('/ayuda')
      const soporte = page.getByTestId('help-support')
      const tutoriales = page.getByTestId('help-tutorials')
      await expect(tutoriales).toBeVisible({ timeout: 20_000 })
      const a = await soporte.boundingBox()
      const b = await tutoriales.boundingBox()
      expect(a && b && a.y + a.height <= b.y + 1, 'Soporte arriba de Tutoriales').toBe(true)
      expect(await desborde(page)).toBeLessThanOrEqual(1)
      expect((await page.getByTestId('help-tutorial-arca').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TOUCH_TARGET)
      await expect(page.locator('.mobile-app-header__title')).toHaveText('Centro de ayuda')
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// Usuarios entre 1024 y 1280 px — ronda 2.
//
// Dentro de Configuración la tabla de Usuarios mide 428 px (1024) a 684 px
// (1280): con cinco columnas, Estado y Acciones quedaban detrás de un scroll
// horizontal. Se mide con un integrante SINTÉTICO agregado a la respuesta de
// `business_users_view` en el navegador (el negocio E2E es compartido y no hace
// falta escribir en él): nada se guarda —el diálogo se cierra con Escape y el
// menú también—.
const INTEGRANTE = 'Integrante BETA-UX-3'

async function conIntegrante(page: Page) {
  await page.route(/\/rest\/v1\/business_users_view(\?|$)/, async route => {
    const respuesta = await route.fetch()
    const filas: unknown = await respuesta.json().catch(() => [])
    const lista = Array.isArray(filas) ? filas as Array<Record<string, unknown>> : []
    const integrante = {
      id: 'e2e0b3a3-0000-4000-8000-0000000000b3', user_id: 'e2e0b3a3-0000-4000-8000-0000000000b3',
      business_id: lista[0]?.business_id ?? null, role: 'tech', is_active: true,
      full_name: INTEGRANTE, email: 'integrante.beta-ux-3@e2e.local', permissions: null,
      created_at: '2026-10-01T12:00:00Z',
    }
    const headers = { ...respuesta.headers(), 'content-type': 'application/json' }
    delete headers['content-length']
    await route.fulfill({ status: respuesta.status(), headers, body: JSON.stringify([...lista, integrante]) })
  })
}

test.describe('@beta-ux-3 Usuarios · acciones a la vista y por teclado (1024–1280)', () => {
  const ANCHOS = [
    { width: 1024, height: 768, ficha: true },
    { width: 1152, height: 800, ficha: true },
    { width: 1280, height: 800, ficha: false },
  ] as const

  for (const { width, height, ficha } of ANCHOS) {
    test(`${width}px: rol, Permisos y menú dentro de la tabla, sin scroll; Tab → Enter → Escape`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await conIntegrante(page)
      await page.goto('/users')
      const fila = page.getByRole('row', { name: new RegExp(INTEGRANTE) })
      const rol = fila.getByRole('combobox', { name: `Rol de ${INTEGRANTE}` })
      const permisos = fila.getByRole('button', { name: `Editar permisos de ${INTEGRANTE}` })
      const menu = fila.getByRole('button', { name: `Más acciones de ${INTEGRANTE}` })
      await expect(permisos).toBeVisible({ timeout: 30_000 })
      await expect(fila.getByText('Activo', { exact: true })).toBeVisible()

      // ── A la vista: dentro de la tabla y de la ventana, sin scroll ─────────
      const tabla = page.getByTestId('users-table-wrap')
      const caja = await tabla.boundingBox()
      if (!caja) throw new Error('la tabla no tiene caja')
      for (const [nombre, control] of [['rol', rol], ['Permisos', permisos], ['menú', menu]] as const) {
        const c = await control.boundingBox()
        if (!c) throw new Error(`${nombre} sin caja`)
        expect(c.x, `${nombre} empieza dentro de la tabla`).toBeGreaterThanOrEqual(caja.x - 1)
        expect(c.x + c.width, `${nombre} termina dentro de la tabla`).toBeLessThanOrEqual(caja.x + caja.width + 1)
        expect(c.x + c.width, `${nombre} dentro de la ventana`).toBeLessThanOrEqual(width)
        expect(c.height, `${nombre} se puede tocar`).toBeGreaterThanOrEqual(ficha ? TOUCH_TARGET : 36)
      }
      expect(await tabla.evaluate(el => el.scrollWidth - el.clientWidth), 'sin scroll horizontal en la tabla').toBeLessThanOrEqual(1)
      expect(await desborde(page), 'sin scroll horizontal en la página').toBeLessThanOrEqual(1)
      // Debajo de 640 px de tabla cada fila es una ficha; desde ahí, tabla.
      expect(await fila.evaluate(el => getComputedStyle(el).display)).toBe(ficha ? 'grid' : 'table-row')

      // ── Teclado: rol → Permisos (diálogo) → menú ───────────────────────────
      await rol.focus()
      await page.keyboard.press('Tab')
      await expect(permisos).toBeFocused()
      expect(await permisos.evaluate(el => getComputedStyle(el).outlineStyle), 'foco visible').toBe('solid')

      await page.keyboard.press('Enter')
      const dialogo = page.getByRole('dialog', { name: `Permisos — ${INTEGRANTE}` })
      await expect(dialogo).toBeVisible()
      await expect.poll(() => dialogo.evaluate(el => el.contains(document.activeElement)), { message: 'el foco entra al diálogo' }).toBe(true)
      // La primera casilla se tilda con Space y muestra su foco; Tab no sale del diálogo.
      await page.keyboard.press('Tab')
      const enfocado = page.locator(':focus')
      await expect(enfocado).toHaveAttribute('type', 'checkbox')
      const antes = await enfocado.isChecked()
      expect(await enfocado.evaluate(el => getComputedStyle(el.nextElementSibling as Element).outlineStyle), 'foco visible en la casilla').toBe('solid')
      await page.keyboard.press('Space')
      expect(await enfocado.isChecked()).toBe(!antes)
      for (let i = 0; i < 40; i += 1) await page.keyboard.press('Tab')
      expect(await dialogo.evaluate(el => el.contains(document.activeElement)), 'Tab no se escapa del diálogo').toBe(true)
      // Escape cierra SIN guardar y el foco vuelve a «Permisos».
      await page.keyboard.press('Escape')
      await expect(dialogo).toBeHidden()
      await expect(permisos).toBeFocused()

      await page.keyboard.press('Tab')
      await expect(menu).toBeFocused()
      await page.keyboard.press('Enter')
      const accion = page.getByRole('menuitem', { name: 'Desactivar usuario' })
      await expect(accion).toBeFocused()
      await expect(accion).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(accion).toBeHidden()
      await expect(menu).toBeFocused()
    })
  }

  test('1440px: tabla de cuatro columnas, con el email debajo del nombre', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await conIntegrante(page)
    await page.goto('/users')
    const tabla = page.getByRole('table', { name: 'Usuarios del negocio' })
    await expect(tabla.getByRole('columnheader')).toHaveText(['Usuario', 'Rol', 'Estado', 'Acciones'], { timeout: 30_000 })
    const fila = tabla.getByRole('row', { name: new RegExp(INTEGRANTE) })
    await expect(fila.getByRole('cell').first()).toContainText('integrante.beta-ux-3@e2e.local')
    expect(await fila.evaluate(el => getComputedStyle(el).display)).toBe('table-row')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Empleados REALES. Mismo patrón que `dashboard-day-one.spec.ts`: usuario de
// Auth por la API de servicio del stack LOCAL, perfil sembrado en el negocio
// E2E y login por la pantalla. Necesitan la base real: no corren contra el
// Supabase simulado de docs/beta-ux-3/evidence/e2e-mock.
const ACTORES = {
  tecnico: { email: 'beta-ux-3-tecnico@e2e.local', password: 'e2e-local-Passw0rd', rol: 'tech', nombre: 'Técnico BETA-UX-3' },
  equipo: { email: 'beta-ux-3-equipo@e2e.local', password: 'e2e-local-Passw0rd', rol: 'tech', nombre: 'Técnico con Usuarios BETA-UX-3' },
} as const
const TECNICO_STATE = 'tests/e2e/.auth/beta-ux-3-tecnico.json'
const EQUIPO_STATE = 'tests/e2e/.auth/beta-ux-3-equipo.json'

const adminLocal = () => createClient(process.env.VITE_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function prepararActor(
  browser: Browser, baseURL: string,
  actor: { email: string; password: string; rol: string; nombre: string }, statePath: string,
  overrides: Record<string, boolean> | null,
): Promise<string> {
  const admin = adminLocal()
  const { data: existentes } = await admin.auth.admin.listUsers()
  let usuario = existentes?.users?.find(u => u.email === actor.email) ?? null
  if (usuario) {
    await admin.auth.admin.updateUserById(usuario.id, { password: actor.password, email_confirm: true })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: actor.email, password: actor.password, email_confirm: true })
    if (error || !data.user) throw new Error(`No se pudo crear el actor E2E ${actor.nombre}: ${error?.message}`)
    usuario = data.user
  }
  sembrarPerfilActor(usuario.id, actor)
  if (overrides) {
    ejecutarSQL(`UPDATE public.profiles SET permissions = '${JSON.stringify(overrides)}'::jsonb WHERE id = '${usuario.id}';`)
  }

  const contexto = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' })
  const pagina = await contexto.newPage()
  await pagina.goto('/login', { waitUntil: 'networkidle' })
  await pagina.getByTestId('login-email').fill(actor.email)
  await pagina.getByTestId('login-password').fill(actor.password)
  await pagina.getByTestId('login-submit').click()
  await pagina.waitForURL(u => !u.pathname.includes('/login'), { timeout: 20_000 })
  if (pagina.url().includes('/no-business')) throw new Error(`El actor E2E ${actor.nombre} no resolvió su negocio.`)
  await contexto.storageState({ path: statePath })
  await contexto.close()
  return usuario.id
}

test.describe('@beta-ux-3 @beta-ux-3-actores Permisos con empleados reales', () => {
  test.describe.configure({ mode: 'serial' })
  test.use({ viewport: DESKTOP })

  let tecnicoId = ''
  let equipoId = ''

  test.beforeAll(async ({ browser }, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL)
    tecnicoId = await prepararActor(browser, baseURL, ACTORES.tecnico, TECNICO_STATE, null)
    equipoId = await prepararActor(browser, baseURL, ACTORES.equipo, EQUIPO_STATE, { users: true })
  })

  test.afterAll(async () => {
    for (const userId of [tecnicoId, equipoId]) {
      if (!userId) continue
      borrarPerfilActor(userId)
      await adminLocal().auth.admin.deleteUser(userId)
    }
  })

  test.describe('técnico con los permisos de su rol', () => {
    test.use({ storageState: TECNICO_STATE })

    test('ve sólo «Centro de ayuda» y no entra a Configuración ni por URL', async ({ page }) => {
      await page.goto('/dashboard')
      await expect.poll(() => itemsDeAdministracion(navLateral(page)), { timeout: 20_000 }).toEqual(['Centro de ayuda'])
      for (const ruta of ['/settings', '/users', '/currency-settings', '/subscription']) {
        await page.goto(ruta)
        await expect(page, ruta).toHaveURL(/\/dashboard$/, { timeout: 20_000 })
        await expect(listaConfiguracion(page)).toHaveCount(0)
      }
    })

    test('entra al Centro de ayuda y a los tutoriales (también por /tutorials)', async ({ page }) => {
      await page.goto('/tutorials')
      await expect(page).toHaveURL(/\/ayuda#tutoriales$/)
      await expect(page.getByTestId('help-support')).toBeVisible({ timeout: 20_000 })
      await page.getByTestId('help-tutorial-arca').click()
      await expect(page.getByText('¿Qué es ARCA?')).toBeVisible()
    })
  })

  test.describe('técnico con el override `users`', () => {
    test.use({ storageState: EQUIPO_STATE })

    test('ve «Configuración» con una sola sección; las del negocio no se ofrecen ni se abren', async ({ page }) => {
      await page.goto('/dashboard')
      await expect.poll(() => itemsDeAdministracion(navLateral(page)), { timeout: 20_000 }).toEqual(['Configuración', 'Centro de ayuda'])
      await navLateral(page).getByRole('link', { name: 'Configuración', exact: true }).click()
      await expect(page).toHaveURL(/\/settings$/)
      await expect(page.getByTestId('settings-pick-section')).toBeVisible({ timeout: 20_000 })
      await expect(listaConfiguracion(page).getByRole('button')).toHaveText(['Usuarios y permisos'])

      // Un enlace a una sección del negocio tampoco la abre.
      await page.goto('/settings?tab=arca')
      await expect(page.getByTestId('settings-pick-section')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('arca-status-card')).toHaveCount(0)
      await page.goto('/currency-settings')
      await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 })

      await page.goto('/settings')
      await seccion(page, 'Usuarios y permisos').click()
      await expect(page).toHaveURL(/\/users$/)
      await expect(page.getByRole('heading', { level: 2, name: 'Usuarios del Negocio' })).toBeVisible({ timeout: 20_000 })
    })
  })
})
