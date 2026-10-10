import { expect, test, type Page } from '@playwright/test'
// BETA-UX-1C: la medición de contraste se mudó a un helper compartido para que
// la use también el gate de Mi Suscripción. Es el mismo código, sin cambios.
import { AA_SMALL_TEXT, applyTheme, contrastOf } from '../helpers/contrast'

const FOCUS_INDICATOR_MINIMUM = 3
const VIEWPORT_WIDTHS = [320, 390, 430, 1440]

// BETA-UX-1F: Inicio dejó de ser una superficie de pestañas. Las suyas
// (Comprobantes / Movimientos de Caja) se fueron con las finanzas, así que
// `/dashboard` salió de esta lista. `AppTabs` hoy sólo vive en el detalle de una
// tarea, que es un diálogo y no una ruta; las clases `.tab` / `.tab-active` que
// mide este spec las siguen cubriendo las dos superficies que quedan.
const LIVE_SURFACES = [
  { name: 'Ofertas · tabs de filtro', path: '/offers' },
  { name: 'Configuración · tabs de navegación', path: '/settings' },
] as const

async function openTabs(page: Page, path: string) {
  await page.goto(path)
  const active = page.locator('.tab-active:visible').first()
  await expect(active).toBeVisible({ timeout: 15_000 })
  const inactive = page.locator('.tab:visible:not(.tab-active)').first()
  await expect(inactive).toBeVisible()
  return { active, inactive }
}

test.describe('@tab-contrast TAB-CONTRAST-1 · estados canónicos', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`selected, unselected, hover y focus cumplen contraste en ${theme}`, async ({ page }) => {
      await applyTheme(page, theme)
      await page.setViewportSize({ width: 1440, height: 900 })
      const { active, inactive } = await openTabs(page, '/offers')

      const selected = await contrastOf(active)
      const unselected = await contrastOf(inactive)

      await inactive.hover()
      await page.waitForTimeout(200)
      const hover = await contrastOf(inactive)

      await page.mouse.move(0, 0)
      await active.focus()
      await page.keyboard.press('Tab')
      await page.waitForTimeout(200)
      const focused = await contrastOf(inactive)
      const focusRing = await contrastOf(inactive, 'outlineColor')
      const focusStyle = await inactive.evaluate(element => {
        const style = getComputedStyle(element)
        return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) }
      })

      console.log('TAB-CONTRAST-1', theme, { selected, unselected, hover, focused, focusRing, focusStyle })

      expect(selected.ratio, `selected ${selected.foreground} / ${selected.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      expect(unselected.ratio, `unselected ${unselected.foreground} / ${unselected.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      expect(hover.ratio, `hover ${hover.foreground} / ${hover.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      expect(focused.ratio, `focused ${focused.foreground} / ${focused.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
      expect(focusRing.ratio, `focus ${focusRing.foreground} / ${focusRing.background}`).toBeGreaterThanOrEqual(FOCUS_INDICATOR_MINIMUM)
      expect(focusStyle.outlineStyle).toBe('solid')
      expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2)

      const selectedCues = await active.evaluate(element => {
        const style = getComputedStyle(element)
        return {
          borderBottomStyle: style.borderBottomStyle,
          borderBottomWidth: parseFloat(style.borderBottomWidth),
          fontWeight: Number(style.fontWeight),
        }
      })
      expect(selectedCues.borderBottomStyle).toBe('solid')
      expect(selectedCues.borderBottomWidth).toBeGreaterThanOrEqual(2)
      expect(selectedCues.fontWeight).toBeGreaterThanOrEqual(700)
    })
  }
})

test.describe('@tab-contrast TAB-CONTRAST-1 · superficies y viewports', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of VIEWPORT_WIDTHS) {
      for (const surface of LIVE_SURFACES) {
        test(`${surface.name} · ${width}px · ${theme}`, async ({ page }) => {
          await applyTheme(page, theme)
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
          const { active, inactive } = await openTabs(page, surface.path)

          const selected = await contrastOf(active)
          const unselected = await contrastOf(inactive)
          expect(selected.ratio, `selected ${selected.foreground} / ${selected.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
          expect(unselected.ratio, `unselected ${unselected.foreground} / ${unselected.background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT)

          const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth)
          expect(overflow).toBeLessThanOrEqual(1)

          const selectedCues = await active.evaluate(element => {
            const style = getComputedStyle(element)
            return {
              borderBottomWidth: parseFloat(style.borderBottomWidth),
              fontWeight: Number(style.fontWeight),
            }
          })
          expect(selectedCues.borderBottomWidth).toBeGreaterThanOrEqual(2)
          expect(selectedCues.fontWeight).toBeGreaterThanOrEqual(700)
        })
      }
    }
  }
})
