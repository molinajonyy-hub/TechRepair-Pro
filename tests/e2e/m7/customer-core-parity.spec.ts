// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-1 · Gate distintivo de paridad.
//
// Crea el MISMO cliente lógico por las dos superficies de alta, con los mismos
// campos del core, y compara las filas REALMENTE PERSISTIDAS.
//
//   A. Clientes → Nuevo cliente      (página completa)
//   B. Nueva Orden → Crear cliente rápido (diálogo)
//
// Antes de este lote, el mismo tecleo producía filas distintas:
//   A guardaba `DNI: 30.123.456` · B guardaba `30.123.456`.
//
// Corre sólo bajo el proyecto `m7-local`: stack local, usuario sembrado, y el
// globalSetup valida el destino antes de cualquier spec. `consultarJSON` va por
// `docker exec` al contenedor local, así que este archivo es estructuralmente
// incapaz de tocar producción.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test, type Page } from '@playwright/test'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

// Marca propia del lote: hace el cleanup exacto y no toca fixtures ajenos.
const MARK = 'UICONS1'
const FULL_PAGE_NAME = `${MARK} Alta Full Page`
const QUICK_NAME = `${MARK} Alta Rapida`
const PHONE = '3512345678'
const EMAIL = 'uicons1@example.test'
const DOCUMENT_TYPED = '30.123.456'

type CustomerRow = {
  name: string
  phone: string | null
  email: string | null
  document: string | null
  customer_type: string
  business_name: string | null
  contact_person: string | null
}

function readCustomer(name: string): CustomerRow {
  return consultarJSON<CustomerRow>(`
    SELECT name, phone, email, document, customer_type, business_name, contact_person
      FROM public.customers
     WHERE business_id = '${E2E.business}' AND name = '${name}'
  `)
}

function cleanup() {
  ejecutarSQL(`DELETE FROM public.customers
                WHERE business_id = '${E2E.business}' AND name LIKE '${MARK} %';`)
}

async function createFromFullPage(page: Page) {
  await page.goto('/customers/new')
  await page.getByTestId('customer-name-input').fill(FULL_PAGE_NAME)
  await page.getByTestId('customer-phone-input').fill(PHONE)
  await page.getByTestId('customer-email-input').fill(EMAIL)
  await page.getByTestId('customer-document-input').fill(DOCUMENT_TYPED)
  await page.getByTestId('customer-save-button').click()
  // La página completa navega al detalle del cliente creado.
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/)
}

async function createFromQuickDialog(page: Page) {
  await page.goto('/orders/new')
  await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
  const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Nombre completo').fill(QUICK_NAME)
  await dialog.getByLabel('Teléfono').fill(PHONE)
  await dialog.getByLabel('Email').fill(EMAIL)
  await dialog.getByLabel('DNI').fill(DOCUMENT_TYPED)
  await dialog.getByRole('button', { name: 'Crear cliente' }).click()
  await expect(dialog).not.toBeVisible()
  // Contrato con el wizard: vuelve seleccionado en el paso Cliente.
  await expect(page.getByRole('button', { name: new RegExp(QUICK_NAME) })).toBeVisible()
}

