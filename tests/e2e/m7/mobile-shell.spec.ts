import { expect, test, type Locator, type Page } from '@playwright/test'

const EVIDENCE = 'docs/p0-mobile-evidence/implementation-mobile-01'
const TOLERANCE = 1

type Box = { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
}

async function expectTouchTarget(locator: Locator, name: string) {
  const box = await locator.boundingBox()
  expect(box, `${name} no tiene rect visible`).not.toBeNull()
  if (!box) return
  expect(box.width, `${name} mide menos de 44px de ancho`).toBeGreaterThanOrEqual(44)
  expect(box.height, `${name} mide menos de 44px de alto`).toBeGreaterThanOrEqual(44)
}

async function expectInsideViewport(page: Page, locator: Locator, name: string) {
  const viewport = page.viewportSize()
  const box = await locator.boundingBox()
  expect(viewport).not.toBeNull()
  expect(box, `${name} no tiene rect visible`).not.toBeNull()
  if (!box || !viewport) return
  expect(box.x, `${name} sale por izquierda`).toBeGreaterThanOrEqual(-TOLERANCE)
  expect(box.x + box.width, `${name} sale por derecha`).toBeLessThanOrEqual(viewport.width + TOLERANCE)
  expect(box.y, `${name} sale por arriba`).toBeGreaterThanOrEqual(-TOLERANCE)
  expect(box.y + box.height, `${name} sale por abajo`).toBeLessThanOrEqual(viewport.height + TOLERANCE)
}

async function expectNoDocumentOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(
    geometry.scrollWidth,
    `documento ${geometry.scrollWidth}px > viewport ${geometry.clientWidth}px`,
  ).toBeLessThanOrEqual(geometry.clientWidth + TOLERANCE)
}

async function openOwnerShell(page: Page, width: number, height: number, theme: 'light' | 'dark' = 'light') {
  await page.setViewportSize({ width, height })
  await page.addInitScript(selectedTheme => {
    localStorage.setItem('techrepair_theme', selectedTheme)
    localStorage.setItem('theme', selectedTheme)
  }, theme)
  await page.goto('/dashboard')
  await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible({ timeout: 30_000 })
}

test.describe('@mobile-shell MOBILE-0/1 · shell responsive OWNER', () => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    test(`${viewport.width}x${viewport.height} · navegación, touch y overflow`, async ({ page }) => {
      await openOwnerShell(page, viewport.width, viewport.height, viewport.width === 390 ? 'dark' : 'light')

      const nav = page.getByTestId('mobile-bottom-nav')
      await expect(nav.getByText('Inicio', { exact: true })).toBeVisible()
      await expect(nav.getByText('Órdenes', { exact: true })).toBeVisible()
      await expect(nav.getByText('POS', { exact: true })).toBeVisible()
      await expect(nav.getByText('Clientes', { exact: true })).toBeVisible()
      await expect(nav.getByText('Más', { exact: true })).toBeVisible()
      await expect(nav.locator('.mobile-bottom-nav__item')).toHaveCount(5)

      for (const item of await nav.locator('.mobile-bottom-nav__item').all()) {
        await expectTouchTarget(item, `item ${await item.textContent()}`)
        await expectInsideViewport(page, item, `item ${await item.textContent()}`)
      }

      await expectTouchTarget(page.getByRole('button', { name: 'Abrir más módulos' }).first(), 'fallback Más del header')
      await expectTouchTarget(page.locator('.mobile-app-header').getByTestId('theme-toggle-icon'), 'theme toggle')
      await expectInsideViewport(page, page.locator('.mobile-app-header'), 'header mobile')
      await expectInsideViewport(page, nav, 'bottom nav')
      await expectNoDocumentOverflow(page)

      await page.screenshot({ path: `${EVIDENCE}/${viewport.width}x${viewport.height}-shell.png` })

      if (viewport.width === 320 || viewport.width === 390) {
        await nav.getByRole('button', { name: 'Abrir más módulos' }).click()
        const drawer = page.locator('#mobile-more-drawer')
        await expect(drawer).toBeVisible()
        await expect(drawer.getByRole('link', { name: 'Inventario' })).toBeVisible()
        await expect(drawer.getByText('Mi Guita', { exact: true })).toHaveCount(0)
        await expect(drawer.getByText('SaaS Admin', { exact: true })).toHaveCount(0)
        await expect(drawer.getByRole('link', { name: 'Órdenes' })).toHaveCount(0)
        await page.waitForTimeout(350)
        await expectTouchTarget(drawer.getByRole('button', { name: 'Cerrar menu' }), 'cerrar Más')
        await expectInsideViewport(page, drawer, 'drawer Más')
        await page.screenshot({ path: `${EVIDENCE}/${viewport.width}x${viewport.height}-more.png` })
        await drawer.getByRole('button', { name: 'Cerrar menu' }).click()
      }
    })
  }

  test('routing mantiene active state, Back y refresh', async ({ page }) => {
    await openOwnerShell(page, 390, 844)
    const nav = page.getByTestId('mobile-bottom-nav')
    await nav.getByText('Órdenes', { exact: true }).click()
    await expect(page).toHaveURL(/\/orders$/)
    await expect(nav.getByRole('link', { name: 'Órdenes' })).toHaveAttribute('aria-current', 'page')

    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.reload()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(nav.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page')
  })

  test('desktop conserva Sidebar y no monta visualmente bottom nav', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/dashboard')
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden()
  })
})

test.describe('@mobile-shell UpdateBanner + rutas públicas', () => {
  test('login no muestra nav y el banner no tapa el CTA (incluye negative geometry gate)', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
      serviceWorkers: 'block',
      storageState: { cookies: [], origins: [] },
    })
    const publicPage = await context.newPage()
    await publicPage.route('**/version.json**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ buildTime: 'future-build-for-mobile-gate', commit: 'test' }),
    }))
    await publicPage.goto('/login')
    await expect(publicPage.getByTestId('mobile-bottom-nav')).toHaveCount(0)

    const cta = publicPage.getByTestId('login-submit')
    await expect(cta).toBeVisible({ timeout: 15_000 })
    await cta.scrollIntoViewIfNeeded()
    await publicPage.waitForTimeout(10_500)
    const banner = publicPage.getByTestId('update-banner')
    await expect(banner).toBeVisible()
    await expectTouchTarget(banner.getByRole('button', { name: 'Actualizar' }), 'Actualizar versión')
    await expectTouchTarget(banner.getByRole('button', { name: 'Cerrar aviso de actualización' }), 'Cerrar update banner')

    const bannerBox = await banner.boundingBox()
    const ctaBox = await cta.boundingBox()
    expect(bannerBox).not.toBeNull()
    expect(ctaBox).not.toBeNull()
    if (bannerBox && ctaBox) {
      expect(overlaps(bannerBox, ctaBox), 'el banner real tapa el CTA').toBe(false)

      // Self-test negativo: el mismo banner puesto sobre el CTA sí debe ser
      // detectado por el helper, evitando un gate que siempre pase.
      const brokenOffset = { ...bannerBox, y: ctaBox.y }
      expect(overlaps(brokenOffset, ctaBox), 'el gate negativo no detecta solapamiento').toBe(true)
    }

    await publicPage.screenshot({ path: `${EVIDENCE}/320x568-login-update-banner.png` })
    await context.close()
  })
})
