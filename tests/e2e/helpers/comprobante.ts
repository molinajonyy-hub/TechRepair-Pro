import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export interface ComprobanteOptions {
  productName: string
  quantity?: number
  paymentMethod?: 'efectivo' | 'transferencia' | string
  customerName?: string
}

/**
 * Opens the ComprobanteProModal from the /comprobantes page.
 * Waits for the product search input to be visible before returning.
 */
export async function openComprobanteModal(page: Page): Promise<void> {
  await page.goto('/comprobantes')
  const newBtn = page.locator('[data-testid="comprobantes-new-button"]')
  await expect(newBtn).toBeVisible({ timeout: 10_000 })
  await newBtn.click()
  // Wait for the product search input (main POS indicator)
  await expect(page.locator('[data-testid="comprobante-product-search"]')).toBeVisible({ timeout: 10_000 })
}

/**
 * Searches for a product in the POS product search bar and selects the first result.
 * The product must already exist in the account's inventory.
 */
export async function searchAndAddProduct(page: Page, productName: string): Promise<void> {
  const searchInput = page.locator('[data-testid="comprobante-product-search"]')
  await expect(searchInput).toBeVisible({ timeout: 8_000 })
  await searchInput.fill(productName)

  // Wait for results dropdown
  const results = page.locator('[data-testid="comprobante-product-results"]')
  await expect(results).toBeVisible({ timeout: 8_000 })

  // Click first result
  const firstOption = page.locator('[data-testid="comprobante-product-option"]').first()
  await expect(firstOption).toBeVisible({ timeout: 5_000 })
  await firstOption.click()

  // Wait for item to be added (product search clears)
  await expect(searchInput).toHaveValue('', { timeout: 5_000 })
}

/**
 * Selects a payment method by clicking its button.
 * Uses data-testid="comprobante-payment-{method}" format.
 */
export async function selectPaymentMethod(page: Page, method: string): Promise<void> {
  const btn = page.locator(`[data-testid="comprobante-payment-${method}"]`)
  await expect(btn).toBeVisible({ timeout: 8_000 })
  await btn.click()

  // Wait for payment chip to appear
  await expect(page.locator('[data-testid="comprobante-payment-chip"]').first())
    .toBeVisible({ timeout: 5_000 })
}

/**
 * Submits the comprobante by clicking the "Cobrar" button.
 * Waits for the success screen to appear.
 */
export async function submitComprobante(page: Page): Promise<void> {
  const saveBtn = page.locator('[data-testid="comprobante-save-button"]')
  await expect(saveBtn).toBeVisible({ timeout: 8_000 })
  await saveBtn.click()

  // Wait for success screen
  await expect(page.locator('[data-testid="comprobante-success-screen"]')).toBeVisible({ timeout: 15_000 })
}

/**
 * Closes the modal after a successful comprobante (clicks "Cerrar").
 */
export async function closeAfterSuccess(page: Page): Promise<void> {
  const closeBtn = page.locator('[data-testid="comprobante-close-after-success"]')
  await expect(closeBtn).toBeVisible({ timeout: 5_000 })
  await closeBtn.click()
}

/**
 * Full flow: open modal → add product → select payment → submit → close.
 * Returns when the modal is closed after success.
 */
export async function createComprobanteCash(page: Page, options: ComprobanteOptions): Promise<void> {
  await openComprobanteModal(page)

  // Select customer if provided
  if (options.customerName) {
    const customerSearch = page.locator('[data-testid="comprobante-customer-search"]')
    await customerSearch.fill(options.customerName)
    const customerOption = page.locator('[data-testid="comprobante-customer-option"]').first()
    await expect(customerOption).toBeVisible({ timeout: 5_000 })
    await customerOption.click()
  }

  await searchAndAddProduct(page, options.productName)
  await selectPaymentMethod(page, options.paymentMethod ?? 'efectivo')
  await submitComprobante(page)
  await closeAfterSuccess(page)
}

/**
 * Full flow for cuenta corriente payment.
 * Requires a customer to be selected.
 */
export async function createComprobanteCuentaCorriente(page: Page, options: ComprobanteOptions): Promise<void> {
  if (!options.customerName) throw new Error('createComprobanteCuentaCorriente requires customerName')

  await openComprobanteModal(page)

  // Select customer
  const customerSearch = page.locator('[data-testid="comprobante-customer-search"]')
  await customerSearch.fill(options.customerName)
  const customerOption = page.locator('[data-testid="comprobante-customer-option"]').first()
  await expect(customerOption).toBeVisible({ timeout: 5_000 })
  await customerOption.click()

  await searchAndAddProduct(page, options.productName)

  // Select cuenta corriente
  const ccBtn = page.locator('[data-testid="comprobante-payment-cuenta_corriente"]')
  await expect(ccBtn).toBeVisible({ timeout: 5_000 })
  await expect(ccBtn).not.toBeDisabled({ timeout: 3_000 })
  await ccBtn.click()

  await submitComprobante(page)
  await closeAfterSuccess(page)
}