test.describe('@customer-core UI-CONSISTENCY-1 · paridad entre superficies de alta', () => {
  test.beforeEach(() => cleanup())
  test.afterAll(() => cleanup())

  test('el mismo cliente creado por las dos superficies persiste igual', async ({ page }) => {
    await createFromFullPage(page)
    await createFromQuickDialog(page)

    const full = readCustomer(FULL_PAGE_NAME)
    const quick = readCustomer(QUICK_NAME)

    // 1) El documento quedó en el formato canónico en AMBAS filas.
    expect(full.document).toBe('DNI 30123456')
    expect(quick.document).toBe('DNI 30123456')

    // 2) Los campos compartidos son semánticamente idénticos.
    //    (`name` se excluye a propósito: es lo único que distingue las filas.)
    for (const field of ['phone', 'email', 'document', 'customer_type', 'business_name', 'contact_person'] as const) {
      expect(quick[field], `divergencia en "${field}"`).toEqual(full[field])
    }

    // 3) Y el tipo de cliente es un valor que acepta el CHECK de la tabla.
    expect(full.customer_type).toBe('minorista')
  })

  test('un mayorista creado por cada superficie persiste igual', async ({ page }) => {
    const fullWholesale = `${MARK} Mayorista Full`
    const quickWholesale = `${MARK} Mayorista Rapido`

    await page.goto('/customers/new')
    await page.getByTestId('customer-name-input').fill(fullWholesale)
    await page.getByTestId('customer-phone-input').fill(PHONE)
    await page.getByTestId('customer-type-mayorista').click()
    // Elegir mayorista pasa el documento a CUIT en las dos superficies.
    await expect(page.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('customer-document-input').fill('20-30123456-7')
    await page.getByTestId('customer-business-name-input').fill('Demo SRL')
    await page.getByTestId('customer-save-button').click()
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/)

    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    await dialog.getByLabel('Tipo de cliente').selectOption('mayorista')
    await expect(dialog.getByLabel('Tipo de documento')).toHaveValue('cuit')
    await dialog.getByLabel('Razón social').fill('Demo SRL')
    await dialog.getByLabel('Nombre de contacto').fill(quickWholesale)
    await dialog.getByLabel('Teléfono').fill(PHONE)
    await dialog.getByLabel('CUIT').fill('20-30123456-7')
    await dialog.getByRole('button', { name: 'Crear cliente' }).click()
    await expect(dialog).not.toBeVisible()

    const full = readCustomer(fullWholesale)
    const quick = readCustomer(quickWholesale)

    expect(full.document).toBe('CUIT 20301234567')
    expect(quick.document).toBe('CUIT 20301234567')
    for (const field of ['document', 'customer_type', 'business_name'] as const) {
      expect(quick[field], `divergencia en "${field}"`).toEqual(full[field])
    }
    expect(full.customer_type).toBe('mayorista')
    expect(full.business_name).toBe('Demo SRL')
  })

  test('la edición no puede dejar un mayorista sin razón social', async ({ page }) => {
    const name = `${MARK} Para Editar`
    ejecutarSQL(`INSERT INTO public.customers (business_id, name, phone, customer_type)
                 VALUES ('${E2E.business}', '${name}', '${PHONE}', 'minorista');`)

    await page.goto('/customers')
    // Se apunta a LA fila del cliente, no a `.first()`: el buscador tiene 300 ms
    // de debounce y `.first()` puede agarrar otra fila antes de que filtre.
    const listRow = page.getByRole('row').filter({ hasText: name })
    await expect(listRow).toBeVisible()
    await listRow.getByTitle('Editar cliente').click()
    await expect(page.getByText('Editar Cliente')).toBeVisible()
    await expect(page.getByTestId('customer-edit-name-input')).toHaveValue(name)

    await page.getByTestId('customer-edit-type-mayorista').click()
    // El gate que faltaba: sin razón social, no se guarda.
    await expect(page.getByTestId('customer-edit-save-button')).toBeDisabled()

    await page.getByTestId('customer-edit-business-name-input').fill('Editada SRL')
    await expect(page.getByTestId('customer-edit-save-button')).toBeEnabled()
    await page.getByTestId('customer-edit-save-button').click()

    await expect(page.getByText('Editar Cliente')).not.toBeVisible()
    const row = readCustomer(name)
    expect(row.customer_type).toBe('mayorista')
    expect(row.business_name).toBe('Editada SRL')
  })
})

