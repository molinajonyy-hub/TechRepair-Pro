import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { e2eId } from './data'

export interface E2EOrderData {
  brandName: string
  modelName: string
  issue: string
  budget?: string
}

/** Generates unique E2E-prefixed order data for a test run. */
export function e2eOrderData(): E2EOrderData {
  const id = e2eId()
  return {
    brandName: `E2E-Brand-${id}`,
    modelName: `E2E-Model-${id}`,
    issue: `E2E falla reportada ${id}`,
    budget: '1000',
  }
}

/**
 * Fills a brand or model Autocomplete field.
 * Clicks, types the value, waits for "Crear '...'" button, clicks it.
 * If the value already exists as an option, clicks it directly.
 */
export async function fillAutocomplete(page: Page, testId: string, value: string): Promise<void> {
  const input = page.locator(`[data-testid="${testId}"]`)
  await expect(input).not.toBeDisabled({ timeout: 8_000 })
  await input.click()
  await input.fill(value)

  // Check if value already exists as an option
  const existingOption = page.locator(`button:text-is("${value}")`).first()
  const createOption  = page.locator(`button:has-text('Crear "${value}"')`).first()

  // Wait for either the existing option or the create option
  await Promise.race([
    existingOption.waitFor({ state: 'visible', timeout: 5_000 }).then(() => existingOption.click()),
    createOption.waitFor({ state: 'visible', timeout: 5_000 }).then(() => createOption.click()),
  ]).catch(async () => {
    // Fallback: try create button with broader match
    const createBtn = page.locator('button').filter({ hasText: /^Crear "/ }).first()
    await createBtn.waitFor({ state: 'visible', timeout: 3_000 })
    await createBtn.click()
  })

  // Verify value was set in the input
  await expect(input).toHaveValue(value, { timeout: 6_000 })
}

/**
 * Creates a new E2E order via the UI.
 * Expects to start from any page; navigates to /orders/new.
 * Returns the order UUID from the URL after creation.
 */
export async function createOrderViaUI(page: Page, data: E2EOrderData, customerName?: string): Promise<string> {
  await page.goto('/orders/new')
  await page.waitForURL('/orders/new', { timeout: 10_000 })

  // Step 1: Select customer
  const customerSearch = page.locator('[data-testid="new-order-customer-search"]')
  await expect(customerSearch).toBeVisible({ timeout: 10_000 })

  if (customerName) {
    await customerSearch.fill(customerName)
  }

  // Wait for customer cards to appear
  const firstCard = page.locator('[data-testid="new-order-customer-card"]').first()
  await expect(firstCard).toBeVisible({ timeout: 10_000 })
  // handleSelectCustomer immediately calls setStep('device') — no separate continue btn
  await firstCard.click()

  // Step 2: Device info appears immediately after clicking customer card
  const deviceTypeSelect = page.locator('[data-testid="new-order-device-type-select"]')
  await expect(deviceTypeSelect).toBeVisible({ timeout: 10_000 })
  await deviceTypeSelect.selectOption('other')

  // Brand autocomplete
  await fillAutocomplete(page, 'new-order-brand-input', data.brandName)

  // Model autocomplete (enabled after brand is set)
  await fillAutocomplete(page, 'new-order-model-input', data.modelName)

  // Issue textarea
  const issueInput = page.locator('[data-testid="new-order-issue-input"]')
  await expect(issueInput).toBeVisible({ timeout: 5_000 })
  await issueInput.fill(data.issue)

  // Budget (optional)
  if (data.budget) {
    const budgetInput = page.locator('[data-testid="new-order-budget-input"]')
    if (await budgetInput.isVisible()) {
      await budgetInput.fill(data.budget)
    }
  }

  // Submit
  const saveBtn = page.locator('[data-testid="new-order-save-button"]')
  await expect(saveBtn).toBeEnabled({ timeout: 5_000 })
  await saveBtn.click()

  // Wait for redirect to order detail
  await page.waitForURL(/\/orders\/[a-f0-9-]{36}/, { timeout: 15_000 })

  const url = page.url()
  const match = url.match(/\/orders\/([a-f0-9-]{36})/)
  return match ? match[1] : ''
}
