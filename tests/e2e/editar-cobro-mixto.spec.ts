/**
 * @finance
 * TEST CRÍTICO — Regresión BUG-01: Pago mixto + editar cobro no infla total_cobrado.
 * Protege el fix de replace_comprobante_payment RPC.
 *
 * POR QUÉ REQUIERE ID MANUAL:
 *   El BUG-01 original solo manifestaba con comprobantes que tenían MÚLTIPLES
 *   filas en comprobante_payments (ej: pago mixto = $500 efectivo + $500 transferencia).
 *   Crear este comprobante vía UI de forma fiable desde un test es frágil:
 *   requiere interactuar con ComprobanteProModal y seleccionar método "mixto".
 *   Por eso este test queda en modo fixme hasta tener un helper de setup robusto.
 *
 * CÓMO ACTIVAR:
 *   1. Crear un comprobante con método de pago "Mixto" ($500 efectivo + $500 transferencia).
 *   2. Abrir el comprobante y copiar el UUID de la URL: /comprobantes/<uuid>
 *   3. Agregar en .env.test:
 *        E2E_COMPROBANTE_ID_MIXTO=<uuid-del-comprobante>
 *   4. El test se activará automáticamente.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'

test.describe('@finance Editar cobro — pago mixto (BUG-01 regression)', () => {
  test('pago mixto + editar cobro no genera total_cobrado > total', async ({ page }) => {
    test.fixme(
      !process.env.E2E_COMPROBANTE_ID_MIXTO,
      'Requiere E2E_COMPROBANTE_ID_MIXTO: comprobante creado con pago $500 efectivo + $500 transferencia.\n' +
      'ALTERNATIVA AUTOSUFICIENTE (pendiente): ' +
      'Ahora que ComprobanteProModal tiene data-testid (comprobante-product-search, comprobante-payment-efectivo/transferencia, ' +
      'comprobante-payment-amount, comprobante-save-button), es factible crear el comprobante mixto en el test. ' +
      'Requiere: (1) crear producto E2E, (2) abrir modal, (3) agregar producto, ' +
      '(4) click efectivo + llenar $500, (5) click transferencia + llenar $500, (6) cobrar. ' +
      'Ver helpers/comprobante.ts para el helper createComprobanteCash ya funcional. ' +
      'Agregar createComprobanteMixed(page, {half1: "efectivo", half2: "transferencia", total: 1000}).'
    )

    await login(page)
    const comprobanteId = process.env.E2E_COMPROBANTE_ID_MIXTO!
    await page.goto(`/comprobantes/${comprobanteId}`)

    const estadoWidget = page.locator('[data-testid="estado-cobro-widget"]')
    await expect(estadoWidget).toBeVisible({ timeout: 10_000 })

    // Abrir Editar cobro
    await page.click('[data-testid="edit-payment-button"]')
    const amountInput = page.locator('[data-testid="edit-payment-amount-input"]')
    await expect(amountInput).toBeVisible()

    // El monto pre-cargado debe ser el total del comprobante, NO la suma inflada
    // (BUG-01: la suma de 2 filas de payments daba $1000 + $500 = $1500)
    const amountValue = await amountInput.inputValue()
    const amount = parseFloat(amountValue)
    expect(amount).toBeLessThanOrEqual(1000)
    expect(amount).not.toBe(1500)

    // Cambiar a transferencia total y guardar
    await amountInput.fill('1000')
    await page.selectOption('[data-testid="edit-payment-method-select"]', 'transferencia')
    await page.click('[data-testid="edit-payment-save-button"]')
    await expect(page.locator('[data-testid="edit-payment-save-button"]')).not.toBeVisible({ timeout: 8_000 })

    // Verificar que el widget NO muestra valores inflados
    await expect(estadoWidget).not.toContainText('1.500')
    await expect(estadoWidget).not.toContainText('1500')
    await expect(estadoWidget).not.toContainText('2.000')
    await expect(estadoWidget).not.toContainText('2000')
  })
})
