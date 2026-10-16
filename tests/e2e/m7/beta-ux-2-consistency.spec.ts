// ─────────────────────────────────────────────────────────────────────────────
// BETA-UX-2 — consistencia visual: encabezado compartido y Configuración.
//
// Medido antes del lote (docs/beta-ux-2): tres encabezados distintos (ícono de
// 44px con gradiente, de 40px plano y de 36px), dos distancias a la barra
// superior (24 y 48px) y dos anchos de página (las pantallas con `.page-shell`
// sumaban su padding al del layout). Configuración: diez pestañas en una fila.
//
// Lo que se asevera acá es lo pintado, que jsdom no ve: la MISMA geometría del
// encabezado en todas las pantallas internas, y la navegación agrupada de
// Configuración en escritorio y en el celular. La recepción en 4 pasos y el
// patrón que no bloquea están en `mobile2a-order-intake.spec.ts`.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test, type Page } from '@playwright/test'
import { AA_SMALL_TEXT, applyTheme, contrastOf, paintedContrastOf } from '../helpers/contrast'

const PANTALLAS = [
  '/dashboard', '/orders', '/comprobantes', '/customers', '/tasks',
  '/warranties', '/suppliers', '/expenses', '/caja', '/settings',
] as const

const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

type Medida = {
  ruta: string; left: number; top: number; icono: number; glifo: number; radio: string
  fondoIcono: string; titulo: string; subtitulo: string | null; desborde: number
}

async function medirEncabezado(page: Page, ruta: string): Promise<Medida> {
  // Lo que se mide es el encabezado: no hace falta esperar a cada recurso
  // externo (Bootstrap y las fuentes entran por CDN).
  await page.goto(ruta, { waitUntil: 'domcontentloaded' })
  const encabezado = page.locator('.main-layout-inner .page-hdr').first()
  await expect(encabezado.locator('h1')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))))
  return encabezado.evaluate((hdr, r) => {
    const icono = hdr.querySelector('.page-hdr-icon') as HTMLElement
    const glifo = icono.querySelector('svg') as SVGElement
    const titulo = hdr.querySelector('.page-hdr-title') as HTMLElement
    const subtitulo = hdr.querySelector('.page-hdr-subtitle') as HTMLElement | null
    const caja = hdr.getBoundingClientRect()
    const estiloIcono = getComputedStyle(icono)
    return {
      ruta: r,
      left: Math.round(caja.left),
      top: Math.round(caja.top + window.scrollY),
      icono: Math.round(icono.getBoundingClientRect().width),
      glifo: Math.round(glifo.getBoundingClientRect().width),
      radio: estiloIcono.borderRadius,
      fondoIcono: estiloIcono.backgroundImage,
      titulo: getComputedStyle(titulo).fontSize,
      subtitulo: subtitulo ? getComputedStyle(subtitulo).fontSize : null,
      desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  }, ruta)
}

