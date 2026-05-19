/**
 * @finance
 * TEST CRÍTICO — Regresión BUG-01: Editar cobro no infla total_cobrado.
 * Protege el fix de replace_comprobante_payment RPC.
 *
 * ESTRATEGIA AUTOSUFICIENTE:
 *   - Si E2E_COMPROBANTE_ID_EFECTIVO está en .env.test, navega directo a ese ID.
 *   - Si no, navega al listado y espera que aparezca el primer comprobante.
 *   - Lee el monto pre-cargado en el modal de editar cobro.
 *   - Cambia solo el método de pago (mismo monto) y guarda.
 *   - Verifica que el monto post-guardado no está inflado (x1.5 o x2).
 *   - Si no hay comprobantes en la cuenta QA, salta con skip explicativo.
 *
 * FIX: el count() inmediato retornaba 0 antes de que el listado cargara
 * (lazy chunk + Supabase async). Reemplazado por waitFor con timeout.
 *
 * FALLBACK MANUAL:
 *   Setear E2E_COMPROBANTE_ID_EFECTIVO en .env.test para usar un ID fijo.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'

test.describe('@finance Editar cobro — regresión BUG-01 (autosuficiente)', () => {
  test('editar cobro no infla total_cobrado', async ({ page }) => {
    await login(page)

    // Si hay un ID fijo en env, usarlo directamente
    const fixedId = process.env.E2E_COMPROBANTE_ID_EFECTIVO
    if (fixedId) {
      await page.goto(`/comprobantes/${fixedId}`)
    } else {
      // Navegar al listado y ESPERAR que aparezca al menos un comprobante
      await nav.comprobantes(page)

      const firstLink = page.locator('a[href*="/comprobantes/"]').first()
      const appeared = await firstLink
        .waitFor({ state: 'attached', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)

      if (!appeared) {
        test.skip(true, 'Sin comprobantes visibles en el listado tras 15s — crear al menos uno desde la app.')
        return
      }
      await firstLink.click()
      await page.waitForURL(/\/comprobantes\/[a-f0-9-]{36}/, { timeout: 10_000 })
    }

    const estadoWidget = page.locator('[data-testid="estado-cobro-widget"]')
    await expect(estadoWidget).toBeVisible({ timeout: 10_000 })

    // Solo comprobantes con botón de editar (no anulados, no NC)
    const editBtn = page.locator('[data-testid="edit-payment-button"]')
    if (!await editBtn.isVisible()) {
      test.skip(true, 'El comprobante encontrado no tiene botón editar cobro (anulado o NC).')
      return
    }

    // Leer el monto pre-cargado ANTES de guardar
    await editBtn.click()
    const amountInput = page.locator('[data-testid="edit-payment-amount-input"]')
    await expect(amountInput).toBeVisible()
    const preFillAmount = parseFloat(await amountInput.inputValue())
    expect(preFillAmount).toBeGreaterThan(0)

    // Cambiar solo el método de pago (mantener mismo monto) y guardar
    const methodSelect = page.locator('[data-testid="edit-payment-method-select"]')
    const currentMethod = await methodSelect.inputValue()
    const newMethod = currentMethod === 'efectivo' ? 'transferencia' : 'efectivo'
    await methodSelect.selectOption(newMethod)

    await page.click('[data-testid="edit-payment-save-button"]')
    await expect(page.locator('[data-testid="edit-payment-save-button"]')).not.toBeVisible({ timeout: 8_000 })

    // Verificar que el widget refleja el monto correcto (no inflado)
    await expect(estadoWidget).toBeVisible({ timeout: 8_000 })
    const widgetText = await estadoWidget.textContent()

    // BUG-01 inflaba x1.5 (suma de 2 payment rows) o x2 (doble impacto)
    const inflated150 = (preFillAmount * 1.5).toLocaleString('es-AR', { maximumFractionDigits: 0 })
    const inflated200 = (preFillAmount * 2).toLocaleString('es-AR', { maximumFractionDigits: 0 })
    expect(widgetText).not.toContain(inflated150)
    expect(widgetText).not.toContain(inflated200)
  })
})
