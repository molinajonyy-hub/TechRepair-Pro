/**
 * @whatsapp @smoke
 * WhatsApp actions integrated into key modules: OrderDetail, Comprobante,
 * WarrantyDetailModal, CustomerDetail.
 *
 * All tests are read-only and use optional fixture env vars:
 *   E2E_ORDER_ID, E2E_COMPROBANTE_ID, E2E_WARRANTY_ID, E2E_CUSTOMER_ID
 * Skips gracefully when data fixtures are absent.
 * Does NOT send real messages.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

const ORDER_ID       = process.env.E2E_ORDER_ID
const COMPROBANTE_ID = process.env.E2E_COMPROBANTE_ID
const WARRANTY_ID    = process.env.E2E_WARRANTY_ID
const CUSTOMER_ID    = process.env.E2E_CUSTOMER_ID

// ─── OrderDetail — WhatsApp dropdown ─────────────────────────────────────────

test.describe('@whatsapp @smoke OrderDetail — acciones WhatsApp', () => {

  test('dropdown WhatsApp existe en OrderDetail', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    if (ORDER_ID) {
      await page.goto(`/orders/${ORDER_ID}`)
    } else {
      await nav.orders(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waDropdownBtn = page.locator('button', { hasText: /whatsapp/i }).first()
    await expect(waDropdownBtn).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('abrir dropdown muestra 4 acciones de plantilla', async ({ page }) => {
    await login(page)

    if (ORDER_ID) {
      await page.goto(`/orders/${ORDER_ID}`)
    } else {
      await nav.orders(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waDropdownBtn = page.locator('button', { hasText: /whatsapp/i }).first()
    if (await waDropdownBtn.count() === 0) { test.skip(); return }

    await waDropdownBtn.click()

    await expect(page.locator('[data-testid="order-whatsapp-received"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="order-whatsapp-quote"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="order-whatsapp-ready"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="order-whatsapp-free"]')).toBeVisible({ timeout: 5_000 })
  })

  test('acción "Orden recibida" abre WhatsAppPreviewModal', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    if (ORDER_ID) {
      await page.goto(`/orders/${ORDER_ID}`)
    } else {
      await nav.orders(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waDropdownBtn = page.locator('button', { hasText: /whatsapp/i }).first()
    if (await waDropdownBtn.count() === 0) { test.skip(); return }

    await waDropdownBtn.click()

    const receivedBtn = page.locator('[data-testid="order-whatsapp-received"]')
    if (await receivedBtn.count() === 0) { test.skip(); return }
    await receivedBtn.click()

    await expect(page.locator('[data-testid="whatsapp-preview-modal"]')).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('OrderDetail no tiene botones WhatsApp duplicados', async ({ page }) => {
    await login(page)

    if (ORDER_ID) {
      await page.goto(`/orders/${ORDER_ID}`)
    } else {
      await nav.orders(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    // Exactly one WhatsApp dropdown trigger in the header (not counting modal internals)
    const headerWaBtns = page.locator('.page-hdr button, header button').filter({ hasText: /whatsapp/i })
    const count = await headerWaBtns.count()
    expect(count, 'Solo un botón WhatsApp en el header').toBeLessThanOrEqual(1)
  })
})

// ─── Comprobante — WhatsApp preview ──────────────────────────────────────────

test.describe('@whatsapp @smoke Comprobante — acción WhatsApp', () => {

  test('botón WhatsApp existe en Comprobante', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    if (COMPROBANTE_ID) {
      await page.goto(`/comprobantes/${COMPROBANTE_ID}`)
    } else {
      await nav.comprobantes(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="comprobante-whatsapp-send"], [data-testid="comprobante-whatsapp-debt"]').first()
    await expect(waBtn).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('click en WhatsApp de Comprobante abre preview modal', async ({ page }) => {
    await login(page)

    if (COMPROBANTE_ID) {
      await page.goto(`/comprobantes/${COMPROBANTE_ID}`)
    } else {
      await nav.comprobantes(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="comprobante-whatsapp-send"], [data-testid="comprobante-whatsapp-debt"]').first()
    if (await waBtn.count() === 0) { test.skip(); return }

    const isDisabled = await waBtn.isDisabled()
    if (isDisabled) {
      const title = await waBtn.getAttribute('title')
      expect(title, 'Botón disabled debe tener tooltip').toBeTruthy()
      return
    }

    await waBtn.click()
    await expect(page.locator('[data-testid="whatsapp-preview-modal"]')).toBeVisible({ timeout: 10_000 })
  })

  test('preview de Comprobante incluye botón fallback wa.me', async ({ page }) => {
    await login(page)

    if (COMPROBANTE_ID) {
      await page.goto(`/comprobantes/${COMPROBANTE_ID}`)
    } else {
      await nav.comprobantes(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="comprobante-whatsapp-send"], [data-testid="comprobante-whatsapp-debt"]').first()
    if (await waBtn.count() === 0 || await waBtn.isDisabled()) { test.skip(); return }

    await waBtn.click()

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(modal.locator('[data-testid="whatsapp-fallback-button"]')).toBeVisible({ timeout: 5_000 })
  })
})

// ─── WarrantyDetailModal — WhatsApp preview ──────────────────────────────────

test.describe('@whatsapp @smoke Garantía — WhatsApp preview', () => {

  async function openFirstWarranty(page: import('@playwright/test').Page) {
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')
    const firstRow = page.locator('table tbody tr').first()
    if (await firstRow.count() === 0) return false
    await firstRow.click()
    await page.waitForLoadState('networkidle')
    return true
  }

  test('garantía usa WhatsAppActionButton (no link <a> directo)', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    const opened = await openFirstWarranty(page)
    if (!opened) { test.skip(); return }

    // Button rendered by WhatsAppActionButton has data-testid="whatsapp-action-button"
    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    await expect(waBtn).toBeVisible({ timeout: 10_000 })

    // Must NOT be a plain anchor — it should open a preview modal instead
    const tagName = await waBtn.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName, 'Debe ser un <button>, no un <a>').toBe('button')

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('click en WhatsApp de garantía abre preview modal', async ({ page }) => {
    await login(page)

    const opened = await openFirstWarranty(page)
    if (!opened) { test.skip(); return }

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.count() === 0) { test.skip(); return }

    const isDisabled = await waBtn.isDisabled()
    if (isDisabled) {
      const title = await waBtn.getAttribute('title')
      expect(title, 'Botón disabled debe tener tooltip').toBeTruthy()
      return
    }

    await waBtn.click()
    await expect(page.locator('[data-testid="whatsapp-preview-modal"]')).toBeVisible({ timeout: 10_000 })
  })

  test('garantía reclamada selecciona plantilla warranty_claim_received', async ({ page }) => {
    await login(page)
    await nav.warranties(page)
    await page.waitForLoadState('networkidle')

    // Find a warranty row marked as claimed
    const claimedRow = page.locator('table tbody tr').filter({ hasText: /reclamad/i }).first()
    if (await claimedRow.count() === 0) { test.skip(); return }

    await claimedRow.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.count() === 0 || await waBtn.isDisabled()) { test.skip(); return }

    await waBtn.click()

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    const templateSelect = modal.locator('[data-testid="whatsapp-template-select"]')
    await expect(templateSelect).toBeVisible({ timeout: 5_000 })
    const selectedVal = await templateSelect.inputValue()
    expect(selectedVal, 'Reclamo debe pre-seleccionar warranty_claim_received').toBe('warranty_claim_received')
  })
})

// ─── CustomerDetail — Comunicaciones tab ─────────────────────────────────────

test.describe('@whatsapp @smoke CustomerDetail — Comunicaciones', () => {

  async function openCustomer(page: import('@playwright/test').Page) {
    if (CUSTOMER_ID) {
      await page.goto(`/customers/${CUSTOMER_ID}`)
      await page.waitForLoadState('networkidle')
      return true
    }
    await nav.customers(page)
    await page.waitForLoadState('networkidle')
    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return false
    await firstLink.click()
    await page.waitForLoadState('networkidle')
    return true
  }

  test('tab Comunicaciones visible en CustomerDetail', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    const opened = await openCustomer(page)
    if (!opened) { test.skip(); return }

    await expect(page.locator('button', { hasText: /comunicaciones/i })).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('sección Comunicaciones carga historial o empty state', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)

    const opened = await openCustomer(page)
    if (!opened) { test.skip(); return }

    const tab = page.locator('button', { hasText: /comunicaciones/i })
    if (await tab.count() === 0) { test.skip(); return }

    await tab.click()
    await page.waitForLoadState('networkidle')

    await expect(page.locator('[data-testid="customer-communications-section"]')).toBeVisible({ timeout: 10_000 })

    const rowCount   = await page.locator('[data-testid="customer-communication-row"]').count()
    const emptyCount = await page.locator('text=/sin comunicaciones/i').count()
    expect(rowCount + emptyCount, 'Debe mostrar historial o empty state').toBeGreaterThan(0)

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('botón WhatsApp en CustomerDetail abre preview modal', async ({ page }) => {
    await login(page)

    const opened = await openCustomer(page)
    if (!opened) { test.skip(); return }

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.count() === 0) { test.skip(); return }

    const isDisabled = await waBtn.isDisabled()
    if (isDisabled) {
      const title = await waBtn.getAttribute('title')
      expect(title, 'Botón disabled debe tener tooltip').toBeTruthy()
      return
    }

    await waBtn.click()
    await expect(page.locator('[data-testid="whatsapp-preview-modal"]')).toBeVisible({ timeout: 10_000 })
  })
})

// ─── Fallback wa.me siempre disponible ───────────────────────────────────────

test.describe('@whatsapp @smoke Fallback — wa.me disponible', () => {

  test('preview modal siempre muestra botón fallback wa.me', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) { test.skip(); return }
    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.count() === 0 || await waBtn.isDisabled()) { test.skip(); return }

    await waBtn.click()

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(modal.locator('[data-testid="whatsapp-fallback-button"]')).toBeVisible({ timeout: 5_000 })
  })

  test('preview modal no muestra valores undefined ni NaN en el mensaje', async ({ page }) => {
    await login(page)

    if (ORDER_ID) {
      await page.goto(`/orders/${ORDER_ID}`)
    } else {
      await nav.orders(page)
      await page.waitForLoadState('networkidle')
      const firstLink = page.locator('table tbody tr a').first()
      if (await firstLink.count() === 0) { test.skip(); return }
      await firstLink.click()
    }
    await page.waitForLoadState('networkidle')

    const waDropdownBtn = page.locator('button', { hasText: /whatsapp/i }).first()
    if (await waDropdownBtn.count() === 0) { test.skip(); return }

    await waDropdownBtn.click()

    const receivedBtn = page.locator('[data-testid="order-whatsapp-received"]')
    if (await receivedBtn.count() === 0) { test.skip(); return }
    await receivedBtn.click()

    const textarea = page.locator('[data-testid="whatsapp-preview-textarea"]')
    await expect(textarea).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(400)

    const msg = await textarea.inputValue()
    expect(msg, 'Mensaje no debe ser vacío').toBeTruthy()
    expect(msg, 'Mensaje no debe contener "undefined"').not.toContain('undefined')
    expect(msg, 'Mensaje no debe contener "NaN"').not.toContain('NaN')
    expect(msg, 'Mensaje no debe contener "[object Object]"').not.toContain('[object Object]')
  })
})

// ─── Edición de teléfono + estados honestos + interceptación de URLs ─────────

test.describe('@whatsapp @smoke Preview modal — edición y estados honestos', () => {

  /** Bloquea cualquier navegación real a WhatsApp para no abrir dominios externos. */
  async function blockWhatsAppUrls(page: import('@playwright/test').Page) {
    await page.route(/wa\.me|web\.whatsapp\.com|api\.whatsapp\.com/, route => route.abort())
  }

  async function openModalFromCustomer(page: import('@playwright/test').Page) {
    await nav.customers(page)
    await page.waitForLoadState('networkidle')
    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return false
    await firstLink.click()
    await page.waitForLoadState('networkidle')
    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.count() === 0 || await waBtn.isDisabled()) return false
    await waBtn.click()
    return await page.locator('[data-testid="whatsapp-preview-modal"]').isVisible()
  }

  test('permite editar el teléfono y lo re-normaliza (formato AR 549…)', async ({ page }) => {
    await login(page)
    if (!(await openModalFromCustomer(page))) { test.skip(); return }

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await modal.locator('[data-testid="whatsapp-edit-phone"]').click()
    const input = modal.locator('[data-testid="whatsapp-phone-input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill('0351 15 1234567')

    // El encabezado muestra el número normalizado a formato móvil AR.
    await expect(modal).toContainText('+5493511234567', { timeout: 5_000 })
  })

  test('copiar mensaje funciona y reporta "Copiado" (no "Enviado")', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await login(page)
    if (!(await openModalFromCustomer(page))) { test.skip(); return }

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await modal.locator('[data-testid="whatsapp-copy-button"]').click()

    const status = modal.locator('[data-testid="whatsapp-send-status"]')
    await expect(status).toBeVisible({ timeout: 5_000 })
    await expect(status).toContainText(/copiado/i)
    await expect(status).not.toContainText(/enviado por api/i)
  })

  test('abrir WhatsApp (fallback) NO afirma "Enviado por API"', async ({ page }) => {
    await login(page)
    await blockWhatsAppUrls(page)
    if (!(await openModalFromCustomer(page))) { test.skip(); return }

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    // Botón principal de apertura (Desktop/Web/Mobile según plataforma).
    const openBtn = modal.locator('[data-testid="whatsapp-send-api-button"], [data-testid="whatsapp-fallback-button"]').first()
    if (await openBtn.count() === 0 || await openBtn.isDisabled()) { test.skip(); return }
    await openBtn.click()

    // Sin Cloud API conectada, nunca debe decir "Enviado por API".
    await expect(modal).not.toContainText(/enviado por api/i, { timeout: 3_000 })
  })

  test('Escape cierra el modal', async ({ page }) => {
    await login(page)
    if (!(await openModalFromCustomer(page))) { test.skip(); return }

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="whatsapp-preview-modal"]')).toBeHidden({ timeout: 5_000 })
  })
})