test.describe('@beta-ux-2 encabezado compartido', () => {
  for (const [nombre, viewport, esperado] of [
    ['escritorio', DESKTOP, { icono: 48, glifo: 24, titulo: '24px', subtitulo: '14px', radio: '14px' }],
    ['celular', MOBILE, { icono: 44, glifo: 22, titulo: '22px', subtitulo: '13px', radio: '12px' }],
  ] as const) {
    test(`misma geometría en todas las pantallas internas · ${nombre}`, async ({ page }) => {
      test.setTimeout(300_000)  // diez pantallas, una detrás de otra
      await page.setViewportSize(viewport)
      const medidas: Medida[] = []
      for (const ruta of PANTALLAS) medidas.push(await medirEncabezado(page, ruta))
      console.log('BETA-UX-2 encabezados', nombre, JSON.stringify(medidas))

      for (const m of medidas) {
        expect(m.icono, `${m.ruta}: caja del ícono`).toBe(esperado.icono)
        expect(m.glifo, `${m.ruta}: glifo`).toBe(esperado.glifo)
        expect(m.radio, `${m.ruta}: radio del ícono`).toBe(esperado.radio)
        expect(m.fondoIcono, `${m.ruta}: el ícono no lleva gradiente`).toBe('none')
        expect(m.titulo, `${m.ruta}: título`).toBe(esperado.titulo)
        if (m.subtitulo) expect(m.subtitulo, `${m.ruta}: subtítulo`).toBe(esperado.subtitulo)
        expect(m.desborde, `${m.ruta}: sin scroll horizontal`).toBeLessThanOrEqual(1)
      }
      // Misma columna en todas: nada de padding propio por pantalla.
      expect(new Set(medidas.map(m => m.left)).size, 'el encabezado arranca en la misma columna').toBe(1)
      // Mismo alto sobre la página. Inicio en el celular lleva la fila de caja y
      // dólar arriba (BETA-UX-1F), así que se compara sin ella.
      const tops = medidas.filter(m => !(nombre === 'celular' && m.ruta === '/dashboard')).map(m => m.top)
      expect(Math.max(...tops) - Math.min(...tops), 'el encabezado arranca a la misma altura').toBeLessThanOrEqual(1)
    })
  }

  for (const tema of ['light', 'dark'] as const) {
    test(`el subtítulo se lee (AA) sobre el fondo pintado · ${tema}`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.setViewportSize(DESKTOP)
      for (const ruta of ['/orders', '/comprobantes', '/caja'] as const) {
        await page.goto(ruta)
        const subtitulo = page.locator('.main-layout-inner .page-hdr-subtitle').first()
        await expect(subtitulo).toBeVisible({ timeout: 20_000 })
        const medida = await paintedContrastOf(subtitulo)
        expect(medida.ratio, `${ruta} ${tema}: ${medida.foreground} / ${medida.backgroundWorst}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      }
    })
  }
})

test.describe('@beta-ux-2 Configuración · navegación agrupada', () => {
  const nav = (page: Page) => page.getByTestId('settings-nav')
  const item = (page: Page, nombre: string) => nav(page).getByRole('button', { name: nombre, exact: true })

  test('escritorio: grupos, sección actual marcada sin depender del color y URL compartible', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/settings')
    await expect(nav(page)).toBeVisible({ timeout: 20_000 })
    await expect(nav(page).locator('.settings-nav__group-label')).toHaveText(['Negocio', 'Facturación', 'Cobros', 'Documentos y mensajes'])
    await expect(nav(page).getByRole('button')).toHaveCount(10)

    // Sin `?tab=`, escritorio abre «Datos del negocio».
    await expect(item(page, 'Datos del negocio')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('settings-content')).toBeVisible()

    await item(page, 'Integración ARCA').click()
    await expect(page).toHaveURL(/[?&]tab=arca\b/)
    await expect(item(page, 'Integración ARCA')).toHaveAttribute('aria-current', 'page')
    await expect(item(page, 'Datos del negocio')).not.toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('arca-status-card').or(page.getByTestId('arca-status-error'))).toBeVisible({ timeout: 20_000 })

    // La selección tiene forma y peso, no sólo color.
    const pistas = await item(page, 'Integración ARCA').evaluate(element => ({
      peso: Number(getComputedStyle(element).fontWeight),
      barra: parseFloat(getComputedStyle(element, '::before').width),
    }))
    expect(pistas.peso).toBeGreaterThanOrEqual(700)
    expect(pistas.barra).toBeGreaterThanOrEqual(3)

    // Volver con el navegador vuelve a la sección anterior.
    await page.goBack()
    await expect(item(page, 'Datos del negocio')).toHaveAttribute('aria-current', 'page')
  })

  for (const tema of ['light', 'dark'] as const) {
    test(`contraste de la navegación · ${tema}`, async ({ page }) => {
      await applyTheme(page, tema)
      await page.setViewportSize(DESKTOP)
      await page.goto('/settings?tab=pagos')
      await expect(item(page, 'Cobros y pagos')).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
      const activo = await contrastOf(item(page, 'Cobros y pagos'))
      const inactivo = await contrastOf(item(page, 'WhatsApp'))
      const grupo = await contrastOf(nav(page).locator('.settings-nav__group-label').first())
      for (const [nombre, medida] of [['activo', activo], ['inactivo', inactivo], ['grupo', grupo]] as const)
        expect(medida.ratio, `${nombre} ${medida.foreground} / ${medida.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)

      // Foco visible con teclado.
      await item(page, 'WhatsApp').focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      const foco = await item(page, 'WhatsApp').evaluate(element => getComputedStyle(element).outlineStyle)
      expect(foco).toBe('solid')
    })
  }

  test('celular: lista agrupada → sección a pantalla completa → volver', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/settings')
    await expect(nav(page)).toBeVisible({ timeout: 20_000 })
    // Sin sección elegida, el celular muestra la lista y no la sección.
    await expect(page.getByTestId('settings-content')).toBeHidden()
    const altos = await nav(page).getByRole('button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height))
    for (const alto of altos) expect(alto, 'fila táctil').toBeGreaterThanOrEqual(44)

    await item(page, 'WhatsApp').click()
    await expect(page).toHaveURL(/[?&]tab=whatsapp\b/)
    await expect(nav(page)).toBeHidden()
    await expect(page.getByTestId('settings-content')).toBeVisible()
    await expect(page.getByTestId('settings-content')).toBeFocused()
    await expect(page.getByTestId('whatsapp-templates-settings')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('settings-back').click()
    await expect(page).not.toHaveURL(/[?&]tab=/)
    await expect(nav(page)).toBeVisible()
    await expect(page.getByTestId('settings-content')).toBeHidden()
  })

  test('los enlaces existentes (`?tab=`) abren la sección directo, también en el celular', async ({ page }) => {
    for (const viewport of [MOBILE, { width: 320, height: 640 }, DESKTOP]) {
      await page.setViewportSize(viewport)
      await page.goto('/settings?tab=pagos')
      await expect(page.getByTestId('settings-content')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('settings-content')).toContainText('Cobros y Pagos')
      const desborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(desborde, `${viewport.width}px sin scroll horizontal`).toBeLessThanOrEqual(1)
    }
  })
})