// ── Sanidad responsive y de tema ────────────────────────────────────────────
// No es un rediseño: sólo se comprueba que las superficies tocadas no
// desbordan ni tapan su CTA. El diálogo sumó un campo (tipo de documento) y el
// modal de edición sumó cuatro, así que el riesgo real es de alto y scroll.
const MOBILE_WIDTHS = [320, 390, 430]

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('@customer-core UI-CONSISTENCY-1 · sanidad responsive', () => {
  test.afterAll(() => cleanup())

  for (const width of MOBILE_WIDTHS) {
    test(`el alta rápida abre, no desborda y cancela en ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto('/orders/new')

      const trigger = page.getByRole('button', { name: 'Crear cliente rápido' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
      await expect(dialog).toBeVisible()

      // El campo nuevo está presente y el diálogo sigue sin desbordar.
      await expect(dialog.getByLabel('Tipo de documento')).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(1)

      // El CTA es alcanzable y nada lo tapa: se comprueba por hit-test real,
      // no sólo por visibilidad.
      //
      // NOTA: hoy mide ~39 px de alto, por debajo del mínimo táctil de 44 px.
      // Viene del footer de ResponsiveDialog (MOBILE-2A) y este lote NO lo
      // toca: cambiar el alto del AppButton afecta el footer de TODOS los
      // diálogos de la app.
      //
      // UI-CONSISTENCY-4 (PR #86) NO lo cubre. Medido tras integrarlo: subió
      // `.icon-btn` a 44×44 con `--mobile-touch-target` bajo 1023 px, pero el
      // footer de los diálogos sigue en 39,1 px. No asumir que ya está resuelto.
      // Queda para el lote de convergencia de diálogos; acá sólo se fija que no
      // haya regresión de alcance.
      const cta = dialog.getByRole('button', { name: 'Crear cliente' })
      await expect(cta).toBeVisible()
      const reachable = await cta.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        return [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].every((y) => {
          const hit = document.elementFromPoint(x, y)
          return hit === element || Boolean(hit && element.contains(hit))
        })
      })
      expect(reachable).toBe(true)

      // Escape cierra sin crear nada.
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
    })
  }

  test('el modal de edición scrollea sus campos nuevos en 320px', async ({ page }) => {
    const name = `${MARK} Responsive`
    ejecutarSQL(`INSERT INTO public.customers (business_id, name, phone, customer_type, business_name)
                 VALUES ('${E2E.business}', '${name}', '${PHONE}', 'mayorista', 'Demo SRL');`)

    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto('/customers')
    await page.getByRole('row').filter({ hasText: name }).getByTitle('Editar cliente').click()
    await expect(page.getByText('Editar Cliente')).toBeVisible()

    expect(await overflow(page)).toBeLessThanOrEqual(1)

    // Los campos que sumó el lote son alcanzables por el scroll propio del modal.
    const businessName = page.getByTestId('customer-edit-business-name-input')
    await businessName.scrollIntoViewIfNeeded()
    await expect(businessName).toBeVisible()
    await expect(page.getByTestId('customer-edit-save-button')).toBeVisible()
    expect(await overflow(page)).toBeLessThanOrEqual(1)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`el alta full page es usable en 1440 · ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('theme', value)
        localStorage.setItem('techrepair_theme', value)
      }, theme)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto('/customers/new')

      await expect(page.getByTestId('customer-name-input')).toBeVisible()
      await expect(page.getByTestId('customer-address-input')).toBeVisible()
      await expect(page.getByTestId('customer-document-input')).toBeVisible()
      expect(await overflow(page)).toBeLessThanOrEqual(1)

      // Los controles del lote pintan texto legible, no heredan transparente.
      const contrast = await page.evaluate(() => {
        const target = document.querySelector('[data-testid="customer-document-type-dni"]')
        if (!target) return null
        const style = getComputedStyle(target)
        return { color: style.color, transparent: style.color === 'rgba(0, 0, 0, 0)' }
      })
      expect(contrast).not.toBeNull()
      expect(contrast!.transparent).toBe(false)
    })
  }
})
