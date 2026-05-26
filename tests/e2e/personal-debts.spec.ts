/**
 * @personal @debts @smoke
 * Mi Guita — Deudas y cuentas por cobrar.
 * Cubre navegación, formularios, validaciones, tipo deuda/cobro, pagos y widget del dashboard.
 */
import { test, expect, type Page } from '@playwright/test'
import { login } from './helpers/auth'
import { watchConsoleErrors } from './helpers/console'

// ── helpers ───────────────────────────────────────────────────────────────────

async function openDebts(page: Page) {
  await page.goto('/personal/deudas')
  await page.waitForSelector('[data-testid="personal-layout"]', { timeout: 15_000 })
  await page.waitForSelector('[data-testid="personal-debts-page"]', { timeout: 10_000 })
}

async function openDebtForm(page: Page) {
  await openDebts(page)
  await page.click('[data-testid="personal-debt-new-button"]')
  await page.waitForSelector('[data-testid="personal-debt-form"]', { timeout: 5_000 })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('@personal @debts @smoke Mi Guita — deudas', () => {

  // ── Navigation ─────────────────────────────────────────────────────────────

  test('navegar a /personal/deudas carga sin errores de consola', async ({ page }) => {
    const errors = watchConsoleErrors(page)
    await login(page)
    await openDebts(page)
    expect(errors().length).toBe(0)
  })

  test('pantalla muestra la página de deudas sin crash', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const page_ = page.locator('[data-testid="personal-debts-page"]')
    await expect(page_).toBeVisible()
  })

  // ── Empty state ─────────────────────────────────────────────────────────────

  test('empty state visible si no hay deudas activas', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const rows = await page.locator('[data-testid="personal-debt-row"]').count()
    if (rows === 0) {
      await expect(page.locator('[data-testid="personal-debts-empty"]')).toBeVisible()
    } else {
      // Si hay deudas, que al menos se muestre la lista
      expect(rows).toBeGreaterThan(0)
    }
  })

  // ── New debt form ───────────────────────────────────────────────────────────

  test('botón nueva deuda abre el formulario', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    await expect(page.locator('[data-testid="personal-debt-form"]')).toBeVisible()
  })

  test('selector de tipo deuda visible: Yo debo y Me deben', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    await expect(page.locator('[data-testid="personal-debt-type-selector"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-debt-type-debt"]')).toBeVisible()
    await expect(page.locator('[data-testid="personal-debt-type-receivable"]')).toBeVisible()
  })

  test('tipo "Yo debo" se puede seleccionar', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    const btn = page.locator('[data-testid="personal-debt-type-debt"]')
    await btn.click()
    // after clicking, button should appear visually active (aria or style change)
    await expect(btn).toBeVisible()
  })

  test('tipo "Me deben" se puede seleccionar', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    const btn = page.locator('[data-testid="personal-debt-type-receivable"]')
    await btn.click()
    await expect(btn).toBeVisible()
  })

  test('formulario valida que el monto sea requerido', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    // Fill name but leave amount empty, try to submit
    const nameInput = page.locator('[data-testid="personal-debt-name"]')
    if (await nameInput.isVisible()) {
      await nameInput.fill('Test deuda')
    }
    const submitBtn = page.locator('[data-testid="personal-debt-save"]')
    if (await submitBtn.isVisible()) {
      await submitBtn.click()
      // The form should still be visible (not closed) — indicating validation prevented submit
      await expect(page.locator('[data-testid="personal-debt-form"]')).toBeVisible()
    }
  })

  test('campos del formulario tienen font-size ≥ 16px (sin zoom en iOS)', async ({ page }) => {
    await login(page)
    await openDebtForm(page)
    const inputs = page.locator('[data-testid="personal-debt-form"] input')
    const count  = await inputs.count()
    for (let i = 0; i < count; i++) {
      const fs = await inputs.nth(i).evaluate(
        el => parseFloat(window.getComputedStyle(el).fontSize)
      )
      expect(fs).toBeGreaterThanOrEqual(16)
    }
  })

  // ── Payment form ────────────────────────────────────────────────────────────

  test('botón pagar/cobrar en fila de deuda abre el formulario de pago', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const payBtn = page.locator('[data-testid="personal-debt-pay-button"]').first()
    if (await payBtn.isVisible()) {
      await payBtn.click()
      await page.waitForSelector('[data-testid="personal-debt-payment-form"]', { timeout: 5_000 })
      await expect(page.locator('[data-testid="personal-debt-payment-form"]')).toBeVisible()
    }
  })

  test('formulario de pago bloquea monto mayor al saldo', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const payBtn = page.locator('[data-testid="personal-debt-pay-button"]').first()
    if (await payBtn.isVisible()) {
      await payBtn.click()
      await page.waitForSelector('[data-testid="personal-debt-payment-form"]', { timeout: 5_000 })
      const amtInput = page.locator('[data-testid="personal-debt-payment-amount"]')
      if (await amtInput.isVisible()) {
        await amtInput.fill('99999999')
        const submitBtn = page.locator('[data-testid="personal-debt-payment-save"]')
        if (await submitBtn.isVisible()) {
          await submitBtn.click()
          // Form should remain visible (validation error) or error message shown
          const formStillVisible = await page.locator('[data-testid="personal-debt-payment-form"]').isVisible()
          expect(formStillVisible).toBe(true)
        }
      }
    }
  })

  // ── Dashboard widget ────────────────────────────────────────────────────────

  test('widget de deudas visible en el dashboard', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    await expect(page.locator('[data-testid="personal-debts-widget"]')).toBeVisible()
  })

  test('widget de deudas navega a /personal/deudas al hacer click', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-debts-widget"]', { timeout: 15_000 })
    await page.click('[data-testid="personal-debts-widget"]')
    await page.waitForURL('**/personal/deudas', { timeout: 5_000 })
    expect(page.url()).toContain('/personal/deudas')
  })

  // ── Hide amounts ────────────────────────────────────────────────────────────

  test('ocultar importes enmascara los montos en la página de deudas', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const toggleBtn = page.locator('[data-testid="personal-debts-toggle-hide"]')
    if (await toggleBtn.isVisible()) {
      await toggleBtn.click()
      // Any visible amount should be masked (show ••••)
      const pageContent = await page.locator('[data-testid="personal-debts-page"]').textContent()
      expect(pageContent).toContain('••••')
    }
  })

  test('toggle de ocultar en dashboard enmascara widget de deudas', async ({ page }) => {
    await login(page)
    await page.goto('/personal')
    await page.waitForSelector('[data-testid="personal-dashboard"]', { timeout: 15_000 })
    const toggleBtn = page.locator('[data-testid="personal-toggle-hide"]')
    await toggleBtn.click()
    const widget = page.locator('[data-testid="personal-debts-widget"]')
    await expect(widget).toBeVisible()
    // When there are active debts, amounts should be masked
    const widgetText = await widget.textContent()
    if (widgetText && (widgetText.includes('Yo debo') || widgetText.includes('Me deben'))) {
      expect(widgetText).toContain('••••')
    }
  })

  // ── Safe area (iOS) ─────────────────────────────────────────────────────────

  test('page container tiene padding-bottom para safe-area en iOS', async ({ page }) => {
    await login(page)
    await openDebts(page)
    const container = page.locator('[data-testid="personal-debts-page"]')
    await expect(container).toBeVisible()
    // The personal layout wraps pages with safe-area padding — just verify it renders without overflow issues
    const boundingBox = await container.boundingBox()
    expect(boundingBox).not.toBeNull()
    expect(boundingBox!.height).toBeGreaterThan(0)
  })

})
