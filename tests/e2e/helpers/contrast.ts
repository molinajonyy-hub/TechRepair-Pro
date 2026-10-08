import type { Locator, Page } from '@playwright/test'

/** WCAG AA para texto de tamaño normal. */
export const AA_SMALL_TEXT = 4.5

export type ContrastMeasurement = {
  ratio: number
  foreground: string
  background: string
  fontSize: string
  fontWeight: string
}

/** Contraste WCAG del color computado contra las capas de fondo ya compuestas. */
export async function contrastOf(locator: Locator, colorProperty: 'color' | 'outlineColor' = 'color'): Promise<ContrastMeasurement> {
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

/** Fija el tema ANTES de que cargue la app. */
export async function applyTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((value) => {
    localStorage.setItem('theme', value)
    localStorage.setItem('techrepair_theme', value)
  }, theme)
}
