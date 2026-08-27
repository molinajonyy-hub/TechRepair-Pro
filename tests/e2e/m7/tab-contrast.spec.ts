import { expect, test, type Locator, type Page } from '@playwright/test'

const AA_SMALL_TEXT = 4.5
const FOCUS_INDICATOR_MINIMUM = 3
const VIEWPORT_WIDTHS = [320, 390, 430, 1440]

const LIVE_SURFACES = [
  { name: 'Dashboard · AppTabs', path: '/dashboard' },
  { name: 'Ofertas · tabs de filtro', path: '/offers' },
  { name: 'Configuración · tabs de navegación', path: '/settings' },
] as const

type ContrastMeasurement = {
  ratio: number
  foreground: string
  background: string
  fontSize: string
  fontWeight: string
}

/** Contraste WCAG del color computado contra las capas de fondo ya compuestas. */
async function contrastOf(locator: Locator, colorProperty: 'color' | 'outlineColor' = 'color'): Promise<ContrastMeasurement> {
  return locator.evaluate((element, property) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) || []).map(Number)
    const srgb = (channel: number) => {
      const value = channel / 255
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
    }
    const luminance = (rgb: number[]) =>
      0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2])

    const layers: Array<{ rgb: number[]; alpha: number }> = []
    for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
      const parts = parse(getComputedStyle(node).backgroundColor)
      if (parts.length < 3) continue
      const alpha = parts.length > 3 ? parts[3] : 1
      if (alpha === 0) continue
      layers.push({ rgb: parts.slice(0, 3), alpha })
      if (alpha === 1) break
    }

    let background = layers.length && layers[layers.length - 1].alpha === 1
      ? layers[layers.length - 1].rgb
      : [255, 255, 255]
    for (let index = layers.length - 2; index >= 0; index--) {
      const { rgb, alpha } = layers[index]
      background = rgb.map((channel, position) =>
        channel * alpha + background[position] * (1 - alpha))
    }

    const style = getComputedStyle(element)
    const foreground = parse(style[property]).slice(0, 3)
    const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)

    return {
      ratio: (high + 0.05) / (low + 0.05),
      foreground: style[property],
      background: `rgb(${background.map(Math.round).join(', ')})`,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    }
  }, colorProperty)
}

async function applyTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => {
    localStorage.setItem('theme', value)
    localStorage.setItem('techrepair_theme', value)
  }, theme)
}

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
