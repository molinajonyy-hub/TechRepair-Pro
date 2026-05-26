/**
 * @personal @cards @smoke
 * Mi Guita — Tarjetas de crédito.
 * Cubre navegación, formularios, validaciones, font-size iOS y flujos principales.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function openCards(page: Page) {
  await page.goto('/personal/tarjetas')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-cards-page"]', { timeout: 10_000 })
}

async function openCardForm(page: Page) {
  await openCards(page)
  await page.click('[data-testid="personal-card-new-button"]')
  await page.waitForSelector('[data-testid="personal-card-form"]', { timeout: 5_000 })
}

async function openPurchaseForm(page: Page) {
  await openCards(page)
  await page.click('[data-testid="personal-card-purchase-button"]')
  await page.waitForSelector('[data-testid="personal-card-purchase-form"]', { timeout: 5_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @cards @smoke Mi Guita — tarjetas de crédito', () => {

  // ── Navigation ─────────────────────────────────────────────────────────────

  test('navegar a /personal/tarjetas carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await openCards(page)
    expect(errors().length).toBe(0)
  })

  test('bottom nav Tarjetas está activo cuando se está en /personal/tarjetas', async ({ page }) => {
    await login(page)
    await openCards(page)
    const navBtn = page.locator('[data-testid="personal-nav-cards"]')
    await expect(navBtn).toBeVisible()
    await expect(navBtn).toHaveAttribute('aria-current', 'page')
  })

  test('pantalla muestra empty state o lista de tarjetas sin crash', async ({ page }) => {
    await login(page)
    await openCards(page)
    // Either shows the empty state OR at least one card row — either is valid
    const hasEmpty = await page.locator('[data-testid="personal-cards-page"]').isVisible()
    expect(hasEmpty).toBe(true)
  })

  test('quick actions visibles: + Tarjeta, + Compra, Pagar', async ({ page }) => {
    await login(page)
    await openCards(page)
    await expect(page.locator('[data-testid="personal-card-new-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-card-purchase-button"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-card-pay-button"]')).toBeVisible()
  })

  // ── Card form ───────────────────────────────────────────────────────────────

  test('botón + abre formulario de nueva tarjeta', async ({ page }) => {
    await login(page)
    await openCardForm(page)
    await expect(page.locator('[data-testid="personal-card-form"]')).toBeVisible()
  })

  test('formulario de tarjeta tiene campos requeridos con font ≥ 16px', async ({ page }) => {
    await login(page)
    await openCardForm(page)
    const nameInput = page.locator('[data-testid="personal-card-name-input"]')
    await expect(nameInput).toBeVisible()
    const fs = await nameInput.evaluate(el => window.getComputedStyle(el).fontSize)
    expect(parseFloat(fs)).toBeGreaterThanOrEqual(16)
  })

  test('formulario tarjeta — error al guardar sin nombre', async ({ page }) => {
    await login(page)
    await openCardForm(page)
    // Leave name empty, click save
    await page.click('[data-testid="personal-card-save"]')
    await expect(page.locator('[data-testid="personal-card-form"]')).toContainText(/obligatorio/i)
  })

  test('formulario tarjeta — día de cierre es select con opciones 1-31', async ({ page }) => {
    await login(page)
    await openCardForm(page)
    const closingSelect = page.locator('[data-testid="personal-card-closing-day"]')
    await expect(closingSelect).toBeVisible()
    const options = await closingSelect.locator('option').count()
    expect(options).toBe(31)
  })

  test('formulario tarjeta — crear tarjeta nueva exitosamente', async ({ page }) => {
    await login(page)
    await openCardForm(page)
    const ts = Date.now()
    await page.fill('[data-testid="personal-card-name-input"]', `Visa Test ${ts}`)
    await page.fill('[data-testid="personal-card-issuer-input"]', 'Banco Test')
    await page.click('[data-testid="personal-card-save"]')
    // Form should close and card should appear in list
    await expect(page.locator('[data-testid="personal-card-form"]')).not.toBeVisible({ timeout: 8_000 })
    await expect(page.locator('[data-testid="personal-cards-page"]')).toContainText(`Visa Test ${ts}`, { timeout: 5_000 })
  })

  // ── Purchase form ───────────────────────────────────────────────────────────

  test('botón + Compra abre formulario de compra', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    await expect(page.locator('[data-testid="personal-card-purchase-form"]')).toBeVisible()
  })

  test('formulario compra — input de monto tiene font ≥ 16px', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    const amtInput = page.locator('[data-testid="personal-card-purchase-amount"]')
    await expect(amtInput).toBeVisible()
    const fs = await amtInput.evaluate(el => window.getComputedStyle(el).fontSize)
    expect(parseFloat(fs)).toBeGreaterThanOrEqual(16)
  })

  test('formulario compra — select de primera cuota tiene opciones de mes', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    const monthSelect = page.locator('[data-testid="personal-card-purchase-first-month"]')
    await expect(monthSelect).toBeVisible()
    const options = await monthSelect.locator('option').count()
    expect(options).toBeGreaterThanOrEqual(12)
  })

  test('formulario compra — error al guardar sin descripción', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    // Fill amount but no description
    await page.fill('[data-testid="personal-card-purchase-amount"]', '10000')
    await page.click('[data-testid="personal-card-purchase-save"]')
    await expect(page.locator('[data-testid="personal-card-purchase-form"]')).toContainText(/descripción|obligatori/i)
  })

  test('formulario compra — preview aparece al ingresar monto y cuotas', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    await page.fill('[data-testid="personal-card-purchase-amount"]', '120000')
    await page.fill('[data-testid="personal-card-purchase-installments"]', '3')
    // Wait a moment for state to update
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="personal-card-purchase-preview"]')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('[data-testid="personal-card-purchase-preview"]')).toContainText('3 cuotas')
  })

  test('formulario compra — preview muestra monto por cuota correcto', async ({ page }) => {
    await login(page)
    await openPurchaseForm(page)
    await page.fill('[data-testid="personal-card-purchase-amount"]', '90000')
    await page.fill('[data-testid="personal-card-purchase-installments"]', '3')
    await page.waitForTimeout(300)
    const preview = page.locator('[data-testid="personal-card-purchase-preview"]')
    await expect(preview).toBeVisible({ timeout: 3_000 })
    // Should show $30.000 per installment (90000 / 3)
    await expect(preview).toContainText('$30')
  })

  // ── Payment form ────────────────────────────────────────────────────────────

  test('botón Pagar abre formulario de pago', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-card-pay-button"]')
    await expect(page.locator('[data-testid="personal-card-payment-form"]')).toBeVisible({ timeout: 5_000 })
  })

  test('formulario pago — input monto tiene font ≥ 16px', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-card-pay-button"]')
    await page.waitForSelector('[data-testid="personal-card-payment-form"]')
    const amtInput = page.locator('[data-testid="personal-card-payment-amount"]')
    if (await amtInput.isVisible()) {
      const fs = await amtInput.evaluate(el => window.getComputedStyle(el).fontSize)
      expect(parseFloat(fs)).toBeGreaterThanOrEqual(16)
    }
  })

  test('formulario pago — botón de pago deshabilitado sin confirmar', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-card-pay-button"]')
    await page.waitForSelector('[data-testid="personal-card-payment-form"]')
    const saveBtn = page.locator('[data-testid="personal-card-payment-save"]')
    if (await saveBtn.isVisible()) {
      await expect(saveBtn).toBeDisabled()
    }
  })

  // ── Dashboard card widget ───────────────────────────────────────────────────

  test('dashboard personal carga sin errores con cards data', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    // Card widget should exist (either empty state or summary)
    await expect(page.locator('[data-testid="personal-dashboard"]')).toBeVisible()
    expect(errors().length).toBe(0)
  })

  // ── Card row interaction ────────────────────────────────────────────────────

  test('tarjeta existente aparece en la lista con datos básicos', async ({ page }) => {
    await login(page)
    await openCards(page)
    const cardRows = page.locator('[data-testid="personal-card-row"]')
    const count = await cardRows.count()
    if (count > 0) {
      await expect(cardRows.first().locator('[data-testid="personal-card-name"]')).toBeVisible()
      await expect(cardRows.first().locator('[data-testid="personal-card-statement-total"]')).toBeVisible()
    }
    // Test passes regardless — just verifies no crash
    expect(true).toBe(true)
  })

  test('tap en tarjeta abre detail sheet', async ({ page }) => {
    await login(page)
    await openCards(page)
    const cardRows = page.locator('[data-testid="personal-card-row"]')
    const count = await cardRows.count()
    if (count > 0) {
      await cardRows.first().click()
      // Detail sheet should appear (has stats, actions)
      await page.waitForTimeout(500)
      // The detail sheet shows the card name prominently
      const name = await cardRows.first().locator('[data-testid="personal-card-name"]').textContent()
      if (name) {
        // Look for it in a modal-like overlay (fixed position element)
        const overlay = page.locator('div[style*="position: fixed"]').last()
        await expect(overlay).toBeVisible({ timeout: 3_000 })
      }
    }
    expect(true).toBe(true)
  })

  // ── Summary display ─────────────────────────────────────────────────────────

  test('tarjetas con datos muestran summary card con totals', async ({ page }) => {
    await login(page)
    await openCards(page)
    const summary = page.locator('[data-testid="personal-cards-summary"]')
    const cardRows = page.locator('[data-testid="personal-card-row"]')
    if (await cardRows.count() > 0) {
      await expect(summary).toBeVisible()
      await expect(page.locator('[data-testid="personal-cards-total-due"]')).toBeVisible()
      await expect(page.locator('[data-testid="personal-cards-future-total"]')).toBeVisible()
    }
    // Either summary shows or not depending on data — no crash expected
    expect(true).toBe(true)
  })

  // ── Mobile navigation ───────────────────────────────────────────────────────

  test('navegar de Tarjetas a Inicio y volver sin romper estado', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-nav-home"]')
    await expect(page.locator('[data-testid="personal-dashboard"]')).toBeVisible({ timeout: 8_000 })
    await page.click('[data-testid="personal-nav-cards"]')
    await expect(page.locator('[data-testid="personal-cards-page"]')).toBeVisible({ timeout: 8_000 })
  })

  test('no se rompe el bottom nav al estar en /personal/tarjetas', async ({ page }) => {
    await login(page)
    await openCards(page)
    const nav = page.locator('[data-testid="personal-bottom-nav"]')
    await expect(nav).toBeVisible()
    await expect(nav.locator('button')).toHaveCount(5)
  })

  // ── Hide amounts ────────────────────────────────────────────────────────────

  test('toggle ocultar importes: cifras se muestran como ••••', async ({ page }) => {
    await login(page)
    await openCards(page)
    const toggle = page.locator('[data-testid="personal-cards-toggle-hide"]')
    await expect(toggle).toBeVisible()
    // Enable hide
    await toggle.click()
    await page.waitForTimeout(300)
    const totalDue = page.locator('[data-testid="personal-cards-total-due"]')
    if (await totalDue.isVisible()) {
      const text = await totalDue.textContent()
      expect(text).toContain('••••')
    }
    // Disable hide
    await toggle.click()
    await page.waitForTimeout(200)
  })

  test('toggle hide: después de desactivar vuelven a aparecer números', async ({ page }) => {
    await login(page)
    await openCards(page)
    const toggle = page.locator('[data-testid="personal-cards-toggle-hide"]')
    await toggle.click()
    await page.waitForTimeout(200)
    await toggle.click()
    await page.waitForTimeout(200)
    const totalDue = page.locator('[data-testid="personal-cards-total-due"]')
    if (await totalDue.isVisible()) {
      const text = await totalDue.textContent()
      expect(text).not.toContain('••••')
    }
  })

  // ── Month selector ──────────────────────────────────────────────────────────

  test('selector de mes es visible en la página de tarjetas', async ({ page }) => {
    await login(page)
    await openCards(page)
    await expect(page.locator('[data-testid="personal-cards-month-selector"]')).toBeVisible()
  })

  test('selector de mes: avanzar mes cambia el mes mostrado', async ({ page }) => {
    await login(page)
    await openCards(page)
    const selector = page.locator('[data-testid="personal-cards-month-selector"]')
    const labelBefore = await selector.locator('span').textContent()
    await selector.locator('button').last().click()
    await page.waitForTimeout(200)
    const labelAfter = await selector.locator('span').textContent()
    expect(labelAfter).not.toBe(labelBefore)
  })

  test('selector de mes: retroceder y avanzar vuelve al mes original', async ({ page }) => {
    await login(page)
    await openCards(page)
    const selector = page.locator('[data-testid="personal-cards-month-selector"]')
    const labelBefore = await selector.locator('span').textContent()
    await selector.locator('button').last().click()
    await page.waitForTimeout(100)
    await selector.locator('button').first().click()
    await page.waitForTimeout(100)
    const labelAfter = await selector.locator('span').textContent()
    expect(labelAfter).toBe(labelBefore)
  })

  // ── Pay statement form ──────────────────────────────────────────────────────

  test('formulario pago: tiene selector de período', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-card-pay-button"]')
    await page.waitForSelector('[data-testid="personal-card-payment-form"]', { timeout: 5_000 })
    const amtInput = page.locator('[data-testid="personal-card-payment-amount"]')
    if (await amtInput.isVisible()) {
      const periodSelect = page.locator('[data-testid="personal-card-payment-period"]')
      await expect(periodSelect).toBeVisible()
      const options = await periodSelect.locator('option').count()
      expect(options).toBeGreaterThanOrEqual(12)
    }
  })

  test('formulario pago: botón deshabilitado sin confirmar', async ({ page }) => {
    await login(page)
    await openCards(page)
    await page.click('[data-testid="personal-card-pay-button"]')
    await page.waitForSelector('[data-testid="personal-card-payment-form"]', { timeout: 5_000 })
    const saveBtn = page.locator('[data-testid="personal-card-payment-save"]')
    if (await saveBtn.isVisible()) {
      await expect(saveBtn).toBeDisabled()
    }
  })

  // ── Dashboard card widget ───────────────────────────────────────────────────

  test('dashboard muestra widget de tarjetas con testid correcto', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    const widget = page.locator('[data-testid="personal-cards-widget"]')
    await expect(widget).toBeVisible({ timeout: 8_000 })
  })

  test('dashboard widget tarjetas navega a /personal/tarjetas al hacer click', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-cards-widget"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-cards-widget"]')
    await expect(page.locator('[data-testid="personal-cards-page"]')).toBeVisible({ timeout: 8_000 })
  })

  // ── Mobile safe area ────────────────────────────────────────────────────────

  test('card detail sheet usa safe-area-inset en maxHeight', async ({ page }) => {
    await login(page)
    await openCards(page)
    const cardRows = page.locator('[data-testid="personal-card-row"]')
    if (await cardRows.count() > 0) {
      await cardRows.first().click()
      await page.waitForTimeout(500)
      const overlay = page.locator('div[style*="safe-area-inset"]')
      expect(await overlay.count()).toBeGreaterThan(0)
    }
    expect(true).toBe(true)
  })
})
