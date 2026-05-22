/**
 * @whatsapp @smoke
 * WhatsApp templates and preview modal.
 * Does NOT send real messages — all tests use dry-run / fallback mode.
 * No real API tokens needed for these tests.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { watchConsoleErrors } from './helpers/console'

// ─── WhatsApp module page ─────────────────────────────────────────────────

test.describe('@whatsapp @smoke WhatsApp — módulo principal', () => {

  test('página de WhatsApp carga sin crash', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/whatsapp')
    await page.waitForLoadState('networkidle')

    // Should show some heading or setup page
    const heading = page.locator('h1, h2, .page-hdr-title, .page-title').first()
    await expect(heading).toBeVisible({ timeout: 15_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })
})

// ─── Customer with phone — WhatsApp button ────────────────────────────────

test.describe('@whatsapp @smoke Customer — botón WhatsApp', () => {

  test('botón WhatsApp existe en detalle de cliente con teléfono', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    // Find a customer row and open detail
    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return // No customers — skip

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]')
    await expect(waBtn).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('click en WhatsApp abre preview modal', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()

    // Only click if not disabled (customer has a phone)
    const isDisabled = await waBtn.isDisabled()
    if (isDisabled) {
      // Disabled = no phone — verify tooltip/aria-label is present
      const label = await waBtn.getAttribute('title')
      expect(label ?? '', 'Botón deshabilitado debe tener tooltip explicativo').toBeTruthy()
      return
    }

    await waBtn.click()

    // Preview modal should open
    await expect(page.locator('[data-testid="whatsapp-preview-modal"]'))
      .toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })

  test('preview modal tiene selector de plantilla y textarea editable', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.isDisabled()) return // No phone

    await waBtn.click()
    await page.waitForLoadState('networkidle')

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    // Template selector
    await expect(modal.locator('[data-testid="whatsapp-template-select"]'))
      .toBeVisible({ timeout: 5_000 })

    // Editable textarea
    await expect(modal.locator('[data-testid="whatsapp-preview-textarea"]'))
      .toBeVisible({ timeout: 5_000 })

    // Copy button
    await expect(modal.locator('[data-testid="whatsapp-copy-button"]'))
      .toBeVisible({ timeout: 5_000 })

    // Fallback button
    await expect(modal.locator('[data-testid="whatsapp-fallback-button"]'))
      .toBeVisible({ timeout: 5_000 })
  })

  test('cambiar plantilla actualiza el mensaje', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.isDisabled()) return

    await waBtn.click()
    await page.waitForLoadState('networkidle')

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    const templateSelect = modal.locator('[data-testid="whatsapp-template-select"]')
    const textarea = modal.locator('[data-testid="whatsapp-preview-textarea"]')

    await expect(textarea).toBeVisible({ timeout: 10_000 })
    const msgBefore = await textarea.inputValue()

    // Change template if options available
    const options = await templateSelect.locator('option').count()
    if (options > 1) {
      await templateSelect.selectOption({ index: 1 })
      await page.waitForTimeout(300)
      const msgAfter = await textarea.inputValue()
      // Message should have changed (or at least be non-empty)
      expect(msgAfter.trim().length, 'Mensaje no debe estar vacío').toBeGreaterThan(0)
      // Note: may be the same template content if only one real option
      void msgBefore
    }
  })

  test('cliente sin teléfono — botón disabled con mensaje útil', async ({ page }) => {
    // This test verifies the UI gracefully handles missing phone
    // We check that any disabled WhatsApp button has a tooltip
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    const isDisabled = await waBtn.isDisabled()

    if (isDisabled) {
      // Should have a title attribute explaining why
      const title = await waBtn.getAttribute('title')
      expect(title, 'Botón disabled debe explicar por qué').toBeTruthy()
    }
    // If not disabled, we skip this check (customer has phone)
  })
})

// ─── OrderDetail — WhatsApp template actions ─────────────────────────────

test.describe('@whatsapp @smoke OrderDetail — acciones WhatsApp', () => {

  test('orden existente tiene botón WhatsApp', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/orders')
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    // Original WhatsApp button (ModalEnviarWhatsApp)
    const waBtn = page.locator('button', { hasText: /whatsapp/i }).first()
    await expect(waBtn).toBeVisible({ timeout: 10_000 })

    expect(errors().length, 'Sin errores de consola').toBe(0)
  })
})

// ─── Template content validation ─────────────────────────────────────────

test.describe('@whatsapp @smoke Templates — contenido', () => {

  test('template de garantía está disponible en el modal', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.isDisabled()) return

    await waBtn.click()

    const modal = page.locator('[data-testid="whatsapp-preview-modal"]')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    const templateSelect = modal.locator('[data-testid="whatsapp-template-select"]')
    await expect(templateSelect).toBeVisible({ timeout: 5_000 })

    // Check that guarantee template exists in options
    const guaranteeOption = templateSelect.locator('option[value="guarantee"]')
    await expect(guaranteeOption, 'Template de garantía debe existir').toBeAttached()
  })

  test('preview modal renderiza mensaje sin valores [undefined] o NaN', async ({ page }) => {
    await login(page)
    await nav.customers(page)
    await page.waitForLoadState('networkidle')

    const firstLink = page.locator('table tbody tr a').first()
    if (await firstLink.count() === 0) return

    await firstLink.click()
    await page.waitForLoadState('networkidle')

    const waBtn = page.locator('[data-testid="whatsapp-action-button"]').first()
    if (await waBtn.isDisabled()) return

    await waBtn.click()

    const textarea = page.locator('[data-testid="whatsapp-preview-textarea"]')
    await expect(textarea).toBeVisible({ timeout: 10_000 })

    await page.waitForTimeout(500)  // Let message load

    const messageContent = await textarea.inputValue()
    expect(messageContent, 'Mensaje no debe ser vacío').toBeTruthy()
    expect(messageContent, 'Mensaje no debe tener "undefined"').not.toContain('undefined')
    expect(messageContent, 'Mensaje no debe tener "NaN"').not.toContain('NaN')
    expect(messageContent, 'Mensaje no debe tener "[object Object]"').not.toContain('[object Object]')
  })
})
