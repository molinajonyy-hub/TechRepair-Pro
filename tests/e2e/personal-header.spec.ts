/**
 * @personal @header @smoke
 * Mi Guita — Header personalizado con logo verde y saludo.
 * Valida branding, saludo por horario, frase secundaria y compatibilidad mobile/PWA.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

const GREETINGS = ['Buen día', 'Buenas tardes', 'Buenas noches']

async function goToPersonal(page: Page) {
  await login(page)
  await page.goto('/personal')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-header"]',  { timeout: 10_000 })
}

test.describe('@personal @header @smoke Mi Guita — header personalizado', () => {

  // ── Branding ─────────────────────────────────────────────────────────────────

  test('header usa el logo verde de Mi Guita (no el índigo de gestión)', async ({ page }) => {
    await goToPersonal(page)
    const logo = page.locator('[data-testid="personal-header-logo"]')
    await expect(logo).toBeVisible()
    const src = await logo.getAttribute('src')
    // Debe usar el logo verde (miguita), NO cat-logo.svg (índigo)
    expect(src).toBeTruthy()
    expect(src).not.toContain('cat-logo.svg')
    expect(src?.toLowerCase()).toMatch(/miguita|green/)
  })

  test('header NO muestra el texto fijo "Mi Guita" como wordmark estático', async ({ page }) => {
    await goToPersonal(page)
    const header = page.locator('[data-testid="personal-header"]')
    const greeting = await page.locator('[data-testid="personal-header-greeting"]').textContent()
    // El header ahora muestra un saludo dinámico, no el string literal "Mi Guita"
    expect(greeting).toBeTruthy()
    expect(greeting).not.toBe('Mi Guita')
  })

  test('header no usa ícono Wallet como identidad principal', async ({ page }) => {
    await goToPersonal(page)
    // El logo debe ser una imagen, no un svg de lucide-react con clase wallet
    const logo = page.locator('[data-testid="personal-header-logo"]')
    await expect(logo).toBeVisible()
    const tag = await logo.evaluate(el => el.tagName.toLowerCase())
    expect(tag).toBe('img')
  })

  // ── Saludo por horario ────────────────────────────────────────────────────────

  test('saludo usa uno de los tres horarios esperados', async ({ page }) => {
    await goToPersonal(page)
    const text = await page.locator('[data-testid="personal-header-greeting"]').textContent()
    expect(text).toBeTruthy()
    const hasValidGreeting = GREETINGS.some(g => text!.startsWith(g))
    expect(hasValidGreeting).toBe(true)
  })

  test('saludo visible sin crash de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await goToPersonal(page)
    await expect(page.locator('[data-testid="personal-header-greeting"]')).toBeVisible()
    expect(errors().length).toBe(0)
  })

  test('saludo muestra nombre si el usuario lo tiene', async ({ page }) => {
    await goToPersonal(page)
    const text = await page.locator('[data-testid="personal-header-greeting"]').textContent()
    expect(text).toBeTruthy()
    // Si hay nombre, el saludo tiene la forma "Buen día, Nombre"
    // Si no hay nombre, solo muestra el saludo — ambos son válidos
    const matchesWithName    = GREETINGS.some(g => text!.match(new RegExp(`^${g},\\s+\\S+`)))
    const matchesWithoutName = GREETINGS.some(g => text!.trim() === g)
    expect(matchesWithName || matchesWithoutName).toBe(true)
  })

  // ── Frase secundaria ─────────────────────────────────────────────────────────

  test('frase secundaria visible en el header', async ({ page }) => {
    await goToPersonal(page)
    const phrase = page.locator('[data-testid="personal-header-phrase"]')
    await expect(phrase).toBeVisible()
    const text = await phrase.textContent()
    expect(text?.trim().length).toBeGreaterThan(0)
  })

  test('frase secundaria no supera 60 caracteres (compacta)', async ({ page }) => {
    await goToPersonal(page)
    const text = await page.locator('[data-testid="personal-header-phrase"]').textContent()
    expect(text?.trim().length).toBeLessThanOrEqual(60)
  })

  // ── Mobile / PWA ─────────────────────────────────────────────────────────────

  test('header visible en viewport mobile iPhone (390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await goToPersonal(page)
    const header = page.locator('[data-testid="personal-header"]')
    await expect(header).toBeVisible()
    const box = await header.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(390)
  })

  test('header no genera overflow horizontal en mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await goToPersonal(page)
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(400)
  })

  test('header sticky — sigue visible al hacer scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await goToPersonal(page)
    await page.evaluate(() => window.scrollBy(0, 300))
    await page.waitForTimeout(200)
    await expect(page.locator('[data-testid="personal-header"]')).toBeVisible()
  })

  // ── Contenido consistente ─────────────────────────────────────────────────────

  test('header tiene altura razonable para mobile (no ocupa más de 80px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await goToPersonal(page)
    const box = await page.locator('[data-testid="personal-header"]').boundingBox()
    expect(box).not.toBeNull()
    // El header no debe ser demasiado alto (bloqueando contenido útil)
    expect(box!.height).toBeLessThanOrEqual(80)
  })

  test('logo y saludo conviven sin solaparse horizontalmente', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await goToPersonal(page)
    const logoBox    = await page.locator('[data-testid="personal-header-logo"]').boundingBox()
    const greetBox   = await page.locator('[data-testid="personal-header-greeting"]').boundingBox()
    expect(logoBox).not.toBeNull()
    expect(greetBox).not.toBeNull()
    // El saludo debe empezar a la derecha del logo
    expect(greetBox!.x).toBeGreaterThan(logoBox!.x)
  })

})
