// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES-UX-1B · Contacto alternativo para avisos + destinatario por orden.
//
// Base REAL (stack local de CI). Cada paso se confirma leyendo las filas con
// SQL: el contacto en `customers`, la elección y su copia en
// `order_notification_recipients`. Nunca se abre WhatsApp: sólo el preview.
//
//   · escritorio: ficha → contacto → recepción elige el alternativo → la orden
//     y el preview lo proponen → la ficha cambia y la orden conserva la copia →
//     se vuelve al titular desde la orden
//   · celular: alta rápida con contacto desde Nueva orden
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

const RUN = Date.now().toString(36).toUpperCase()
const MARK = `CLIUX1B ${RUN}`
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

function seedCustomer(name: string, phone = '3511230000'): string {
  const id = randomUUID()
  ejecutarSQL(`INSERT INTO public.customers (id, business_id, name, phone, customer_type)
               VALUES ('${id}', '${E2E.business}', '${name}', '${phone}', 'minorista');`)
  return id
}

function customerRow(id: string) {
  return consultarJSON<{ phone: string; notification_contact_name: string | null; notification_contact_phone: string | null }>(`
    SELECT phone, notification_contact_name, notification_contact_phone FROM public.customers
     WHERE id = '${id}' AND business_id = '${E2E.business}'`)
}

function recipientRow(orderId: string) {
  return consultarJSON<{ recipient: string; contact_name: string | null; contact_phone: string | null; customer_id: string }>(`
    SELECT r.recipient, r.contact_name, r.contact_phone, o.customer_id
      FROM public.order_notification_recipients r JOIN public.orders o ON o.id = r.order_id
     WHERE r.order_id = '${orderId}' AND r.business_id = '${E2E.business}'`)
}

async function next(page: Page) {
  const bar = page.getByTestId('mobile-action-bar')
  const button = (await bar.isVisible()) ? bar.getByRole('button', { name: 'Continuar' }) : page.locator('.intake-desktop-actions').getByRole('button', { name: 'Continuar' })
  await button.click()
}

async function finishIntake(page: Page): Promise<string> {
  await next(page)
  await page.getByLabel('Marca').fill('Samsung')
  await page.getByLabel('Modelo').fill('Galaxy CLIUX1B')
  await next(page)
  await page.getByTestId('intake-problem').fill('No carga')
  await next(page)
  const bar = page.getByTestId('mobile-action-bar')
  const create = (await bar.isVisible()) ? bar.getByRole('button', { name: 'Crear orden' }) : page.locator('.intake-desktop-actions').getByRole('button', { name: 'Crear orden' })
  await create.click()
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/)
  return page.url().split('/').pop()!
}

