/**
 * @landing @smoke
 * Landing pública (/landing): estructura, navegación, recorrido interactivo,
 * planes, FAQ, accesibilidad/movimiento y analítica (sin servicios externos).
 *
 * No requiere autenticación: la landing es pública. Los eventos de analítica se
 * inspeccionan sobre `window.dataLayer` (la integración con Clarity NO se testea).
 */
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Precios mensuales desde la fuente de verdad (sin importar el módulo, que usa
// import.meta.env). Se extraen del código como texto.
const SUBSCRIPTION_SRC = readFileSync('src/types/subscription.ts', 'utf-8')
const PLAN_MONTHLY = [...SUBSCRIPTION_SRC.matchAll(/price_monthly:\s*([\d_]+)/g)]
  .map(m => Number(m[1].replace(/_/g, '')))

const fmtAR = (n: number) => n.toLocaleString('es-AR')

async function dataLayerEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as { dataLayer?: { event: string }[] }).dataLayer || []).map(e => e.event))
}
async function dataLayer(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (window as unknown as { dataLayer?: Record<string, unknown>[] }).dataLayer || [])
}

// Captura los destinos de navegación SPA (react-router usa history.pushState).
// Es determinista: el guard del onboarding redirige a /login con replaceState,
// que NO sobreescribe el push capturado, evitando carreras de tiempo.
async function installNavSpy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __navs: string[] }
    w.__navs = []
    const orig = history.pushState.bind(history)
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      try { w.__navs.push(String(args[2] ?? location.pathname + location.search)) } catch { /* no-op */ }
      return orig(...args)
    }
  })
}
async function navTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __navs?: string[] }).__navs || [])
}

// ─── Carga y estructura ───────────────────────────────────────────────────────
test.describe('@landing @smoke Carga y estructura', () => {
  test('carga sin redirección y con un único H1', async ({ page }) => {
    await page.goto('/landing')
    await expect(page).toHaveURL(/\/landing$/)
    const h1 = page.locator('h1')
    await expect(h1).toHaveCount(1)
    await expect(h1).toContainText(/bajo control/i)
  })

  test('el CTA "Probar gratis 14 días" del hero es visible y va a onboarding', async ({ page }) => {
    await page.goto('/landing')
    const cta = page.locator('#top').getByRole('button', { name: /probar gratis 14 días/i })
    await expect(cta).toBeVisible()
    await installNavSpy(page)
    await cta.click()
    // El destino es /onboarding (el guard puede luego rebotar a /login sin sesión).
    await expect.poll(() => navTargets(page)).toEqual(
      expect.arrayContaining([expect.stringContaining('/onboarding')]),
    )
  })

  test('sin scroll horizontal en 360px y 1280px', async ({ page }) => {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/landing')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      expect(overflow, `overflow horizontal @${width}px`).toBe(false)
    }
  })
})

// ─── Navegación ───────────────────────────────────────────────────────────────
test.describe('@landing Navegación', () => {
  test('header desktop: un enlace interno lleva a su sección', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/landing')
    await page.locator('.lp-nav').getByRole('button', { name: 'Planes' }).click()
    await expect(page.locator('#planes')).toBeInViewport({ timeout: 5000 })
  })

  test('menú mobile abre/cierra y aria-expanded cambia', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/landing')
    const burger = page.locator('.lp-burger')
    await expect(burger).toHaveAttribute('aria-expanded', 'false')

    await burger.click()
    await expect(burger).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#lp-mobile-menu')).toBeVisible()

    await burger.click()
    await expect(burger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#lp-mobile-menu')).toHaveCount(0)
  })
})

// ─── Recorrido interactivo ────────────────────────────────────────────────────
test.describe('@landing Recorrido', () => {
  test('la sección aparece y los tabs tienen roles accesibles', async ({ page }) => {
    await page.goto('/landing')
    await expect(page.locator('#recorrido')).toContainText(/Una reparación\. Todo el negocio conectado\./i)
    const tablist = page.getByRole('tablist', { name: /etapas de una reparación/i })
    await expect(tablist).toBeVisible()
    await expect(tablist.getByRole('tab')).toHaveCount(6)
    await expect(page.locator('#lp-journey-panel')).toHaveAttribute('role', 'tabpanel')
  })

  test('elegir "Se trabaja" refleja el estado esperado en el panel', async ({ page }) => {
    await page.goto('/landing')
    const tab = page.getByRole('tab', { name: /se trabaja/i })
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const panel = page.locator('#lp-journey-panel')
    await expect(panel).toContainText(/En reparación/i)
    await expect(panel).toContainText(/Usás repuestos/i)
  })

  test('el autoavance no impide la interacción manual', async ({ page }) => {
    await page.goto('/landing')
    const tab = page.getByRole('tab', { name: /se cobra/i })
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    // Tras interactuar, el autoavance se detiene: sigue en la etapa elegida.
    await page.waitForTimeout(4600)
    await expect(tab).toHaveAttribute('aria-selected', 'true')
  })
})

