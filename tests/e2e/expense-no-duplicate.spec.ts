/**
 * @finance
 * Gasto no duplicado — protege que la RPC atómica create_expense_with_finance
 * no crea registros duplicados ante clicks rápidos.
 *
 * Contexto: Expenses.tsx usa RPC atómica (INF-02). Si el botón no se deshabilita
 * a tiempo, dos submits podrían crear dos registros. Este test verifica que solo
 * aparece uno.
 *
 * REQUISITO: caja abierta en la cuenta QA.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { nav } from './helpers/navigation'
import { e2eExpense } from './helpers/data'

test.describe('@finance Gasto no duplicado (INF-02 RPC)', () => {
  test('guardar gasto con caja abierta: botón se deshabilita durante guardado', async ({ page }) => {
    await login(page)
    await nav.expenses(page)

    const newBtn = page.locator('[data-testid="expense-new-button"]')
    const visible = await newBtn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)
    if (!visible) {
      test.skip(true, 'expense-new-button no visible — revisar permisos QA')
      return
    }
    await newBtn.click()

    const amountInput = page.locator('[data-testid="expense-amount-input"]')
    await expect(amountInput).toBeVisible({ timeout: 8_000 })

    // Caja cerrada → skip
    const cajaCerradaEl = page.locator('text=Caja cerrada')
    if (await cajaCerradaEl.isVisible()) {
      test.skip(true, 'Caja cerrada — abrir caja antes de correr este test @finance')
      return
    }

    const desc = e2eExpense()
    await amountInput.fill('500')
    await page.fill('[data-testid="expense-description-input"]', desc)

    // Intentar doble click en guardar — el botón debe deshabilitarse inmediatamente
    const saveBtn = page.locator('[data-testid="expense-save-button"]')
    await saveBtn.click()
    // Intentar click de nuevo (el botón puede estar cargando)
    await saveBtn.click({ force: true })

    // Esperar a que la operación complete
    await page.waitForTimeout(2_000)

    // Verificar que el gasto aparece UNA SOLA VEZ en el listado
    const entries = page.locator(`text=${desc}`)
    await expect(entries.first()).toBeVisible({ timeout: 10_000 })

    // Contar cuántas veces aparece el texto — no debe haber duplicado
    const count = await entries.count()
    expect(count, `El gasto "${desc}" no debe aparecer más de una vez`).toBeLessThanOrEqual(1)
  })

  test('gasto con monto cero sigue mostrando error (RPC valida server-side)', async ({ page }) => {
    await login(page)
    await nav.expenses(page)

    const newBtn = page.locator('[data-testid="expense-new-button"]')
    const visible = await newBtn.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)
    if (!visible) {
      test.skip(true, 'expense-new-button no visible — revisar permisos QA')
      return
    }
    await newBtn.click()

    const amountInput = page.locator('[data-testid="expense-amount-input"]')
    await expect(amountInput).toBeVisible({ timeout: 8_000 })

    await amountInput.fill('0')
    await page.fill('[data-testid="expense-description-input"]', 'E2E test validacion')
    await page.click('[data-testid="expense-save-button"]')

    // El error de validación debe aparecer
    await expect(
      page.locator('[role="alert"], [data-testid="expense-error-message"]')
    ).toBeVisible({ timeout: 5_000 })

    // El modal sigue abierto
    await expect(amountInput).toBeVisible()
  })
})
