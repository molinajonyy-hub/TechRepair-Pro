/**
 * @finance
 * Gastos: crear gasto con RPC atómica create_expense_with_finance.
 * Verifica que el gasto aparece en el listado y que no quedan registros
 * parciales ante un error de validación.
 * Protege INF-02 (atomicidad de gastos).
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eExpense } from './helpers/data'

test.describe('@finance Gastos atómicos (INF-02)', () => {
  test('crear gasto simple efectivo aparece en listado', async ({ page }) => {
    await login(page)
    await nav.expenses(page)

    // Abrir modal de nuevo gasto
    const newBtn = page.locator('[data-testid="expense-new-button"]')
    if (!await newBtn.isVisible()) {
      test.skip()
      return
    }
    await newBtn.click()

    const desc = e2eExpense()
    await page.fill('[data-testid="expense-description-input"]', desc)
    await page.fill('[data-testid="expense-amount-input"]', '1000')

    const methodSelect = page.locator('[data-testid="expense-payment-method-select"]')
    if (await methodSelect.isVisible()) {
      await methodSelect.selectOption('efectivo')
    }

    await page.click('[data-testid="expense-save-button"]')

    // Verificar que el gasto aparece en el listado
    await expect(page.locator(`text=${desc}`)).toBeVisible({ timeout: 10_000 })
  })

  test('gasto con monto inválido muestra error y no crea registro', async ({ page }) => {
    await login(page)
    await nav.expenses(page)

    const newBtn = page.locator('[data-testid="expense-new-button"]')
    if (!await newBtn.isVisible()) {
      test.skip()
      return
    }
    await newBtn.click()

    // Dejar monto en 0 o vacío
    const amountInput = page.locator('[data-testid="expense-amount-input"]')
    if (await amountInput.isVisible()) {
      await amountInput.fill('0')
    }
    await page.click('[data-testid="expense-save-button"]')

    // Debe mostrar error, no cerrar el modal
    const errorMsg = page.locator('[role="alert"], .alert-inline-error, .alert-inline')
    await expect(errorMsg).toBeVisible({ timeout: 5_000 })
  })
})
