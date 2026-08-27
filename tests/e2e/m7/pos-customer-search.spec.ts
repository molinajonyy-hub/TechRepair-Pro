// UI-CONSISTENCY-2B — búsqueda real de clientes desde el POS.
// El fixture vive sólo en el Supabase local y desborda deliberadamente las
// 300 filas que el selector anterior descargaba antes de buscar en memoria.
import { test, expect } from './fixtures'
import { ejecutarSQL } from '../setup/sqlLocal.ts'
import { E2E } from '../setup/seedE2E.ts'
import { openComprobanteModal } from '../helpers/comprobante'

const TARGET_ID = '20000000-0000-4000-8000-000000000325'
const OTHER_TENANT_ID = '20000000-0000-4000-8000-000000000999'

function seedCustomers(): void {
  ejecutarSQL(`
    BEGIN;
    DELETE FROM public.customers WHERE name LIKE 'POS-CUST-2B-%';

    INSERT INTO public.customers
      (id, business_id, name, phone, document, customer_type)
    SELECT
      ('20000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      '${E2E.business}',
      CASE WHEN i = 325
        THEN 'POS-CUST-2B-325 Objetivo Beta'
        ELSE 'POS-CUST-2B-' || lpad(i::text, 3, '0')
      END,
      CASE WHEN i = 325 THEN '+54 11 4567-8901' ELSE '' END,
      CASE WHEN i = 325 THEN 'DNI: 30.123.456' ELSE NULL END,
      'minorista'
    FROM generate_series(1, 350) AS i;

    INSERT INTO public.customers
      (id, business_id, name, phone, document, customer_type)
    VALUES
      ('${OTHER_TENANT_ID}', '${E2E.otroBusiness}',
       'POS-CUST-2B-325 Objetivo Beta', '555-AJENO', 'DNI 30123456', 'mayorista');
    COMMIT;
  `)
}

async function searchCustomer(page: import('@playwright/test').Page, query: string) {
  const input = page.getByTestId('comprobante-customer-search')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(query)
  await expect(page.getByTestId('comprobante-customer-results')).toBeVisible()
  return page.getByTestId('comprobante-customer-option')
}

test.beforeAll(seedCustomers)

test('@m7 @pos-customer REGRESIÓN >300: encuentra por nombre la fila 325', async ({ page }) => {
  await openComprobanteModal(page)
  const options = await searchCustomer(page, 'Objetivo Beta')

  await expect(options).toHaveCount(1)
  await expect(options).toHaveAttribute('data-customer-id', TARGET_ID)
  await expect(options).not.toHaveAttribute('data-customer-id', OTHER_TENANT_ID)

  await options.click()
  await expect(page.getByText('POS-CUST-2B-325 Objetivo Beta', { exact: true })).toBeVisible()
  await expect(page.getByTestId('comprobante-customer-search')).toHaveCount(0)

  // El atajo existente sigue reabriendo el selector con el cliente elegido.
  await page.keyboard.press('F2')
  await expect(page.getByTestId('comprobante-customer-search')).toBeFocused()
  await expect(page.getByTestId('comprobante-customer-search'))
    .toHaveValue('POS-CUST-2B-325 Objetivo Beta')
})

test('@m7 @pos-customer busca el documento histórico por forma compacta y canónica', async ({ page }) => {
  await openComprobanteModal(page)
  const options = await searchCustomer(page, 'DNI 30123456')

  await expect(options).toHaveCount(1)
  await expect(options).toHaveAttribute('data-customer-id', TARGET_ID)

  await page.getByTestId('comprobante-customer-search').fill('30.123.456')
  await expect(options).toHaveCount(1)
  await expect(options).toHaveAttribute('data-customer-id', TARGET_ID)
})

test('@m7 @pos-customer busca teléfono con o sin separadores', async ({ page }) => {
  await openComprobanteModal(page)
  const options = await searchCustomer(page, '541145678901')

  await expect(options).toHaveCount(1)
  await expect(options).toHaveAttribute('data-customer-id', TARGET_ID)
})
