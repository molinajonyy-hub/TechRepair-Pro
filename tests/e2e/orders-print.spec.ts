/**
 * @orders @print
 * Validar branding de impresión de órdenes — protege stable-print-branding-v2.
 *
 * ESTRATEGIA ADAPTATIVA:
 *   - No se asume un valor específico de businessName (depende de la config de la cuenta QA).
 *   - Se verifica CONSISTENCIA: ambas rutas (tabla + modal detalle) renderizan el mismo nombre.
 *   - Se verifica ESTRUCTURA: ambas copias presentes (COPIA CLIENTE + USO INTERNO).
 *   - Se verifica que ServiceOrderPrint recibe printSettings (el elemento service-order-business-name existe).
 *
 * El test de "no Mi Negocio" solo aplica si la cuenta QA tiene un nombre configurado
 * distinto al default. Si no tiene configuración, "Mi Negocio" es el valor esperado.
 *
 * NOTA: la cuenta QA debe tener al menos 1 orden para que los tests de tabla corran.
 *   Abrir /orders después de correr orders-create.spec.ts.
 */
import { test, expect } from '@playwright/test'
import { login } from './helpers/auth'
import { createOrderViaUI, e2eOrderData } from './helpers/orders'

test.describe('@orders @print Branding en impresión de órdenes', () => {

  test('tabla de órdenes: hidden div tiene estructura correcta al imprimir', async ({ page }) => {
    await login(page)

    // Stubear window.open para evitar popup real
    await page.addInitScript(() => {
      ;(window as any).open = () => null
    })

    await page.goto('/orders')
    await page.waitForLoadState('networkidle')

    const printBtns = page.locator('[data-testid="order-print-button"]')
    const count = await printBtns.count()
    if (count === 0) {
      test.skip(true, 'Sin órdenes en la cuenta QA — correr orders-create.spec.ts primero.')
      return
    }

    await printBtns.first().click()

    // El hidden div aparece mientras se procesa (~500ms ventana)
    const hiddenRoot = page.locator('[data-testid="order-print-hidden-root"]')
    await expect(hiddenRoot).toBeAttached({ timeout: 450 })

    // El elemento de nombre del negocio debe existir
    const bizNameEl = hiddenRoot.locator('[data-testid="service-order-business-name"]').first()
    await expect(bizNameEl).toBeAttached({ timeout: 100 })

    // El nombre no debe estar vacío
    const bizName = await bizNameEl.textContent()
    expect((bizName ?? '').trim().length).toBeGreaterThan(0)

    // Ambas copias deben estar presentes
    await expect(hiddenRoot.locator('[data-testid="service-order-client-copy"]')).toBeAttached({ timeout: 100 })
    await expect(hiddenRoot.locator('[data-testid="service-order-local-copy"]')).toBeAttached({ timeout: 100 })
  })

  test('detalle de orden: modal preview tiene estructura correcta', async ({ page }) => {
    await login(page)

    const data = e2eOrderData()
    const orderId = await createOrderViaUI(page, data)
    expect(orderId).toBeTruthy()

    // Abrir modal de impresión
    const printBtn = page.locator('[data-testid="order-print-preview-button"]')
    await expect(printBtn).toBeVisible({ timeout: 10_000 })
    await printBtn.click()

    // El modal renderiza ServiceOrderPrint con printSettings del negocio
    const printRoot = page.locator('[data-testid="service-order-print-root"]')
    await expect(printRoot).toBeVisible({ timeout: 10_000 })

    // El elemento de nombre debe existir y tener contenido
    const bizNameEls = printRoot.locator('[data-testid="service-order-business-name"]')
    await expect(bizNameEls.first()).toBeVisible({ timeout: 5_000 })
    const modalBizName = await bizNameEls.first().textContent()
    expect((modalBizName ?? '').trim().length).toBeGreaterThan(0)

    // Ambas copias del documento deben estar presentes
    await expect(printRoot.locator('[data-testid="service-order-client-copy"]')).toBeVisible({ timeout: 3_000 })
    await expect(printRoot.locator('[data-testid="service-order-local-copy"]')).toBeVisible({ timeout: 3_000 })

    // El número de la orden debe aparecer en el preview
    const shortId = orderId.slice(0, 8).toUpperCase()
    await expect(printRoot).toContainText(shortId, { timeout: 3_000 })
  })

  test('ambas rutas usan el mismo nombre de negocio (consistencia)', async ({ page }) => {
    await login(page)

    // Stubear window.open para tabla
    await page.addInitScript(() => {
      ;(window as any).open = () => null
    })

    // Crear una orden E2E
    const data = e2eOrderData()
    const orderId = await createOrderViaUI(page, data)
    expect(orderId).toBeTruthy()

    // === RUTA 1: Imprimir desde el modal de detalle (OrderPrintPreviewModal) ===
    const printBtn = page.locator('[data-testid="order-print-preview-button"]')
    await expect(printBtn).toBeVisible({ timeout: 10_000 })
    await printBtn.click()

    const printRoot = page.locator('[data-testid="service-order-print-root"]')
    await expect(printRoot).toBeVisible({ timeout: 10_000 })
    const modalBizName = await printRoot.locator('[data-testid="service-order-business-name"]').first().textContent()

    // Cerrar modal y volver al listado
    const closeBtn = page.locator('.modal-hdr button[aria-label], button[aria-label="Cerrar"]').first()
    if (await closeBtn.isVisible()) await closeBtn.click()
    await page.keyboard.press('Escape')
    await page.goto('/orders')
    await page.waitForLoadState('networkidle')

    // === RUTA 2: Imprimir desde la tabla (Orders.tsx handlePrint) ===
    const printBtns = page.locator('[data-testid="order-print-button"]')
    const count = await printBtns.count()
    if (count === 0) {
      test.skip(true, 'Sin órdenes en lista para comparar rutas.')
      return
    }

    await printBtns.first().click()

    const hiddenRoot = page.locator('[data-testid="order-print-hidden-root"]')
    await expect(hiddenRoot).toBeAttached({ timeout: 450 })
    const tableBizName = await hiddenRoot.locator('[data-testid="service-order-business-name"]').first().textContent()

    // === Consistencia: ambas rutas deben mostrar el mismo nombre ===
    expect(tableBizName?.trim()).toBe(modalBizName?.trim())
  })
})
