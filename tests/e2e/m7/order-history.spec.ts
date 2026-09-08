import { test, expect } from './fixtures'
import { ejecutarSQL, consultarJSON } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

// Synthetic rows in the guarded LOCAL Docker database, never production.
const fixture = {
  customer: '00000000-0000-0000-0000-00000e2ec801',
  device: '00000000-0000-0000-0000-00000e2ec802',
  order: '00000000-0000-0000-0000-00000e2ec803',
}

function cleanup() {
  ejecutarSQL(`BEGIN;
    DELETE FROM public.status_history WHERE order_id = '${fixture.order}';
    DELETE FROM public.orders WHERE id = '${fixture.order}';
    DELETE FROM public.devices WHERE id = '${fixture.device}';
    DELETE FROM public.customers WHERE id = '${fixture.customer}';
    COMMIT;`)
}

test.beforeAll(() => {
  cleanup()
  ejecutarSQL(`BEGIN;
    INSERT INTO public.customers (id, business_id, name, phone)
    VALUES ('${fixture.customer}', '${E2E.business}', 'Cliente historial sintético', '0000000000');
    INSERT INTO public.devices (id, business_id, customer_id, type, brand, model, issue)
    VALUES ('${fixture.device}', '${E2E.business}', '${fixture.customer}',
      'smartphone', 'Equipo', 'Historial sintético', 'Fixture local');
    INSERT INTO public.orders (id, business_id, customer_id, device_id, status, priority)
    VALUES ('${fixture.order}', '${E2E.business}', '${fixture.customer}', '${fixture.device}', 'new', 'medium');
    INSERT INTO public.status_history (order_id, business_id, status, note, created_at)
    VALUES
      ('${fixture.order}', '${E2E.business}', 'diagnosis', 'Nota conocida sintética', '2026-09-01T10:00:00Z'),
      ('${fixture.order}', '${E2E.business}', 'received', 'Nota legacy sintética', '2026-09-01T11:00:00Z'),
      ('${fixture.order}', '${E2E.business}', 'estado_eliminado', 'Nota desconocida sintética', '2026-09-01T12:00:00Z');
    COMMIT;`)
})

test.afterAll(cleanup)

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`@orders history preserves mixed stored statuses and the detail remains usable (${viewport.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    const writes: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/rest/v1/status_history' && !['GET', 'HEAD'].includes(request.method())) {
        writes.push(request.method())
      }
    })
    await page.goto(`/orders/${fixture.order}`)
    await expect(page.getByText('Cliente historial sintético', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Historial', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Historial de Estados' })).toBeVisible()
    for (const label of ['Diagnóstico', 'Estado desconocido (received)', 'Estado desconocido (estado_eliminado)']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(page.getByText('Nota legacy sintética', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('order-history.png'), fullPage: true })
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await expect(page.getByText('Cliente historial sintético', { exact: true })).toBeVisible()
    await expect(page.getByText('Historial sintético', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
    expect(writes).toEqual([])
    const stored = consultarJSON<{ statuses: string[] }>(`
      SELECT array_agg(status ORDER BY created_at) AS statuses
      FROM public.status_history WHERE order_id = '${fixture.order}'`)
    expect(stored.statuses).toEqual(['diagnosis', 'received', 'estado_eliminado'])
  })
}
