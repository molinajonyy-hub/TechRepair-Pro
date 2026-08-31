import { test, expect } from './fixtures'
import { E2E } from '../setup/seedE2E'
import { ejecutarSQL, consultarJSON } from '../setup/sqlLocal'
import { openComprobanteModal, searchAndAddProduct, submitComprobante } from '../helpers/comprobante'

test.describe('@mp-pos-beta preservation', () => {
  test.beforeAll(() => {
    ejecutarSQL(`SELECT public.seed_commission_defaults('${E2E.business}'); SELECT public.create_default_payment_buttons('${E2E.business}');`)
  })

  test('manual MP sale creates payment, Caja and finance without MP network', async ({ page }) => {
    const forbidden: string[] = []
    await page.route(/mercadopago\.|\/functions\/v1\/mp-(oauth|payments)/, route => {
      forbidden.push(route.request().url()); return route.abort()
    })
    await openComprobanteModal(page)
    await page.getByRole('button', { name: 'Remito', exact: true }).click()
    await searchAndAddProduct(page, 'Producto E2E')
    await page.getByRole('button', { name: 'MercadoPago', exact: true }).click()
    await page.getByRole('group', { name: 'Opciones de MercadoPago' }).getByRole('button', { name: 'Débito' }).click()
    await expect(page.getByTestId('comprobante-payment-chip')).toContainText('Débito')
    const checkoutResponse = page.waitForResponse(r => r.url().includes('/rpc/create_comprobante_checkout_atomic'))
    await submitComprobante(page)
    const result = await (await checkoutResponse).json()
    const id: string = result.comprobante_id
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    const rows = consultarJSON<{ payments: number; caja: number; finance: number; provider: string }>(`
      SELECT (SELECT count(*)::int FROM public.comprobante_payments WHERE comprobante_id='${id}') AS payments,
        (SELECT count(*)::int FROM public.financial_movements WHERE comprobante_id='${id}' AND type='income' AND amount_ars > 0) AS caja,
        (SELECT count(*)::int FROM public.business_finance_entries WHERE reference_comprobante_id='${id}' AND type='income' AND amount_ars > 0) AS finance,
        (SELECT payment_provider FROM public.comprobante_payments WHERE comprobante_id='${id}' LIMIT 1) AS provider
    `)
    expect(rows.payments).toBe(1)
    expect(rows.caja).toBeGreaterThan(0)
    expect(rows.finance).toBeGreaterThan(0)
    expect(rows.provider).toBe('MercadoPago')
    expect(forbidden).toEqual([])
  })

  test('direct old callback is redirected; subscription routes and settings remain present', async ({ page }) => {
    const forbidden: string[] = []
    await page.route(/mercadopago\.|\/functions\/v1\/mp-(oauth|payments)/, route => {
      forbidden.push(route.request().url()); return route.abort()
    })
    await page.goto('/mp/callback?code=old-code&state=forged')
    await expect(page).toHaveURL(/\/landing$/)
    await page.goto('/subscription/plans')
    await expect(page.getByText('Pagos procesados de forma segura por Mercado Pago', { exact: false })).toBeVisible()
    await page.goto('/settings')
    await expect(page.getByText('Conectar Mercado Pago', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Tipo integración', { exact: true })).toHaveCount(0)
    expect(forbidden).toEqual([])
  })
})
