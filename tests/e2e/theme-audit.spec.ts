/**
 * Audit de legibilidad del theming — recorre páginas clave del sistema
 * autenticado, calcula el contraste real texto/fondo de cada elemento con
 * texto y reporta combinaciones sospechosas (ratio < 1.8). También verifica
 * que la "isla dark" de Mi Guita conserve su paleta oscura bajo tema light.
 *
 * Tema a auditar: AUDIT_THEME=light (default) | AUDIT_THEME=dark
 *   npx playwright test tests/e2e/theme-audit.spec.ts
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'

const PAGES = [
  '/dashboard',
  '/orders',
  '/customers',
  '/inventory',
  '/comprobantes',
  '/caja',
  '/expenses',
  '/suppliers',
  '/settings?tab=preferencias',
]

async function auditContrast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map(v => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const parse = (c: string) => (c.match(/[\d.]+/g) || []).map(Number)
    const effectiveBg = (el: Element): number[] | null => {
      let cur: Element | null = el
      while (cur) {
        const bg = parse(getComputedStyle(cur).backgroundColor)
        if (bg.length >= 3 && (bg.length === 3 || bg[3] > 0.6)) return bg.slice(0, 3)
        cur = cur.parentElement
      }
      return null
    }
    const issues: string[] = []
    const els = Array.from(document.querySelectorAll('main *, .main-layout-content *'))
      .filter(el => {
        const t = (el as HTMLElement).innerText
        return t && t.trim().length > 1 && el.children.length === 0
      })
      .slice(0, 400)
    for (const el of els) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.3) continue
      const color = parse(cs.color)
      if (color.length < 3 || (color.length === 4 && color[3] < 0.3)) continue
      const bg = effectiveBg(el)
      if (!bg) continue
      const l1 = lum(color.slice(0, 3)); const l2 = lum(bg)
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      if (ratio < 1.8) {
        issues.push(`${(el as HTMLElement).innerText.trim().slice(0, 40)} | color:${cs.color} bg:rgb(${bg}) ratio:${ratio.toFixed(2)}`)
      }
    }
    return issues.slice(0, 20)
  })
}

const AUDIT_THEME = process.env.AUDIT_THEME === 'dark' ? 'dark' : 'light'

test(`audit: páginas autenticadas legibles en ${AUDIT_THEME} + islas dark intactas`, async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/landing')
  await page.evaluate(t => localStorage.setItem('techrepair_theme', t), AUDIT_THEME)
  await login(page)
  await page.waitForSelector('.main-layout-content', { timeout: 15_000 })

  const report: Record<string, string[]> = {}
  for (const path of PAGES) {
    await page.goto(path)
    await page.waitForTimeout(2500)
    report[path] = await auditContrast(page)
  }

  // Mi Guita: isla dark — el layout personal fija data-theme="dark".
  await page.goto('/personal')
  await page.waitForTimeout(2500)
  const island = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="personal-layout"]')
    if (!el) return { present: false, theme: null as string | null, bg: null as string | null }
    return {
      present: true,
      theme: el.getAttribute('data-theme'),
      bg: getComputedStyle(el).backgroundColor,
    }
  })

  console.log(`=== AUDIT REPORT (${AUDIT_THEME}) ===`)
  for (const [p, issues] of Object.entries(report)) {
    console.log(`\n${p}: ${issues.length} issues`)
    for (const i of issues) console.log('  - ' + i)
  }
  console.log('\nMi Guita island:', JSON.stringify(island))

  if (island.present) {
    expect(island.theme).toBe('dark')
    // Fondo oscuro real (canal rojo bajo)
    const r = Number((island.bg || '').match(/\d+/)?.[0] ?? 255)
    expect(r).toBeLessThan(40)
  }
})
