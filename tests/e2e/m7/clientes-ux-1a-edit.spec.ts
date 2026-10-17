// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES-UX-1A · Edición de clientes con persistencia REAL.
//
// Cada caso escribe por la pantalla, recarga o reabre, y lee la fila de la base
// local con SQL: «se cerró el diálogo» no prueba que se haya guardado.
//
//   · ficha individual: «Editar cliente» (antes no existía)
//   · listado: confirmación visible después de guardar
//   · mayorista del portal sin razón social: el owner corrige el teléfono
//   · escritorio (1440) y celular (390)
//
// Corre bajo `m7-local`: `ejecutarSQL` va por `docker exec` al contenedor local,
// así que este archivo no puede tocar producción.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

const MARK = 'CLIUX1A'
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }

type Row = {
  name: string
  phone: string
  notes: string | null
  document: string | null
  address: string | null
  customer_type: string
  business_name: string | null
  contact_person: string | null
}

function seedCustomer(name: string, extra: Partial<Record<keyof Row, string | null>> = {}): string {
  const id = randomUUID()
  const fields = { name, phone: '3511230000', customer_type: 'minorista', ...extra }
  const cols = Object.keys(fields).join(', ')
  const vals = Object.values(fields).map(v => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)).join(', ')
  ejecutarSQL(`INSERT INTO public.customers (id, business_id, ${cols}) VALUES ('${id}', '${E2E.business}', ${vals});`)
  return id
}

function readCustomer(id: string): Row {
  return consultarJSON<Row>(`
    SELECT name, phone, notes, document, address, customer_type, business_name, contact_person
      FROM public.customers WHERE id = '${id}' AND business_id = '${E2E.business}'
  `)
}

function cleanup() {
  ejecutarSQL(`DELETE FROM public.customers WHERE business_id = '${E2E.business}' AND name LIKE '${MARK} %';`)
}

async function editFromDetail(page: Page, id: string) {
  await page.goto(`/customers/${id}`)
  const edit = page.getByRole('button', { name: 'Editar cliente' })
  await expect(edit).toBeVisible()
  await edit.click()
  const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
  await expect(dialog).toBeVisible()
  return dialog
}

test.beforeEach(cleanup)
test.afterAll(cleanup)

test.describe('@clientes-ux-1a escritorio', () => {
  test.use({ viewport: DESKTOP })

  test('ficha: «Editar cliente» guarda, confirma y persiste al recargar', async ({ page }) => {
    const name = `${MARK} Ficha Escritorio`
    const id = seedCustomer(name, { document: 'DNI 30111222' })
    const dialog = await editFromDetail(page, id)

    await expect(dialog.getByTestId('customer-name-input')).toHaveValue(name)
    await dialog.getByTestId('customer-phone-input').fill('3517654321')
    await dialog.getByTestId('customer-notes-input').fill('Prefiere WhatsApp por la tarde')
    await dialog.getByTestId('customer-address-input').fill('Av. Colón 100, Córdoba')
    await dialog.getByTestId('customer-edit-save-button').click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-saved-notice')).toContainText('Cambios guardados.')
    await expect(page.getByTestId('customer-detail-notes')).toHaveText('Prefiere WhatsApp por la tarde')

    // Persistencia real: la fila y la ficha recargada.
    const row = readCustomer(id)
    expect(row).toMatchObject({ phone: '3517654321', notes: 'Prefiere WhatsApp por la tarde', address: 'Av. Colón 100, Córdoba', document: 'DNI 30111222', customer_type: 'minorista' })
    await page.reload()
    await expect(page.getByText('3517654321')).toBeVisible()
    await expect(page.getByTestId('customer-detail-document')).toHaveText('DNI 30111222')

    // Reabrir el editor trae lo guardado.
    const again = await editFromDetail(page, id)
    await expect(again.getByTestId('customer-phone-input')).toHaveValue('3517654321')
    await expect(again.getByTestId('customer-notes-input')).toHaveValue('Prefiere WhatsApp por la tarde')
  })

  test('listado: guardar confirma con el nombre y la fila persiste', async ({ page }) => {
    const name = `${MARK} Listado`
    const id = seedCustomer(name)
    await page.goto('/customers')
    const row = page.getByRole('row').filter({ hasText: name })
    await expect(row).toBeVisible()
    await row.getByTitle('Editar cliente').click()
    const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
    await dialog.getByTestId('customer-phone-input').fill('3519998888')
    await dialog.getByTestId('customer-edit-save-button').click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-saved-notice')).toContainText(`Cambios guardados en ${name}.`)
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('3519998888')
    expect(readCustomer(id).phone).toBe('3519998888')
  })

  test('mayorista del portal sin razón social: el owner corrige el teléfono sin inventarla', async ({ page }) => {
    const name = `${MARK} Mayorista Portal`
    const id = seedCustomer(name, { customer_type: 'mayorista', phone: '', business_name: null, contact_person: null })
    const dialog = await editFromDetail(page, id)

    await dialog.getByTestId('customer-phone-input').fill('3515550000')
    await dialog.getByTestId('customer-edit-save-button').click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-saved-notice')).toContainText('Cambios guardados.')
    expect(readCustomer(id)).toMatchObject({ phone: '3515550000', customer_type: 'mayorista', business_name: null, contact_person: null })
  })

  test('borrar la razón social de un mayorista sigue bloqueado y no escribe', async ({ page }) => {
    const name = `${MARK} Mayorista Con Razon`
    const id = seedCustomer(name, { customer_type: 'mayorista', business_name: 'Demo SRL' })
    const dialog = await editFromDetail(page, id)

    await dialog.getByTestId('customer-business-name-input').fill('')
    await dialog.getByTestId('customer-edit-save-button').click()

    await expect(dialog.getByText('Un cliente mayorista necesita razón social.')).toBeVisible()
    await expect(dialog).toBeVisible()
    expect(readCustomer(id).business_name).toBe('Demo SRL')
  })
})

test.describe('@clientes-ux-1a celular', () => {
  test.use({ viewport: MOBILE })

  test('ficha: el botón está a la vista, el editor ocupa la pantalla y guarda', async ({ page }) => {
    const name = `${MARK} Ficha Celular`
    const id = seedCustomer(name)
    await page.goto(`/customers/${id}`)
    const edit = page.getByRole('button', { name: 'Editar cliente' })
    await expect(edit).toBeInViewport()
    const box = await edit.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32)
    // La ficha ya no desborda: las pestañas quedan dentro de la pantalla.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    await edit.click()
    const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('customer-phone-input').fill('3514443333')
    const save = dialog.getByTestId('customer-edit-save-button')
    await expect(save).toBeInViewport()
    await save.click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-saved-notice')).toContainText('Cambios guardados.')
    expect(readCustomer(id).phone).toBe('3514443333')
  })

  test('listado: Editar desde el menú de la tarjeta guarda y confirma', async ({ page }) => {
    const name = `${MARK} Tarjeta Celular`
    const id = seedCustomer(name)
    await page.goto('/customers')
    await page.getByTestId('customers-search-input').fill(name)
    await page.getByRole('button', { name: `Acciones de ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Editar' }).click()
    const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
    await dialog.getByTestId('customer-notes-input').fill('Retira el sábado')
    await dialog.getByTestId('customer-edit-save-button').click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByTestId('customer-saved-notice')).toContainText(`Cambios guardados en ${name}.`)
    expect(readCustomer(id).notes).toBe('Retira el sábado')
  })
})
