/**
 * Theming Light/Dark — contrato end-to-end.
 *
 * Cubre los criterios de aceptación del sistema de temas:
 *  - Primera visita (sin preferencia guardada) → abre en Light.
 *  - El toggle cambia a Dark sin recargar y persiste en localStorage.
 *  - Tras recargar, la preferencia guardada gana sobre el default.
 *  - En el sistema autenticado el toggle del header funciona igual.
 *  - Sanidad anti-ilegible: el texto de los inputs contrasta con su fondo.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'

const THEME_KEY = 'techrepair_theme'

async function clearThemePreference(page: Page) {
  await page.evaluate(key => {
    localStorage.removeItem(key)
    localStorage.removeItem('theme')
  }, THEME_KEY)
}

function getDataTheme(page: Page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'))
}

test.describe('Tema Light/Dark @smoke', () => {
  test('primera visita sin preferencia → landing abre en Light', async ({ page }) => {
    await page.goto('/landing')
    await clearThemePreference(page)
    await page.reload()
    await page.waitForSelector('.landing-root')

    expect(await getDataTheme(page)).toBe('light')
    // Fondo claro real (no dark): el canal rojo del bg de la landing es alto.
    const bg = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.landing-root')!).backgroundColor)
    const [r] = bg.match(/\d+/g)!.map(Number)
    expect(r).toBeGreaterThan(200)
  })

  test('toggle de landing → dark aplicado y persistido; reload lo mantiene', async ({ page }) => {
    await page.goto('/landing')
    await clearThemePreference(page)
    await page.reload()
    await page.waitForSelector('.lp-header-actions')

    await page.click('.lp-header-actions button[aria-label*="oscuro"]')
    expect(await getDataTheme(page)).toBe('dark')
    expect(await page.evaluate(k => localStorage.getItem(k), THEME_KEY)).toBe('dark')

    await page.reload()
    await page.waitForSelector('.landing-root')
    expect(await getDataTheme(page)).toBe('dark')

    // El dark de la landing conserva su fondo oscuro original.
    const bg = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.landing-root')!).backgroundColor)
    expect(bg).toBe('rgb(10, 16, 32)')
  })

  test('login abre en Light y los inputs contrastan con su texto', async ({ page }) => {
    await page.goto('/login')
    await clearThemePreference(page)
    await page.reload()
    await page.waitForSelector('[data-testid="login-email"]')

    expect(await getDataTheme(page)).toBe('light')

    const { bg, color } = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="login-email"]')!
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundColor, color: cs.color }
    })
    expect(bg).not.toBe(color) // nunca texto del mismo color que el fondo
    // Input claro con texto oscuro: canal rojo del fondo alto, del texto bajo.
    const bgR = Number(bg.match(/\d+/g)![0])
    const colorR = Number(color.match(/\d+/g)![0])
    expect(bgR).toBeGreaterThan(200)
    expect(colorR).toBeLessThan(100)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`update banner legible en ${theme}: isla dark con texto claro`, async ({ page }) => {
      // Forzar el estado "hay actualización": version.json devuelve un build distinto.
      await page.route('**/version.json*', route =>
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ buildTime: 'e2e-fake-build' }) }))

      await page.clock.install()
      await page.goto('/login')
      await page.evaluate((t) => localStorage.setItem('techrepair_theme', t), theme)
      await page.reload()
      await page.waitForSelector('[data-testid="login-email"]')

      // El detector chequea a los 10s del mount.
      await page.clock.fastForward(11_000)
      const banner = page.locator('[data-testid="update-banner"]')
      await banner.waitFor({ state: 'visible', timeout: 5_000 })

      const { msgColor, bannerBgImage, islandTheme } = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="update-banner"]')!
        const msg = document.querySelector('[data-testid="update-banner-message"]')!
        return {
          msgColor: getComputedStyle(msg).color,
          bannerBgImage: getComputedStyle(b).backgroundImage,
          islandTheme: b.getAttribute('data-theme'),
        }
      })

      // El banner es una isla dark en ambos temas: fondo oscuro fijo…
      expect(islandTheme).toBe('dark')
      expect(bannerBgImage).toContain('rgb(30, 41, 59)')
      // …y el mensaje SIEMPRE claro (canal rojo alto), sin que los overrides
      // light lo re-mapeen a texto oscuro sobre fondo oscuro.
      const [r] = msgColor.match(/\d+/g)!.map(Number)
      expect(r, `mensaje "${msgColor}" debe ser claro sobre el banner oscuro`).toBeGreaterThan(180)
    })
  }

  test('autenticado: abre en Light, el toggle del header cambia a Dark sin recargar y persiste', async ({ page }) => {
    await page.goto('/landing')
    await clearThemePreference(page)
    await login(page)
    await page.waitForSelector('.main-layout-content', { timeout: 15_000 })

    expect(await getDataTheme(page)).toBe('light')

    // Toggle del TopHeader (desktop).
    await page.click('[data-testid="theme-toggle-icon"]:visible')
    expect(await getDataTheme(page)).toBe('dark')
    expect(await page.evaluate(k => localStorage.getItem(k), THEME_KEY)).toBe('dark')

    // Sin recarga: el sidebar ya rinde oscuro.
    const sidebarBg = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.sidebar')!).backgroundColor)
    expect(sidebarBg).toBe('rgba(11, 18, 32, 0.98)')

    // Reload conserva dark.
    await page.reload()
    await page.waitForSelector('.main-layout-content', { timeout: 15_000 })
    expect(await getDataTheme(page)).toBe('dark')

    // Volver a light para no ensuciar el estado de otros specs.
    await page.click('[data-testid="theme-toggle-icon"]:visible')
    expect(await getDataTheme(page)).toBe('light')
  })
})