// ─── Planes ───────────────────────────────────────────────────────────────────
test.describe('@landing Planes', () => {
  test('los precios visibles coinciden con la configuración', async ({ page }) => {
    expect(PLAN_MONTHLY.length, 'precios detectados en subscription.ts').toBe(3)
    await page.goto('/landing')
    const planes = page.locator('#planes')
    for (const price of PLAN_MONTHLY) {
      await expect(planes).toContainText(fmtAR(price))
    }
  })

  test('seleccionar un plan navega al onboarding conservando el plan', async ({ page }) => {
    await page.goto('/landing')
    await installNavSpy(page)
    await page.locator('#planes .lp-plan.is-featured')
      .getByRole('button', { name: /probar gratis 14 días/i })
      .click()

    // El plan se conserva en el destino de navegación (?plan=pro)...
    await expect.poll(() => navTargets(page)).toEqual(
      expect.arrayContaining([expect.stringContaining('/onboarding?plan=pro')]),
    )
    // ...y en el evento de analítica.
    const events = await dataLayer(page)
    expect(events.find(e => e.event === 'plan_selected')?.plan, 'plan_selected conserva el plan').toBe('pro')
  })
})

// ─── FAQ ──────────────────────────────────────────────────────────────────────
test.describe('@landing FAQ', () => {
  test('una pregunta abre y cierra, con aria-expanded y contenido visible', async ({ page }) => {
    await page.goto('/landing')
    // La 2ª pregunta arranca cerrada (la 1ª está abierta por defecto).
    const q = page.getByRole('button', { name: /necesito instalar algo/i })
    const item = page.locator('.lp-faq-item').filter({ has: q })
    const answer = item.locator('.lp-faq-a-inner')
    await q.scrollIntoViewIfNeeded()
    await expect(q).toHaveAttribute('aria-expanded', 'false')

    await q.click()
    await expect(q).toHaveAttribute('aria-expanded', 'true')
    await expect(answer).toBeVisible()
    await expect(answer).toContainText(/Funciona en el navegador/i)

    await q.click()
    await expect(q).toHaveAttribute('aria-expanded', 'false')
  })
})

// ─── Accesibilidad y movimiento ───────────────────────────────────────────────
test.describe('@landing Accesibilidad', () => {
  test('con prefers-reduced-motion el contenido no queda en opacity 0', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/landing')
    // Esperar a que la sección monte antes de leer estilos (evita carrera con React).
    const reveal = page.locator('#crecimiento .lp-reveal').first()
    await reveal.waitFor({ state: 'attached' })
    const info = await reveal.evaluate(el => ({
      opacity: getComputedStyle(el as HTMLElement).opacity,
      mm: matchMedia('(prefers-reduced-motion: reduce)').matches,
    }))
    expect(info.mm, 'la emulación de reduced-motion debe estar activa').toBe(true)
    // Sin animaciones, el contenido es visible por defecto (no queda en opacity 0).
    expect(info.opacity).toBe('1')
    await expect(page.locator('#planes')).toContainText('Planes')
  })

  test('el foco de teclado es visible en el primer interactivo', async ({ page }) => {
    await page.goto('/landing')
    // Esperar a que el header monte (primer foco real) antes de tabular.
    await expect(page.locator('.lp-logo').first()).toBeVisible()
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      return { focusVisible: el.matches(':focus-visible'), outlineStyle: cs.outlineStyle }
    })
    expect(focus?.focusVisible).toBe(true)
    expect(focus?.outlineStyle).not.toBe('none')
  })
})

// ─── Analítica (sin servicios externos) ───────────────────────────────────────
test.describe('@landing Analytics', () => {
  test('landing_view y eventos de interacción se registran en dataLayer', async ({ page }) => {
    await page.goto('/landing')
    // landing_view se emite en el efecto de montaje: poll hasta que aparezca.
    await expect.poll(() => dataLayerEvents(page)).toContain('landing_view')

    // hero_product_demo_click (no navega)
    await page.locator('#top').getByRole('button', { name: /ver cómo funciona/i }).click()
    // journey_step_interaction
    await page.getByRole('tab', { name: /se informa/i }).click()
    // pricing_section_reached (IO al entrar a planes)
    await page.locator('#planes').scrollIntoViewIfNeeded()
    // faq_opened
    await page.getByRole('button', { name: /necesito instalar algo/i }).click()

    await expect.poll(async () => dataLayerEvents(page)).toEqual(
      expect.arrayContaining([
        'landing_view',
        'hero_product_demo_click',
        'journey_step_interaction',
        'pricing_section_reached',
        'faq_opened',
      ]),
    )
  })

  test('el CTA del hero emite hero_trial_click y signup_started', async ({ page }) => {
    await page.goto('/landing')
    await page.locator('#top').getByRole('button', { name: /probar gratis 14 días/i }).click()
    // Navegación SPA: window.dataLayer se conserva.
    const events = await dataLayerEvents(page)
    expect(events).toContain('hero_trial_click')
    expect(events).toContain('signup_started')
  })
})