test.describe('@clientes-ux-1b escritorio', () => {
  test.use({ viewport: DESKTOP })

  test('contacto en la ficha → recepción → orden y WhatsApp → la copia sobrevive a la ficha', async ({ page }) => {
    const name = `${MARK} Juan Titular`
    const id = seedCustomer(name, '3511234567')

    // 1. Ficha: cargar el contacto para avisos.
    await page.goto(`/customers/${id}`)
    await page.getByRole('button', { name: 'Editar cliente' }).click()
    const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
    await dialog.getByLabel('Nombre del contacto').fill('María Hija')
    await dialog.getByLabel('Teléfono para avisos').fill('351 15 555-1234')
    await dialog.getByTestId('customer-edit-save-button').click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-detail-notice')).toContainText('María Hija')
    expect(customerRow(id)).toEqual({ phone: '3511234567', notification_contact_name: 'María Hija', notification_contact_phone: '351 15 555-1234' })

    // 2. Recepción: por defecto el cliente; se elige el contacto alternativo.
    await page.goto('/orders/new')
    await page.getByLabel('Buscar cliente').fill(name)
    await page.getByRole('button', { name: new RegExp(name) }).click()
    const choice = page.getByTestId('intake-notify')
    await expect(choice.getByTestId('intake-notify-customer')).toHaveAttribute('aria-pressed', 'true')
    await choice.getByTestId('intake-notify-alternate').click()
    await expect(choice.getByTestId('intake-notify-alternate')).toHaveAttribute('aria-pressed', 'true')
    const orderId = await finishIntake(page)

    expect(recipientRow(orderId)).toEqual({ recipient: 'alternate', contact_name: 'María Hija', contact_phone: '351 15 555-1234', customer_id: id })

    // 3. Orden: el panel y el preview proponen al contacto alternativo.
    const panel = page.getByTestId('order-notify-panel')
    await expect(panel.getByTestId('order-notify-recipient')).toContainText('Contacto alternativo')
    await expect(panel.getByTestId('order-notify-recipient')).toContainText('María Hija')
    await page.locator('.order-detail-header__secondary').getByRole('button', { name: 'WhatsApp' }).click()
    await page.getByTestId('order-whatsapp-free').click()
    const preview = page.getByTestId('whatsapp-preview-modal')
    await expect(preview.getByTestId('whatsapp-recipient-summary')).toContainText('María Hija')
    await expect(preview.getByTestId('whatsapp-recipient-summary')).toContainText('Contacto alternativo')
    await expect(preview.getByTestId('whatsapp-recipient')).toContainText('+5493515551234')
    await preview.getByRole('button', { name: 'Cerrar' }).first().click()

    // 4. La ficha cambia: la orden conserva a quien se eligió y ofrece actualizar.
    ejecutarSQL(`UPDATE public.customers SET notification_contact_name = 'Pedro Vecino', notification_contact_phone = '3514443333'
                  WHERE id = '${id}' AND business_id = '${E2E.business}';`)
    await page.reload()
    await expect(page.getByTestId('order-notify-recipient')).toContainText('María Hija')
    await expect(page.getByTestId('order-notify-stale')).toContainText('Pedro Vecino')
    expect(recipientRow(orderId).contact_name).toBe('María Hija')

    // 5. Volver al titular desde la orden.
    await page.getByTestId('order-notify-choose-customer').click()
    await expect(page.getByTestId('order-notify-recipient')).toHaveAttribute('data-kind', 'customer')
    await expect(page.getByTestId('order-notify-panel').getByRole('status')).toContainText(`Los avisos de esta orden van a ${name}.`)
    expect(recipientRow(orderId)).toMatchObject({ recipient: 'customer', contact_name: null, contact_phone: null, customer_id: id })
    // La titularidad y el teléfono principal no se tocaron en ningún paso.
    expect(customerRow(id).phone).toBe('3511234567')
  })

  test('sin contacto alternativo la recepción no ofrece elegir y la orden avisa al titular', async ({ page }) => {
    const name = `${MARK} Sin Contacto`
    seedCustomer(name, '3517654321')
    await page.goto('/orders/new')
    await page.getByLabel('Buscar cliente').fill(name)
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await expect(page.getByTestId('intake-notify')).toHaveCount(0)
    const orderId = await finishIntake(page)

    const sinFila = consultarJSON<{ n: number }>(`SELECT count(*)::int AS n FROM public.order_notification_recipients WHERE order_id = '${orderId}'`)
    expect(sinFila.n).toBe(0)
    await expect(page.getByTestId('order-notify-recipient')).toHaveAttribute('data-kind', 'customer')
    await expect(page.getByTestId('order-notify-recipient')).toContainText('3517654321')
  })
})

test.describe('@clientes-ux-1b celular', () => {
  test.use({ viewport: MOBILE })

  test('alta rápida con contacto para avisos desde Nueva orden', async ({ page }) => {
    const name = `${MARK} Alta Rapida`
    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    await dialog.getByLabel('Nombre completo').fill(name)
    await dialog.getByLabel('Teléfono', { exact: true }).fill('3512223333')
    await dialog.getByTestId('customer-notice-toggle').click()
    await dialog.getByLabel('Nombre del contacto').fill('Quien Retira')
    await dialog.getByLabel('Teléfono para avisos').fill('+54 9 351 444-5555')
    await dialog.getByTestId('quick-customer-save-button').click()
    await expect(dialog).not.toBeVisible()

    const alternate = page.getByTestId('intake-notify-alternate')
    await expect(alternate).toContainText('Quien Retira')
    await alternate.click()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    const orderId = await finishIntake(page)

    expect(recipientRow(orderId)).toMatchObject({ recipient: 'alternate', contact_name: 'Quien Retira', contact_phone: '+54 9 351 444-5555' })
    await expect(page.getByTestId('order-notify-recipient')).toContainText('Quien Retira')
    const panelOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(panelOverflow).toBeLessThanOrEqual(1)
  })
})
